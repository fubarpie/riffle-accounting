// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import fastifyMultipart from "@fastify/multipart";
import {
  RECONCILIATION_WRITER_ROLES, completeReconciliation, createReconciliation, deleteStatementDocument,
  getReconciliation, getStatementDocument, insertStatementDocument, isIsoDate, listReconciliations,
  listStatementDocuments, setReconciliationItems, uuidv7, voidReconciliation, withMembership,
  STATEMENT_CONTENT_TYPES, MAX_ITEMS_PER_CALL,
  type MembershipRole, type ReconciliationDetail, type Reconciliation, type StatementDocument,
} from "@riffle/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import type { ApiConfig } from "../config";
import { Conflict, NotFound } from "../errors";
import { VaultStorage, attachmentDisposition, detectContentType, sanitizeFilename } from "../vault";

const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_STORAGE_DIR = "./data/statements";

const bizParams = z.object({ id: z.uuid() });
const recParams = z.object({ id: z.uuid(), rid: z.uuid() });
const docParams = z.object({ id: z.uuid(), rid: z.uuid(), docId: z.uuid() });

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");
/** Minor units as an integer or a decimal string (JSON numbers lose precision past 2^53). */
const minor = z.union([z.string().regex(/^-?\d{1,16}$/), z.number().int().safe()]).transform((v) => BigInt(v));

const createBody = z.object({
  accountId: z.uuid(),
  statementStart: isoDate,
  statementEnd: isoDate,
  openingBalance: minor.optional(),
  closingBalance: minor,
}).strict();
const listQuery = z.object({
  accountId: z.uuid().optional(),
  status: z.enum(["draft", "completed", "voided"]).optional(),
}).strict();
const itemsBody = z.object({
  add: z.array(z.uuid()).max(MAX_ITEMS_PER_CALL).optional(),
  remove: z.array(z.uuid()).max(MAX_ITEMS_PER_CALL).optional(),
}).strict().refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, "add or remove at least one line");

const recView = (r: Reconciliation) => ({
  ...r, openingBalanceMinor: r.openingBalanceMinor.toString(), closingBalanceMinor: r.closingBalanceMinor.toString(),
});
const docView = (d: StatementDocument) => {
  // storageKey is an internal detail and is never exposed.
  const { storageKey: _omit, ...rest } = d;
  return rest;
};
const detailView = (d: ReconciliationDetail, documents?: StatementDocument[]) => {
  const money = <T extends { amountMinor: bigint; statementAmountMinor: bigint }>(l: T) =>
    ({ ...l, amountMinor: l.amountMinor.toString(), statementAmountMinor: l.statementAmountMinor.toString() });
  const s = d.summary;
  return {
    reconciliation: recView(d.reconciliation),
    summary: {
      ...s, openingBalanceMinor: s.openingBalanceMinor.toString(), closingBalanceMinor: s.closingBalanceMinor.toString(),
      clearedMinor: s.clearedMinor.toString(), differenceMinor: s.differenceMinor.toString(),
      balanced: s.differenceMinor === 0n,
    },
    cleared: d.cleared.map(money),
    candidates: d.candidates.map(money),
    candidatesTruncated: d.candidatesTruncated,
    suggestedLineIds: d.suggestedLineIds,
    suggestedTotalMinor: d.suggestedTotalMinor.toString(),
    ...(documents && { documents: documents.map(docView) }),
  };
};

