// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BankAccountLink,
  type Keyring,
  type ParsedTransaction,
  BankInputError,
  ConnectionDisabledError,
  MAX_IMPORT_BATCH,
  SecretError,
  getAccessUrl,
  getConnection,
  importBatch,
  listLinks,
  recordSyncResult,
  updateConnection,
  withTenant,
} from "@riffle/db";
import {
  type FetchLike,
  type SimpleFinAccount,
  type SimpleFinWarning,
  DAY_MS,
  MAX_WINDOW_DAYS,
  SimpleFinAccessRevokedError,
  SimpleFinError,
  SimpleFinRateLimitedError,
  computeFetchRange,
  createSimpleFinAdapter,
} from "@riffle/simplefin";
import type { Pool, PoolClient } from "pg";
import { isDue } from "./due";
import type { ConnectionSource, WorkerConnection } from "./source";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (m, f) => console.log(JSON.stringify({ level: "info", msg: m, ...f })),
  warn: (m, f) => console.warn(JSON.stringify({ level: "warn", msg: m, ...f })),
  error: (m, f) => console.error(JSON.stringify({ level: "error", msg: m, ...f })),
};

export interface ImportDeps {
  /** Pool connecting as the restricted riffle_app role (RLS applies). */
  pool: Pool;
  source: ConnectionSource;
  keyring: Keyring;
  fetch?: FetchLike;
  now?: () => Date;
  log?: Logger;
  /** Aborts in-flight SimpleFIN requests on shutdown. */
  signal?: AbortSignal;
  /** Failed connections are retried after this long; used only with `onlyIfDue`. */
  retryMs?: number;
}

export interface ImportOptions {
  /** Re-check dueness after taking the lock (scheduler). Manual runs skip it. */
  onlyIfDue?: boolean;
}

export type ImportStatus =
  | "imported" // fetched and staged; last_synced_at advanced (possibly with warnings)
  | "partial" // some linked accounts could not be staged; last_synced_at NOT advanced
  | "failed" // nothing imported; error recorded on the connection
  | "skipped" // disabled, or no linked accounts yet
  | "not_due"
  | "locked" // another worker replica is importing this connection
  | "not_found";

export interface ImportOutcome {
  status: ImportStatus;
  reason?: string;
  inserted: number;
  duplicate: number;
  updated: number;
  /** Provider account ids returned by SimpleFIN that have no link (not imported). */
  unlinkedAccounts: string[];
  accountErrors: { accountId: string; message: string }[];
  /** Messages from the SimpleFIN errlist, as stored on the connection. */
  warnings: string[];
  /** The access URL was revoked (402/403); the connection was disabled. */
  disabled: boolean;
  /** Ask the scheduler to stop calling SimpleFIN for this long (rate limiting). */
  retryAfterMs?: number;
}

const empty = (status: ImportStatus, reason?: string): ImportOutcome => ({
  status, ...(reason !== undefined && { reason }),
  inserted: 0, duplicate: 0, updated: 0, unlinkedAccounts: [], accountErrors: [], warnings: [], disabled: false,
});

const DEFAULT_RETRY_MS = 6 * 3_600_000;
const DEFAULT_BACKOFF_MS = 3_600_000;
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|daily (request )?limit|quota/i;

/** Strip anything URL-shaped (could carry credentials) and bound the length. */
export function sanitizeMessage(s: string, max = 200): string {
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim().slice(0, max);
}

function describeWarnings(ws: readonly SimpleFinWarning[]): string[] {
  return ws.map((w) => `${sanitizeMessage(w.code, 40)}: ${sanitizeMessage(w.message)}`);
}

/** Compose the text for `last_error`. The database column holds at most 1000 characters. */
function joinMessages(prefix: string | undefined, items: readonly string[]): string {
  const shown = items.slice(0, 5);
  const more = items.length > shown.length ? ` (+${items.length - shown.length} more)` : "";
  return [prefix, shown.join("; ") + more].filter((x) => x && x.trim() !== "").join(" - ").slice(0, 1000);
}

/** Never leak error text we do not control: only typed client errors are echoed. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof SimpleFinError) return sanitizeMessage(err.message);
  if (err instanceof SecretError) return "Stored credentials could not be decrypted (check RIFFLE_SECRET_KEY)";
  if (err instanceof Error && err.name === "AbortError") return "Import aborted (shutting down)";
  return `Unexpected error (${err instanceof Error ? err.name : "unknown"})`;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * SimpleFIN transaction -> store shape. Returns an error string for rows the
 * store could not represent. The raw payload keeps provider facts only; it
 * never contains the access URL.
 */
