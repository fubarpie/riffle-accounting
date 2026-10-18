import { postTransaction, withTenant } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const adminUrl = process.env["TEST_ADMIN_URL"];
const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });

/** Skip (not fail) the whole file when Postgres is unreachable. */
async function postgresAvailable(): Promise<boolean> {
  if (!adminUrl) return false;
  const probe = new pg.Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await probe.query("SELECT 1 FROM live_journal_lines LIMIT 0");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const hasPg = await postgresAvailable();

let app: FastifyInstance;
beforeAll(async () => {
  if (!hasPg) return;
  app = await buildApp({ pool, config: { secureCookies: false, allowRegistration: true, trustedOrigins: [] } });
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});

interface Client { cookie: string; id: string; email: string }
let n = 0;

async function signup(label: string): Promise<Client> {
  const email = `${label}-${Date.now()}-${n++}@example.test`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email, name: label, password: "a-long-test-password" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "riffle_session");
  return { cookie: `riffle_session=${c?.value}`, id: res.json().user.id, email };
}
const get = (c: Client | null, url: string) =>
  app.inject({ method: "GET", url, headers: c ? { cookie: c.cookie } : {} });

async function seed() {
  const owner = await signup("owner");
  const created = await app.inject({
    method: "POST", url: "/api/businesses", headers: { cookie: owner.cookie }, payload: { name: "Acme", currency: "USD" },
  });
  const biz: string = created.json().business.id;
  const accts: { id: string; code: string }[] = (await get(owner, `/api/businesses/${biz}/accounts`)).json().accounts;
  const a = (code: string) => accts.find((x) => x.code === code)!.id;
  const post = (date: string, description: string, lines: [string, bigint][]) =>
    withTenant(pool, { userId: owner.id, businessId: biz }, (c) => postTransaction(c, biz, owner.id, {
      kind: "journal", date, description, lines: lines.map(([code, amount]) => ({ accountId: a(code), amount })),
    }));
  await post("2026-01-02", "Contribution", [["1010", 100_000n], ["3100", -100_000n]]);
  await post("2026-01-10", "=HYPERLINK(\"http://evil.test\",\"x\")", [["1100", 50_000n], ["4000", -45_000n], ["2200", -5_000n]]);
  await post("2026-02-05", "Rent, February", [["6100", 30_000n], ["1010", -30_000n]]);
  return { owner, biz, a };
}

const addRole = async (owner: Client, biz: string, role: string) => {
  const u = await signup(role);
  const res = await app.inject({
    method: "POST", url: `/api/businesses/${biz}/members`, headers: { cookie: owner.cookie },
    payload: { email: u.email, role },
  });
  expect(res.statusCode).toBe(201);
  return u;
};

const reportUrls = (biz: string, accountId: string) => [
  `/api/businesses/${biz}/reports/trial-balance?asOf=2026-12-31`,
  `/api/businesses/${biz}/reports/profit-loss?from=2026-01-01&to=2026-12-31`,
  `/api/businesses/${biz}/reports/balance-sheet?asOf=2026-12-31`,
  `/api/businesses/${biz}/reports/general-ledger?from=2026-01-01&to=2026-12-31&accountId=${accountId}`,
  `/api/businesses/${biz}/reports/tax-summary?from=2026-01-01&to=2026-12-31`,
];

