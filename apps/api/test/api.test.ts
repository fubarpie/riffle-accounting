import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const admin = new pg.Pool({ connectionString: process.env["TEST_ADMIN_URL"], max: 2 });
const pool = new pg.Pool({ connectionString: process.env["TEST_APP_URL"], max: 8 });
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    pool,
    config: { secureCookies: false, allowRegistration: true, trustedOrigins: [] },
  });
});
afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), pool.end()]);
});

let n = 0;
const PASSWORD = "a-long-test-password";

interface Client {
  cookie: string;
  id: string;
  email: string;
}

async function signup(label = "u"): Promise<Client> {
  const email = `${label}-${Date.now()}-${n++}@example.test`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/register", payload: { email, name: label, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  return { cookie: cookieOf(res), id: res.json().user.id, email };
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === "riffle_session");
  if (!c) throw new Error("no session cookie");
  return `riffle_session=${c.value}`;
}

function call(c: Client | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: c ? { cookie: c.cookie } : {},
  });
}

async function newBusiness(owner: Client): Promise<string> {
  const res = await call(owner, "POST", "/api/businesses", { name: "Acme", currency: "USD" });
  expect(res.statusCode).toBe(201);
  return res.json().business.id;
}

async function addMember(owner: Client, biz: string, who: Client, role: string) {
  const res = await call(owner, "POST", `/api/businesses/${biz}/members`, { email: who.email, role });
  expect(res.statusCode).toBe(201);
}

describe("authentication", () => {
  it("registers, reports /me, logs out", async () => {
    const u = await signup();
    const me = await call(u, "GET", "/api/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(u.email);
    expect(me.json().user.passwordHash).toBeUndefined();

    expect((await call(u, "POST", "/api/auth/logout")).statusCode).toBe(204);
    expect((await call(u, "GET", "/api/auth/me")).statusCode).toBe(401);
  });

  it("sets an HttpOnly SameSite=Lax cookie", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { email: `c-${Date.now()}@example.test`, name: "c", password: PASSWORD },
    });
    const c = res.cookies.find((x) => x.name === "riffle_session");
    expect(c?.httpOnly).toBe(true);
    expect(String(c?.sameSite).toLowerCase()).toBe("lax");
  });

  it("logs in with the right password and rejects the wrong one identically for unknown users", async () => {
    const u = await signup();
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email.toUpperCase(), password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: "wrong-wrong-wrong" } });
    const ghost = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ghost@example.test", password: "wrong-wrong-wrong" } });
    expect(bad.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(bad.json()).toEqual(ghost.json());
  });

  it("validates registration input and refuses duplicates", async () => {
    const u = await signup();
    const dup = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: u.email, name: "x", password: PASSWORD } });
    expect(dup.statusCode).toBe(409);
    const weak = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "w@example.test", name: "x", password: "short" } });
    expect(weak.statusCode).toBe(400);
    const badEmail = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "nope", name: "x", password: PASSWORD } });
    expect(badEmail.statusCode).toBe(400);
  });

  it("throttles repeated failures for one account", async () => {
    const u = await signup();
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: "wrong-wrong-wrong" } })).statusCode;
    }
    expect(last).toBe(429);
    // Even the right password is refused while blocked.
    const right = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PASSWORD } });
    expect(right.statusCode).toBe(429);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const u = await signup();
    const res = await app.inject({
      method: "POST", url: "/api/businesses", payload: { name: "X", currency: "USD" },
      headers: { cookie: u.cookie, origin: "https://evil.example", host: "riffle.test" },
    });
    expect(res.statusCode).toBe(403);
    const same = await app.inject({
      method: "POST", url: "/api/businesses", payload: { name: "X", currency: "USD" },
      headers: { cookie: u.cookie, origin: "https://riffle.test", host: "riffle.test" },
    });
    expect(same.statusCode).toBe(201);
  });

  it("requires login for business routes", async () => {
    expect((await call(null, "GET", "/api/businesses")).statusCode).toBe(401);
  });
});

