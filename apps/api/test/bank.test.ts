import { randomBytes } from "node:crypto";
import { parseKeyring } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";

const admin = new pg.Pool({ connectionString: process.env["TEST_ADMIN_URL"], max: 2 });
const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });
let app: FastifyInstance;

// ---------------------------------------------------------------- mock SimpleFIN
const SECRET_PASS = "s3cretpass";
const ACCESS_URL = `https://user:${SECRET_PASS}@bridge.test/simplefin`;
const claimed = new Set<string>();
let nowSec = Math.floor(Date.now() / 1000);
let accountSet: object;
let errlist: object[] = [];
const requests: string[] = [];

const tokenFor = (name: string) => Buffer.from(`https://bridge.test/claim/${name}`).toString("base64");

function resetAccountSet() {
  errlist = [];
  accountSet = {
    accounts: [
      {
        id: "ACT-USD", name: "Checking", currency: "USD", balance: "1000.00", "balance-date": nowSec,
        transactions: [
          { id: "T-1", posted: nowSec - 86_400, amount: "-12.50", description: "COFFEE SHOP" },
          { id: "T-2", posted: nowSec - 86_400, amount: "250.00", description: "CLIENT PAYMENT" },
        ],
      },
      { id: "ACT-EUR", name: "Euro", currency: "EUR", balance: "5.00", "balance-date": nowSec, transactions: [] },
    ],
  };
}

const mockFetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
  requests.push(`${init?.method ?? "GET"} ${input.split("?")[0]}`);
  const u = new URL(input);
  if (u.pathname.startsWith("/claim/")) {
    if (claimed.has(u.pathname)) return new Response("gone", { status: 403 });
    claimed.add(u.pathname);
    return new Response(ACCESS_URL, { status: 200 });
  }
  if (u.pathname === "/simplefin/accounts") {
    if (!init?.headers || !JSON.stringify(init.headers).includes("Basic")) return new Response("no", { status: 401 });
    return Response.json({ ...accountSet, errlist });
  }
  return new Response("nope", { status: 404 });
});

beforeAll(async () => {
  const keyring = parseKeyring(`1:${randomBytes(32).toString("base64")}`);
  app = await buildApp({
    pool, simplefinFetch: mockFetch,
    config: { secureCookies: false, allowRegistration: true, trustedOrigins: [], keyring },
  });
});
afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), pool.end()]);
});

// ---------------------------------------------------------------- helpers
let n = 0;
interface Client { cookie: string; id: string; email: string }

