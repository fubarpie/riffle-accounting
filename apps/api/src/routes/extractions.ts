// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import fastifyMultipart from "@fastify/multipart";
import {
  EXTRACTION_WRITER_ROLES, ExtractionInputError, MAX_EXTRACTION_LINES, approveExtraction, createExtraction,
  getExtraction, insertStatementDocument, isIsoDate, listExtractions, rejectExtraction, updateExtraction, uuidv7,
  withMembership,
  type Extraction, type ExtractionLine, type MembershipRole, type NewExtractionLine,
} from "@riffle/db";
import {
  CsvExtractor, ExtractorError, extractPdfText, toDraft, validateExtraction,
  type ExtractInput, type Extractor,
} from "@riffle/extractor";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import type { ApiConfig } from "../config";
import { NotFound } from "../errors";
import { VaultStorage, detectContentType, sanitizeFilename } from "../vault";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_STORAGE_DIR } from "./reconciliations";

/** Candidate data is readable by every member; only writers may upload, edit, approve or reject. */
const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];

const bizParams = z.object({ id: z.uuid() });
const extParams = z.object({ id: z.uuid(), eid: z.uuid() });

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");
/** Minor units as an integer or a decimal string (JSON numbers lose precision past 2^53). */
const minor = z.union([z.string().regex(/^-?\d{1,16}$/), z.number().int().safe()]).transform((v) => BigInt(v));

