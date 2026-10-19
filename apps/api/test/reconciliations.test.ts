import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postTransaction, voidTransaction, withTenant } from "@riffle/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { attachmentDisposition, detectContentType, sanitizeFilename } from "../src/vault";

const adminUrl = process.env["TEST_ADMIN_URL"];
const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });
const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
const MAX_UPLOAD = 2048;

let app: FastifyInstance;
let storageRoot: string;
let sandbox: string;

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "riffle-vault-test-"));
  storageRoot = join(sandbox, "statements");
  app = await buildApp({
    pool,
    config: {
      secureCookies: false, allowRegistration: true, trustedOrigins: [],
      statementStorageDir: storageRoot, maxUploadBytes: MAX_UPLOAD,
    },
  });
});
afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), admin.end()]);
  rmSync(sandbox, { recursive: true, force: true });
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

function call(c: Client | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: c ? { cookie: c.cookie } : {},
  });
}

const PDF = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const CSV = Buffer.from("date,amount\n2026-01-02,1000.00\n");

function multipart(filename: string, type: string, data: Buffer) {
  const boundary = "----riffletest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function upload(c: Client | null, url: string, filename: string, type: string, data: Buffer) {
  const m = multipart(filename, type, data);
  return app.inject({
    method: "POST", url, payload: m.payload, headers: { ...m.headers, ...(c ? { cookie: c.cookie } : {}) },
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
  const post = (date: string, description: string, lines: [string, bigint][]) =>
    withTenant(pool, { userId: owner.id, businessId: biz }, (c) => postTransaction(c, biz, owner.id, {
      kind: "journal", date, description, lines: lines.map(([code, amount]) => ({ accountId: acct(code), amount })),
    }));
  return { biz, owner, people, acct, post, url: `/api/businesses/${biz}/reconciliations` };
}
type World = Awaited<ReturnType<typeof world>>;

async function create(w: World, body: Record<string, unknown>, who = "owner") {
  return call(w.people[who]!, "POST", w.url, { accountId: w.acct("1010"), ...body });
}
async function detail(w: World, rid: string, who = "owner") {
  const res = await call(w.people[who]!, "GET", `${w.url}/${rid}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}
/** World with +1000.00 posted to checking in January and -300.00 in February. */
async function seeded() {
  const w = await world();
  await w.post("2026-01-02", "Contribution", [["1010", 100_000n], ["3100", -100_000n]]);
  await w.post("2026-02-05", "Rent", [["6100", 30_000n], ["1010", -30_000n]]);
  return w;
}
const january = { statementStart: "2026-01-01", statementEnd: "2026-01-31", closingBalance: 100_000 };
const february = { statementStart: "2026-02-01", statementEnd: "2026-02-28", closingBalance: 70_000 };

/** Create a January reconciliation, clear everything suggested and return its id + line ids. */
async function draftWithLines(w: World, body: Record<string, unknown> = january) {
  const res = await create(w, body);
  expect(res.statusCode).toBe(201);
  const rid: string = res.json().reconciliation.id;
  const d = await detail(w, rid);
  return { rid, lineIds: d.suggestedLineIds as string[] };
}
async function completed(w: World, body: Record<string, unknown> = january) {
  const { rid, lineIds } = await draftWithLines(w, body);
  expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds })).statusCode).toBe(200);
  const res = await call(w.owner, "POST", `${w.url}/${rid}/complete`);
  expect(res.statusCode).toBe(200);
  return { rid, lineIds };
}

// ---------------------------------------------------------------- reconciliation
describe("reconciliation: lifecycle", () => {
  it("creates, clears lines and completes when the difference is zero", async () => {
    const w = await seeded();
    const created = await create(w, january);
    expect(created.statusCode).toBe(201);
    const rec = created.json().reconciliation;
    expect(rec.status).toBe("draft");
    expect(rec.openingBalanceMinor).toBe("0");
    expect(rec.closingBalanceMinor).toBe("100000");

    const before = await detail(w, rec.id);
    expect(before.summary.differenceMinor).toBe("100000");
    expect(before.summary.balanced).toBe(false);
    expect(before.suggestedLineIds).toHaveLength(1); // the February line is after statement end
    expect(before.candidates).toHaveLength(1);
    expect(before.suggestedTotalMinor).toBe("100000");

    const put = await call(w.owner, "PUT", `${w.url}/${rec.id}/items`, { add: before.suggestedLineIds });
    expect(put.statusCode).toBe(200);
    expect(put.json().added).toHaveLength(1);
    expect(put.json().summary.differenceMinor).toBe("0");
    expect(put.json().summary.balanced).toBe(true);

    const done = await call(w.owner, "POST", `${w.url}/${rec.id}/complete`);
    expect(done.statusCode).toBe(200);
    expect(done.json().reconciliation.status).toBe("completed");
    expect(done.json().reconciliation.completedBy).toBe(w.owner.id);
    expect(done.json().cleared).toHaveLength(1);

    const list = await call(w.people["viewer"]!, "GET", `${w.url}?status=completed`);
    expect(list.json().reconciliations.map((r: { id: string }) => r.id)).toEqual([rec.id]);

    const audits = await admin.query(
      "SELECT action FROM audit_log WHERE business_id=$1 AND entity_id=$2 ORDER BY id", [w.biz, rec.id]);
    expect(audits.rows.map((r) => r.action)).toEqual(["reconciliation.create", "reconciliation.items", "reconciliation.complete"]);
  });

  it("signs liability accounts the way a statement prints them", async () => {
    const w = await world();
    await w.post("2026-01-05", "Card purchase", [["6100", 4_500n], ["2100", -4_500n]]);
    const res = await call(w.owner, "POST", w.url, { ...january, accountId: w.acct("2100"), closingBalance: 4_500 });
    expect(res.statusCode).toBe(201);
    const d = await detail(w, res.json().reconciliation.id);
    expect(d.candidates[0].amountMinor).toBe("-4500");
    expect(d.candidates[0].statementAmountMinor).toBe("4500");
    expect(d.suggestedTotalMinor).toBe("4500");
  });

  it("rejects completion while the difference is not zero, and changes nothing", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const res = await call(w.owner, "POST", `${w.url}/${rid}/complete`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("difference");
    expect((await detail(w, rid)).reconciliation.status).toBe("draft");
  });

  it("rejects a wrong-account, post-statement-end or unknown line", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const all = (await admin.query("SELECT id, account_id FROM journal_lines WHERE business_id=$1", [w.biz])).rows;
    const other = all.find((l) => l.account_id !== w.acct("1010"))!;
    expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: [other.id] })).statusCode).toBe(422);

    const feb = (await admin.query(
      "SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.business_id=$1 AND l.account_id=$2 AND e.entry_date='2026-02-05'",
      [w.biz, w.acct("1010")])).rows[0]!;
    expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: [feb.id] })).statusCode).toBe(422);
    expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: [crypto.randomUUID()] })).statusCode).toBe(422);
  });

  it("only one draft per account; only asset/liability accounts; end not before start", async () => {
    const w = await seeded();
    expect((await create(w, january)).statusCode).toBe(201);
    expect((await create(w, february)).statusCode).toBe(409);
    expect((await call(w.owner, "POST", w.url, { ...january, accountId: w.acct("6100") })).statusCode).toBe(422);
    expect((await call(w.owner, "POST", w.url, { ...january, accountId: w.acct("2100"), statementEnd: "2025-12-31" })).statusCode).toBe(422);
  });
});

describe("reconciliation: opening balance chain", () => {
  it("defaults to, and must match, the previous completed closing balance", async () => {
    const w = await seeded();
    await completed(w);

    const bad = await create(w, { ...february, openingBalance: 99_999 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toContain("opening balance");

    const stale = await create(w, { statementStart: "2026-01-15", statementEnd: "2026-01-31", closingBalance: 1 });
    expect(stale.statusCode).toBe(422); // must end after the previous one

    const ok = await create(w, february);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().reconciliation.openingBalanceMinor).toBe("100000");
  });

  it("completes a second period whose opening carries the first closing", async () => {
    const w = await seeded();
    await completed(w);
    const res = await create(w, { ...february, openingBalance: "100000" });
    expect(res.statusCode).toBe(201);
    const rid = res.json().reconciliation.id;
    const d = await detail(w, rid);
    expect(d.suggestedLineIds).toHaveLength(1);
    expect(d.suggestedTotalMinor).toBe("-30000");
    await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: d.suggestedLineIds });
    const done = await call(w.owner, "POST", `${w.url}/${rid}/complete`);
    expect(done.statusCode).toBe(200);
    expect(done.json().summary.balanced).toBe(true);
  });
});

describe("reconciliation: access control", () => {
  it("returns 401 without a session", async () => {
    const w = await seeded();
    expect((await call(null, "GET", w.url)).statusCode).toBe(401);
    expect((await call(null, "POST", w.url, { ...january, accountId: w.acct("1010") })).statusCode).toBe(401);
  });

  it("lets viewers read but gives 403 on every write", async () => {
    const w = await seeded();
    const { rid, lineIds } = await draftWithLines(w);
    const viewer = w.people["viewer"]!;
    expect((await call(viewer, "GET", w.url)).statusCode).toBe(200);
    expect((await call(viewer, "GET", `${w.url}/${rid}`)).statusCode).toBe(200);

    expect((await create(w, february, "viewer")).statusCode).toBe(403);
    expect((await call(viewer, "PUT", `${w.url}/${rid}/items`, { add: lineIds })).statusCode).toBe(403);
    expect((await call(viewer, "POST", `${w.url}/${rid}/complete`)).statusCode).toBe(403);
    expect((await call(viewer, "POST", `${w.url}/${rid}/void`)).statusCode).toBe(403);
    expect((await upload(viewer, `${w.url}/${rid}/documents`, "s.pdf", "application/pdf", PDF)).statusCode).toBe(403);

    const doc = await upload(w.owner, `${w.url}/${rid}/documents`, "s.pdf", "application/pdf", PDF);
    expect(doc.statusCode).toBe(201);
    expect((await call(viewer, "DELETE", `${w.url}/${rid}/documents/${doc.json().document.id}`)).statusCode).toBe(403);
    expect((await call(viewer, "GET", `${w.url}/${rid}/documents/${doc.json().document.id}`)).statusCode).toBe(200);

    // The viewer's attempts changed nothing.
    expect((await detail(w, rid)).cleared).toHaveLength(0);
    expect((await detail(w, rid)).reconciliation.status).toBe("draft");
  });

  it("lets bookkeepers and admins write", async () => {
    const w = await seeded();
    const res = await create(w, january, "bookkeeper");
    expect(res.statusCode).toBe(201);
    expect((await call(w.people["admin"]!, "POST", `${w.url}/${res.json().reconciliation.id}/void`)).statusCode).toBe(200);
  });

  it("isolates tenants (404 across businesses, RLS hides rows, foreign lines are unknown)", async () => {
    const a = await seeded();
    const b = await seeded();
    const { rid, lineIds } = await completed(a);
    const doc = await upload(a.owner, `${a.url}/${rid}/documents`, "a.pdf", "application/pdf", PDF);
    expect(doc.statusCode).toBe(201);
    const docId: string = doc.json().document.id;

    // B's owner against A's business, and A's ids under B's business.
    expect((await call(b.owner, "GET", `${a.url}/${rid}`)).statusCode).toBe(404);
    expect((await call(b.owner, "GET", a.url)).statusCode).toBe(404);
    expect((await call(b.owner, "GET", `${a.url}/${rid}/documents/${docId}`)).statusCode).toBe(404);
    expect((await call(b.owner, "GET", `${b.url}/${rid}`)).statusCode).toBe(404);
    expect((await call(b.owner, "GET", `${b.url}/${rid}/documents/${docId}`)).statusCode).toBe(404);
    expect((await call(b.owner, "POST", `${b.url}/${rid}/void`)).statusCode).toBe(404);
    expect((await call(b.owner, "DELETE", `${b.url}/${rid}/documents/${docId}`)).statusCode).toBe(404);
    // A's own cookie cannot reach B either.
    expect((await call(a.owner, "GET", `${b.url}`)).statusCode).toBe(404);

    // B cannot clear A's line in B's draft.
    const bDraft = await draftWithLines(b);
    const foreign = await call(b.owner, "PUT", `${b.url}/${bDraft.rid}/items`, { add: lineIds });
    expect(foreign.statusCode).toBe(422);
    expect((await call(a.owner, "GET", `${a.url}/${rid}`)).json().cleared).toHaveLength(1);

    // Row-level security, independent of the route layer.
    const seen = await withTenant(pool, { userId: b.owner.id, businessId: b.biz }, async (c) => ({
      recs: (await c.query("SELECT id FROM reconciliations WHERE id = $1", [rid])).rowCount,
      items: (await c.query("SELECT id FROM reconciliation_items WHERE reconciliation_id = $1", [rid])).rowCount,
      docs: (await c.query("SELECT id FROM statement_documents WHERE id = $1", [docId])).rowCount,
    }));
    expect(seen).toEqual({ recs: 0, items: 0, docs: 0 });
    await expect(withTenant(pool, { userId: b.owner.id, businessId: b.biz }, (c) =>
      c.query(
        `INSERT INTO reconciliations (id, business_id, account_id, statement_start, statement_end, opening_balance_minor, closing_balance_minor, created_by)
         VALUES ($1,$2,$3,'2026-03-01','2026-03-31',0,0,$4)`,
        [crypto.randomUUID(), a.biz, a.acct("1010"), b.owner.id]))).rejects.toThrow();
  });
});

describe("reconciliation: line exclusivity, void and immutability", () => {
  it("rejects clearing a line twice, even from another reconciliation", async () => {
    const w = await seeded();
    const first = await completed(w);
    const second = await create(w, february);
    expect(second.statusCode).toBe(201);
    const res = await call(w.owner, "PUT", `${w.url}/${second.json().reconciliation.id}/items`, { add: first.lineIds });
    // Not even offered as a candidate, and an explicit attempt is a conflict.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already cleared");
    const d = await detail(w, second.json().reconciliation.id);
    expect(d.candidates.some((c: { lineId: string }) => first.lineIds.includes(c.lineId))).toBe(false);
  });

  it("treats re-adding a line to the same draft as a no-op", async () => {
    const w = await seeded();
    const { rid, lineIds } = await draftWithLines(w);
    await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds });
    const again = await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds });
    expect(again.statusCode).toBe(200);
    expect(again.json().added).toHaveLength(0);
    expect(again.json().cleared).toHaveLength(1);
  });

  it("prevents two concurrent drafts from clearing the same line (DB-level)", async () => {
    const w = await seeded();
    const first = await completed(w);
    const other = await admin.query(
      `INSERT INTO reconciliations (id, business_id, account_id, statement_start, statement_end, opening_balance_minor, closing_balance_minor, created_by)
       VALUES ($1,$2,$3,'2026-02-01','2026-02-28',100000,0,$4) RETURNING id`,
      [crypto.randomUUID(), w.biz, w.acct("1010"), w.owner.id]);
    await expect(admin.query(
      `INSERT INTO reconciliation_items (id, business_id, reconciliation_id, line_id, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [crypto.randomUUID(), w.biz, other.rows[0].id, first.lineIds[0], w.owner.id])).rejects.toThrow(/duplicate key|unique/);
  });

  it("void releases the lines so they can be cleared again", async () => {
    const w = await seeded();
    const first = await completed(w);
    const voided = await call(w.owner, "POST", `${w.url}/${first.rid}/void`);
    expect(voided.statusCode).toBe(200);
    expect(voided.json().reconciliation.status).toBe("voided");
    expect(voided.json().reconciliation.voidedBy).toBe(w.owner.id);
    const rows = await admin.query("SELECT voided_at FROM reconciliation_items WHERE reconciliation_id=$1", [first.rid]);
    expect(rows.rows.every((r) => r.voided_at !== null)).toBe(true);

    // Same period again: line is available and the chain restarts from zero.
    const again = await create(w, january);
    expect(again.statusCode).toBe(201);
    expect(again.json().reconciliation.openingBalanceMinor).toBe("0");
    const d = await detail(w, again.json().reconciliation.id);
    expect(d.suggestedLineIds).toEqual(first.lineIds);
    expect((await call(w.owner, "PUT", `${w.url}/${again.json().reconciliation.id}/items`, { add: first.lineIds })).statusCode).toBe(200);

    // Voiding twice is a conflict; a voided reconciliation is frozen.
    expect((await call(w.owner, "POST", `${w.url}/${first.rid}/void`)).statusCode).toBe(409);
    expect((await call(w.owner, "PUT", `${w.url}/${first.rid}/items`, { remove: first.lineIds })).statusCode).toBe(409);
    expect((await call(w.owner, "POST", `${w.url}/${first.rid}/complete`)).statusCode).toBe(409);
  });

  it("voids a draft and refuses to void an earlier completed one before a later one", async () => {
    const w = await seeded();
    const first = await completed(w);
    const second = await completed(w, { ...february, openingBalance: 100_000 });
    const blocked = await call(w.owner, "POST", `${w.url}/${first.rid}/void`);
    expect(blocked.statusCode).toBe(409);
    expect((await call(w.owner, "POST", `${w.url}/${second.rid}/void`)).statusCode).toBe(200);
    expect((await call(w.owner, "POST", `${w.url}/${first.rid}/void`)).statusCode).toBe(200);
  });

  it("freezes completed items at the API and the database", async () => {
    const w = await seeded();
    const { rid, lineIds } = await completed(w);
    expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { remove: lineIds })).statusCode).toBe(409);
    expect((await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds })).statusCode).toBe(409);

    await expect(admin.query("DELETE FROM reconciliation_items WHERE reconciliation_id=$1", [rid])).rejects.toThrow(/cannot be removed/);
    await expect(admin.query("UPDATE reconciliation_items SET line_id = $2 WHERE reconciliation_id=$1", [rid, crypto.randomUUID()]))
      .rejects.toThrow(/immutable/);
    await expect(admin.query("UPDATE reconciliations SET closing_balance_minor = 1 WHERE id=$1", [rid])).rejects.toThrow(/immutable/);
    await expect(admin.query("UPDATE reconciliations SET status = 'draft', completed_at = NULL, completed_by = NULL WHERE id=$1", [rid]))
      .rejects.toThrow();
    await expect(admin.query("DELETE FROM reconciliations WHERE id=$1", [rid])).rejects.toThrow(/cannot be deleted/);

    // The riffle_app role cannot delete reconciliations at all.
    await expect(withTenant(pool, { userId: w.owner.id, businessId: w.biz }, (c) =>
      c.query("DELETE FROM reconciliations WHERE id=$1", [rid]))).rejects.toThrow();
  });

  it("refuses to reverse a transaction that a completed reconciliation cleared", async () => {
    const w = await world();
    const posted = await w.post("2026-01-02", "Contribution", [["1010", 100_000n], ["3100", -100_000n]]);
    const { rid } = await completed(w);
    await expect(withTenant(pool, { userId: w.owner.id, businessId: w.biz }, (c) =>
      voidTransaction(c, w.biz, w.owner.id, posted.transactionId))).rejects.toThrow(/reconciliation/);
    // After voiding the reconciliation the transaction can be voided again.
    expect((await call(w.owner, "POST", `${w.url}/${rid}/void`)).statusCode).toBe(200);
    await withTenant(pool, { userId: w.owner.id, businessId: w.biz }, (c) =>
      voidTransaction(c, w.biz, w.owner.id, posted.transactionId));
  });

  it("flags lines whose transaction was voided while the reconciliation was a draft", async () => {
    const w = await world();
    const posted = await w.post("2026-01-02", "Contribution", [["1010", 100_000n], ["3100", -100_000n]]);
    const { rid } = await draftWithLines(w);
    const lineIds = (await detail(w, rid)).suggestedLineIds;
    await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds });
    await withTenant(pool, { userId: w.owner.id, businessId: w.biz }, (c) =>
      voidTransaction(c, w.biz, w.owner.id, posted.transactionId));
    const d = await detail(w, rid);
    expect(d.summary.staleCount).toBe(1);
    expect(d.cleared[0].stale).toBe(true);
    const done = await call(w.owner, "POST", `${w.url}/${rid}/complete`);
    expect(done.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- vault unit
describe("vault helpers", () => {
  it("detects content from bytes", () => {
    expect(detectContentType(PDF)).toBe("application/pdf");
    expect(detectContentType(PNG)).toBe("image/png");
    expect(detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(detectContentType(CSV)).toBe("text/csv");
    expect(detectContentType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectContentType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectContentType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull(); // PE/EXE
    expect(detectContentType(Buffer.alloc(0))).toBeNull();
  });
  it("sanitises filenames and builds a safe disposition header", () => {
    expect(sanitizeFilename("../../x.pdf")).toBe("x.pdf");
    expect(sanitizeFilename("..\\..\\win.pdf")).toBe("win.pdf");
    expect(sanitizeFilename("..")).toBe("statement");
    expect(sanitizeFilename(undefined)).toBe("statement");
    expect(sanitizeFilename('a"b\r\nSet-Cookie: x.pdf')).not.toMatch(/[\r\n"]/);
    const h = attachmentDisposition('é"\r\n.pdf');
    expect(h.startsWith("attachment;")).toBe(true);
    expect(h).not.toMatch(/[\r\n]/);
  });
});

// ---------------------------------------------------------------- vault http
describe("statement vault", () => {
  it("uploads, lists, downloads as an attachment with nosniff, and records audit + sha256", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const up = await upload(w.people["bookkeeper"]!, `${w.url}/${rid}/documents`, "Jan statement.pdf", "application/pdf", PDF);
    expect(up.statusCode).toBe(201);
    const doc = up.json().document;
    expect(doc.filename).toBe("Jan statement.pdf");
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.sizeBytes).toBe(PDF.length);
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.storageKey).toBeUndefined();
    expect(up.body).not.toContain(storageRoot);

    const list = await call(w.people["viewer"]!, "GET", `${w.url}/${rid}/documents`);
    expect(list.json().documents).toHaveLength(1);
    expect((await detail(w, rid)).documents).toHaveLength(1);

    const dl = await call(w.people["viewer"]!, "GET", `${w.url}/${rid}/documents/${doc.id}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    expect(String(dl.headers["content-disposition"])).toMatch(/^attachment;/);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl.headers["cache-control"]).toContain("no-store");

    const a = await admin.query("SELECT action FROM audit_log WHERE business_id=$1 AND entity_id=$2", [w.biz, doc.id]);
    expect(a.rows.map((r) => r.action)).toEqual(["statement.upload"]);
  });

  it("accepts PNG and CSV uploads", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    expect((await upload(w.owner, `${w.url}/${rid}/documents`, "scan.png", "image/png", PNG)).statusCode).toBe(201);
    expect((await upload(w.owner, `${w.url}/${rid}/documents`, "export.csv", "text/csv", CSV)).statusCode).toBe(201);
  });

  it("rejects disallowed types, mismatched magic bytes, empty files and non-multipart bodies", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const url = `${w.url}/${rid}/documents`;
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

    expect((await upload(w.owner, url, "a.exe", "application/x-msdownload", exe)).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.html", "text/html", Buffer.from("<script>1</script>"))).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.svg", "image/svg+xml", Buffer.from("<svg/>"))).statusCode).toBe(415);
    // Claimed type allowed, bytes say otherwise.
    expect((await upload(w.owner, url, "a.pdf", "application/pdf", PNG)).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.png", "image/png", PDF)).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.pdf", "application/pdf", exe)).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.csv", "text/csv", Buffer.from("<html>x</html>"))).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.csv", "text/csv", Buffer.from([0x00, 0x01, 0x02, 0x03]))).statusCode).toBe(415);
    expect((await upload(w.owner, url, "a.pdf", "application/pdf", Buffer.alloc(0))).statusCode).toBe(400);
    expect((await call(w.owner, "POST", url, { hello: "world" })).statusCode).toBe(415);

    expect((await call(w.owner, "GET", url)).json().documents).toHaveLength(0);
  });

  it("rejects oversize uploads and leaves no file or row behind", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD * 2, 0x41)]);
    const res = await upload(w.owner, `${w.url}/${rid}/documents`, "big.pdf", "application/pdf", big);
    expect(res.statusCode).toBe(413);
    expect((await call(w.owner, "GET", `${w.url}/${rid}/documents`)).json().documents).toHaveLength(0);
    // Exactly at the limit is fine.
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD - PDF.length, 0x20)]);
    expect((await upload(w.owner, `${w.url}/${rid}/documents`, "ok.pdf", "application/pdf", exact)).statusCode).toBe(201);
  });

  it("cannot be steered outside the storage directory by a hostile filename", async () => {
    const w = await seeded();
    const { rid } = await draftWithLines(w);
    const names = ["../../x.pdf", "..%2F..%2Fx.pdf", "..\\..\\x.pdf", "/etc/passwd", 'a"; filename*=UTF-8\'\'evil.pdf'];
    for (const name of names) {
      const res = await upload(w.owner, `${w.url}/${rid}/documents`, name, "application/pdf", PDF);
      expect(res.statusCode).toBe(201);
      const doc = res.json().document;
      expect(doc.filename).not.toMatch(/[\\/"]/);
      const dl = await call(w.owner, "GET", `${w.url}/${rid}/documents/${doc.id}`);
      expect(dl.statusCode).toBe(200);
      expect(String(dl.headers["content-disposition"])).toMatch(/^attachment;/);
      expect(String(dl.headers["content-disposition"])).not.toMatch(/\.\.[/\\]/);
    }
    // Nothing was written next to, or above, the vault.
    expect(existsSync(join(sandbox, "x.pdf"))).toBe(false);
    expect(existsSync(join(storageRoot, "x.pdf"))).toBe(false);
    expect(existsSync(join(storageRoot, "..", "x.pdf"))).toBe(false);
    expect(readdirSync(sandbox)).toEqual(["statements"]);
    // Every stored file is <business>/<uuid>, nothing else.
    const bizDir = join(storageRoot, w.biz);
    expect(statSync(bizDir).isDirectory()).toBe(true);
    for (const f of readdirSync(bizDir)) expect(f).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(bizDir)).toHaveLength(names.length);
    const keys = (await admin.query("SELECT storage_key FROM statement_documents WHERE business_id=$1", [w.biz])).rows;
    for (const k of keys) expect(k.storage_key).toMatch(new RegExp(`^${w.biz}/[0-9a-f-]{36}$`));
  });

  it("enforces tenancy on download", async () => {
    const a = await seeded();
    const b = await seeded();
    const { rid } = await draftWithLines(a);
    const up = await upload(a.owner, `${a.url}/${rid}/documents`, "s.pdf", "application/pdf", PDF);
    const docId = up.json().document.id;
    expect((await call(null, "GET", `${a.url}/${rid}/documents/${docId}`)).statusCode).toBe(401);
    expect((await call(b.owner, "GET", `${a.url}/${rid}/documents/${docId}`)).statusCode).toBe(404);
    expect((await call(b.owner, "GET", `${b.url}/${rid}/documents/${docId}`)).statusCode).toBe(404);
    // Right business, wrong reconciliation.
    const other = await call(a.owner, "POST", a.url, { ...february, accountId: a.acct("2100") , closingBalance: 0 });
    expect(other.statusCode).toBe(201);
    expect((await call(a.owner, "GET", `${a.url}/${other.json().reconciliation.id}/documents/${docId}`)).statusCode).toBe(404);
    expect((await call(a.owner, "GET", `${a.url}/${rid}/documents/${docId}`)).statusCode).toBe(200);
  });

  it("deletes documents only while the reconciliation is a draft", async () => {
    const w = await seeded();
    const { rid, lineIds } = await draftWithLines(w);
    const url = `${w.url}/${rid}/documents`;
    const d1 = (await upload(w.owner, url, "one.pdf", "application/pdf", PDF)).json().document.id;
    const d2 = (await upload(w.owner, url, "two.pdf", "application/pdf", PDF)).json().document.id;

    const key = (await admin.query("SELECT storage_key FROM statement_documents WHERE id=$1", [d1])).rows[0].storage_key;
    expect(existsSync(join(storageRoot, key))).toBe(true);
    expect((await call(w.owner, "DELETE", `${url}/${d1}`)).statusCode).toBe(204);
    expect(existsSync(join(storageRoot, key))).toBe(false);
    expect((await call(w.owner, "GET", `${url}/${d1}`)).statusCode).toBe(404);
    expect((await call(w.owner, "DELETE", `${url}/${d1}`)).statusCode).toBe(404);

    await call(w.owner, "PUT", `${w.url}/${rid}/items`, { add: lineIds });
    expect((await call(w.owner, "POST", `${w.url}/${rid}/complete`)).statusCode).toBe(200);
    const blocked = await call(w.owner, "DELETE", `${url}/${d2}`);
    expect(blocked.statusCode).toBe(409);
    expect((await call(w.owner, "GET", `${url}/${d2}`)).statusCode).toBe(200);
    // Still attachable after completion (e.g. the PDF arrives late), but not after void.
    expect((await upload(w.owner, url, "late.pdf", "application/pdf", PDF)).statusCode).toBe(201);
    await expect(admin.query("DELETE FROM statement_documents WHERE id=$1", [d2])).rejects.toThrow(/only be deleted/);

    expect((await call(w.owner, "POST", `${w.url}/${rid}/void`)).statusCode).toBe(200);
    expect((await upload(w.owner, url, "after.pdf", "application/pdf", PDF)).statusCode).toBe(409);
    expect((await call(w.owner, "DELETE", `${url}/${d2}`)).statusCode).toBe(409);

    const actions = (await admin.query(
      "SELECT action FROM audit_log WHERE business_id=$1 AND entity_id=$2", [w.biz, d1])).rows.map((r) => r.action);
    expect([...actions].sort()).toEqual(["statement.delete", "statement.upload"]);
  });

  it("404s uploads to an unknown reconciliation", async () => {
    const w = await seeded();
    const res = await upload(w.owner, `${w.url}/${crypto.randomUUID()}/documents`, "s.pdf", "application/pdf", PDF);
    expect(res.statusCode).toBe(404);
  });
});
