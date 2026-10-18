import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadImportConfig, loadWorkerKeyring } from "../src/config";

const key = randomBytes(32).toString("base64");
const full = { DATABASE_URL: "postgres://x", RIFFLE_SECRET_KEY: `1:${key}` };

describe("loadImportConfig", () => {
  it("applies defaults", () => {
    expect(loadImportConfig(full)).toEqual({
      enabled: true, tickMs: 60_000, concurrency: 2, retryMs: 360 * 60_000, shutdownGraceMs: 20_000,
    });
  });

  it("stays disabled when unset and the prerequisites are missing (Phase 0 deployments)", () => {
    expect(loadImportConfig({}).enabled).toBe(false);
    expect(loadImportConfig({ DATABASE_URL: "postgres://x" }).enabled).toBe(false);
    expect(loadImportConfig({ RIFFLE_SECRET_KEY: `1:${key}` }).enabled).toBe(false);
  });

  it("honours an explicit false even with prerequisites", () => {
    expect(loadImportConfig({ ...full, RIFFLE_IMPORT_ENABLED: "false" }).enabled).toBe(false);
    expect(loadImportConfig({ ...full, RIFFLE_IMPORT_ENABLED: "off" }).enabled).toBe(false);
  });

  it("fails closed when explicitly enabled without prerequisites", () => {
    expect(() => loadImportConfig({ RIFFLE_IMPORT_ENABLED: "true" })).toThrow(/DATABASE_URL and RIFFLE_SECRET_KEY/);
    expect(() => loadImportConfig({ RIFFLE_IMPORT_ENABLED: "1", DATABASE_URL: "x" })).toThrow();
  });

  it("rejects an unparsable boolean", () => {
    expect(() => loadImportConfig({ ...full, RIFFLE_IMPORT_ENABLED: "maybe" })).toThrow(/true or false/);
  });

  it("reads and converts numeric settings", () => {
    const c = loadImportConfig({
      ...full, RIFFLE_IMPORT_INTERVAL_SECONDS: "30", RIFFLE_IMPORT_CONCURRENCY: "4", RIFFLE_IMPORT_RETRY_MINUTES: "30",
    });
    expect(c).toMatchObject({ tickMs: 30_000, concurrency: 4, retryMs: 1_800_000 });
  });

  it("treats blank values as unset", () => {
    expect(loadImportConfig({ ...full, RIFFLE_IMPORT_CONCURRENCY: " " }).concurrency).toBe(2);
  });

  it.each([
    ["RIFFLE_IMPORT_INTERVAL_SECONDS", "4"], ["RIFFLE_IMPORT_INTERVAL_SECONDS", "3601"],
    ["RIFFLE_IMPORT_CONCURRENCY", "0"], ["RIFFLE_IMPORT_CONCURRENCY", "9"],
    ["RIFFLE_IMPORT_RETRY_MINUTES", "14"], ["RIFFLE_IMPORT_RETRY_MINUTES", "1441"],
    ["RIFFLE_IMPORT_CONCURRENCY", "1.5"], ["RIFFLE_IMPORT_CONCURRENCY", "two"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => loadImportConfig({ ...full, [name]: value })).toThrow(new RegExp(name));
  });
});

describe("loadWorkerKeyring", () => {
  it("parses a key ring, first entry current", () => {
    const ring = loadWorkerKeyring({ RIFFLE_SECRET_KEY: `2:${key},1:${randomBytes(32).toString("base64")}` });
    expect(ring.currentId).toBe("2"); expect(ring.keys.size).toBe(2);
  });

  it("throws on a missing or malformed key", () => {
    expect(() => loadWorkerKeyring({})).toThrow();
    expect(() => loadWorkerKeyring({ RIFFLE_SECRET_KEY: "1:short" })).toThrow();
  });
});