function mapTransaction(
  a: SimpleFinAccount, t: SimpleFinAccount["transactions"][number], now: Date,
): ParsedTransaction | string {
  if (!Number.isSafeInteger(t.amountMinor)) return "amount out of range";
  return {
    externalAccountId: a.id,
    externalId: t.id,
    // A pending item has no posted time yet: use the fetch date as the best known date.
    postedDate: isoDate(t.postedAt ?? now),
    amountMinor: BigInt(t.amountMinor),
    description: t.description,
    pending: t.pending,
    raw: {
      provider: "simplefin",
      accountName: a.name,
      currency: a.currency,
      postedAt: t.postedAt ? t.postedAt.toISOString() : null,
    },
  };
}

/** Session-level advisory lock; every replica hashes the same id to the same key. */
const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
const lockName = (id: string) => `riffle:bank_import:${id}`;

/**
 * Import one connection: decrypt the access URL, fetch the window, stage
 * transactions for linked accounts, and record the result on the connection.
 *
 * Mutual exclusion across replicas uses a session advisory lock held on a
 * dedicated client for the whole run. (A row lock would pin an open
 * transaction across a network call; this does not.) The lock is
 * try-acquired, so a second replica gets `locked` instead of waiting.
 */
export async function importConnection(
  deps: ImportDeps, connectionId: string, opts: ImportOptions = {},
): Promise<ImportOutcome> {
  const lockClient = await deps.pool.connect();
  let discard = false;
  try {
    const { rows } = await lockClient.query<{ ok: boolean }>(LOCK_SQL, [lockName(connectionId)]);
    if (!rows[0]?.ok) return empty("locked");
    try {
      return await runLocked(deps, connectionId, opts);
    } finally {
      try {
        await lockClient.query(UNLOCK_SQL, [lockName(connectionId)]);
      } catch {
        discard = true; // dropping the session releases the lock
      }
    }
  } catch (err) {
    discard = true;
    throw err;
  } finally {
    lockClient.release(discard);
  }
}

async function runLocked(deps: ImportDeps, connectionId: string, opts: ImportOptions): Promise<ImportOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? consoleLogger;
  const conn = await deps.source.get(connectionId);
  if (!conn) return empty("not_found");
  if (conn.status === "disabled") return empty("skipped", "connection is disabled");
  // Another replica may have finished this connection between our listing and our lock.
  if (opts.onlyIfDue && !isDue(conn, now, deps.retryMs ?? DEFAULT_RETRY_MS)) return empty("not_due");

  const ctx = { userId: conn.createdBy, businessId: conn.businessId };

  // 1. Read what we need, then release the transaction before touching the network.
  let accessUrl: string;
  let links: BankAccountLink[];
  let lastSyncedAt: Date | null;
  try {
    const prep = await withTenant(deps.pool, ctx, async (c) => {
      const fresh = await getConnection(c, conn.businessId, conn.id);
      if (!fresh) return undefined;
      const l = await listLinks(c, conn.businessId, conn.id);
      // No point decrypting, or calling the bank, when nothing is linked.
      const url = l.length === 0 ? "" : await getAccessUrl(c, conn.businessId, conn.id, deps.keyring);
      return { fresh, links: l, url };
    });
    if (!prep) return empty("not_found");
    if (prep.fresh.status === "disabled") return empty("skipped", "connection is disabled");
    if (prep.links.length === 0) {
      // Deliberately not recorded as a sync: advancing last_synced_at would shrink the
      // window and lose history for accounts linked later.
      return empty("skipped", "no linked accounts");
    }
    accessUrl = prep.url;
    links = prep.links;
    lastSyncedAt = prep.fresh.lastSyncedAt ? new Date(prep.fresh.lastSyncedAt) : null;
  } catch (err) {
    return fail(deps, conn, safeErrorMessage(err), { disable: false });
  }

  // 2. Fetch: last success minus 5 days, at most 90 days. If an account was linked after
  // the last sync, its earlier history was skipped as unlinked, so take the full window.
  let range = computeFetchRange(lastSyncedAt, now);
  if (lastSyncedAt && links.some((l) => new Date(l.createdAt) > lastSyncedAt!)) {
    range = { start: new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS), end: range.end };
  }
  let set;
  try {
    set = await createSimpleFinAdapter(deps.fetch ?? fetch).fetchRange(accessUrl, range, {
      pending: true,
      ...(deps.signal && { signal: deps.signal }),
    });
  } catch (err) {
    if (err instanceof SimpleFinAccessRevokedError) {
      log.warn("simplefin access revoked; disabling connection", { connectionId });
      return fail(deps, conn, "SimpleFIN access was revoked or disabled. Re-authorize: create a new setup token and replace the connection's access URL.", { disable: true });
    }
    if (err instanceof SimpleFinRateLimitedError) {
      const retryAfterMs = (err.retryAfterSeconds ?? DEFAULT_BACKOFF_MS / 1000) * 1000;
      return fail(deps, conn, "SimpleFIN rate limit reached; will retry later", { disable: false, retryAfterMs });
    }
    return fail(deps, conn, safeErrorMessage(err), { disable: false });
  }

  // 3. Stage per account inside savepoints so one bad account cannot sink the rest.
  const linkByExternal = new Map(links.map((l) => [l.externalAccountId, l]));
  const warnings = describeWarnings(set.warnings);
  const authProblem = set.warnings.some((w) => w.kind === "auth");
  const rateLimited = set.warnings.some((w) => RATE_LIMIT_TEXT.test(w.message) || RATE_LIMIT_TEXT.test(w.code));
  const out = empty("imported");
  out.warnings = warnings;
  if (rateLimited) out.retryAfterMs = DEFAULT_BACKOFF_MS;

  try {
    await withTenant(deps.pool, ctx, async (c) => {
      for (const account of set.accounts) {
        if (!linkByExternal.has(account.id)) {
          out.unlinkedAccounts.push(account.id);
          continue;
        }
        await stageAccount(c, conn, account, now, out);
      }
      const problems = [
        ...out.accountErrors.map((e) => `account ${sanitizeMessage(e.accountId, 40)}: ${e.message}`),
        ...warnings,
      ];
      if (out.accountErrors.length > 0 || authProblem) {
        out.status = "partial";
        const prefix = authProblem ? "SimpleFIN needs re-authentication at the bank" : "Some accounts failed to import";
        await recordSyncResult(c, conn.businessId, conn.createdBy, conn.id, { ok: false, error: joinMessages(prefix, problems) });
      } else {
        await recordSyncResult(c, conn.businessId, conn.createdBy, conn.id, { ok: true });
        if (warnings.length > 0) {
          // Informational: keep the sync a success but leave the bank's messages visible.
          await c.query(
            "UPDATE bank_connections SET last_error = $3 WHERE business_id = $1 AND id = $2",
            [conn.businessId, conn.id, joinMessages("SimpleFIN reported", warnings)],
          );
        }
      }
    });
  } catch (err) {
    if (err instanceof ConnectionDisabledError) return empty("skipped", "connection is disabled");
    return fail(deps, conn, safeErrorMessage(err), { disable: false });
  }

  log.info("simplefin import finished", {
    connectionId, status: out.status, inserted: out.inserted, duplicate: out.duplicate, updated: out.updated,
    unlinkedAccounts: out.unlinkedAccounts.length, accountErrors: out.accountErrors.length, warnings: warnings.length,
  });
  return out;
}

