import { SimpleFinInputError } from "./errors.js";

export const DAY_MS = 86_400_000;
export const MAX_WINDOW_DAYS = 90;
export const OVERLAP_DAYS = 5;

export interface DateRange {
  start: Date;
  end: Date;
}

/** Split [from, to] into contiguous chunks of at most 90 days. */
export function planWindows(from: Date, to: Date): DateRange[] {
  const f = from.getTime();
  const t = to.getTime();
  if (Number.isNaN(f) || Number.isNaN(t)) throw new SimpleFinInputError("Invalid date");
  if (f > t) throw new SimpleFinInputError("Range start is after end");
  const step = MAX_WINDOW_DAYS * DAY_MS;
  const out: DateRange[] = [];
  let cursor = f;
  do {
    const end = Math.min(cursor + step, t);
    out.push({ start: new Date(cursor), end: new Date(end) });
    cursor = end;
  } while (cursor < t);
  return out;
}

/** lastSync minus a 5-day overlap up to now, capped at 90 days. Null lastSync = full 90 days. */
export function computeFetchRange(lastSyncedAt: Date | null, now: Date): DateRange {
  const earliest = now.getTime() - MAX_WINDOW_DAYS * DAY_MS;
  const wanted = lastSyncedAt ? lastSyncedAt.getTime() - OVERLAP_DAYS * DAY_MS : earliest;
  if (Number.isNaN(wanted)) throw new SimpleFinInputError("Invalid lastSyncedAt");
  return { start: new Date(Math.min(Math.max(wanted, earliest), now.getTime())), end: new Date(now.getTime()) };
}
