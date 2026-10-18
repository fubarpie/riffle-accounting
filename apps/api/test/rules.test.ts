import { postTransaction, withTenant } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const admin = new pg.Pool({ connectionString: process.env["TEST_ADMIN_URL"], max: 2 });
const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ pool, config: { secureCookies: false, allowRegistration: true, trustedOrigins: [] } });
});
afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), pool.end()]);
});

let n = 0;
interface Client { cookie: string; id: string; email: string }

async function signup(label: string): Promise<Client> {
  const email = `${label}-${Date.now()}-${n++}@example.test`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email, name: label, password: "a-long-test-password" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "riffle_session");
  return { cookie: `riffle_session=${c!.value}`, id: res.json().user.id, email };
}

function call(c: Client | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: c ? { cookie: c.cookie } : {},
  });
}

/** A business with one member per role, a checking/fuel/sales account set and one transaction. */
async function world() {
  const owner = await signup("owner");
  const res = await call(owner, "POST", "/api/businesses", { name: "Acme", currency: "USD" });
  const biz: string = res.json().business.id;
  const people: Record<string, Client> = { owner };
  for (const role of ["admin", "bookkeeper", "viewer"]) {
    const u = await signup(role);
    expect((await call(owner, "POST", `/api/businesses/${biz}/members`, { email: u.email, role })).statusCode).toBe(201);
    people[role] = u;
  }
  const accounts: { id: string; code: string }[] = (await call(owner, "GET", `/api/businesses/${biz}/accounts`)).json().accounts;
  const acct = (code: string) => accounts.find((a) => a.code === code)!.id;
  const { transactionId } = await withTenant(pool, { userId: owner.id, businessId: biz }, (c) =>
    postTransaction(c, biz, owner.id, {
      kind: "withdrawal", date: "2026-03-15", description: "SHELL OIL 77",
      lines: [{ accountId: acct("6020"), amount: 5_000n }, { accountId: acct("1010"), amount: -5_000n }],
    }));
  const body = (o: object = {}) => ({
    name: "Fuel", conditions: [{ type: "description", op: "contains", value: "shell" }],
    actions: [{ type: "set_category", accountId: acct("6000") }, { type: "add_tag", tag: "fuel" }], ...o,
  });
  return { biz, people, acct, transactionId, body };
}

describe("rules: role checks", () => {
  it.each([["owner", 201], ["admin", 201], ["bookkeeper", 201], ["viewer", 403]] as const)(
    "%s creating a rule gets %i", async (role, status) => {
      const w = await world();
      const res = await call(w.people[role]!, "POST", `/api/businesses/${w.biz}/rules`, w.body());
      expect(res.statusCode).toBe(status);
      const count = (await admin.query("SELECT count(*)::int AS n FROM rules WHERE business_id=$1", [w.biz])).rows[0].n;
      expect(count).toBe(status === 201 ? 1 : 0);
    });

  it("viewer can read rules and the dry-run preview but not update, delete or apply", async () => {
    const w = await world();
    const created = await call(w.people["bookkeeper"]!, "POST", `/api/businesses/${w.biz}/rules`, w.body());
    const ruleId: string = created.json().rule.id;
    const v = w.people["viewer"]!;
    const url = `/api/businesses/${w.biz}/rules`;

    expect((await call(v, "GET", url)).json().rules).toHaveLength(1);
    expect((await call(v, "GET", `${url}/${ruleId}`)).statusCode).toBe(200);
    expect((await call(v, "POST", `${url}/dry-run`, {})).statusCode).toBe(200);

    expect((await call(v, "PATCH", `${url}/${ruleId}`, { enabled: false })).statusCode).toBe(403);
    expect((await call(v, "DELETE", `${url}/${ruleId}`)).statusCode).toBe(403);
    expect((await call(v, "POST", `${url}/apply`, {})).statusCode).toBe(403);
    const still = (await admin.query("SELECT enabled FROM rules WHERE id=$1", [ruleId])).rows[0];
    expect(still.enabled).toBe(true);
  });

  it.each(["admin", "bookkeeper"] as const)("%s can update, apply and delete", async (role) => {
    const w = await world();
    const url = `/api/businesses/${w.biz}/rules`;
    const ruleId: string = (await call(w.people["owner"]!, "POST", url, w.body())).json().rule.id;
    const p = w.people[role]!;
    expect((await call(p, "PATCH", `${url}/${ruleId}`, { priority: 5 })).json().rule.priority).toBe(5);
    expect((await call(p, "POST", `${url}/apply`, {})).statusCode).toBe(200);
    expect((await call(p, "DELETE", `${url}/${ruleId}`)).statusCode).toBe(204);
  });

  it("requires authentication, and hides the business from non-members", async () => {
    const w = await world();
    expect((await call(null, "GET", `/api/businesses/${w.biz}/rules`)).statusCode).toBe(401);
    expect((await call(null, "POST", `/api/businesses/${w.biz}/rules`, w.body())).statusCode).toBe(401);
    const outsider = await signup("outsider");
    expect((await call(outsider, "GET", `/api/businesses/${w.biz}/rules`)).statusCode).toBe(404);
    expect((await call(outsider, "POST", `/api/businesses/${w.biz}/rules`, w.body())).statusCode).toBe(404);
    expect((await call(outsider, "POST", `/api/businesses/${w.biz}/rules/apply`, {})).statusCode).toBe(404);
  });

  it("does not leak rules across businesses", async () => {
    const a = await world();
    const b = await world();
    const ruleId: string = (await call(a.people["owner"]!, "POST", `/api/businesses/${a.biz}/rules`, a.body())).json().rule.id;
    // b's owner addressing a's rule through b's business sees nothing, and cannot change it.
    expect((await call(b.people["owner"]!, "GET", `/api/businesses/${b.biz}/rules/${ruleId}`)).statusCode).toBe(404);
    expect((await call(b.people["owner"]!, "PATCH", `/api/businesses/${b.biz}/rules/${ruleId}`, { enabled: false })).statusCode).toBe(404);
    expect((await call(b.people["owner"]!, "DELETE", `/api/businesses/${b.biz}/rules/${ruleId}`)).statusCode).toBe(404);
  });
});

