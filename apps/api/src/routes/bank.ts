// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BANK_WRITER_ROLES, BankInputError, ConnectionDisabledError, createConnection, getAccessUrl, getConnection,
  getStaged, importBatch, linkAccount, listConnections, listLinks, listStaged, postStaged, recordSyncResult,
  updateConnection, updateStaged, withMembership,
  type BankConnection, type Keyring, type MembershipRole, type ParsedTransaction, type StagedTransaction,
} from "@riffle/db";
import {
  computeFetchRange, createSimpleFinAdapter, fetchAccounts, type FetchLike, type SimpleFinAccount,
  type SimpleFinWarning, SimpleFinError,
} from "@riffle/simplefin";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../auth-plugin";
import type { ApiConfig } from "../config";
import { Conflict, NotFound, RateLimited, Unavailable } from "../errors";

const ALL_ROLES: readonly MembershipRole[] = ["owner", "admin", "bookkeeper", "viewer"];

const bizParams = z.object({ id: z.uuid() });
const connParams = z.object({ id: z.uuid(), connId: z.uuid() });
const linkParams = z.object({ id: z.uuid(), connId: z.uuid(), externalAccountId: z.string().min(1).max(200) });
const stagedParams = z.object({ id: z.uuid(), stagedId: z.uuid() });

const claimBody = z.object({
  setupToken: z.string().trim().min(1).max(4096),
  label: z.string().trim().min(1).max(120),
}).strict();
const linkBody = z.object({ accountId: z.uuid() }).strict();
const approveBody = z.object({ categoryAccountId: z.uuid().optional() }).strict();
const stagedQuery = z.object({
  status: z.enum(["new", "approved", "ignored", "posted"]).optional(),
  connectionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();
const MAX_BULK = 100;
const bulkBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"), ids: z.array(z.uuid()).min(1).max(MAX_BULK),
    categoryAccountId: z.uuid().optional(),
  }).strict(),
  z.object({ action: z.literal("reject"), ids: z.array(z.uuid()).min(1).max(MAX_BULK) }).strict(),
]);

/** bigint cannot be JSON-serialised; money goes out as a decimal string of minor units. */
const staged = (s: StagedTransaction) => ({ ...s, amountMinor: s.amountMinor.toString() });

interface Discovered {
  externalAccountId: string;
  name: string;
  currency: string;
  balanceMinor: string;
  balanceDate: string;
}
const toDiscovered = (a: SimpleFinAccount): Discovered => ({
  externalAccountId: a.id, name: a.name, currency: a.currency,
  balanceMinor: String(a.balanceMinor), balanceDate: a.balanceDate.toISOString(),
});
const warningView = (w: SimpleFinWarning) => ({
  kind: w.kind, code: w.code, message: w.message,
  ...(w.connectionId !== undefined && { connectionId: w.connectionId }),
  ...(w.accountId !== undefined && { accountId: w.accountId }),
});

