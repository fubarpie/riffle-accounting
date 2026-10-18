import { afterAll, describe, expect, it } from "vitest";
import { importConnection } from "../src/import";
import {
  accountSet, admin, captureLog, closePools, connRow, deferred, json, makeDeps, makeFixture,
  mockFetch, SECRET_PASS, stagedFor, until,
} from "./helpers";

afterAll(closePools);

const DAY = 86_400_000;
const T = (id: string, extra: object = {}) => ({ id, ...extra });

describe("importConnection", () => {
  it("stages new transactions for linked accounts and records the sync", async () => {
    const f = await makeFixture();
    const log = captureLog();
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1"), T("A2", { amount: "250.00", description: "CLIENT PAYMENT" })] }])));
    const out = await importConnection(makeDeps({ fetch, log }), f.connectionId);

    expect(out).toMatchObject({ status: "imported", inserted: 2, duplicate: 0, updated: 0, disabled: false });
    const rows = await stagedFor(f.connectionId);
    expect(rows.map((r) => [r.external_id, r.amount_minor, r.status])).toEqual([["A1", "-1250", "new"], ["A2", "25000", "new"]]);
    // Raw payload and logs carry provider facts only, never the access URL.
    expect(JSON.stringify(rows.map((r) => r.raw))).not.toContain(SECRET_PASS);
    expect(log.lines.join("\n")).not.toContain(SECRET_PASS);
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("active");
    expect(c.last_synced_at).not.toBeNull();
    expect(c.last_error).toBeNull();
    // Basic auth moved into the header; the URL passed to fetch has no credentials.
    expect(fetch.calls[0]!.username).toBe("");
    expect(fetch.calls[0]!.href).not.toContain(SECRET_PASS);
  });

  it("is idempotent: re-running the same data inserts nothing", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1"), T("A2")] }])));
    const deps = makeDeps({ fetch });
    await importConnection(deps, f.connectionId);
    const again = await importConnection(deps, f.connectionId);
    expect(again).toMatchObject({ status: "imported", inserted: 0, duplicate: 2, updated: 0 });
    expect(await stagedFor(f.connectionId)).toHaveLength(2);
  });

  it("dedupes the overlap window and fetches from last sync minus 5 days", async () => {
    const f = await makeFixture();
    let phase = 1;
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: phase === 1 ? [T("A1"), T("A2")] : [T("A2"), T("A3")] }])));
    const deps = makeDeps({ fetch });
    await importConnection(deps, f.connectionId);
    phase = 2;
    const second = await importConnection(deps, f.connectionId);

    expect(second).toMatchObject({ inserted: 1, duplicate: 1 });
    expect((await stagedFor(f.connectionId)).map((r) => r.external_id)).toEqual(["A1", "A2", "A3"]);
    const first = fetch.calls[0]!;
    const next = fetch.calls[1]!;
    const secs = (u: URL, k: string) => Number(u.searchParams.get(k)) * 1000;
    expect(Date.now() - secs(first, "start-date")).toBeGreaterThan(89 * DAY); // first sync: full 90 days
    expect(Date.now() - secs(next, "start-date")).toBeGreaterThan(4.9 * DAY);
    expect(Date.now() - secs(next, "start-date")).toBeLessThan(5.1 * DAY);
    expect(next.searchParams.get("pending")).toBe("1");
  });

  it("updates a pending row in place when the bank settles it", async () => {
    const f = await makeFixture();
    let amount = "-10.00";
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("P1", { amount })] }])));
    const deps = makeDeps({ fetch });
    await importConnection(deps, f.connectionId);
    await admin.query("UPDATE staged_transactions SET pending = true WHERE connection_id = $1", [f.connectionId]);
    amount = "-10.40";
    const out = await importConnection(deps, f.connectionId);
    expect(out.updated).toBe(1);
    const rows = await stagedFor(f.connectionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_minor).toBe("-1040");
  });

  it.each([403, 402])("HTTP %i disables the connection and records a re-authorize message", async (status) => {
    const f = await makeFixture();
    const log = captureLog();
    const out = await importConnection(makeDeps({ fetch: mockFetch(() => new Response("no", { status })), log }), f.connectionId);
    expect(out).toMatchObject({ status: "failed", disabled: true });
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("disabled");
    expect(c.last_error).toMatch(/revoked|Re-authorize/i);
    expect(log.lines.join("\n")).not.toContain(SECRET_PASS);
    // A disabled connection is never imported again.
    const fetch = mockFetch(() => json(accountSet([])));
    expect((await importConnection(makeDeps({ fetch }), f.connectionId)).status).toBe("skipped");
    expect(fetch.calls).toHaveLength(0);
  });

  it("HTTP 401 records an error but does not disable (SimpleFIN client maps only 402/403 to revoked)", async () => {
    const f = await makeFixture();
    const out = await importConnection(makeDeps({ fetch: mockFetch(() => new Response("no", { status: 401 })) }), f.connectionId);
    expect(out).toMatchObject({ status: "failed", disabled: false });
    expect((await connRow(f.connectionId)).status).toBe("error");
  });

  it("HTTP 429 backs off using Retry-After and keeps the connection retryable", async () => {
    const f = await makeFixture();
    const out = await importConnection(
      makeDeps({ fetch: mockFetch(() => new Response("slow", { status: 429, headers: { "retry-after": "120" } })) }), f.connectionId);
    expect(out).toMatchObject({ status: "failed", disabled: false, retryAfterMs: 120_000 });
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("error");
    expect(c.last_error).toMatch(/rate limit/i);
    expect(c.last_synced_at).toBeNull();
  });

  it("HTTP 429 without Retry-After defaults to one hour", async () => {
    const f = await makeFixture();
    const out = await importConnection(makeDeps({ fetch: mockFetch(() => new Response("slow", { status: 429 })) }), f.connectionId);
    expect(out.retryAfterMs).toBe(3_600_000);
  });

  it("an errlist rate-limit message also asks the scheduler to back off", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1")] }], [{ code: "gen.rate", msg: "Daily request limit reached" }])));
    const out = await importConnection(makeDeps({ fetch }), f.connectionId);
    expect(out.retryAfterMs).toBe(3_600_000);
  });

  it("persists errlist messages without URLs or credentials, and still counts as a sync", async () => {
    const f = await makeFixture();
    const msg = `Bank said https://user:${SECRET_PASS}@evil.test/path?token=abc failed`;
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1")] }], [{ code: "con.slow", msg }])));
    const log = captureLog();
    const out = await importConnection(makeDeps({ fetch, log }), f.connectionId);
    expect(out.status).toBe("imported");
    const c = await connRow(f.connectionId);
    expect(c.last_synced_at).not.toBeNull();
    expect(c.status).toBe("active");
    expect(c.last_error).toContain("con.slow");
    expect(c.last_error).toContain("[url]");
    for (const bad of [SECRET_PASS, "https://", "evil.test", "token=abc"]) {
      expect(c.last_error).not.toContain(bad);
      expect(JSON.stringify(out)).not.toContain(bad);
      expect(log.lines.join("\n")).not.toContain(bad);
    }
  });

  it("an auth errlist entry stages what it can but is partial and not a success", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1")] }], [{ code: "con.auth", msg: "Please sign in again" }])));
    const out = await importConnection(makeDeps({ fetch }), f.connectionId);
    expect(out).toMatchObject({ status: "partial", inserted: 1 });
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("error");
    expect(c.last_synced_at).toBeNull();
    expect(c.last_error).toMatch(/re-authentication/);
  });

  it("skips unlinked provider accounts and reports them", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(() => json(accountSet([
      { id: "ACT-1", txs: [T("A1")] }, { id: "ACT-X", txs: [T("X1"), T("X2")] },
    ])));
    const out = await importConnection(makeDeps({ fetch }), f.connectionId);
    expect(out).toMatchObject({ status: "imported", inserted: 1, unlinkedAccounts: ["ACT-X"] });
    expect((await stagedFor(f.connectionId)).map((r) => r.external_id)).toEqual(["A1"]);
  });

  it("does not call the bank, or advance last_synced_at, when nothing is linked", async () => {
    const f = await makeFixture({ links: [] });
    const fetch = mockFetch(() => json(accountSet([])));
    const out = await importConnection(makeDeps({ fetch }), f.connectionId);
    expect(out).toMatchObject({ status: "skipped", reason: "no linked accounts" });
    expect(fetch.calls).toHaveLength(0);
    expect((await connRow(f.connectionId)).last_synced_at).toBeNull();
  });

  it("a failing account is rolled back via savepoint without failing the others", async () => {
    const f = await makeFixture({ links: ["BAD", "GOOD"] });
    const fetch = mockFetch(() => json(accountSet([
      { id: "BAD", txs: [T("B1"), T("B2".padEnd(250, "x"))] }, // over-long id: rejected by the store
      { id: "GOOD", txs: [T("G1"), T("G2")] },
    ])));
    const out = await importConnection(makeDeps({ fetch }), f.connectionId);
    expect(out.status).toBe("partial");
    expect(out.inserted).toBe(2);
    expect(out.accountErrors).toHaveLength(1);
    expect(out.accountErrors[0]!.accountId).toBe("BAD");
    expect((await stagedFor(f.connectionId)).map((r) => r.external_id)).toEqual(["G1", "G2"]);
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("error");
    expect(c.last_synced_at).toBeNull(); // not advanced, so the next run re-covers the failed account
    expect(c.last_error).toContain("BAD");
  });

  it("returns 'locked' for a concurrent import of the same connection, then recovers", async () => {
    const f = await makeFixture();
    const gate = deferred();
    const fetch = mockFetch(async () => {
      await gate.promise;
      return json(accountSet([{ id: "ACT-1", txs: [T("A1")] }]));
    });
    const deps = makeDeps({ fetch });
    const first = importConnection(deps, f.connectionId);
    await until(() => fetch.calls.length === 1);

    const second = await importConnection(deps, f.connectionId);
    expect(second.status).toBe("locked");
    expect(fetch.calls).toHaveLength(1); // the loser never reached the bank

    gate.resolve();
    expect((await first).status).toBe("imported");
    // The lock is released afterwards.
    expect((await importConnection(makeDeps({ fetch: mockFetch(() => json(accountSet([{ id: "ACT-1" }]))) }), f.connectionId)).status).toBe("imported");
    expect(await stagedFor(f.connectionId)).toHaveLength(1);
  });

  it("different connections do not block each other", async () => {
    const [a, b] = await Promise.all([makeFixture(), makeFixture()]);
    const gate = deferred();
    const fetch = mockFetch(async () => { await gate.promise; return json(accountSet([{ id: "ACT-1", txs: [T("A1")] }])); });
    const deps = makeDeps({ fetch });
    const pa = importConnection(deps, a.connectionId);
    const pb = importConnection(deps, b.connectionId);
    await until(() => fetch.calls.length === 2);
    gate.resolve();
    expect((await Promise.all([pa, pb])).map((o) => o.status)).toEqual(["imported", "imported"]);
  });

  it("onlyIfDue re-checks under the lock and returns not_due after a fresh sync", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(() => json(accountSet([{ id: "ACT-1", txs: [T("A1")] }])));
    const deps = makeDeps({ fetch });
    expect((await importConnection(deps, f.connectionId, { onlyIfDue: true })).status).toBe("imported");
    expect((await importConnection(deps, f.connectionId, { onlyIfDue: true })).status).toBe("not_due");
    expect(fetch.calls).toHaveLength(1);
    // A manual run ignores dueness.
    expect((await importConnection(deps, f.connectionId)).status).toBe("imported");
  });

  it("reports not_found for an unknown connection and skips a disabled one", async () => {
    const fetch = mockFetch(() => json(accountSet([])));
    expect((await importConnection(makeDeps({ fetch }), "00000000-0000-4000-8000-000000000000")).status).toBe("not_found");
    const f = await makeFixture({ status: "disabled" });
    expect((await importConnection(makeDeps({ fetch }), f.connectionId)).status).toBe("skipped");
    expect(fetch.calls).toHaveLength(0);
  });

  it("records a generic failure for a server error without echoing response text", async () => {
    const f = await makeFixture();
    const out = await importConnection(makeDeps({ fetch: mockFetch(() => new Response(`boom https://x:${SECRET_PASS}@h.test`, { status: 500 })) }), f.connectionId);
    expect(out.status).toBe("failed");
    const c = await connRow(f.connectionId);
    expect(c.status).toBe("error");
    expect(c.last_error).not.toContain(SECRET_PASS);
  });

  it("maps a wrong key ring to a safe message", async () => {
    const f = await makeFixture();
    const { parseKeyring } = await import("@riffle/db");
    const { randomBytes } = await import("node:crypto");
    const wrong = parseKeyring(`1:${randomBytes(32).toString("base64")}`);
    const out = await importConnection(makeDeps({ keyring: wrong, fetch: mockFetch(() => json(accountSet([]))) }), f.connectionId);
    expect(out.status).toBe("failed");
    expect(out.reason).toMatch(/could not be decrypted/);
  });
});
