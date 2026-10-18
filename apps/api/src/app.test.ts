// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("GET /healthz", () => {
  it("reports ok with service name and version", async () => {
    const app = await buildApp({ version: "9.9.9" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "riffle-api", version: "9.9.9" });
    await app.close();
  });
});

describe("without a web build", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("with a web build", () => {
  function makeWebDist(): string {
    const dir = mkdtempSync(join(tmpdir(), "riffle-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Riffle</title>");
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("serves index.html at / and for client-side routes", async () => {
    const app = await buildApp({ webDist: makeWebDist() });
    for (const url of ["/", "/some/client/route"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<title>Riffle</title>");
    }
    await app.close();
  });

  it("still returns 404 for unknown API paths and keeps /healthz working", async () => {
    const app = await buildApp({ webDist: makeWebDist() });
    expect((await app.inject({ method: "GET", url: "/api/unknown" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});
