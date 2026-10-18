// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkerConnection } from "./source";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** FNV-1a, 32 bit. Stable across processes and releases. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** UTC hour (0-23) of the daily slot, derived from the connection id so load spreads out. */
export function slotHour(connectionId: string): number {
  return fnv1a(connectionId) % 24;
}

/** The most recent daily slot at or before `now` (UTC hour from the id, minute from the row). */
export function latestSlot(c: Pick<WorkerConnection, "id" | "scheduleMinute">, now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const slot = today + slotHour(c.id) * HOUR_MS + c.scheduleMinute * 60_000;
  return new Date(slot <= now.getTime() ? slot : slot - DAY_MS);
}

/**
 * Should this connection be imported now?
 *
 *  - disabled: never.
 *  - error: retry once `retryMs` has passed since the failed attempt
 *    (`updated_at` is stamped by the failure record). That bounds failures to
 *    24h/retryMs attempts a day, far below SimpleFIN's 24-requests-a-day cap.
 *  - otherwise once per daily slot: due when the last success predates the
 *    most recent slot (or there never was one).
 */
export function isDue(c: WorkerConnection, now: Date, retryMs: number): boolean {
  if (c.status === "disabled") return false;
  if (c.status === "error") return now.getTime() - c.updatedAt.getTime() >= retryMs;
  if (!c.lastSyncedAt) return true;
  return c.lastSyncedAt.getTime() < latestSlot(c, now).getTime();
}