async function signup(label: string): Promise<Client> {
  const email = `${label}-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email, name: label, password: "a-long-test-password" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "riffle_session");
  return { cookie: `riffle_session=${c!.value}`, id: res.json().user.id, email };
}

function call(c: Client | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: c ? { cookie: c.cookie } : {},
  });
}

async function world() {
  resetAccountSet();
  const owner = await signup("owner");
  const biz: string = (await call(owner, "POST", "/api/businesses", { name: "Acme", currency: "USD" })).json().business.id;
  const people: Record<string, Client> = { owner };
  for (const role of ["admin", "bookkeeper", "viewer"]) {
    const u = await signup(role);
    expect((await call(owner, "POST", `/api/businesses/${biz}/members`, { email: u.email, role })).statusCode).toBe(201);
    people[role] = u;
  }
  const accounts: { id: string; code: string }[] = (await call(owner, "GET", `/api/businesses/${biz}/accounts`)).json().accounts;
  const acct = (code: string) => accounts.find((a) => a.code === code)!.id;
  return { biz, people, acct, url: `/api/businesses/${biz}/bank` };
}
type World = Awaited<ReturnType<typeof world>>;

let tokenSeq = 0;
async function connect(w: World, who = "owner") {
  const res = await call(w.people[who]!, "POST", `${w.url}/connections`, {
    setupToken: tokenFor(`tok${Date.now()}-${tokenSeq++}`), label: "My bank",
  });
  expect(res.statusCode).toBe(201);
  return res.json().connection.id as string;
}

/** Connected, synced, USD account linked to checking (1010). */
async function linked(w: World) {
  const conn = await connect(w);
  const owner = w.people["owner"]!;
  expect((await call(owner, "POST", `${w.url}/connections/${conn}/sync-accounts`)).statusCode).toBe(200);
  const res = await call(owner, "PUT", `${w.url}/connections/${conn}/links/ACT-USD`, { accountId: w.acct("1010") });
  expect(res.statusCode).toBe(200);
  return conn;
}

// ---------------------------------------------------------------- tests
describe("bank: connections", () => {
  it("claims a setup token, stores the access URL encrypted and never returns it", async () => {
    const w = await world();
    const token = tokenFor("happy");
    const res = await call(w.people["bookkeeper"]!, "POST", `${w.url}/connections`, { setupToken: token, label: " Chase " });
    expect(res.statusCode).toBe(201);
    const conn = res.json().connection;
    expect(conn.label).toBe("Chase");
    expect(conn.status).toBe("active");
    expect(res.body).not.toContain(SECRET_PASS);
    expect(res.body).not.toContain("accessUrl");

    const row = (await admin.query("SELECT access_url_enc FROM bank_connections WHERE id=$1", [conn.id])).rows[0];
    expect(Buffer.from(row.access_url_enc).includes(Buffer.from(SECRET_PASS))).toBe(false);

    const list = await call(w.people["viewer"]!, "GET", `${w.url}/connections`);
    expect(list.json().connections).toHaveLength(1);
    expect(list.body).not.toContain(SECRET_PASS);
    const audit = await admin.query("SELECT before, after FROM audit_log WHERE business_id=$1", [w.biz]);
    expect(JSON.stringify(audit.rows)).not.toContain(SECRET_PASS);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });

  it("fails cleanly when a setup token is reused, and does not create a connection", async () => {
    const w = await world();
    const token = tokenFor("reuse");
    const body = { setupToken: token, label: "A" };
    expect((await call(w.people["owner"]!, "POST", `${w.url}/connections`, body)).statusCode).toBe(201);
    const again = await call(w.people["owner"]!, "POST", `${w.url}/connections`, body);
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toMatch(/Claim failed/);
    expect(again.body).not.toContain(token);
    expect((await call(w.people["owner"]!, "GET", `${w.url}/connections`)).json().connections).toHaveLength(1);
  });

  it("rejects a malformed token with 400 before any network call", async () => {
    const w = await world();
    const before = requests.length;
    const res = await call(w.people["owner"]!, "POST", `${w.url}/connections`, { setupToken: "not base64 !!", label: "x" });
    expect(res.statusCode).toBe(400);
    expect(requests.length).toBe(before);
  });

  it("viewer gets 403 on every write and the setup token is not consumed", async () => {
    const w = await world();
    const conn = await connect(w);
    const v = w.people["viewer"]!;
    const before = requests.length;
    const staged = "00000000-0000-4000-8000-000000000000";
    const attempts = [
      call(v, "POST", `${w.url}/connections`, { setupToken: tokenFor("viewer"), label: "x" }),
      call(v, "DELETE", `${w.url}/connections/${conn}`),
      call(v, "POST", `${w.url}/connections/${conn}/sync-accounts`),
      call(v, "PUT", `${w.url}/connections/${conn}/links/ACT-USD`, { accountId: w.acct("1010") }),
      call(v, "POST", `${w.url}/connections/${conn}/import-now`),
      call(v, "POST", `${w.url}/staged/${staged}/approve`, {}),
      call(v, "POST", `${w.url}/staged/${staged}/reject`),
      call(v, "POST", `${w.url}/staged/bulk`, { action: "approve", ids: [staged] }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.statusCode).toBe(403);
    expect(requests.length).toBe(before);
    expect((await call(v, "GET", `${w.url}/staged`)).statusCode).toBe(200);
  });

  it("requires authentication", async () => {
    const w = await world();
    expect((await call(null, "GET", `${w.url}/connections`)).statusCode).toBe(401);
  });

  it("isolates businesses: other tenants get 404 and cannot touch a connection", async () => {
    const a = await world();
    const b = await world();
    const conn = await connect(a);
    const bo = b.people["owner"]!;
    expect((await call(bo, "GET", `${a.url}/connections`)).statusCode).toBe(404);
    expect((await call(bo, "POST", `${a.url}/connections`, { setupToken: tokenFor("x"), label: "x" })).statusCode).toBe(404);
    // Addressing a's connection through b's business finds nothing.
    expect((await call(bo, "DELETE", `${b.url}/connections/${conn}`)).statusCode).toBe(404);
    expect((await call(bo, "POST", `${b.url}/connections/${conn}/sync-accounts`)).statusCode).toBe(404);
    expect((await call(bo, "POST", `${b.url}/connections/${conn}/import-now`)).statusCode).toBe(404);
    expect((await call(bo, "GET", `${b.url}/connections`)).json().connections).toEqual([]);
    expect((await admin.query("SELECT status FROM bank_connections WHERE id=$1", [conn])).rows[0].status).toBe("active");
  });

  it("disconnect disables the connection and blocks import", async () => {
    const w = await world();
    const conn = await linked(w);
    const res = await call(w.people["admin"]!, "DELETE", `${w.url}/connections/${conn}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().connection.status).toBe("disabled");
    expect((await call(w.people["admin"]!, "POST", `${w.url}/connections/${conn}/import-now`)).statusCode).toBe(409);
  });
});