const uploadQuery = z.object({
  accountId: z.uuid(),
  // CSV only, for exports without a running balance column (or to override the derived values).
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  openingBalance: minor.optional(),
  closingBalance: minor.optional(),
}).strict();
const listQuery = z.object({
  status: z.enum(["pending", "staged", "flagged", "approved", "rejected"]).optional(),
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const lineBody = z.object({
  date: isoDate,
  description: z.string().max(1000),
  amountMinor: minor,
  alreadyRecorded: z.boolean().optional(),
}).strict();
const patchBody = z.object({
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  openingBalance: minor.optional(),
  closingBalance: minor.optional(),
  lines: z.array(lineBody).max(MAX_EXTRACTION_LINES).optional(),
}).strict();

const extractionView = (e: Extraction) => ({
  ...e, openingBalanceMinor: e.openingBalanceMinor.toString(), closingBalanceMinor: e.closingBalanceMinor.toString(),
});
// `raw` (the extractor's untouched line) stays in the database for audit and is not served.
const lineView = (l: ExtractionLine) => {
  const { raw: _omit, ...rest } = l;
  return { ...rest, amountMinor: l.amountMinor.toString() };
};
const detailView = (d: { extraction: Extraction; lines: ExtractionLine[] }) => ({
  extraction: extractionView(d.extraction), lines: d.lines.map(lineView),
});

export async function extractionRoutes(
  app: FastifyInstance, opts: { pool: Pool; config: ApiConfig },
): Promise<void> {
  const { pool, config } = opts;
  const maxBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const vault = new VaultStorage(config.statementStorageDir ?? DEFAULT_STORAGE_DIR);
  const base = "/api/businesses/:id/extractions";
  // The gate is a pure function: the same verdict whether it runs at upload, edit or approval.
  const gate = validateExtraction;

  // Scoped to this plugin: other routes keep rejecting multipart bodies.
  await app.register(fastifyMultipart, {
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2, headerPairs: 32 },
  });

  app.post(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);

    // Role first, query second, body last: a viewer learns nothing and cannot make us buffer an upload.
    const { currency } = await withMembership(pool, user.id, id, EXTRACTION_WRITER_ROLES, async (c) => {
      const q = uploadQuery.parse(request.query);
      const { rows } = await c.query<{ type: string; archived: boolean }>(
        "SELECT type, archived_at IS NOT NULL AS archived FROM accounts WHERE business_id = $1 AND id = $2", [id, q.accountId]);
      if (!rows[0]) throw new NotFound();
      if (rows[0].type !== "asset" && rows[0].type !== "liability") {
        throw new ExtractionInputError("statements can only be uploaded for asset or liability accounts");
      }
      if (rows[0].archived) throw new ExtractionInputError("account is archived");
      const biz = await c.query<{ currency: string }>("SELECT currency FROM businesses WHERE id = $1", [id]);
      return { currency: biz.rows[0]!.currency };
    });
    const q = uploadQuery.parse(request.query);

    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "Expected multipart/form-data with one file" });
    }
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "No file was uploaded" });
    const data = await part.toBuffer(); // throws a 413 past the size limit
    if (part.file.truncated) return reply.code(413).send({ error: `File exceeds ${maxBytes} bytes` });
    if (data.length === 0) return reply.code(400).send({ error: "File is empty" });

    const claimed = part.mimetype.split(";")[0]!.trim().toLowerCase();
    if (claimed !== "text/csv" && claimed !== "application/pdf") {
      return reply.code(415).send({ error: "Only PDF (with a text layer) and CSV statements can be extracted" });
    }
    const detected = detectContentType(data);
    if (detected !== claimed) {
      return reply.code(415).send({ error: "File contents do not match the declared type" });
    }

    // Extraction runs OUTSIDE any database transaction: a model call can take a minute.
    let extractor: Extractor;
    const input: ExtractInput = { filename: sanitizeFilename(part.filename), mimeType: detected };
    if (detected === "text/csv") {
      extractor = new CsvExtractor({
        currency, periodStart: q.periodStart, periodEnd: q.periodEnd,
        openingBalance: q.openingBalance, closingBalance: q.closingBalance,
      });
      input.bytes = data;
    } else {
      if (!config.extractor) throw new ExtractorError("not_configured", "PDF extraction is not configured on this server (set EXTRACTOR)");
      extractor = config.extractor;
      input.text = await extractPdfText(new Uint8Array(data));
    }
    const draft = toDraft(await extractor.extract(input));

    const docId = uuidv7();
    const storageKey = `${id}/${docId}`;
    const sha256 = createHash("sha256").update(data).digest("hex");
    await vault.put(storageKey, data);
    try {
      const result = await withMembership(pool, user.id, id, EXTRACTION_WRITER_ROLES, async (c) => {
        await insertStatementDocument(c, id, user.id, {
          id: docId, reconciliationId: null, filename: input.filename, contentType: detected,
          sizeBytes: data.length, sha256, storageKey,
        });
        return createExtraction(c, id, user.id, {
          accountId: q.accountId, documentId: docId, extractorName: extractor.name, extractorModel: extractor.model,
          periodStart: draft.periodStart, periodEnd: draft.periodEnd,
          openingBalanceMinor: draft.openingBalance, closingBalanceMinor: draft.closingBalance,
          currency: draft.currency, lines: draft.lines,
        }, gate);
      });
      return reply.code(201).send(detailView(result));
    } catch (err) {
      // No row, so no orphan file.
      await vault.remove(storageKey).catch(() => undefined);
      throw err;
    }
  });

  app.get(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    const q = listQuery.parse(request.query);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({
      extractions: (await listExtractions(c, id, q)).map(extractionView),
    }));
  });

  app.get(`${base}/:eid`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, eid } = extParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const found = await getExtraction(c, id, eid);
      if (!found) throw new NotFound();
      return detailView(found);
    });
  });

  // Correct the extraction and re-run the gate. An empty body just re-validates.
  const edit = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, eid } = extParams.parse(request.params);
    return withMembership(pool, user.id, id, EXTRACTION_WRITER_ROLES, async (c) => {
      const body = patchBody.parse(request.body ?? {});
      const lines: NewExtractionLine[] | undefined = body.lines?.map((l) => ({
        date: l.date, description: l.description, amountMinor: l.amountMinor, alreadyRecorded: l.alreadyRecorded === true,
        raw: { editedBy: user.id, date: l.date, description: l.description, amountMinor: l.amountMinor.toString() },
      }));
      return detailView(await updateExtraction(c, id, user.id, eid, {
        ...(body.periodStart !== undefined && { periodStart: body.periodStart }),
        ...(body.periodEnd !== undefined && { periodEnd: body.periodEnd }),
        ...(body.openingBalance !== undefined && { openingBalanceMinor: body.openingBalance }),
        ...(body.closingBalance !== undefined && { closingBalanceMinor: body.closingBalance }),
        ...(lines !== undefined && { lines }),
      }, gate));
    });
  };
  app.patch(`${base}/:eid`, edit);
  app.post(`${base}/:eid/revalidate`, edit);

  app.post(`${base}/:eid/approve`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, eid } = extParams.parse(request.params);
    const res = await withMembership(pool, user.id, id, EXTRACTION_WRITER_ROLES, (c) =>
      approveExtraction(c, id, user.id, eid, gate));
    // Not thrown: the refreshed verdict and the refusal audit entry were committed and must stay.
    if (res.outcome === "not_approvable") {
      return reply.code(422).send({ error: "The extraction does not pass validation and cannot be approved", ...detailView(res) });
    }
    if (res.outcome === "already_approved") return { alreadyApproved: true, posted: 0, ...detailView(res) };
    return { alreadyApproved: false, posted: res.posted, skippedAlreadyRecorded: res.skipped, transactionIds: res.transactionIds, ...detailView(res) };
  });

  app.post(`${base}/:eid/reject`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, eid } = extParams.parse(request.params);
    const res = await withMembership(pool, user.id, id, EXTRACTION_WRITER_ROLES, (c) => rejectExtraction(c, id, user.id, eid));
    return { alreadyRejected: res.alreadyRejected, ...detailView(res) };
  });
}
