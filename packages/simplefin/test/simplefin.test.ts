import { describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  SimpleFinAccessRevokedError,
  SimpleFinClaimError,
  SimpleFinHttpError,
  SimpleFinInputError,
  SimpleFinProtocolError,
  SimpleFinRateLimitedError,
  SimpleFinTimeoutError,
  SimpleFinTokenError,
  claimAccessUrl,
  computeFetchRange,
  createSimpleFinAdapter,
  fetchAccounts,
  parseAmountToMinor,
  planWindows,
  randomMinuteSchedule,
  splitAccessUrl,
  type FetchLike,
} from "../src/index.js";

const CLAIM = "https://bridge.example.org/simplefin/claim/DEMO123";
const TOKEN = Buffer.from(CLAIM).toString("base64");
const ACCESS = "https://user%40x:p%3Aw@bridge.example.org/simplefin";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const goodSet = {
  errlist: [{ code: "con.auth", msg: "Re-auth needed", conn_id: "c1" }],
  errors: ["legacy problem"],
  connections: [{ conn_id: "c1", name: "Bank", org_id: "o", org_url: "https://b.example", sfin_url: "https://b.example/sf" }],
  accounts: [
    {
      id: "a1", name: "Checking", currency: "USD", balance: "100.50", "available-balance": "90.00",
      "balance-date": 1700000000, conn_id: "c1",
      transactions: [
        { id: "t1", posted: 1699990000, amount: "-12.34", description: "Coffee" },
        { id: "t2", posted: 0, amount: "5", description: "Pending", pending: true },
      ],
    },
  ],
};

describe("claimAccessUrl", () => {
  it("POSTs empty body to decoded claim URL and returns access URL", async () => {
    const f = vi.fn<FetchLike>(async () => new Response("https://u:p@bridge.example.org/simplefin\n"));
    const url = await claimAccessUrl(TOKEN, f);
    expect(url).toBe("https://u:p@bridge.example.org/simplefin");
    expect(f).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = f.mock.calls[0]!;
    expect(calledUrl).toBe(CLAIM);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("");
  });
  it("accepts base64url tokens", async () => {
    const t = Buffer.from(CLAIM + "?x=>>>").toString("base64url");
    const f = vi.fn<FetchLike>(async () => new Response("https://u:p@h.example/s"));
    await claimAccessUrl(t, f);
    expect(f.mock.calls[0]![0]).toContain("bridge.example.org");
  });
  it.each(["", "   ", "not base64!!", "@@@@"])("rejects malformed token %j", async (t) => {
    const f = vi.fn<FetchLike>();
    await expect(claimAccessUrl(t, f)).rejects.toBeInstanceOf(SimpleFinTokenError);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects non-URL payload", async () => {
    await expect(claimAccessUrl(Buffer.from("hello").toString("base64"), vi.fn())).rejects.toBeInstanceOf(SimpleFinTokenError);
  });
  it("rejects http claim URLs", async () => {
    const t = Buffer.from("http://bridge.example.org/claim/x").toString("base64");
    const f = vi.fn<FetchLike>();
    await expect(claimAccessUrl(t, f)).rejects.toBeInstanceOf(SimpleFinTokenError);
    expect(f).not.toHaveBeenCalled();
  });
  it("does not retry on failure and error does not leak token", async () => {
    const f = vi.fn<FetchLike>(async () => new Response("", { status: 403 }));
    const err = await claimAccessUrl(TOKEN, f).catch((e) => e);
    expect(err).toBeInstanceOf(SimpleFinClaimError);
    expect(err.status).toBe(403);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(err.message)).not.toContain(TOKEN);
    expect(String(err.message)).not.toContain("DEMO123");
  });
  it("rejects a claim response that is not an https access URL with credentials", async () => {
    for (const body of ["garbage", "http://u:p@h.example/x", "https://h.example/x"]) {
      await expect(claimAccessUrl(TOKEN, async () => new Response(body))).rejects.toBeInstanceOf(SimpleFinClaimError);
    }
  });
  it("does not log anything", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    await claimAccessUrl(TOKEN, async () => new Response("https://u:p@h.example/s"));
    spies.forEach((s) => { expect(s).not.toHaveBeenCalled(); s.mockRestore(); });
  });
  it("times out via AbortSignal with typed error", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(claimAccessUrl(TOKEN, f, { timeoutMs: 10 })).rejects.toBeInstanceOf(SimpleFinTimeoutError);
  });
});

