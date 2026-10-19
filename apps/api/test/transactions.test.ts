import { postTransaction, voidTransaction, withTenant } from "@riffle/db";
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
  const email = `${label}-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email, name: label, password: "a-long-test-password" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "riffle_session");
  return { cookie: `riffle_session=${c?.value}`, id: res.json().user.id, email };
}
const get = (c: Client | null, url: string) =>
  app.inject({ method: "GET", url, headers: c ? { cookie: c.cookie } : {} });

interface Txn { id: string; description: string; notes: string; kind: string; date: string; voided: boolean;
  amountMinor: string | null; accounts: { accountId: string; code: string | null; amountMinor: string }[] }

async function seed() {
  const owner = await signup("owner");
  const created = await app.inject({
    method: "POST", url: "/api/businesses", headers: { cookie: owner.cookie }, payload: { name: "Acme", currency: "USD" },
  });
  const biz: string = created.json().business.id;
  const accts: { id: string; code: string }[] = (await get(owner, `/api/businesses/${biz}/accounts`)).json().accounts;
  const a = (code: string) => accts.find((x) => x.code === code)!.id;
  const post = (kind: "journal" | "deposit" | "withdrawal", date: string, description: string,
    lines: [string, bigint, string?][], notes = "") =>
    withTenant(pool, { userId: owner.id, businessId: biz }, async (c) => (await postTransaction(c, biz, owner.id, {
      kind, date, description, notes,
      lines: lines.map(([code, amount, memo]) => ({ accountId: a(code), amount, ...(memo ? { memo } : {}) })),
    })).transactionId);

  const contribution = await post("journal", "2026-01-02", "Contribution", [["1010", 100_000n], ["3100", -100_000n]]);
  const invoice = await post("deposit", "2026-01-10", "Invoice 100",
    [["1100", 50_000n], ["4000", -45_000n, "consulting"], ["2200", -5_000n]], "client Zeta");
  const rentFeb = await post("withdrawal", "2026-02-05", "Rent, February", [["6100", 30_000n], ["1010", -30_000n]]);
  const rentMar = await post("withdrawal", "2026-03-01", "Rent, March", [["6100", 30_000n], ["1010", -30_000n]]);
  const promoPct = await post("journal", "2026-03-05", "Promo 50% off", [["6100", 100n], ["1010", -100n]]);
  const promoNum = await post("journal", "2026-03-06", "Promo 500 off", [["6100", 200n], ["1010", -200n]]);
  await withTenant(pool, { userId: owner.id, businessId: biz }, (c) => voidTransaction(c, biz, owner.id, rentMar));
  return { owner, biz, a, ids: { contribution, invoice, rentFeb, rentMar, promoPct, promoNum } };
}

const list = async (c: Client | null, biz: string, qs = "") => get(c, `/api/businesses/${biz}/transactions${qs}`);
const rows = (res: { json(): { transactions: Txn[] } }) => res.json().transactions;
const descs = (res: { json(): { transactions: Txn[] } }) => rows(res).map((t) => t.description);

const addRole = async (owner: Client, biz: string, role: string) => {
  const u = await signup(role);
  const res = await app.inject({
    method: "POST", url: `/api/businesses/${biz}/members`, headers: { cookie: owner.cookie },
    payload: { email: u.email, role },
  });
  expect(res.statusCode).toBe(201);
  return u;
};

describe.skipIf(!hasPg)("transactions list route", () => {
  it("lists live transactions newest first, with totals, currency and per-account lines", async () => {
    const { owner, biz } = await seed();
    const res = await list(owner, biz);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe("USD");
    expect(body.total).toBe(5); // the voided one is hidden by default
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(descs(res)).toEqual(["Promo 500 off", "Promo 50% off", "Rent, February", "Invoice 100", "Contribution"]);

    const invoice = rows(res).find((t) => t.description === "Invoice 100")!;
    expect(invoice.kind).toBe("deposit");
    expect(invoice.date).toBe("2026-01-10");
    expect(invoice.notes).toBe("client Zeta");
    expect(invoice.voided).toBe(false);
    expect(invoice.amountMinor).toBe("50000");
    expect(invoice.accounts.map((x) => [x.code, x.amountMinor])).toEqual([
      ["1100", "50000"], ["2200", "-5000"], ["4000", "-45000"],
    ].sort((p, q) => Number(q[1]) - Number(p[1])));
    // Every transaction balances.
    for (const t of rows(res)) expect(t.accounts.reduce((s, x) => s + BigInt(x.amountMinor), 0n)).toBe(0n);
  });

  it("filters by status: live (default), voided, all", async () => {
    const { owner, biz } = await seed();
    const voided = await list(owner, biz, "?status=voided");
    expect(descs(voided)).toEqual(["Rent, March"]);
    expect(rows(voided)[0]!.voided).toBe(true);
    expect(rows(voided)[0]!.amountMinor).toBeNull();
    expect(rows(voided)[0]!.accounts).toEqual([]);
    const all = await list(owner, biz, "?status=all");
    expect(all.json().total).toBe(6);
  });

  it("filters by date range (inclusive), kind and account", async () => {
    const { owner, biz, a } = await seed();
    expect(descs(await list(owner, biz, "?from=2026-01-10&to=2026-02-05&sort=date&dir=asc")))
      .toEqual(["Invoice 100", "Rent, February"]);
    expect(descs(await list(owner, biz, "?kind=withdrawal"))).toEqual(["Rent, February"]);
    expect(descs(await list(owner, biz, "?kind=deposit"))).toEqual(["Invoice 100"]);
    expect(descs(await list(owner, biz, `?accountId=${a("4000")}`))).toEqual(["Invoice 100"]);
    expect((await list(owner, biz, `?accountId=${a("6100")}`)).json().total).toBe(3);
  });

  it("searches description, notes and line memos, case-insensitively", async () => {
    const { owner, biz } = await seed();
    expect(descs(await list(owner, biz, "?q=RENT"))).toEqual(["Rent, February"]);
    expect(descs(await list(owner, biz, "?q=zeta"))).toEqual(["Invoice 100"]);
    expect(descs(await list(owner, biz, "?q=consult"))).toEqual(["Invoice 100"]);
    expect((await list(owner, biz, "?q=nothing-matches-this")).json().total).toBe(0);
  });

  it("matches LIKE wildcards literally", async () => {
    const { owner, biz } = await seed();
    expect(descs(await list(owner, biz, `?q=${encodeURIComponent("50%")}`))).toEqual(["Promo 50% off"]);
    expect((await list(owner, biz, `?q=${encodeURIComponent("%")}`)).json().total).toBe(1);
    expect((await list(owner, biz, `?q=${encodeURIComponent("_")}`)).json().total).toBe(0);
  });

  it("sorts by date, amount and description in both directions", async () => {
    const { owner, biz } = await seed();
    expect(descs(await list(owner, biz, "?sort=date&dir=asc"))[0]).toBe("Contribution");
    expect(descs(await list(owner, biz, "?sort=amount&dir=desc")).slice(0, 2)).toEqual(["Contribution", "Invoice 100"]);
    expect(descs(await list(owner, biz, "?sort=amount&dir=asc"))[0]).toBe("Promo 50% off");
    expect(descs(await list(owner, biz, "?sort=description&dir=asc"))).toEqual([
      "Contribution", "Invoice 100", "Promo 50% off", "Promo 500 off", "Rent, February",
    ]);
    expect(descs(await list(owner, biz, "?sort=description&dir=desc"))[0]).toBe("Rent, February");
  });

  it("pages without gaps or repeats, and reports the full total", async () => {
    const { owner, biz } = await seed();
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const res = await list(owner, biz, `?limit=2&offset=${offset}`);
      expect(res.json().total).toBe(5);
      expect(res.json().limit).toBe(2);
      seen.push(...descs(res));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const past = await list(owner, biz, "?limit=2&offset=10");
    expect(past.statusCode).toBe(200);
    expect(rows(past)).toEqual([]);
    expect(past.json().total).toBe(5);
  });

  it("rejects bad input with 400", async () => {
    const { owner, biz } = await seed();
    for (const qs of [
      "?from=2026-02-30", "?from=2026-03-01&to=2026-01-01", "?kind=gift", "?sort=notes", "?dir=up",
      "?status=gone", "?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?accountId=nope",
    ]) {
      expect((await list(owner, biz, qs)).statusCode, qs).toBe(400);
    }
    expect((await get(owner, "/api/businesses/not-a-uuid/transactions")).statusCode).toBe(400);
  });

  it("lets every role read, hides the business from non-members (404) and requires a session (401)", async () => {
    const { owner, biz } = await seed();
    const users = [owner, ...(await Promise.all(["admin", "bookkeeper", "viewer"].map((r) => addRole(owner, biz, r))))];
    for (const u of users) expect((await list(u, biz)).statusCode, u.email).toBe(200);
    const outsider = await signup("outsider");
    expect((await list(outsider, biz)).statusCode).toBe(404);
    expect((await list(null, biz)).statusCode).toBe(401);
  });

  it("isolates tenants: another business's transactions and accounts never leak", async () => {
    const one = await seed();
    const two = await seed();
    const res = await list(one.owner, one.biz);
    const mine = new Set(Object.values(one.ids));
    for (const t of rows(res)) expect(mine.has(t.id)).toBe(true);
    // Filtering on an account id from the other business matches nothing.
    const cross = await list(one.owner, one.biz, `?accountId=${two.a("1010")}`);
    expect(cross.statusCode).toBe(200);
    expect(cross.json().total).toBe(0);
    // The other owner cannot read this business at all.
    expect((await list(two.owner, one.biz)).statusCode).toBe(404);
  });
});
