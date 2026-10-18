// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "./health";

const servers: Array<ReturnType<typeof createHealthServer>> = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    await new Promise<void>((resolve) => s?.close(() => resolve()));
  }
});

async function start(): Promise<string> {
  const server = createHealthServer("1.0.0");
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("worker health server", () => {
  it("serves /healthz", async () => {
    const base = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "riffle-worker", version: "1.0.0" });
  });

  it("404s everything else", async () => {
    const base = await start();
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
