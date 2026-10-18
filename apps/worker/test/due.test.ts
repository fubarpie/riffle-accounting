import { describe, expect, it } from "vitest";
import { isDue, latestSlot, slotHour } from "../src/due";
import type { WorkerConnection } from "../src/source";

const HOUR = 3_600_000;
const RETRY = 6 * HOUR;
const ID = "0190a0a0-0000-7000-8000-000000000001";

const conn = (o: Partial<WorkerConnection> = {}): WorkerConnection => ({
  id: ID, businessId: "b", createdBy: "u", status: "active",
  lastSyncedAt: null, updatedAt: new Date("2026-03-01T00:00:00Z"), scheduleMinute: 30, ...o,
});

describe("slotHour / latestSlot", () => {
  it("is stable and within 0-23", () => {
    expect(slotHour(ID)).toBe(slotHour(ID));
    for (let i = 0; i < 200; i++) {
      const h = slotHour(`id-${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
    }
  });

  it("spreads connections across hours", () => {
    const hours = new Set(Array.from({ length: 200 }, (_, i) => slotHour(`conn-${i}`)));
    expect(hours.size).toBeGreaterThan(12);
  });

  it("returns today's slot once it has passed, yesterday's before", () => {
    const h = slotHour(ID);
    const day = Date.UTC(2026, 5, 10);
    const slotToday = day + h * HOUR + 30 * 60_000;
    expect(latestSlot(conn(), new Date(slotToday + 1000)).getTime()).toBe(slotToday);
    expect(latestSlot(conn(), new Date(slotToday - 1000)).getTime()).toBe(slotToday - 24 * HOUR);
    expect(latestSlot(conn(), new Date(slotToday)).getTime()).toBe(slotToday);
  });
});

describe("isDue", () => {
  const h = slotHour(ID);
  const slot = Date.UTC(2026, 5, 10) + h * HOUR + 30 * 60_000;
  const afterSlot = new Date(slot + 10 * 60_000);

  it("never imports a disabled connection", () => {
    expect(isDue(conn({ status: "disabled" }), afterSlot, RETRY)).toBe(false);
  });

  it("imports a connection that never synced", () => {
    expect(isDue(conn(), afterSlot, RETRY)).toBe(true);
  });

  it("is due when the last success predates the latest slot, not after", () => {
    expect(isDue(conn({ lastSyncedAt: new Date(slot - 1000) }), afterSlot, RETRY)).toBe(true);
    expect(isDue(conn({ lastSyncedAt: new Date(slot + 1000) }), afterSlot, RETRY)).toBe(false);
  });

  it("does not run twice in one slot after a success", () => {
    const synced = new Date(slot + 5 * 60_000);
    expect(isDue(conn({ lastSyncedAt: synced }), new Date(slot + 20 * HOUR), RETRY)).toBe(false);
  });

  it("is due again at the next day's slot", () => {
    const synced = new Date(slot + 5 * 60_000);
    expect(isDue(conn({ lastSyncedAt: synced }), new Date(slot + 24 * HOUR + 60_000), RETRY)).toBe(true);
  });

  it("retries a failed connection only after retryMs since the failure", () => {
    const failedAt = new Date(slot);
    const c = conn({ status: "error", updatedAt: failedAt, lastSyncedAt: new Date(slot - 30 * HOUR) });
    expect(isDue(c, new Date(slot + RETRY - 1), RETRY)).toBe(false);
    expect(isDue(c, new Date(slot + RETRY), RETRY)).toBe(true);
  });

  it("a failed connection ignores the daily slot (bounded attempts a day)", () => {
    const c = conn({ status: "error", updatedAt: new Date(slot + 1000), lastSyncedAt: null });
    expect(isDue(c, afterSlot, RETRY)).toBe(false);
  });
});
