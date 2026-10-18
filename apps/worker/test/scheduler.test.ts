import { afterAll, describe, expect, it } from "vitest";
import { ImportScheduler } from "../src/scheduler";
import {
  accountSet, admin, captureLog, closePools, connRow, deferred, json, makeDeps, makeFixture,
  mockFetch, scopedSource, sleep, until, type Fixture,
} from "./helpers";

afterAll(closePools);

const cfg = (o: Partial<ConstructorParameters<typeof ImportScheduler>[0]["config"]> = {}) =>
  ({ tickMs: 50, concurrency: 2, retryMs: 6 * 3_600_000, shutdownGraceMs: 5000, ...o });

const hostOf = (u: URL) => u.host;
const body = () => json(accountSet([{ id: "ACT-1", txs: [{ id: "T1" }] }]));

async function fixtures(n: number): Promise<Fixture[]> {
  return Promise.all(Array.from({ length: n }, () => makeFixture()));
}

describe("ImportScheduler", () => {
  it("imports due connections, leaves fresh and disabled ones alone, and is quiet on the next tick", async () => {
    const [due, fresh, off] = await Promise.all([makeFixture(), makeFixture(), makeFixture({ status: "disabled" })]);
    await admin.query("UPDATE bank_connections SET last_synced_at = now() WHERE id = $1", [fresh.connectionId]);
    const fetch = mockFetch(body);
    const source = scopedSource([due, fresh, off].map((f) => f.connectionId));
    const s = new ImportScheduler({ deps: makeDeps({ fetch, source }), config: cfg() });

    await s.runTick();
    expect(fetch.calls.map(hostOf)).toEqual([due.host]);
    expect((await connRow(due.connectionId)).last_synced_at).not.toBeNull();

    await s.runTick();
    expect(fetch.calls).toHaveLength(1); // imported connection is no longer due
  });

  it("bounds concurrency to the configured limit and still drains the queue", async () => {
    const fx = await fixtures(5);
    let active = 0;
    let peak = 0;
    const fetch = mockFetch(async () => {
      peak = Math.max(peak, ++active);
      await sleep(60);
      active--;
      return body();
    });
    const s = new ImportScheduler({
      deps: makeDeps({ fetch, source: scopedSource(fx.map((f) => f.connectionId)) }), config: cfg({ concurrency: 2 }),
    });
    await s.runTick();
    expect(fetch.calls).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("overlapping runTick calls share one pass", async () => {
    const fx = await fixtures(2);
    const fetch = mockFetch(async () => { await sleep(30); return body(); });
    const s = new ImportScheduler({ deps: makeDeps({ fetch, source: scopedSource(fx.map((f) => f.connectionId)) }), config: cfg() });
    await Promise.all([s.runTick(), s.runTick(), s.runTick()]);
    expect(fetch.calls).toHaveLength(2);
  });

  it("a 429 pauses all SimpleFIN calls for the Retry-After period", async () => {
    const fx = await fixtures(3);
    const fetch = mockFetch(() => new Response("slow", { status: 429, headers: { "retry-after": "600" } }));
    const log = captureLog();
    const s = new ImportScheduler({
      deps: makeDeps({ fetch, log, source: scopedSource(fx.map((f) => f.connectionId)) }), config: cfg({ concurrency: 1 }), log,
    });
    await s.runTick();
    expect(fetch.calls).toHaveLength(1); // the rest of the queue is not attempted
    await s.runTick();
    expect(fetch.calls).toHaveLength(1); // still paused
    expect(log.lines.some((l) => l.includes("backing off"))).toBe(true);
  });

  it("does not hammer a connection that has no linked accounts", async () => {
    const f = await makeFixture({ links: [] });
    const fetch = mockFetch(body);
    const source = scopedSource([f.connectionId]);
    const s = new ImportScheduler({ deps: makeDeps({ fetch, source }), config: cfg() });
    await s.runTick();
    await s.runTick();
    await s.runTick();
    expect(source.gets.filter((id) => id === f.connectionId)).toHaveLength(1); // cooldown after the first skip
    expect(fetch.calls).toHaveLength(0);
  });

  it("an infrastructure error on one connection does not stop the others", async () => {
    const fx = await fixtures(2);
    const base = scopedSource(fx.map((f) => f.connectionId));
    const source = { ...base, get: async (id: string) => { if (id === fx[0]!.connectionId) throw new Error("db down"); return base.get(id); } };
    const log = captureLog();
    const fetch = mockFetch(body);
    const s = new ImportScheduler({ deps: makeDeps({ fetch, source, log }), config: cfg({ concurrency: 1 }), log });
    await s.runTick();
    expect(fetch.calls.map(hostOf)).toEqual([fx[1]!.host]);
    expect(log.lines.some((l) => l.includes("import crashed"))).toBe(true);
  });

  it("start() imports immediately, keeps ticking, and stop() halts further passes", async () => {
    const f = await makeFixture();
    const fetch = mockFetch(body);
    const source = scopedSource([f.connectionId]);
    const s = new ImportScheduler({ deps: makeDeps({ fetch, source }), config: cfg({ tickMs: 30 }) });
    s.start();
    s.start(); // idempotent
    await until(() => fetch.calls.length >= 1);
    const listsBefore = source.gets.length;
    await sleep(150); // several ticks pass; the connection is no longer due
    await s.stop();
    const after = source.gets.length;
    await sleep(150);
    expect(source.gets.length).toBe(after);
    expect(fetch.calls).toHaveLength(1);
    expect(listsBefore).toBeGreaterThanOrEqual(1);
  });

  it("stop() waits for an in-flight import to finish within the grace period", async () => {
    const f = await makeFixture();
    const gate = deferred();
    const fetch = mockFetch(async () => { await gate.promise; return body(); });
    let aborted = false;
    const s = new ImportScheduler({
      deps: makeDeps({ fetch, source: scopedSource([f.connectionId]) }), config: cfg({ shutdownGraceMs: 5000 }), abort: () => { aborted = true; },
    });
    s.start();
    await until(() => fetch.calls.length === 1);
    let stopped = false;
    const stopping = s.stop().then(() => { stopped = true; });
    await sleep(100);
    expect(stopped).toBe(false); // still waiting for the import
    gate.resolve();
    await stopping;
    expect(aborted).toBe(false);
    expect((await connRow(f.connectionId)).last_synced_at).not.toBeNull(); // import completed, not cut off
  });

  it("stop() aborts in-flight fetches after the grace period and leaves the connection retryable", async () => {
    const f = await makeFixture();
    const ac = new AbortController();
    const fetch = mockFetch((_u, init) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const s = new ImportScheduler({
      deps: makeDeps({ fetch, signal: ac.signal, source: scopedSource([f.connectionId]) }),
      config: cfg({ shutdownGraceMs: 100 }), abort: () => ac.abort(),
    });
    s.start();
    await until(() => fetch.calls.length === 1);
    const t0 = Date.now();
    await s.stop();
    expect(ac.signal.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
    const c = await connRow(f.connectionId);
    expect(c.last_synced_at).toBeNull();
    expect(c.status).not.toBe("disabled");
  });

  it("two schedulers on one connection import it once (advisory lock + re-check)", async () => {
    const f = await makeFixture();
    const gate = deferred();
    const fetch = mockFetch(async () => { await gate.promise; return body(); });
    const mk = () => new ImportScheduler({ deps: makeDeps({ fetch, source: scopedSource([f.connectionId]) }), config: cfg() });
    const a = mk().runTick();
    await until(() => fetch.calls.length === 1);
    const b = mk().runTick(); // sees it due, but the lock is held
    await sleep(100);
    gate.resolve();
    await Promise.all([a, b]);
    expect(fetch.calls).toHaveLength(1);
  });
});
