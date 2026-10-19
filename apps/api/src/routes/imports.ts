// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import fastifyMultipart from "@fastify/multipart";
import {
  IMPORT_WRITER_ROLES, approveBatch, autoMapImportAccounts, getBatch, listBatches, rejectBatch, searchImportEntries,
  setAccountMapping, setEntryExcluded, setImportAccountsMapping, setImportEntriesExcluded,
  stageBatch, withMembership, type MembershipRole,
} from "@riffle/db";
import { CsvError, WaveFormatError, parseWaveJournal } from "@riffle/shared";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import type { ApiConfig } from "../config";
import { detectContentType } from "../vault";
import { toStageInput } from "../wave-stage";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./reconciliations";

/** Staged data is readable by every member; only writers may upload, map, exclude or reject. */
const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];
/** Browsers disagree on the type of a .csv; the content sniff below is what actually decides. */
const CSV_CLAIMS = new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]);

const bizParams = z.object({ id: z.uuid() });
const batchParams = z.object({ id: z.uuid(), bid: z.uuid() });
const acctParams = z.object({ id: z.uuid(), bid: z.uuid(), aid: z.uuid() });
const entryParams = z.object({ id: z.uuid(), bid: z.uuid(), eid: z.uuid() });

const uploadQuery = z.object({ source: z.literal("wave_journal").default("wave_journal") }).strict();
const listQuery = z.object({
  status: z.enum(["staged", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const entriesQuery = z.object({
  status: z.enum(["valid", "invalid", "skipped"]).optional(),
  excluded: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const mappingBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target"), accountId: z.uuid() }).strict(),
  z.object({
    kind: z.literal("create"), name: z.string().trim().min(1).max(200),
    type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
]);
const excludeBody = z.object({ excluded: z.boolean() }).strict();

/** Bulk map: only "an existing account" or "clear". Creating many accounts goes through auto-map. */
const bulkMappingBody = z.object({
  accountIds: z.array(z.uuid()).min(1).max(200),
  decision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("target"), accountId: z.uuid() }).strict(),
    z.object({ kind: z.literal("clear") }).strict(),
  ]),
}).strict();
const entryFilterBody = z.object({
  status: z.enum(["valid", "invalid", "skipped"]).optional(),
  excluded: z.boolean().optional(),
  search: z.string().trim().max(200).optional(),
}).strict();
/** Exactly one of `ids` (the rows ticked) or `filter` (everything matching a view). */
const bulkExcludeBody = z.object({
  excluded: z.boolean(),
  ids: z.array(z.uuid()).min(1).max(5000).optional(),
  filter: entryFilterBody.optional(),
}).strict().refine((b) => (b.ids === undefined) !== (b.filter === undefined), { message: "send either ids or filter, not both" });

export async function importRoutes(
  app: FastifyInstance, opts: { pool: Pool; config: ApiConfig },
): Promise<void> {
  const { pool, config } = opts;
  const maxBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const base = "/api/businesses/:id/imports";

  // Scoped to this plugin: other routes keep rejecting multipart bodies.
  await app.register(fastifyMultipart, {
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2, headerPairs: 32 },
  });

  // Upload a file and stage it. The file is parsed in memory and NOT kept; only the parsed rows are stored.
  app.post(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);

    // Role first, query second, body last: a viewer learns nothing and cannot make us buffer an upload.
    await withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, async () => undefined);
    uploadQuery.parse(request.query);

    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "Expected multipart/form-data with one file" });
    }
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "No file was uploaded" });
    const data = await part.toBuffer(); // throws a 413 past the size limit
    if (part.file.truncated) return reply.code(413).send({ error: `File exceeds ${maxBytes} bytes` });
    if (data.length === 0) return reply.code(400).send({ error: "File is empty" });

    const claimed = part.mimetype.split(";")[0]!.trim().toLowerCase();
    if (!CSV_CLAIMS.has(claimed) || detectContentType(data) !== "text/csv") {
      return reply.code(415).send({ error: "Expected a CSV export" });
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return reply.code(422).send({ error: "The file is not valid UTF-8 text" });
    }

    let parsed;
    try {
      parsed = parseWaveJournal(text);
    } catch (err) {
      if (err instanceof WaveFormatError) return reply.code(422).send({ error: err.message });
      // CsvError text may quote file content, so it is not echoed.
      if (err instanceof CsvError) return reply.code(422).send({ error: "The file is not a readable CSV" });
      throw err;
    }

    const sha256 = createHash("sha256").update(data).digest("hex");
    const input = toStageInput(parsed, sha256);
    const result = await withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, (c) => stageBatch(c, id, user.id, input));
    return reply.code(201).send(result);
  });

  app.get(base, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    const q = listQuery.parse(request.query);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({ batches: await listBatches(c, id, q) }));
  });

  app.get(`${base}/:bid`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, (c) => getBatch(c, id, bid));
  });

  // Entries, now with an optional text search and the total that matches (so the screen can offer "select all N").
  app.get(`${base}/:bid/entries`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    const q = entriesQuery.parse(request.query);
    return withMembership(pool, user.id, id, ALL_ROLES, (c) => searchImportEntries(c, id, bid, q));
  });

  app.put(`${base}/:bid/accounts/:aid/mapping`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid, aid } = acctParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, async (c) => {
      const body = mappingBody.parse(request.body);
      return { account: await setAccountMapping(c, id, user.id, bid, aid, body) };
    });
  });

  // Decide every undecided account at once: match an existing one or queue a new one. Nothing is created until approval.
  app.post(`${base}/:bid/accounts/auto-map`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, (c) => autoMapImportAccounts(c, id, user.id, bid));
  });

  // Map or clear several accounts together. All or none.
  app.post(`${base}/:bid/accounts/mapping`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, async (c) => {
      const body = bulkMappingBody.parse(request.body);
      return setImportAccountsMapping(c, id, user.id, bid, body.accountIds, body.decision);
    });
  });

  app.patch(`${base}/:bid/entries/:eid`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid, eid } = entryParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, async (c) => {
      const body = excludeBody.parse(request.body);
      return setEntryExcluded(c, id, user.id, bid, eid, body.excluded);
    });
  });

  // Exclude or include many entries: the ticked ids, or everything matching a filter.
  app.post(`${base}/:bid/entries/exclude`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, async (c) => {
      const body = bulkExcludeBody.parse(request.body);
      const target = body.ids ? { ids: body.ids } : { filter: body.filter ?? {} };
      return setImportEntriesExcluded(c, id, user.id, bid, target, body.excluded);
    });
  });

  app.post(`${base}/:bid/approve`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, (c) => approveBatch(c, id, user.id, bid));
  });

  app.post(`${base}/:bid/reject`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, bid } = batchParams.parse(request.params);
    return withMembership(pool, user.id, id, IMPORT_WRITER_ROLES, (c) => rejectBatch(c, id, user.id, bid));
  });
}