export async function bankRoutes(
  app: FastifyInstance, opts: { pool: Pool; config: ApiConfig; fetchImpl: FetchLike },
): Promise<void> {
  const { pool, config, fetchImpl } = opts;
  const minIntervalMs = config.bankImportMinIntervalMs ?? 3_600_000;
  const adapter = createSimpleFinAdapter(fetchImpl);
  const base = "/api/businesses/:id/bank";

  // Per-process state. The durable rate limit is bank_connections.last_synced_at; these
  // additionally cover failed attempts and concurrent requests within this process.
  const lastAttempt = new Map<string, number>();
  const inFlight = new Set<string>();
  const discovered = new Map<string, Discovered[]>();
  const cacheKey = (biz: string, conn: string) => `${biz}:${conn}`;

  const keyringOrThrow = (): Keyring => {
    if (!config.keyring) throw new Unavailable("Bank import is not configured (RIFFLE_SECRET_KEY is not set)");
    return config.keyring;
  };

  /** Live balances-only style fetch: a zero-width window returns balances, no transactions. */
  async function discover(accessUrl: string): Promise<{ accounts: Discovered[]; warnings: SimpleFinWarning[] }> {
    const now = new Date();
    const set = await fetchAccounts(accessUrl, { startDate: now, endDate: now }, fetchImpl);
    return { accounts: set.accounts.map(toDiscovered), warnings: set.warnings };
  }

  // ------------------------------------------------------------ connections
  app.post(`${base}/connections`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    const keyring = keyringOrThrow();
    // Role first, so a viewer learns nothing and — crucially — never burns a one-time setup token.
    await withMembership(pool, user.id, id, BANK_WRITER_ROLES, async () => undefined);
    const body = claimBody.parse(request.body);
    // The token is single-use: claim exactly once, never retry, never log it.
    const accessUrl = await adapter.claim(body.setupToken);
    const connection = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, (c) =>
      createConnection(c, id, user.id, { label: body.label, accessUrl }, keyring));
    return reply.code(201).send({ connection });
  });

  app.get(`${base}/connections`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => ({ connections: await listConnections(c, id) }));
  });

  // Disconnect: connections are never deleted (audit trail); disabling stops all imports.
  app.delete(`${base}/connections/:connId`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, connId } = connParams.parse(request.params);
    const connection = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, (c) =>
      updateConnection(c, id, user.id, connId, { status: "disabled" }));
    if (!connection) throw new NotFound();
    discovered.delete(cacheKey(id, connId));
    return { connection };
  });

  // --------------------------------------------------------------- accounts
  app.post(`${base}/connections/:connId/sync-accounts`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, connId } = connParams.parse(request.params);
    const keyring = keyringOrThrow();
    const accessUrl = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
      const conn = await getConnection(c, id, connId);
      if (!conn) throw new NotFound();
      if (conn.status === "disabled") throw new ConnectionDisabledError();
      return getAccessUrl(c, id, connId, keyring);
    });
    const found = await discover(accessUrl);
    discovered.set(cacheKey(id, connId), found.accounts);
    const links = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, (c) => listLinks(c, id, connId));
    return { accounts: merge(found.accounts, links), warnings: found.warnings.map(warningView) };
  });

  app.get(`${base}/connections/:connId/accounts`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, connId } = connParams.parse(request.params);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      if (!(await getConnection(c, id, connId))) throw new NotFound();
      const links = await listLinks(c, id, connId);
      return { accounts: merge(discovered.get(cacheKey(id, connId)) ?? [], links) };
    });
  });

  app.put(`${base}/connections/:connId/links/:externalAccountId`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, connId, externalAccountId } = linkParams.parse(request.params);
    const keyring = keyringOrThrow();
    // Phase 1 (read): role, connection, target account and the provider's own view of the account.
    const prep = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
      const body = linkBody.parse(request.body);
      const conn = await getConnection(c, id, connId);
      if (!conn) throw new NotFound();
      const { rows } = await c.query<{ currency: string }>(
        "SELECT currency FROM accounts WHERE business_id = $1 AND id = $2", [id, body.accountId]);
      if (!rows[0]) throw new BankInputError("ledger account not found");
      const accessUrl = discovered.has(cacheKey(id, connId)) ? null : await getAccessUrl(c, id, connId, keyring);
      return { accountId: body.accountId, ledgerCurrency: rows[0].currency.trim(), accessUrl };
    });
    let known = discovered.get(cacheKey(id, connId));
    if (!known) {
      known = (await discover(prep.accessUrl!)).accounts;
      discovered.set(cacheKey(id, connId), known);
    }
    const ext = known.find((a) => a.externalAccountId === externalAccountId);
    if (!ext) throw new BankInputError("unknown bank account for this connection; run sync-accounts first");
    if (ext.currency.toUpperCase() !== prep.ledgerCurrency.toUpperCase()) {
      throw new BankInputError(
        `currency mismatch: bank account is ${ext.currency}, ledger account is ${prep.ledgerCurrency}`);
    }
    const link = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, (c) =>
      linkAccount(c, id, user.id, {
        connectionId: connId, externalAccountId, externalName: ext.name, accountId: prep.accountId,
      }));
    return { link };
  });

  // ----------------------------------------------------------------- staged
  app.get(`${base}/staged`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    const q = stagedQuery.parse(request.query);
    return withMembership(pool, user.id, id, ALL_ROLES, async (c) => {
      const items = await listStaged(c, id, {
        ...(q.status && { status: q.status }), ...(q.connectionId && { connectionId: q.connectionId }),
        limit: q.limit, offset: q.offset,
      });
      return { items: items.map(staged), limit: q.limit, offset: q.offset };
    });
  });

  app.post(`${base}/staged/bulk`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id } = bizParams.parse(request.params);
    return withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
      const body = bulkBody.parse(request.body);
      const results: Array<{ id: string; ok: boolean; transactionId?: string; error?: string }> = [];
      // Each item runs in its own savepoint: one bad row neither poisons the transaction nor blocks the rest.
      for (const [i, stagedId] of [...new Set(body.ids)].entries()) {
        const sp = `bulk_${i}`;
        await c.query(`SAVEPOINT ${sp}`);
        try {
          if (body.action === "approve") {
            const r = await postStaged(c, id, user.id, stagedId,
              body.categoryAccountId ? { categoryAccountId: body.categoryAccountId } : {});
            results.push({ id: stagedId, ok: true, transactionId: r.transactionId });
          } else {
            await updateStaged(c, id, user.id, stagedId, { status: "ignored" });
            results.push({ id: stagedId, ok: true });
          }
          await c.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (err) {
          await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          if (!isDomainError(err)) throw err;
          results.push({ id: stagedId, ok: false, error: (err as Error).message });
        }
      }
      return { action: body.action, succeeded: results.filter((r) => r.ok).length, results };
    });
  });

  app.post(`${base}/staged/:stagedId/approve`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, stagedId } = stagedParams.parse(request.params);
    return withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
      const body = approveBody.parse(request.body ?? {});
      const result = await postStaged(c, id, user.id, stagedId,
        body.categoryAccountId ? { categoryAccountId: body.categoryAccountId } : {});
      const row = await getStaged(c, id, stagedId);
      return { result, staged: row ? staged(row) : null };
    });
  });

  app.post(`${base}/staged/:stagedId/reject`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, stagedId } = stagedParams.parse(request.params);
    return withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => ({
      staged: staged(await updateStaged(c, id, user.id, stagedId, { status: "ignored" })),
    }));
  });

  // ------------------------------------------------------------- import now
  app.post(`${base}/connections/:connId/import-now`, async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const { id, connId } = connParams.parse(request.params);
    const keyring = keyringOrThrow();
    const key = cacheKey(id, connId);
    if (inFlight.has(key)) throw new Conflict("An import for this connection is already running");

    const prep = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
      const conn = await getConnection(c, id, connId);
      if (!conn) throw new NotFound();
      if (conn.status === "disabled") throw new ConnectionDisabledError();
      const links = await listLinks(c, id, connId);
      if (links.length === 0) throw new BankInputError("link at least one bank account before importing");
      const wait = secondsUntilAllowed(conn, lastAttempt.get(key), minIntervalMs);
      if (wait > 0) throw new RateLimited(wait);
      return { conn, links, accessUrl: await getAccessUrl(c, id, connId, keyring) };
    });

    inFlight.add(key);
    lastAttempt.set(key, Date.now());
    try {
      const now = new Date();
      let set;
      try {
        set = await adapter.fetchRange(
          prep.accessUrl,
          computeFetchRange(prep.conn.lastSyncedAt ? new Date(prep.conn.lastSyncedAt) : null, now),
          { pending: true, accountIds: prep.links.map((l) => l.externalAccountId) });
      } catch (err) {
        if (err instanceof SimpleFinError) {
          await withMembership(pool, user.id, id, BANK_WRITER_ROLES, (c) =>
            recordSyncResult(c, id, user.id, connId, { ok: false, error: err.message }));
        }
        throw err; // mapped by the error handler (429 / 502 with the SimpleFIN message)
      }

      const txns: ParsedTransaction[] = set.accounts.flatMap((a) => a.transactions.map((t) => ({
        externalAccountId: a.id,
        externalId: t.id,
        postedDate: (t.postedAt ?? now).toISOString().slice(0, 10),
        amountMinor: BigInt(t.amountMinor),
        description: t.description,
        pending: t.pending,
        raw: { id: t.id, posted: t.postedAt?.toISOString() ?? null, pending: t.pending },
      })));
      const authProblem = set.warnings.find((w) => w.kind === "auth" || w.kind === "connection");
      const { result, connection } = await withMembership(pool, user.id, id, BANK_WRITER_ROLES, async (c) => {
        const r = await importBatch(c, id, user.id, connId, txns);
        const conn = await recordSyncResult(c, id, user.id, connId,
          authProblem ? { ok: false, error: authProblem.message } : { ok: true });
        return { result: r, connection: conn! };
      });
      return { result, connection, warnings: set.warnings.map(warningView) };
    } finally {
      inFlight.delete(key);
    }
  });
}