describe("splitAccessUrl", () => {
  it("strips credentials and builds Basic header with decoded userinfo", () => {
    const { baseUrl, authorization } = splitAccessUrl(ACCESS);
    expect(baseUrl).toBe("https://bridge.example.org/simplefin");
    expect(authorization).toBe("Basic " + Buffer.from("user@x:p:w").toString("base64"));
  });
  it.each(["http://u:p@h.example/s", "https://h.example/s", "nonsense"])("rejects %s", (u) => {
    expect(() => splitAccessUrl(u)).toThrow(SimpleFinInputError);
  });
});

describe("fetchAccounts", () => {
  it("sends Basic auth, credential-free URL and query params", async () => {
    const f = vi.fn<FetchLike>(async () => json(goodSet));
    await fetchAccounts(
      ACCESS,
      { startDate: new Date(1_700_000_000_000), endDate: new Date(1_700_100_000_000), pending: true, accountIds: ["a1", "a2"] },
      f,
    );
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://bridge.example.org/simplefin/accounts?start-date=1700000000&end-date=1700100000&pending=1&account=a1&account=a2");
    expect(url).not.toContain("user");
    expect((init!.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(init!.method).toBe("GET");
  });
  it("omits query string when no options", async () => {
    const f = vi.fn<FetchLike>(async () => json(goodSet));
    await fetchAccounts(ACCESS, {}, f);
    expect(f.mock.calls[0]![0]).toBe("https://bridge.example.org/simplefin/accounts");
  });
  it("parses accounts into minor units", async () => {
    const set = await fetchAccounts(ACCESS, {}, async () => json(goodSet));
    const a = set.accounts[0]!;
    expect(a.balanceMinor).toBe(10050);
    expect(a.availableBalanceMinor).toBe(9000);
    expect(a.balanceDate).toEqual(new Date(1700000000_000));
    expect(a.transactions.map((t) => t.amountMinor)).toEqual([-1234, 500]);
    expect(a.transactions[0]!.pending).toBe(false);
    expect(a.transactions[1]!.pending).toBe(true);
    expect(a.transactions[1]!.postedAt).toBeNull();
    expect(set.connections).toHaveLength(1);
  });
  it("tolerates missing available-balance, errlist and transactions", async () => {
    const set = await fetchAccounts(ACCESS, {}, async () =>
      json({ accounts: [{ id: "a", name: "n", currency: "JPY", balance: "1000", "balance-date": 1 }] }));
    expect(set.accounts[0]!.availableBalanceMinor).toBeNull();
    expect(set.accounts[0]!.balanceMinor).toBe(1000);
    expect(set.warnings).toEqual([]);
  });
  it("surfaces errlist and legacy errors as typed warnings", async () => {
    const set = await fetchAccounts(ACCESS, {}, async () => json(goodSet));
    expect(set.warnings).toEqual([
      { kind: "auth", code: "con.auth", message: "Re-auth needed", connectionId: "c1" },
      { kind: "general", code: "unknown", message: "legacy problem" },
    ]);
  });
  it("classifies account and connection warning codes", async () => {
    const set = await fetchAccounts(ACCESS, {}, async () =>
      json({ accounts: [], errlist: [{ code: "act.missing", msg: "x", account_id: "a9" }, { code: "con.down", msg: "y" }, { code: "gen.other", msg: "z" }] }));
    expect(set.warnings.map((w) => w.kind)).toEqual(["account", "connection", "general"]);
    expect(set.warnings[0]!.accountId).toBe("a9");
  });
  it.each([402, 403] as const)("maps %i to access revoked", async (status) => {
    const err = await fetchAccounts(ACCESS, {}, async () => new Response("", { status })).catch((e) => e);
    expect(err).toBeInstanceOf(SimpleFinAccessRevokedError);
    expect(err.status).toBe(status);
  });
  it("maps 429 to rate limited with Retry-After", async () => {
    const err = await fetchAccounts(ACCESS, {}, async () => new Response("", { status: 429, headers: { "retry-after": "120" } })).catch((e) => e);
    expect(err).toBeInstanceOf(SimpleFinRateLimitedError);
    expect(err.retryAfterSeconds).toBe(120);
  });
  it("maps other statuses to HTTP error without leaking credentials", async () => {
    const err = await fetchAccounts(ACCESS, {}, async () => new Response("", { status: 500 })).catch((e) => e);
    expect(err).toBeInstanceOf(SimpleFinHttpError);
    expect(err.message).not.toContain("p%3Aw");
  });
  it("rejects invalid JSON and schema violations", async () => {
    await expect(fetchAccounts(ACCESS, {}, async () => new Response("<html>"))).rejects.toBeInstanceOf(SimpleFinProtocolError);
    await expect(fetchAccounts(ACCESS, {}, async () => json({ nope: 1 }))).rejects.toBeInstanceOf(SimpleFinProtocolError);
    await expect(
      fetchAccounts(ACCESS, {}, async () => json({ accounts: [{ id: "a", name: "n", currency: "USD", balance: 5, "balance-date": 1 }] })),
    ).rejects.toBeInstanceOf(SimpleFinProtocolError);
  });
  it("rejects unparseable amounts in response as protocol error", async () => {
    const bad = { accounts: [{ id: "a", name: "n", currency: "USD", balance: "1.2.3", "balance-date": 1 }] };
    await expect(fetchAccounts(ACCESS, {}, async () => json(bad))).rejects.toBeInstanceOf(SimpleFinProtocolError);
  });
  it("enforces 90-day window", async () => {
    const f = vi.fn<FetchLike>();
    const s = new Date(0);
    await expect(fetchAccounts(ACCESS, { startDate: s, endDate: new Date(91 * DAY_MS) }, f)).rejects.toBeInstanceOf(SimpleFinInputError);
    await expect(fetchAccounts(ACCESS, { startDate: new Date(DAY_MS), endDate: s }, f)).rejects.toBeInstanceOf(SimpleFinInputError);
    expect(f).not.toHaveBeenCalled();
    await expect(fetchAccounts(ACCESS, { startDate: s, endDate: new Date(90 * DAY_MS) }, async () => json(goodSet))).resolves.toBeDefined();
  });
  it("times out with typed error", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(fetchAccounts(ACCESS, { timeoutMs: 10 }, f)).rejects.toBeInstanceOf(SimpleFinTimeoutError);
  });
  it("propagates caller abort without mapping to timeout", async () => {
    const ac = new AbortController();
    const f: FetchLike = (_u, init) =>
      new Promise((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("user abort"))));
    const p = fetchAccounts(ACCESS, { signal: ac.signal }, f);
    ac.abort();
    await expect(p).rejects.toThrow("user abort");
  });
});

