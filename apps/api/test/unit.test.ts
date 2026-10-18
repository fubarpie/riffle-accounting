import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config";
import { hashPassword, verifyPassword } from "../src/password";
import { FailureLimiter } from "../src/rate-limit";

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterz", h)).toBe(false);
  });
  it("salts every hash", async () => {
    expect(await hashPassword("same password!")).not.toBe(await hashPassword("same password!"));
  });
  it("treats unicode-equivalent passwords as equal (NFKC)", async () => {
    const h = await hashPassword("caf\u00e9-password");
    expect(await verifyPassword("cafe\u0301-password", h)).toBe(true);
  });
  it("rejects malformed stored hashes instead of throwing", async () => {
    for (const bad of ["", "x", "scrypt$1$2$3$4", "bcrypt$a$b$c$d$e", "scrypt$x$8$1$AAAA$"]) {
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
  });
});

describe("FailureLimiter", () => {
  it("blocks after max failures and recovers when the window passes", () => {
    let t = 0;
    const l = new FailureLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) {
      expect(l.isBlocked("k")).toBe(false);
      l.recordFailure("k");
    }
    expect(l.isBlocked("k")).toBe(true);
    expect(l.isBlocked("other")).toBe(false);
    t = 1001;
    expect(l.isBlocked("k")).toBe(false);
  });
  it("reset clears the count", () => {
    const l = new FailureLimiter(1, 1000);
    l.recordFailure("k");
    l.reset("k");
    expect(l.isBlocked("k")).toBe(false);
  });
});

describe("configFromEnv", () => {
  it("defaults to closed registration and insecure cookies outside production", () => {
    expect(configFromEnv({})).toEqual({ secureCookies: false, allowRegistration: false, trustedOrigins: [] });
  });
  it("secure cookies by default in production, overridable", () => {
    expect(configFromEnv({ NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(configFromEnv({ NODE_ENV: "production", COOKIE_SECURE: "false" }).secureCookies).toBe(false);
  });
  it("parses trusted origins", () => {
    expect(configFromEnv({ TRUSTED_ORIGINS: " https://a.test, https://b.test ," }).trustedOrigins)
      .toEqual(["https://a.test", "https://b.test"]);
  });
});