function merge(found: Discovered[], links: Array<{ externalAccountId: string; externalName: string; accountId: string }>) {
  const byExt = new Map(links.map((l) => [l.externalAccountId, l]));
  const out = found.map((a) => ({ ...a, linkedAccountId: byExt.get(a.externalAccountId)?.accountId ?? null }));
  // Links whose provider account was not seen recently still show up.
  for (const l of links) {
    if (!found.some((a) => a.externalAccountId === l.externalAccountId)) {
      out.push({
        externalAccountId: l.externalAccountId, name: l.externalName, currency: "", balanceMinor: "",
        balanceDate: "", linkedAccountId: l.accountId,
      });
    }
  }
  return out;
}

/** Seconds until another import is allowed (0 = now). Uses the later of last success and last attempt. */
function secondsUntilAllowed(conn: BankConnection, attemptMs: number | undefined, minIntervalMs: number): number {
  const last = Math.max(conn.lastSyncedAt ? Date.parse(conn.lastSyncedAt) : 0, attemptMs ?? 0);
  if (last === 0) return 0;
  return Math.max(0, Math.ceil((last + minIntervalMs - Date.now()) / 1000));
}

/** Per-item failures that a bulk call reports rather than aborts on. */
function isDomainError(err: unknown): boolean {
  const n = (err as Error)?.name;
  return n === "StagedStateError" || n === "BankInputError" || n === "NotFoundError"
    || n === "BooksLockedError" || n === "LedgerInputError";
}