describe("rules: validation and behaviour", () => {
  it("rejects invalid definitions with 400 and a non-category target with 400", async () => {
    const w = await world();
    const url = `/api/businesses/${w.biz}/rules`;
    const owner = w.people["owner"]!;
    expect((await call(owner, "POST", url, w.body({ conditions: [] }))).statusCode).toBe(400);
    expect((await call(owner, "POST", url, w.body({ conditions: [{ type: "description", op: "regex", value: "(a+)+$" }] }))).statusCode).toBe(400);
    const bank = await call(owner, "POST", url, w.body({ actions: [{ type: "set_category", accountId: w.acct("1010") }] }));
    expect(bank.statusCode).toBe(400);
    expect(bank.json().issues[0]).toMatch(/income or expense/);
  });

  it("dry-run previews without writing; apply recategorises via reversal and audits", async () => {
    const w = await world();
    const url = `/api/businesses/${w.biz}/rules`;
    const owner = w.people["owner"]!;
    await call(owner, "POST", url, w.body());

    const lines = async () => (await admin.query("SELECT count(*)::int AS n FROM journal_lines WHERE business_id=$1", [w.biz])).rows[0].n;
    const before = await lines();
    const dry = await call(w.people["viewer"]!, "POST", `${url}/dry-run`, {});
    expect(dry.json()).toMatchObject({ dryRun: true, matched: 1 });
    expect(dry.json().results[0].changes.category.accountId).toBe(w.acct("6000"));
    expect(await lines()).toBe(before);

    // Drafts can be tried without saving.
    const draft = await call(owner, "POST", `${url}/dry-run`, {
      rules: [{ name: "none", conditions: [{ type: "description", op: "starts_with", value: "zzz" }], actions: [{ type: "add_tag", tag: "x" }] }],
    });
    expect(draft.json().matched).toBe(0);

    const applied = await call(w.people["bookkeeper"]!, "POST", `${url}/apply`, {});
    expect(applied.json().applied).toHaveLength(1);
    expect(await lines()).toBe(before + 4);

    // Bookkeepers can read the audit trail of what the rules did.
    const log = await call(w.people["bookkeeper"]!, "GET", `/api/businesses/${w.biz}/audit-log`);
    const actions: string[] = log.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["rule.create", "transaction.rule_apply", "transaction.edit"]));
  });
});