describe("bank: accounts and links", () => {
  it("syncs discovered accounts and links one to a ledger account", async () => {
    const w = await world();
    const conn = await connect(w);
    const owner = w.people["owner"]!;
    const sync = await call(owner, "POST", `${w.url}/connections/${conn}/sync-accounts`);
    expect(sync.statusCode).toBe(200);
    expect(sync.json().accounts.map((a: { externalAccountId: string }) => a.externalAccountId).sort()).toEqual(["ACT-EUR", "ACT-USD"]);
    const link = await call(owner, "PUT", `${w.url}/connections/${conn}/links/ACT-USD`, { accountId: w.acct("1010") });
    expect(link.statusCode).toBe(200);
    expect(link.json().link.accountId).toBe(w.acct("1010"));
    const list = await call(w.people["viewer"]!, "GET", `${w.url}/connections/${conn}/accounts`);
    expect(list.json().accounts.find((a: { externalAccountId: string }) => a.externalAccountId === "ACT-USD").linkedAccountId)
      .toBe(w.acct("1010"));
  });

  it("rejects a currency mismatch, an unknown bank account and a foreign ledger account", async () => {
    const w = await world();
    const other = await world();
    const conn = await connect(w);
    const owner = w.people["owner"]!;
    await call(owner, "POST", `${w.url}/connections/${conn}/sync-accounts`);
    const eur = await call(owner, "PUT", `${w.url}/connections/${conn}/links/ACT-EUR`, { accountId: w.acct("1010") });
    expect(eur.statusCode).toBe(422);
    expect(eur.json().error).toMatch(/currency mismatch/);
    expect((await call(owner, "PUT", `${w.url}/connections/${conn}/links/NOPE`, { accountId: w.acct("1010") })).statusCode).toBe(422);
    const foreign = await call(owner, "PUT", `${w.url}/connections/${conn}/links/ACT-USD`, { accountId: other.acct("1010") });
    expect(foreign.statusCode).toBe(422);
    expect((await admin.query("SELECT count(*)::int n FROM bank_account_links WHERE business_id=$1", [w.biz])).rows[0].n).toBe(0);
  });

  it("surfaces SimpleFIN errlist messages", async () => {
    const w = await world();
    const conn = await connect(w);
    errlist = [{ code: "con.auth", msg: "Please re-authenticate with Chase", conn_id: "c1" }];
    const res = await call(w.people["owner"]!, "POST", `${w.url}/connections/${conn}/sync-accounts`);
    expect(res.json().warnings[0]).toMatchObject({ code: "con.auth", message: "Please re-authenticate with Chase" });
  });
});