describe("registration policy", () => {
  it("closes after the first user unless allowed", async () => {
    const closed = await buildApp({
      pool, config: { secureCookies: false, allowRegistration: false, trustedOrigins: [] },
    });
    // Users already exist in the shared database, so registration must be refused.
    const res = await closed.inject({
      method: "POST", url: "/api/auth/register",
      payload: { email: `late-${Date.now()}@example.test`, name: "x", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    await closed.close();
  });
});

describe("businesses and tenancy", () => {
  it("creates a business with the default chart and lists it for its owner only", async () => {
    const a = await signup("a");
    const b = await signup("b");
    const biz = await newBusiness(a);
    const accounts = await call(a, "GET", `/api/businesses/${biz}/accounts`);
    expect(accounts.json().accounts.length).toBe(43);
    expect((await call(a, "GET", "/api/businesses")).json().businesses.map((x: { id: string }) => x.id)).toContain(biz);
    expect((await call(b, "GET", "/api/businesses")).json().businesses).toEqual([]);
  });

  it("returns 404 (not 403) to non-members on every business route", async () => {
    const a = await signup("a");
    const stranger = await signup("s");
    const biz = await newBusiness(a);
    for (const [m, path] of [
      ["GET", ""], ["GET", "/accounts"], ["GET", "/members"], ["GET", "/audit-log"],
    ] as const) {
      expect((await call(stranger, m, `/api/businesses/${biz}${path}`)).statusCode, path).toBe(404);
    }
    expect((await call(stranger, "POST", `/api/businesses/${biz}/members`, { email: stranger.email, role: "owner" })).statusCode).toBe(404);
  });

  it("rejects malformed ids and currencies", async () => {
    const a = await signup();
    expect((await call(a, "GET", "/api/businesses/not-a-uuid")).statusCode).toBe(400);
    expect((await call(a, "POST", "/api/businesses", { name: "X", currency: "usd" })).statusCode).toBe(400);
    expect((await call(a, "POST", "/api/businesses", { name: "  ", currency: "USD" })).statusCode).toBe(400);
  });
});

describe("audit log access by role", () => {
  const cases: [string, number][] = [["owner", 200], ["admin", 200], ["bookkeeper", 200], ["viewer", 403]];
  it.each(cases)("%s -> %i", async (role, status) => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    let who = owner;
    if (role !== "owner") {
      who = await signup(role);
      await addMember(owner, biz, who, role);
    }
    const res = await call(who, "GET", `/api/businesses/${biz}/audit-log`);
    expect(res.statusCode).toBe(status);
    if (status === 200) {
      const actions = res.json().entries.map((e: { action: string }) => e.action);
      expect(actions).toContain("business.create");
    }
  });

  it("paginates newest first", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    for (let i = 0; i < 3; i++) {
      const u = await signup("m");
      await addMember(owner, biz, u, "viewer");
    }
    const p1 = (await call(owner, "GET", `/api/businesses/${biz}/audit-log?limit=2`)).json();
    expect(p1.entries).toHaveLength(2);
    expect(p1.nextBefore).toBeTruthy();
    const p2 = (await call(owner, "GET", `/api/businesses/${biz}/audit-log?limit=10&before=${p1.nextBefore}`)).json();
    expect(p2.entries.length).toBe(2);
    expect(p2.nextBefore).toBeNull();
    const seen = new Set([...p1.entries, ...p2.entries].map((e: { id: string }) => e.id));
    expect(seen.size).toBe(4);
  });
});

describe("role gating on other routes", () => {
  it("viewers can read accounts but not the member list", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    const viewer = await signup("v");
    await addMember(owner, biz, viewer, "viewer");
    expect((await call(viewer, "GET", `/api/businesses/${biz}/accounts`)).statusCode).toBe(200);
    expect((await call(viewer, "GET", `/api/businesses/${biz}/members`)).statusCode).toBe(403);
    expect((await call(viewer, "POST", `/api/businesses/${biz}/members`, { email: owner.email, role: "viewer" })).statusCode).toBe(403);
  });
});

describe("member management", () => {
  it("lets an admin manage bookkeepers/viewers but not owners/admins", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    const admin = await signup("a");
    const bk = await signup("b");
    const peer = await signup("p");
    await addMember(owner, biz, admin, "admin");
    await addMember(admin, biz, bk, "bookkeeper");

    // Cannot grant admin/owner.
    expect((await call(admin, "POST", `/api/businesses/${biz}/members`, { email: peer.email, role: "admin" })).statusCode).toBe(403);
    expect((await call(admin, "PATCH", `/api/businesses/${biz}/members/${bk.id}`, { role: "owner" })).statusCode).toBe(403);
    // Cannot touch the owner or itself-as-admin promotion.
    expect((await call(admin, "PATCH", `/api/businesses/${biz}/members/${owner.id}`, { role: "viewer" })).statusCode).toBe(403);
    expect((await call(admin, "DELETE", `/api/businesses/${biz}/members/${owner.id}`)).statusCode).toBe(403);
    // Can demote a bookkeeper.
    expect((await call(admin, "PATCH", `/api/businesses/${biz}/members/${bk.id}`, { role: "viewer" })).statusCode).toBe(200);
    expect((await call(admin, "DELETE", `/api/businesses/${biz}/members/${bk.id}`)).statusCode).toBe(204);
  });

  it("rejects duplicates and unknown users", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    const u = await signup("u");
    await addMember(owner, biz, u, "viewer");
    expect((await call(owner, "POST", `/api/businesses/${biz}/members`, { email: u.email, role: "viewer" })).statusCode).toBe(409);
    expect((await call(owner, "POST", `/api/businesses/${biz}/members`, { email: "nobody@example.test", role: "viewer" })).statusCode).toBe(404);
  });

  it("never leaves a business without an owner", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    expect((await call(owner, "PATCH", `/api/businesses/${biz}/members/${owner.id}`, { role: "admin" })).statusCode).toBe(409);
    expect((await call(owner, "DELETE", `/api/businesses/${biz}/members/${owner.id}`)).statusCode).toBe(409);
    // With a second owner, the first may step down.
    const co = await signup("co");
    await addMember(owner, biz, co, "owner");
    expect((await call(owner, "PATCH", `/api/businesses/${biz}/members/${owner.id}`, { role: "admin" })).statusCode).toBe(200);
  });

  it("lets any member leave, and records every change in the audit log", async () => {
    const owner = await signup("o");
    const biz = await newBusiness(owner);
    const v = await signup("v");
    await addMember(owner, biz, v, "viewer");
    await call(owner, "PATCH", `/api/businesses/${biz}/members/${v.id}`, { role: "bookkeeper" });
    expect((await call(v, "DELETE", `/api/businesses/${biz}/members/${v.id}`)).statusCode).toBe(204);
    expect((await call(v, "GET", `/api/businesses/${biz}`)).statusCode).toBe(404);
    const actions = (await call(owner, "GET", `/api/businesses/${biz}/audit-log`)).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["business.create", "member.add", "member.role_change", "member.leave"]));
  });
});
