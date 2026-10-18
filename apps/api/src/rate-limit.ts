// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Minimal in-memory sliding-window failure counter, used to slow credential
 * guessing. Per-process: behind several replicas the effective limit is
 * multiplied, which is acceptable for a brake (not a hard guarantee).
 */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const live = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (live.length) this.hits.set(key, live);
    else this.hits.delete(key);
    return live;
  }

  /** True when `key` has used up its failures and must be refused. */
  isBlocked(key: string): boolean {
    return this.prune(key).length >= this.max;
  }

  recordFailure(key: string): void {
    const live = this.prune(key);
    live.push(this.now());
    this.hits.set(key, live);
    // Bound memory under a spray of distinct keys.
    if (this.hits.size > 10_000) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
