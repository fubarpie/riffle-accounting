import { randomBytes } from "node:crypto";
import {
  createBusiness, createConnection, linkAccount, parseKeyring, uuidv7, withTenant,
  type Keyring,
} from "@riffle/db";
import type { FetchLike } from "@riffle/simplefin";
import pg from "pg";
import type { ImportDeps, Logger } from "../src/import";
import { pgConnectionSource, type ConnectionSource, type WorkerConnection } from "../src/source";

/** Owner pool: fixtures and assertions only. */
export const admin = new pg.Pool({ connectionString: process.env["TEST_ADMIN_URL"], max: 3 });
/** Application pool: riffle_app, subject to RLS, exactly like the worker. */
export const app = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 12 });

export const closePools = (): Promise<void[]> => Promise.all([admin.end(), app.end()]);

export const SECRET_PASS = "s3cretpass";
export const keyring: Keyring = parseKeyring(`1:${randomBytes(32).toString("base64")}`);

let seq = 0;
export interface Fixture {
  userId: string;
  businessId: string;
  connectionId: string;
  accessUrl: string;
  /** Host of the access URL, so a mock fetch can tell connections apart. */
  host: string;
  ledger: string[];
}

/** A business with one connection. `links` are the provider account ids to link (default: ACT-1). */
export async function makeFixture(o: { links?: string[]; status?: "active" | "disabled" } = {}): Promise<Fixture> {
  const userId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [userId, `w-${userId}@example.test`, "worker"]);
  const businessId = await createBusiness(app, userId, { name: `Biz ${uuidv7()}`, currency: "USD" });
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM accounts WHERE business_id = $1 AND code IN ('1010','1020','2010') ORDER BY code", [businessId]);
  const ledger = rows.map((r) => r.id);
  const host = `bridge-${++seq}-${uuidv7().slice(-8)}.test`;
  const accessUrl = `https://user:${SECRET_PASS}@${host}/simplefin`;
  const ctx = { userId, businessId };
  const conn = await withTenant(app, ctx, (c) =>
    createConnection(c, businessId, userId, { label: "Bank", accessUrl, scheduleMinute: 7 }, keyring));
  const ext = o.links ?? ["ACT-1"];
  for (const [i, externalAccountId] of ext.entries()) {
    await withTenant(app, ctx, (c) => linkAccount(c, businessId, userId, {
      connectionId: conn.id, externalAccountId, externalName: externalAccountId, accountId: ledger[i % ledger.length]!,
    }));
  }
  if (o.status === "disabled") {
    await admin.query("UPDATE bank_connections SET status = 'disabled' WHERE id = $1", [conn.id]);
  }
  return { userId, businessId, connectionId: conn.id, accessUrl, host, ledger };
}

export interface Tx { id: string; amount?: string; description?: string; ageDays?: number }
export interface Acct { id: string; txs?: Tx[] }

/** An Account Set body as SimpleFIN serves it. */
export function accountSet(accounts: Acct[], errlist: { code: string; msg: string }[] = []): object {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    errlist,
    accounts: accounts.map((a) => ({
      id: a.id, name: `Name ${a.id}`, currency: "USD", balance: "100.00", "balance-date": nowSec,
      transactions: (a.txs ?? []).map((t) => ({
        id: t.id, posted: nowSec - Math.round((t.ageDays ?? 1) * 86_400),
        amount: t.amount ?? "-12.50", description: t.description ?? "COFFEE SHOP",
      })),
    })),
  };
}

export const json = (body: object, status = 200): Response => Response.json(body, { status });

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Mock fetch that records every request URL. */
export function mockFetch(handler: Handler): FetchLike & { calls: URL[] } {
  const calls: URL[] = [];
  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    calls.push(u);
    return handler(u, init);
  };
  return Object.assign(f, { calls });
}

/** Captures log lines so tests can assert nothing sensitive was written. */
export function captureLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (msg: string, f?: Record<string, unknown>) => { lines.push(JSON.stringify({ level, msg, ...f })); };
  return { lines, info: add("info"), warn: add("warn"), error: add("error") };
}

export function makeDeps(over: Partial<ImportDeps> = {}): ImportDeps {
  return { pool: app, source: pgConnectionSource(app), keyring, retryMs: 6 * 3_600_000, log: captureLog(), ...over };
}

/** The shared database holds other tests' connections: only ever look at our own. */
export function scopedSource(ids: string[], inner: ConnectionSource = pgConnectionSource(app)): ConnectionSource & { gets: string[] } {
  const gets: string[] = [];
  const set = new Set(ids);
  return {
    gets,
    list: async () => (await inner.list()).filter((c: WorkerConnection) => set.has(c.id)),
    get: async (id) => { gets.push(id); return set.has(id) ? inner.get(id) : undefined; },
  };
}

export async function connRow(id: string) {
  const { rows } = await admin.query<{
    status: string; last_error: string | null; last_synced_at: Date | null; updated_at: Date;
  }>("SELECT status, last_error, last_synced_at, updated_at FROM bank_connections WHERE id = $1", [id]);
  return rows[0]!;
}

export async function stagedFor(connectionId: string) {
  const { rows } = await admin.query<{
    external_id: string; amount_minor: string; pending: boolean; status: string; raw: Record<string, unknown>; link_id: string;
  }>("SELECT external_id, amount_minor, pending, status, raw, link_id FROM staged_transactions WHERE connection_id = $1 ORDER BY external_id", [connectionId]);
  return rows;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds. */
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
