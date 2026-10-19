// SPDX-License-Identifier: AGPL-3.0-or-later
// All data in this file is synthetic. Do not paste real exports here.
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });
const admin = new pg.Pool({ connectionString: process.env["TEST_ADMIN_URL"], max: 2 });
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    pool,
    config: { secureCookies: false, allowRegistration: true, trustedOrigins: [] as string[], maxUploadBytes: 1_000_000 },
  });
});
afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), admin.end()]);
});

// ---------------------------------------------------------------- helpers
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
function call(c: Client | null, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: c ? { cookie: c.cookie } : {},
  });
}
function upload(c: Client | null, url: string, data: Buffer | string, type = "text/csv", filename = "journal.csv") {
  const boundary = "----riffletest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return app.inject({
    method: "POST", url, payload: Buffer.concat([head, Buffer.from(data), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...(c ? { cookie: c.cookie } : {}) },
  });
}

async function world() {
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
  return { biz, owner, people, acct, base: `/api/businesses/${biz}/imports` };
}
type World = Awaited<ReturnType<typeof world>>;

// Synthetic Wave-shaped journal. Names and numbers are made up.
const HEADER = [
  "Transaction ID", "Transaction Date", "Account Name", "Transaction Description",
  "Transaction Line Description", "Amount (One column)", "",
  "Debit Amount (Two Column Approach)", "Credit Amount (Two Column Approach)",
  "Other Accounts for this Transaction", "Customer", "Vendor", "Invoice Number",
  "Bill Number", "Notes / Memo", "Amount Before Sales Tax", "Sales Tax Amount",
  "Sales Tax Name", "Transaction Date Added", "Transaction Date Last Modified",
  "Account Group", "Account Type", "Account ID",
].join(",");
interface L { id: string; acct: string; dr?: string; cr?: string; group: string; acctId?: string; date?: string }
const line = (l: L): string => [
  l.id, l.date ?? "2024-01-15", `"${l.acct}"`, '"Test"', "", l.dr ?? l.cr ?? "", "", l.dr ?? "", l.cr ?? "",
  "", "", "", "", "", '""', "", "", "", "2024-02-01", "2024-02-01", l.group, "Type", l.acctId ?? "",
].join(",");
const csv = (...ls: L[]): string => [HEADER, ...ls.map(line)].join("\r\n") + "\r\n";

const FAKE_NUMBER = "9999888877776666";
const T1 = "1000000000000000001";
const T2 = "1000000000000000002";
const T3 = "1000000000000000003";
/** T1 and T2 balance; T3 does not. Three accounts. */
const JOURNAL = csv(
  { id: T1, acct: "Test Checking", dr: "100.00", group: "Asset", acctId: FAKE_NUMBER },
  { id: T1, acct: "Test Income", cr: "100.00", group: "Income" },
  { id: T2, acct: "Test Checking", cr: "25.00", group: "Asset", acctId: FAKE_NUMBER, date: "2024-01-20" },
  { id: T2, acct: "Test Supplies", dr: "25.00", group: "Expense", date: "2024-01-20" },
  { id: T3, acct: "Test Checking", dr: "10.00", group: "Asset", acctId: FAKE_NUMBER, date: "2024-01-25" },
  { id: T3, acct: "Test Income", cr: "9.00", group: "Income", date: "2024-01-25" },
);
/** A different file (different hash) that overlaps JOURNAL on T1. */
const OVERLAP = csv(
  { id: T1, acct: "Test Checking", dr: "100.00", group: "Asset" },
  { id: T1, acct: "Test Income", cr: "100.00", group: "Income" },
  { id: "1000000000000000004", acct: "Test Checking", dr: "7.00", group: "Asset", date: "2024-02-01" },
  { id: "1000000000000000004", acct: "Test Income", cr: "7.00", group: "Income", date: "2024-02-01" },
);