export async function reconciliationRoutes(
  app: FastifyInstance, opts: { pool: Pool; config: ApiConfig },
): Promise<void> {
  const { pool, config } = opts;
  const maxBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const vault = new VaultStorage(config.statementStorageDir ?? DEFAULT_STORAGE_DIR);
  const base = "/api/businesses/:id/reconciliations";

  // Scoped to this plugin: other routes keep rejecting multipart bodies.
  await app.register(fastifyMultipart, {
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2, headerPairs: 32 },
  });

  app.post(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    // Role first, body second: a viewer learns nothing about validation.
    const rec = await withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, async (c) => {
      const body = createBody.parse(request.body);
      return createReconciliation(c, id, user.id, {
        accountId: body.accountId, statementStart: body.statementStart, statementEnd: body.statementEnd,
        openingBalanceMinor: body.openingBalance, closingBalanceMinor: body.closingBalance,
      });
    });
    return reply.code(201).send({ reconciliation: recView(rec) });
  });

  app.get(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    const q = listQuery.parse(request.query);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({
      reconciliations: (await listReconciliations(c, id, q)).map(recView),
    }));
  });

  app.get(`${base}/:rid`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const detail = await getReconciliation(c, id, rid);
      if (!detail) throw new NotFound();
      return detailView(detail, await listStatementDocuments(c, id, rid));
    });
  });

  app.put(`${base}/:rid/items`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);
    return withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, async (c) => {
      const body = itemsBody.parse(request.body);
      const result = await setReconciliationItems(c, id, user.id, rid, body);
      const detail = (await getReconciliation(c, id, rid))!;
      return { ...result, ...detailView(detail) };
    });
  });

  app.post(`${base}/:rid/complete`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);
    return withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, async (c) =>
      detailView(await completeReconciliation(c, id, user.id, rid)));
  });

  app.post(`${base}/:rid/void`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);
    return withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, async (c) =>
      detailView(await voidReconciliation(c, id, user.id, rid)));
  });

  // ------------------------------------------------------------------ vault
  app.post(`${base}/:rid/documents`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);

    // Authorise and check the target BEFORE reading the body, so a viewer or a
    // bad id cannot make us buffer an upload.
    await withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, async (c) => {
      const detail = await getReconciliation(c, id, rid);
      if (!detail) throw new NotFound();
      if (detail.reconciliation.status === "voided") throw new Conflict("reconciliation is voided");
    });

    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "Expected multipart/form-data with one file" });
    }
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "No file was uploaded" });
    // toBuffer throws a 413 if the part exceeds the size limit.
    const data = await part.toBuffer();
    if (part.file.truncated) return reply.code(413).send({ error: `File exceeds ${maxBytes} bytes` });
    if (data.length === 0) return reply.code(400).send({ error: "File is empty" });

    const claimed = part.mimetype.split(";")[0]!.trim().toLowerCase();
    if (!(STATEMENT_CONTENT_TYPES as readonly string[]).includes(claimed)) {
      return reply.code(415).send({ error: "Only PDF, PNG, JPEG and CSV statements are accepted" });
    }
    const detected = detectContentType(data);
    if (detected !== claimed) {
      return reply.code(415).send({ error: "File contents do not match the declared type" });
    }

    const docId = uuidv7();
    const storageKey = `${id}/${docId}`;
    const sha256 = createHash("sha256").update(data).digest("hex");
    await vault.put(storageKey, data);
    try {
      const doc = await withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, (c) =>
        insertStatementDocument(c, id, user.id, {
          id: docId, reconciliationId: rid, filename: sanitizeFilename(part.filename),
          contentType: detected, sizeBytes: data.length, sha256, storageKey,
        }));
      return reply.code(201).send({ document: docView(doc) });
    } catch (err) {
      // No row, so no orphan file.
      await vault.remove(storageKey).catch(() => undefined);
      throw err;
    }
  });

  app.get(`${base}/:rid/documents`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid } = recParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      if (!(await getReconciliation(c, id, rid))) throw new NotFound();
      return { documents: (await listStatementDocuments(c, id, rid)).map(docView) };
    });
  });

  app.get(`${base}/:rid/documents/:docId`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid, docId } = docParams.parse(request.params);
    const doc = await withMembership(pool, user.id, id, ALL_ROLES, (c) => getStatementDocument(c, id, rid, docId));
    if (!doc) throw new NotFound();
    let file;
    try {
      file = await vault.read(doc.storageKey);
    } catch (err) {
      request.log.error({ err, docId }, "statement file missing from the vault");
      throw new NotFound();
    }
    return reply
      .header("Content-Type", doc.contentType)
      .header("Content-Length", String(file.size))
      .header("Content-Disposition", attachmentDisposition(doc.filename))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .send(file.stream);
  });

  app.delete(`${base}/:rid/documents/:docId`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, rid, docId } = docParams.parse(request.params);
    const doc = await withMembership(pool, user.id, id, RECONCILIATION_WRITER_ROLES, (c) =>
      deleteStatementDocument(c, id, user.id, rid, docId));
    // After commit: a crash here leaves an unreferenced file, never a row pointing at nothing.
    await vault.remove(doc.storageKey).catch((err: unknown) => request.log.error({ err, docId }, "could not remove statement file"));
    return reply.code(204).send();
  });
}
