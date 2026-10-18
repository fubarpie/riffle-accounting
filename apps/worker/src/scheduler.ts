// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ImportConfig } from "./config";
import { isDue } from "./due";
import { type ImportDeps, type ImportOutcome, type Logger, consoleLogger, importConnection } from "./import";

/** How long to leave a connection alone after it was skipped without a sync (e.g. nothing linked yet). */
const SKIP_COOLDOWN_MS = 3_600_000;

export interface SchedulerOptions {
  deps: ImportDeps;
  config: Pick<ImportConfig, "tickMs" | "concurrency" | "retryMs" | "shutdownGraceMs">;
  /** Called by `stop()` to abort in-flight fetches after the grace period. */
  abort?: () => void;
  log?: Logger;
}

/**
 * Wakes up every `tickMs`, lists connections, and imports the due ones with
 * bounded concurrency. Dueness is a pure function of database state
 * (`isDue`), so replicas converge without coordination; the per-connection
 * advisory lock in `importConnection` (plus its re-check under the lock)
 * prevents a double import when two replicas race.
 */
export class ImportScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private pausedUntil = 0;
  private readonly cooldown = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly o: SchedulerOptions) {
    this.log = o.log ?? consoleLogger;
  }

  start(): void {
    if (this.timer || this.stopping) return;
    const loop = (): void => {
      this.timer = setTimeout(() => {
        void this.runTick().finally(() => {
          if (!this.stopping) loop();
        });
      }, this.o.config.tickMs);
    };
    // First pass immediately so a restart catches up on missed slots.
    void this.runTick().finally(() => {
      if (!this.stopping) loop();
    });
  }

  /** One scheduling pass. Never rejects; overlapping calls share the running pass. */
  runTick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.tick()
      .catch((err: unknown) => {
        this.log.error("import tick failed", { error: err instanceof Error ? err.name : "unknown" });
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async tick(): Promise<void> {
    const { deps, config } = this.o;
    const now = (deps.now ?? (() => new Date()))();
    if (now.getTime() < this.pausedUntil) return;
    const all = await deps.source.list();
    const due = all
      .filter((c) => isDue(c, now, config.retryMs))
      .filter((c) => (this.cooldown.get(c.id) ?? 0) <= now.getTime())
      // Stalest first, so a backlog drains in a fair order.
      .sort((a, b) => (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0));
    if (due.length === 0) return;

    const queue = due.map((c) => c.id);
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopping || Date.now() < this.pausedUntil) return;
        const id = queue.shift();
        if (id === undefined) return;
        try {
          this.note(id, await importConnection(deps, id, { onlyIfDue: true }));
        } catch (err) {
          // Infrastructure error (e.g. database down). The connection stays due and is retried next tick.
          this.log.error("import crashed", { connectionId: id, error: err instanceof Error ? err.name : "unknown" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, queue.length) }, worker));
  }

  private note(id: string, r: ImportOutcome): void {
    if (r.status === "skipped") this.cooldown.set(id, Date.now() + SKIP_COOLDOWN_MS);
    if (r.retryAfterMs !== undefined) {
      // SimpleFIN is rate limiting us: stop calling it for every connection for a while.
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + r.retryAfterMs);
      this.log.warn("backing off from SimpleFIN", { seconds: Math.round(r.retryAfterMs / 1000) });
    }
  }

  /** Stop scheduling, let in-flight imports finish, abort them after the grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const inflight = this.running;
    if (!inflight) return;
    const grace = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.o.abort?.();
        resolve();
      }, this.o.config.shutdownGraceMs);
      t.unref();
      void inflight.finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
    await grace;
    // After an abort the in-flight work finishes quickly; give it a moment so its pool use ends first.
    await Promise.race([inflight, new Promise((r) => setTimeout(r, 2000).unref())]);
  }
}