async function stage(w: World, data: string = JOURNAL, who = "bookkeeper") {
  return upload(w.people[who]!, w.base, data);
}
async function actions(w: World): Promise<string[]> {
  const res = await call(w.people["bookkeeper"]!, "GET", `/api/businesses/${w.biz}/audit-log?limit=200`);
  expect(res.statusCode).toBe(200);
  return (res.json().entries as { action: string }[]).map((e) => e.action);
}
async function ledgerLineCount(w: World): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM live_journal_lines WHERE business_id = $1", [w.biz]);
  return Number(rows[0]!.n);
}
async function importAccountId(w: World, bid: string, name: string): Promise<string> {
  const detail = (await call(w.owner, "GET", `${w.base}/${bid}`)).json();
  return (detail.accounts as { id: string; sourceName: string }[]).find((a) => a.sourceName === name)!.id;
}

// ---------------------------------------------------------------- access control
describe("imports: access control", () => {
  it("rejects anonymous callers", async () => {
    const w = await world();
    expect((await call(null, "GET", w.base)).statusCode).toBe(401);
    expect((await upload(null, w.base, JOURNAL)).statusCode).toBe(401);
  });

  it("gives viewers 403 on every write and 200 on reads", async () => {
    const w = await world();
    const up = await stage(w);
    expect(up.statusCode).toBe(201);
    const bid: string = up.json().batch.id;
    const v = w.people["viewer"]!;
    const aid = await importAccountId(w, bid, "Test Checking");
    const eid: string = (await call(v, "GET", `${w.base}/${bid}/entries`)).json().entries[0].id;

    expect((await upload(v, w.base, OVERLAP)).statusCode).toBe(403);
    expect((await call(v, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, { kind: "clear" })).statusCode).toBe(403);
    expect((await call(v, "PATCH", `${w.base}/${bid}/entries/${eid}`, { excluded: true })).statusCode).toBe(403);
    expect((await call(v, "POST", `${w.base}/${bid}/reject`)).statusCode).toBe(403);

    expect((await call(v, "GET", w.base)).statusCode).toBe(200);
    expect((await call(v, "GET", `${w.base}/${bid}`)).statusCode).toBe(200);
    expect((await call(v, "GET", `${w.base}/${bid}/entries`)).statusCode).toBe(200);
    expect((await call(w.owner, "GET", `${w.base}/${bid}`)).json().batch.status).toBe("staged");
  });

  it("hides one business's batches from another business's owner", async () => {
    const a = await world();
    const b = await world();
    const bid: string = (await stage(a)).json().batch.id;
    expect([403, 404]).toContain((await call(b.owner, "GET", `${a.base}/${bid}`)).statusCode);
    expect([403, 404]).toContain((await call(b.owner, "GET", a.base)).statusCode);
    // Same batch id under the caller's OWN business is simply not found.
    expect((await call(b.owner, "GET", `${b.base}/${bid}`)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- staging
describe("imports: staging", () => {
  it("stages a file, reports what blocks approval, and leaves the ledger untouched", async () => {
    const w = await world();
    const before = await ledgerLineCount(w);
    const res = await stage(w);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.batch.status).toBe("staged");
    expect(body.counts).toMatchObject({ entries: 3, valid: 2, invalid: 1, skipped: 0, excluded: 0 });
    expect(body.blockers).toMatchObject({ invalidEntries: 1, unmappedAccounts: 3, ready: false });

    expect(await ledgerLineCount(w)).toBe(before);
    const refs = await admin.query("SELECT 1 FROM imported_refs WHERE business_id = $1", [w.biz]);
    expect(refs.rowCount).toBe(0);
    expect(await actions(w)).toContain("import.stage");

    const entries = (await call(w.owner, "GET", `${w.base}/${body.batch.id}/entries`)).json().entries as {
      externalId: string; date: string; status: string; lines: { amountMinor: string }[];
    }[];
    const t1 = entries.find((e) => e.externalId === T1)!; // 19 digits survive as text
    expect(t1.date).toBe("2024-01-15");
    expect(t1.lines.map((l) => l.amountMinor).sort()).toEqual(["-10000", "10000"]);
    expect(entries.find((e) => e.externalId === T3)!.status).toBe("invalid");
  });

  it("keeps only the last 4 characters of an account number", async () => {
    const w = await world();
    const res = await stage(w);
    expect(res.statusCode).toBe(201);
    expect(JSON.stringify(res.json())).not.toContain(FAKE_NUMBER);
    const detail = await call(w.owner, "GET", `${w.base}/${res.json().batch.id}`);
    expect(JSON.stringify(detail.json())).not.toContain(FAKE_NUMBER);
    const { rows } = await admin.query<{ source_name: string; account_ref_last4: string | null }>(
      "SELECT source_name, account_ref_last4 FROM import_accounts WHERE business_id = $1", [w.biz]);
    expect(rows.find((r) => r.source_name === "Test Checking")!.account_ref_last4).toBe("6666");
    // The number must appear in no stored text column at all.
    const dump = await admin.query<{ hit: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM import_batches WHERE business_id = $1 AND summary::text LIKE '%' || $2 || '%')
            OR EXISTS (SELECT 1 FROM import_entries WHERE business_id = $1 AND issues::text LIKE '%' || $2 || '%')
            OR EXISTS (SELECT 1 FROM audit_log WHERE business_id = $1 AND (before::text LIKE '%' || $2 || '%' OR after::text LIKE '%' || $2 || '%'))) AS hit`,
      [w.biz, FAKE_NUMBER]);
    expect(dump.rows[0]!.hit).toBe(false);
  });

  it("refuses the same file twice, until the first batch is rejected", async () => {
    const w = await world();
    const first = await stage(w);
    expect(first.statusCode).toBe(201);
    expect((await stage(w)).statusCode).toBe(409);
    expect((await call(w.owner, "POST", `${w.base}/${first.json().batch.id}/reject`)).statusCode).toBe(200);
    expect((await stage(w)).statusCode).toBe(201);
    expect(await actions(w)).toEqual(expect.arrayContaining(["import.stage", "import.reject"]));
  });

  it("rejects files that are not a Wave journal export", async () => {
    const w = await world();
    expect((await upload(w.people["bookkeeper"]!, w.base, "%PDF-1.4 not a csv", "application/pdf")).statusCode).toBe(415);
    expect((await upload(w.people["bookkeeper"]!, w.base, "a,b\r\n1,2\r\n")).statusCode).toBe(422);
    expect((await upload(w.people["bookkeeper"]!, w.base, "")).statusCode).toBe(400);
    expect((await call(w.owner, "GET", w.base)).json().batches).toEqual([]);
  });

  it("pre-excludes entries an earlier import already posted", async () => {
    const w = await world();
    const first = (await stage(w)).json();
    // Simulate approval of T1 by an earlier import: a real transaction plus its imported_refs row.
    const owner = w.owner.id;
    const txn = await admin.query<{ id: string }>(
      `INSERT INTO transactions (id, business_id, kind, date, description, created_by)
       VALUES (gen_random_uuid(), $1, 'journal', '2024-01-15', 'earlier import', $2) RETURNING id`, [w.biz, owner]);
    await admin.query(
      `INSERT INTO imported_refs (business_id, source, external_id, transaction_id, batch_id)
       VALUES ($1, 'wave_journal', $2, $3, $4)`, [w.biz, T1, txn.rows[0]!.id, first.batch.id]);
    expect((await call(w.owner, "POST", `${w.base}/${first.batch.id}/reject`)).statusCode).toBe(200);

    const again = await stage(w, OVERLAP);
    expect(again.statusCode).toBe(201);
    expect(again.json().batch.summary.staged.alreadyImported).toBe(1);
    const entries = (await call(w.owner, "GET", `${w.base}/${again.json().batch.id}/entries`)).json().entries as {
      externalId: string; excluded: boolean; issues: { code: string }[];
    }[];
    const t1 = entries.find((e) => e.externalId === T1)!;
    expect(t1.excluded).toBe(true);
    expect(t1.issues.map((i) => i.code)).toContain("already_imported");
    expect(entries.find((e) => e.externalId === "1000000000000000004")!.excluded).toBe(false);
  });
});

// ---------------------------------------------------------------- review
describe("imports: review", () => {
  it("maps accounts to an existing account, a new one, or back to undecided", async () => {
    const w = await world();
    const bid: string = (await stage(w)).json().batch.id;
    const checking = await importAccountId(w, bid, "Test Checking");
    const url = `${w.base}/${bid}/accounts/${checking}/mapping`;

    const target = await call(w.people["bookkeeper"]!, "PUT", url, { kind: "target", accountId: w.acct("1010") });
    expect(target.statusCode).toBe(200);
    expect(target.json().account).toMatchObject({ targetAccountId: w.acct("1010"), createName: null });

    const create = await call(w.owner, "PUT", url, { kind: "create", name: "Imported Checking", type: "asset" });
    expect(create.statusCode).toBe(200);
    expect(create.json().account).toMatchObject({ targetAccountId: null, createName: "Imported Checking", createType: "asset" });

    const clear = await call(w.owner, "PUT", url, { kind: "clear" });
    expect(clear.json().account).toMatchObject({ targetAccountId: null, createName: null, createType: null });

    expect((await call(w.owner, "PUT", url, { kind: "target", accountId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await call(w.owner, "PUT", url, { kind: "create", name: "  ", type: "asset" })).statusCode).toBe(400);
    expect((await call(w.owner, "PUT", url, { kind: "create", name: "X", type: "bogus" })).statusCode).toBe(400);
    expect(await actions(w)).toContain("import.map");
  });

  it("will not map to an account from another business", async () => {
    const w = await world();
    const other = await world();
    const bid: string = (await stage(w)).json().batch.id;
    const aid = await importAccountId(w, bid, "Test Checking");
    const res = await call(w.owner, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, { kind: "target", accountId: other.acct("1010") });
    expect(res.statusCode).toBe(404);
  });

  it("becomes ready once the invalid entry is excluded and every used account is decided", async () => {
    const w = await world();
    const bid: string = (await stage(w)).json().batch.id;
    for (const [name, code] of [["Test Checking", "1010"], ["Test Income", "4000"], ["Test Supplies", "6000"]] as const) {
      const aid = await importAccountId(w, bid, name);
      const target = w.acct(code);
      expect((await call(w.owner, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, { kind: "target", accountId: target })).statusCode).toBe(200);
    }
    const mid = (await call(w.owner, "GET", `${w.base}/${bid}`)).json();
    expect(mid.blockers).toMatchObject({ invalidEntries: 1, unmappedAccounts: 0, ready: false });

    const invalid = (await call(w.owner, "GET", `${w.base}/${bid}/entries?status=invalid`)).json().entries as { id: string }[];
    expect(invalid).toHaveLength(1);
    const ex = await call(w.people["bookkeeper"]!, "PATCH", `${w.base}/${bid}/entries/${invalid[0]!.id}`, { excluded: true });
    expect(ex.statusCode).toBe(200);
    expect(ex.json()).toMatchObject({ excluded: true, blockers: { invalidEntries: 0, unmappedAccounts: 0, ready: true } });

    // Putting it back re-blocks; repeating a change is a no-op and writes no second audit row.
    const back = await call(w.owner, "PATCH", `${w.base}/${bid}/entries/${invalid[0]!.id}`, { excluded: false });
    expect(back.json().blockers.ready).toBe(false);
    await call(w.owner, "PATCH", `${w.base}/${bid}/entries/${invalid[0]!.id}`, { excluded: false });
    expect((await actions(w)).filter((a) => a === "import.include")).toHaveLength(1);
    expect(await ledgerLineCount(w)).toBe(0);
  });

  it("freezes a rejected batch", async () => {
    const w = await world();
    const bid: string = (await stage(w)).json().batch.id;
    const aid = await importAccountId(w, bid, "Test Checking");
    const eid: string = (await call(w.owner, "GET", `${w.base}/${bid}/entries`)).json().entries[0].id;
    const rej = await call(w.owner, "POST", `${w.base}/${bid}/reject`);
    expect(rej.statusCode).toBe(200);
    expect(rej.json().batch.status).toBe("rejected");

    expect((await call(w.owner, "POST", `${w.base}/${bid}/reject`)).statusCode).toBe(409);
    expect((await call(w.owner, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, { kind: "clear" })).statusCode).toBe(409);
    expect((await call(w.owner, "PATCH", `${w.base}/${bid}/entries/${eid}`, { excluded: true })).statusCode).toBe(409);
    expect((await call(w.owner, "GET", `${w.base}/${bid}`)).statusCode).toBe(200); // still readable for audit
  });
});

// ---------------------------------------------------------------- approval
describe("imports: approval", () => {
  it("is writer-only, reports blockers as a 409 body, then posts everything in one go", async () => {
    const w = await world();
    const up = await stage(w);
    expect(up.statusCode).toBe(201);
    const bid: string = up.json().batch.id;
    const url = `${w.base}/${bid}/approve`;

    // Viewers cannot approve; anonymous callers are not signed in.
    expect((await call(w.people["viewer"]!, "POST", url)).statusCode).toBe(403);
    expect((await call(null, "POST", url)).statusCode).toBe(401);

    // Blocked: one invalid entry and three undecided accounts. The body says exactly what.
    const blocked = await call(w.people["bookkeeper"]!, "POST", url);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().blockers.invalidEntries).toBe(1);
    expect(blocked.json().blockers.unmappedAccounts.map((a: { sourceName: string }) => a.sourceName).sort())
      .toEqual(["Test Checking", "Test Income", "Test Supplies"]);
    expect(await ledgerLineCount(w)).toBe(0);

    // Map. A class mismatch (Income account onto an asset account) is refused with 422.
    const chk = await importAccountId(w, bid, "Test Checking");
    const inc = await importAccountId(w, bid, "Test Income");
    const sup = await importAccountId(w, bid, "Test Supplies");
    const put = (aid: string, body: unknown) => call(w.owner, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, body);
    expect((await put(inc, { kind: "target", accountId: w.acct("1010") })).statusCode).toBe(422);
    expect((await put(chk, { kind: "target", accountId: w.acct("1010") })).statusCode).toBe(200);
    expect((await put(inc, { kind: "create", name: "Imported Income", type: "income" })).statusCode).toBe(200);
    expect((await put(sup, { kind: "create", name: "Imported Supplies", type: "expense" })).statusCode).toBe(200);

    // Still blocked by the invalid entry until it is excluded.
    const still = await call(w.owner, "POST", url);
    expect(still.statusCode).toBe(409);
    expect(still.json().blockers.unmappedAccounts).toEqual([]);
    const invalidId: string = (await call(w.owner, "GET", `${w.base}/${bid}/entries?status=invalid`)).json().entries[0].id;
    expect((await call(w.owner, "PATCH", `${w.base}/${bid}/entries/${invalidId}`, { excluded: true })).statusCode).toBe(200);

    const ok = await call(w.people["bookkeeper"]!, "POST", url);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ posted: 2, accountsCreated: 2, alreadyImported: 0 });
    expect(ok.json().batch.status).toBe("approved");
    expect(await ledgerLineCount(w)).toBe(4);

    const acts = await actions(w);
    expect(acts).toContain("import.approve");
    expect(acts.filter((a) => a === "account.create")).toHaveLength(2);

    // Terminal: a second approval is a conflict and posts nothing more.
    expect((await call(w.owner, "POST", url)).statusCode).toBe(409);
    expect(await ledgerLineCount(w)).toBe(4);
    // And the approved batch still reads fine for audit.
    expect((await call(w.people["viewer"]!, "GET", `${w.base}/${bid}`)).statusCode).toBe(200);
  });

  it("will not approve into locked books and names the earliest locked date", async () => {
    const w = await world();
    const bid: string = (await stage(w)).json().batch.id;
    const chk = await importAccountId(w, bid, "Test Checking");
    const inc = await importAccountId(w, bid, "Test Income");
    const sup = await importAccountId(w, bid, "Test Supplies");
    const put = (aid: string, body: unknown) => call(w.owner, "PUT", `${w.base}/${bid}/accounts/${aid}/mapping`, body);
    await put(chk, { kind: "target", accountId: w.acct("1010") });
    await put(inc, { kind: "target", accountId: w.acct("4000") });
    await put(sup, { kind: "create", name: "Imported Supplies", type: "expense" });
    const invalidId: string = (await call(w.owner, "GET", `${w.base}/${bid}/entries?status=invalid`)).json().entries[0].id;
    await call(w.owner, "PATCH", `${w.base}/${bid}/entries/${invalidId}`, { excluded: true });
    await admin.query("UPDATE businesses SET books_locked_through = '2024-01-15' WHERE id = $1", [w.biz]);

    const res = await call(w.owner, "POST", `${w.base}/${bid}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().blockers.lockedEntries).toEqual({ count: 1, lockedThrough: "2024-01-15", earliest: "2024-01-15" });
    expect(await ledgerLineCount(w)).toBe(0);
  });
});