async function stageAccount(
  c: PoolClient, conn: WorkerConnection, account: SimpleFinAccount, now: Date, out: ImportOutcome,
): Promise<void> {
  const parsed: ParsedTransaction[] = [];
  let skippedRows = 0;
  for (const t of account.transactions) {
    const m = mapTransaction(account, t, now);
    if (typeof m === "string") skippedRows++;
    else parsed.push(m);
  }
  await c.query("SAVEPOINT import_account");
  try {
    for (let i = 0; i < parsed.length; i += MAX_IMPORT_BATCH) {
      const r = await importBatch(c, conn.businessId, conn.createdBy, conn.id, parsed.slice(i, i + MAX_IMPORT_BATCH));
      out.inserted += r.inserted;
      out.duplicate += r.duplicate;
      out.updated += r.updated;
    }
    await c.query("RELEASE SAVEPOINT import_account");
  } catch (err) {
    if (err instanceof ConnectionDisabledError) throw err;
    await c.query("ROLLBACK TO SAVEPOINT import_account");
    await c.query("RELEASE SAVEPOINT import_account");
    out.accountErrors.push({
      accountId: account.id,
      message: err instanceof BankInputError ? sanitizeMessage(err.message) : `database error (${err instanceof Error ? err.name : "unknown"})`,
    });
    return;
  }
  if (skippedRows > 0) {
    out.accountErrors.push({ accountId: account.id, message: `${skippedRows} transaction(s) had unusable amounts and were skipped` });
  }
}

/** Record a failed attempt (and optionally disable the connection) in its own transaction. */
async function fail(
  deps: ImportDeps, conn: WorkerConnection, message: string,
  o: { disable: boolean; retryAfterMs?: number },
): Promise<ImportOutcome> {
  const log = deps.log ?? consoleLogger;
  const ctx = { userId: conn.createdBy, businessId: conn.businessId };
  try {
    await withTenant(deps.pool, ctx, async (c) => {
      await recordSyncResult(c, conn.businessId, conn.createdBy, conn.id, { ok: false, error: message });
      if (o.disable) await updateConnection(c, conn.businessId, conn.createdBy, conn.id, { status: "disabled" });
    });
  } catch (err) {
    log.error("could not record import failure", { connectionId: conn.id, error: err instanceof Error ? err.name : "unknown" });
  }
  log.warn("simplefin import failed", { connectionId: conn.id, reason: message, disabled: o.disable });
  const out = empty("failed", message);
  out.disabled = o.disable;
  if (o.retryAfterMs !== undefined) out.retryAfterMs = o.retryAfterMs;
  return out;
}