describe("parseAmountToMinor", () => {
  it.each([
    ["12.34", "USD", 1234],
    ["-12.34", "USD", -1234],
    ["+0.5", "USD", 50],
    ["7", "USD", 700],
    [".25", "USD", 25],
    ["5.", "USD", 500],
    ["1.10", "XXX", 110],
    ["1.500", "USD", 150],
    ["1000", "JPY", 1000],
    ["1.234", "KWD", 1234],
    ["-0.00", "USD", 0],
    ["0.07", "USD", 7],
    ["9007199254740.99", "USD", 900719925474099],
  ])("%s %s -> %i", (v, c, want) => {
    expect(parseAmountToMinor(v, c)).toBe(want);
  });
  it("avoids float error cases", () => {
    expect(parseAmountToMinor("1.15", "USD")).toBe(115);
    expect(parseAmountToMinor("0.29", "USD")).toBe(29);
  });
  it.each(["", "abc", "1.2.3", "1,000.00", "--1", "1e3"])("rejects %j", (v) => {
    expect(() => parseAmountToMinor(v, "USD")).toThrow(SimpleFinInputError);
  });
  it("rejects lost precision and overflow", () => {
    expect(() => parseAmountToMinor("1.005", "USD")).toThrow(SimpleFinInputError);
    expect(() => parseAmountToMinor("1.5", "JPY")).toThrow(SimpleFinInputError);
    expect(() => parseAmountToMinor("99999999999999999999", "USD")).toThrow(SimpleFinInputError);
  });
});