describe.skipIf(!hasPg)("report routes", () => {
  it("returns JSON that satisfies the accounting invariants", async () => {
    const { owner, biz } = await seed();
    const tb = (await get(owner, `/api/businesses/${biz}/reports/trial-balance?asOf=2026-12-31`)).json();
    expect(tb.currency).toBe("USD");
    expect(tb.report.totals.debits).toBe(tb.report.totals.credits);
    expect(tb.report.totals.debitBalance).toBe(tb.report.totals.creditBalance);

    const bs = (await get(owner, `/api/businesses/${biz}/reports/balance-sheet?asOf=2026-12-31`)).json().report;
    expect(bs.totals.assets).toBe(bs.totals.liabilities + bs.totals.equity);

    const pl = (await get(owner, `/api/businesses/${biz}/reports/profit-loss?from=2026-01-01&to=2026-12-31`)).json().report;
    expect(pl.totals).toEqual({ income: 45_000, expenses: 30_000, netIncome: 15_000 });
  });

  it("lets every role with membership read every report", async () => {
    const { owner, biz, a } = await seed();
    const users = [owner, ...(await Promise.all(["admin", "bookkeeper", "viewer"].map((r) => addRole(owner, biz, r))))];
    for (const u of users) {
      for (const url of reportUrls(biz, a("1010"))) {
        expect((await get(u, url)).statusCode, `${u.email} ${url}`).toBe(200);
      }
    }
  });

  it("hides businesses from non-members (404) and requires a session (401)", async () => {
    const { biz, a } = await seed();
    const outsider = await signup("outsider");
    for (const url of reportUrls(biz, a("1010"))) {
      expect((await get(outsider, url)).statusCode).toBe(404);
      expect((await get(null, url)).statusCode).toBe(401);
    }
  });

  it("isolates tenants: a member of one business cannot read another's report or account detail", async () => {
    const A = await seed();
    const B = await seed();
    // B's owner asks for A's business id, and for A's account id inside B.
    expect((await get(B.owner, `/api/businesses/${A.biz}/reports/trial-balance?asOf=2026-12-31`)).statusCode).toBe(404);
    const cross = await get(B.owner, `/api/businesses/${B.biz}/reports/general-ledger?from=2026-01-01&to=2026-12-31&accountId=${A.a("1010")}`);
    expect(cross.statusCode).toBe(200);
    expect(cross.json().report.accounts).toEqual([]);
    // Each owner sees only their own figures.
    const own = (await get(A.owner, `/api/businesses/${A.biz}/reports/trial-balance?asOf=2026-12-31`)).json().report;
    expect(own.totals.debits).toBe(150_000 + 30_000);
  });

  it("validates dates with zod", async () => {
    const { owner, biz } = await seed();
    const bad = [
      "trial-balance", "trial-balance?asOf=2026-02-30", "trial-balance?asOf=tomorrow", "trial-balance?asOf=2026-1-1",
      "profit-loss?from=2026-01-01", "profit-loss?from=2026-03-01&to=2026-01-01",
      "general-ledger?from=2026-01-01&to=2026-02-01&accountId=nope", "balance-sheet?asOf=2026-01-01&format=xml",
      "tax-summary?from=2026-01-01&to=2026-02-01&accounts=abc",
    ];
    for (const q of bad) expect((await get(owner, `/api/businesses/${biz}/reports/${q}`)).statusCode, q).toBe(400);
    expect((await get(owner, `/api/businesses/not-a-uuid/reports/trial-balance?asOf=2026-01-01`)).statusCode).toBe(400);
  });

  it("exports CSV with headers, minor units and formula guarding", async () => {
    const { owner, biz } = await seed();
    const tb = await get(owner, `/api/businesses/${biz}/reports/trial-balance?asOf=2026-12-31&format=csv`);
    expect(tb.statusCode).toBe(200);
    expect(tb.headers["content-type"]).toContain("text/csv");
    expect(tb.headers["content-disposition"]).toContain("trial-balance-2026-12-31.csv");
    expect(tb.body.startsWith("Code,Account,Type,Currency,Debits,Credits")).toBe(true);
    expect(tb.body).toContain("1010,Checking,asset,USD,100000,30000,70000,0");

    const gl = await get(owner, `/api/businesses/${biz}/reports/general-ledger?from=2026-01-01&to=2026-12-31&format=csv`);
    expect(gl.statusCode).toBe(200);
    expect(gl.body).toContain("'=HYPERLINK(");
    expect(gl.body).not.toMatch(/,=HYPERLINK/);
    expect(gl.body).toContain('"Rent, February"');
    for (const r of ["profit-loss?from=2026-01-01&to=2026-12-31", "balance-sheet?asOf=2026-12-31", "tax-summary?from=2026-01-01&to=2026-12-31"]) {
      const res = await get(owner, `/api/businesses/${biz}/reports/${r}&format=csv`);
      expect(res.statusCode, r).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    }
  });
});