describe("bank: import and staged review", () => {
  it("imports, honours the rate limit with 429 + retry info, and does not duplicate", async () => {
    const w = await world();
    const conn = await linked(w);
    const owner = w.people["owner"]!;
    const first = await call(owner, "POST", `${w.url}/connections/${conn}/import-now`);
    expect(first.statusCode).toBe(200);
    expect(first.json().result.inserted).toBe(2);
    const second = await call(owner, "POST", `${w.url}/connections/${conn}/import-now`);
    expect(second.statusCode).toBe(429);
    expect(second.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    const list = await call(owner, "GET", `${w.url}/staged?status=new`);
    expect(list.json().items).toHaveLength(2);
    expect(typeof list.json().items[0].amountMinor).toBe("string");
    expect((await call(owner, "GET", `${w.url}/staged?status=new&limit=1&offset=1`)).json().items).toHaveLength(1);
    expect((await call(owner, "GET", `${w.url}/staged?status=bogus`)).statusCode).toBe(400);
  });

  it("surfaces errlist warnings on import and 502s with the bank's message on revoked access", async () => {
    const w = await world();
    const conn = await linked(w);
    errlist = [{ code: "act.sync", msg: "Account is syncing slowly", account_id: "ACT-USD" }];
    const ok = await call(w.people["owner"]!, "POST", `${w.url}/connections/${conn}/import-now`);
    expect(ok.json().warnings[0].message).toBe("Account is syncing slowly");

    const w2 = await world();
    const conn2 = await linked(w2);
    mockFetch.mockImplementationOnce(async () => new Response("", { status: 403 }));
    const res = await call(w2.people["owner"]!, "POST", `${w2.url}/connections/${conn2}/import-now`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/revoked/);
    const row = (await call(w2.people["owner"]!, "GET", `${w2.url}/connections`)).json().connections[0];
    expect(row.status).toBe("error");
  });

  it("approve posts a balanced transaction; a second approve is rejected", async () => {
    const w = await world();
    const conn = await linked(w);
    const owner = w.people["owner"]!;
    await call(owner, "POST", `${w.url}/connections/${conn}/import-now`);
    const items: { id: string; amountMinor: string }[] = (await call(owner, "GET", `${w.url}/staged?status=new`)).json().items;
    const expense = items.find((i) => i.amountMinor === "-1250")!;

    const res = await call(w.people["bookkeeper"]!, "POST", `${w.url}/staged/${expense.id}/approve`, { categoryAccountId: w.acct("6000") });
    expect(res.statusCode).toBe(200);
    const txId: string = res.json().result.transactionId;
    expect(res.json().staged.status).toBe("posted");

    const lines = (await admin.query("SELECT l.account_id, l.amount_minor::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.transaction_id=$1", [txId])).rows;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + BigInt(l.amount), 0n)).toBe(0n);
    expect(lines.find((l) => l.account_id === w.acct("1010"))!.amount).toBe("-1250");
    expect(lines.find((l) => l.account_id === w.acct("6000"))!.amount).toBe("1250");

    const dup = await call(owner, "POST", `${w.url}/staged/${expense.id}/approve`, {});
    expect(dup.statusCode).toBe(409);
    expect((await call(owner, "POST", `${w.url}/staged/${expense.id}/reject`)).statusCode).toBe(409);
    expect((await admin.query("SELECT count(*)::int n FROM staged_transactions WHERE transaction_id=$1", [txId])).rows[0].n).toBe(1);
  });

  it("falls back to uncategorized and refuses bad category overrides", async () => {
    const w = await world();
    const conn = await linked(w);
    const owner = w.people["owner"]!;
    await call(owner, "POST", `${w.url}/connections/${conn}/import-now`);
    const items: { id: string; amountMinor: string }[] = (await call(owner, "GET", `${w.url}/staged`)).json().items;
    const income = items.find((i) => i.amountMinor === "25000")!;
    const bad = await call(owner, "POST", `${w.url}/staged/${income.id}/approve`, { categoryAccountId: w.acct("1010") });
    expect(bad.statusCode).toBe(422);
    const ok = await call(owner, "POST", `${w.url}/staged/${income.id}/approve`, {});
    expect(ok.json().result.categorySource).toBe("uncategorized");
  });

  it("reject ignores a row; bulk approve/reject report per-item results", async () => {
    const w = await world();
    const conn = await linked(w);
    const owner = w.people["owner"]!;
    await call(owner, "POST", `${w.url}/connections/${conn}/import-now`);
    const [a, b] = (await call(owner, "GET", `${w.url}/staged?status=new`)).json().items as { id: string }[];
    expect((await call(owner, "POST", `${w.url}/staged/${a!.id}/reject`)).json().staged.status).toBe("ignored");

    const bulk = await call(owner, "POST", `${w.url}/staged/bulk`, { action: "approve", ids: [a!.id, b!.id] });
    expect(bulk.statusCode).toBe(200);
    const r = bulk.json();
    expect(r.succeeded).toBe(1);
    expect(r.results.find((x: { id: string }) => x.id === a!.id).ok).toBe(false); // ignored rows cannot be approved
    expect(r.results.find((x: { id: string }) => x.id === b!.id).ok).toBe(true);
    const again = await call(owner, "POST", `${w.url}/staged/bulk`, { action: "approve", ids: [b!.id] });
    expect(again.json().succeeded).toBe(0);

    expect((await call(owner, "POST", `${w.url}/staged/bulk`, { action: "reject", ids: [] })).statusCode).toBe(400);
    expect((await call(owner, "POST", `${w.url}/staged/bulk`, { action: "nuke", ids: [a!.id] })).statusCode).toBe(400);
  });

  it("does not let another business approve or see staged rows", async () => {
    const a = await world();
    const b = await world();
    const conn = await linked(a);
    await call(a.people["owner"]!, "POST", `${a.url}/connections/${conn}/import-now`);
    const id: string = (await call(a.people["owner"]!, "GET", `${a.url}/staged`)).json().items[0].id;
    const bo = b.people["owner"]!;
    expect((await call(bo, "GET", `${b.url}/staged`)).json().items).toEqual([]);
    expect((await call(bo, "POST", `${b.url}/staged/${id}/approve`, {})).statusCode).toBe(404);
    expect((await call(bo, "POST", `${b.url}/staged/${id}/reject`)).statusCode).toBe(404);
    expect((await admin.query("SELECT status FROM staged_transactions WHERE id=$1", [id])).rows[0].status).toBe("new");
  });
});

describe("bank: configuration", () => {
  it("answers 503 when no key ring is configured", async () => {
    const bare = await buildApp({
      pool, simplefinFetch: mockFetch,
      config: { secureCookies: false, allowRegistration: true, trustedOrigins: [] },
    });
    const prev = app;
    app = bare;
    try {
      const w = await world();
      const res = await call(w.people["owner"]!, "POST", `${w.url}/connections`, { setupToken: tokenFor("nokey"), label: "x" });
      expect(res.statusCode).toBe(503);
    } finally {
      app = prev;
      await bare.close();
    }
  });
});