describe("planWindows", () => {
  const start = new Date("2025-01-01T00:00:00Z");
  it("returns a single window for short ranges", () => {
    const end = new Date(start.getTime() + 30 * DAY_MS);
    expect(planWindows(start, end)).toEqual([{ start, end }]);
  });
  it("returns single window for exactly 90 days", () => {
    expect(planWindows(start, new Date(start.getTime() + 90 * DAY_MS))).toHaveLength(1);
  });
  it("splits 200 days into contiguous <=90 day chunks", () => {
    const end = new Date(start.getTime() + 200 * DAY_MS);
    const w = planWindows(start, end);
    expect(w).toHaveLength(3);
    expect(w[0]!.start).toEqual(start);
    expect(w.at(-1)!.end).toEqual(end);
    for (let i = 0; i < w.length; i++) {
      expect(w[i]!.end.getTime() - w[i]!.start.getTime()).toBeLessThanOrEqual(90 * DAY_MS);
      if (i > 0) expect(w[i]!.start).toEqual(w[i - 1]!.end);
    }
  });
  it("handles zero-length range", () => {
    expect(planWindows(start, start)).toHaveLength(1);
  });
  it("rejects reversed or invalid ranges", () => {
    expect(() => planWindows(new Date(10), new Date(5))).toThrow(SimpleFinInputError);
    expect(() => planWindows(new Date(NaN), new Date(5))).toThrow(SimpleFinInputError);
  });
});

describe("computeFetchRange", () => {
  const now = new Date("2025-06-30T12:00:00Z");
  it("subtracts 5-day overlap", () => {
    const last = new Date("2025-06-20T12:00:00Z");
    expect(computeFetchRange(last, now)).toEqual({ start: new Date("2025-06-15T12:00:00Z"), end: now });
  });
  it("caps at 90 days", () => {
    const r = computeFetchRange(new Date("2024-01-01T00:00:00Z"), now);
    expect(r.start.getTime()).toBe(now.getTime() - 90 * DAY_MS);
  });
  it("defaults to 90 days when never synced", () => {
    expect(computeFetchRange(null, now).start.getTime()).toBe(now.getTime() - 90 * DAY_MS);
  });
  it("never starts after now", () => {
    expect(computeFetchRange(new Date(now.getTime() + 10 * DAY_MS), now).start.getTime()).toBeLessThanOrEqual(now.getTime());
  });
  it("result always fits one fetch window", () => {
    expect(planWindows(...(Object.values(computeFetchRange(null, now)) as [Date, Date]))).toHaveLength(1);
  });
});

describe("randomMinuteSchedule", () => {
  it("is deterministic", () => {
    expect(randomMinuteSchedule("conn-1")).toBe(randomMinuteSchedule("conn-1"));
  });
  it("is always within 1..59 integers", () => {
    for (let i = 0; i < 5000; i++) {
      const m = randomMinuteSchedule(`seed-${i}`);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(59);
    }
    expect(randomMinuteSchedule("")).toBeGreaterThanOrEqual(1);
  });
  it("spreads across minutes", () => {
    const s = new Set(Array.from({ length: 500 }, (_, i) => randomMinuteSchedule(`c${i}`)));
    expect(s.size).toBeGreaterThan(30);
  });
});

describe("createSimpleFinAdapter", () => {
  it("claims through the adapter", async () => {
    const a = createSimpleFinAdapter(async () => new Response("https://u:p@h.example/s"));
    await expect(a.claim(TOKEN)).resolves.toBe("https://u:p@h.example/s");
  });
  it("splits long ranges into multiple requests and merges transactions", async () => {
    const f = vi.fn<FetchLike>(async () => json(goodSet));
    const a = createSimpleFinAdapter(f);
    const res = await a.fetchRange(ACCESS, { start: new Date(0), end: new Date(200 * DAY_MS) });
    expect(f).toHaveBeenCalledTimes(3);
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0]!.transactions).toHaveLength(2); // deduped by id
    expect(res.warnings).toHaveLength(6);
  });
});
