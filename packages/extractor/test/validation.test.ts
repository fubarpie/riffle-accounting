// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { validateExtraction, type GateInput } from "../src/index.js";

const base = (over: Partial<GateInput> = {}): GateInput => ({
  periodStart: "2026-01-01", periodEnd: "2026-01-31",
  openingBalance: 10_000n, closingBalance: 12_500n,
  lines: [
    { date: "2026-01-05", amountMinor: 5_000n },
    { date: "2026-01-20", amountMinor: -2_500n },
  ],
  existing: [],
  ...over,
});
const codes = (r: ReturnType<typeof validateExtraction>) => r.reasons.map((x) => x.code);

describe("validation gate", () => {
  it("passes a balanced, in-period, unique extraction", () => {
    const r = validateExtraction(base());
    expect(r).toMatchObject({ ok: true, reasons: [], sumMinor: "2500", expectedMinor: "2500", differenceMinor: "0", lineCount: 2 });
  });

  it("is exact to one minor unit", () => {
    const r = validateExtraction(base({ closingBalance: 12_501n }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["balance_mismatch"]);
    expect(r.differenceMinor).toBe("-1");
  });

  it("handles negative balances (card owing money / overdraft)", () => {
    const r = validateExtraction(base({ openingBalance: -5_000n, closingBalance: -2_500n }));
    expect(r.ok).toBe(true);
  });

  it("accepts large bigint amounts within the cap and rejects beyond it", () => {
    const r = validateExtraction(base({
      openingBalance: 0n, closingBalance: 999_999_999_999_999n,
      lines: [{ date: "2026-01-05", amountMinor: 999_999_999_999_999n }],
    }));
    expect(r.ok).toBe(true);
    const over = validateExtraction(base({ openingBalance: 0n, closingBalance: 0n, lines: [{ date: "2026-01-05", amountMinor: 10n ** 16n }] }));
    expect(codes(over)).toContain("non_integer_amount");
  });

  it.each([
    ["fraction", 12.5], ["string fraction", "12.50"], ["NaN", Number.NaN], ["Infinity", Infinity],
    ["exponent string", "1e3"], ["empty", ""], ["null", null], ["undefined", undefined], ["object", {}], ["unsafe int", 2 ** 60],
  ])("flags a non-integer amount (%s)", (_n, amountMinor) => {
    const r = validateExtraction(base({ lines: [{ date: "2026-01-05", amountMinor }] }));
    expect(r.ok).toBe(false);
    expect(r.reasons.find((x) => x.code === "non_integer_amount")?.lineIndex).toBe(0);
  });

  it("accepts integer numbers and digit strings", () => {
    const r = validateExtraction(base({ lines: [{ date: "2026-01-05", amountMinor: 5000 }, { date: "2026-01-06", amountMinor: "-2500" }] }));
    expect(r.ok).toBe(true);
  });

  it("flags dates outside the period, on both edges, but allows the edges themselves", () => {
    expect(validateExtraction(base({ lines: [
      { date: "2026-01-01", amountMinor: 5_000n }, { date: "2026-01-31", amountMinor: -2_500n }] })).ok).toBe(true);
    const r = validateExtraction(base({ lines: [
      { date: "2025-12-31", amountMinor: 5_000n }, { date: "2026-02-01", amountMinor: -2_500n }] }));
    expect(r.reasons.filter((x) => x.code === "date_out_of_period").map((x) => x.lineIndex)).toEqual([0, 1]);
  });

  it("flags impossible dates", () => {
    const r = validateExtraction(base({ lines: [{ date: "2026-02-30", amountMinor: 5_000n }, { date: "2026-01-20", amountMinor: -2_500n }] }));
    expect(codes(r)).toContain("invalid_date");
  });

  it("flags a bad or inverted period and an empty extraction", () => {
    expect(codes(validateExtraction(base({ periodStart: "2026-02-01", periodEnd: "2026-01-01" })))).toContain("invalid_period");
    expect(codes(validateExtraction(base({ periodStart: "nope" })))).toContain("invalid_period");
    const empty = validateExtraction(base({ lines: [], closingBalance: 10_000n }));
    expect(codes(empty)).toEqual(["no_lines"]);
    expect(empty.ok).toBe(false);
  });

  it("flags zero-amount lines unless already recorded", () => {
    const lines = [{ date: "2026-01-05", amountMinor: 2_500n }, { date: "2026-01-06", amountMinor: 0n }];
    expect(codes(validateExtraction(base({ lines })))).toEqual(["zero_amount"]);
    expect(validateExtraction(base({ lines: [lines[0]!, { ...lines[1]!, alreadyRecorded: true }] })).ok).toBe(true);
  });

  describe("duplicates against existing transactions", () => {
    it("flags a line matching an existing date+amount", () => {
      const r = validateExtraction(base({ existing: [{ date: "2026-01-05", amountMinor: 5_000n }] }));
      expect(r.reasons).toEqual([expect.objectContaining({ code: "duplicate_existing", lineIndex: 0 })]);
    });
    it("does not flag same amount on another day or another amount", () => {
      expect(validateExtraction(base({ existing: [{ date: "2026-01-06", amountMinor: 5_000n }, { date: "2026-01-05", amountMinor: -5_000n }] })).ok).toBe(true);
    });
    it("matches as a multiset: one existing consumes only one of two identical lines", () => {
      const r = validateExtraction(base({
        openingBalance: 0n, closingBalance: 200n,
        lines: [{ date: "2026-01-05", amountMinor: 100n }, { date: "2026-01-05", amountMinor: 100n }],
        existing: [{ date: "2026-01-05", amountMinor: 100n }],
      }));
      expect(r.reasons.map((x) => x.lineIndex)).toEqual([0]);
    });
    it("alreadyRecorded lines are exempt but still count in the sum", () => {
      const ok = validateExtraction(base({
        lines: [{ date: "2026-01-05", amountMinor: 5_000n, alreadyRecorded: true }, { date: "2026-01-20", amountMinor: -2_500n }],
        existing: [{ date: "2026-01-05", amountMinor: 5_000n }],
      }));
      expect(ok.ok).toBe(true);
      expect(ok.sumMinor).toBe("2500");
    });
    it("an alreadyRecorded line does not use up an existing match for a later line", () => {
      const r = validateExtraction(base({
        openingBalance: 0n, closingBalance: 200n,
        lines: [{ date: "2026-01-05", amountMinor: 100n, alreadyRecorded: true }, { date: "2026-01-05", amountMinor: 100n }],
        existing: [{ date: "2026-01-05", amountMinor: 100n }],
      }));
      expect(r.reasons.map((x) => x.lineIndex)).toEqual([1]);
    });
  });

  describe("currency", () => {
    it("flags a mismatch, ignores case, and passes when unstated", () => {
      expect(codes(validateExtraction(base({ currency: { extracted: "EUR", business: "USD" } })))).toEqual(["currency_mismatch"]);
      expect(validateExtraction(base({ currency: { extracted: "usd", business: "USD" } })).ok).toBe(true);
      expect(validateExtraction(base({ currency: { extracted: null, business: "USD" } })).ok).toBe(true);
    });
  });

  it("reports every problem at once and is deterministic", () => {
    const input = base({ closingBalance: 0n, lines: [{ date: "2027-01-01", amountMinor: 1.5 }] });
    const a = validateExtraction(input);
    expect(a.ok).toBe(false);
    expect(codes(a).sort()).toEqual(["balance_mismatch", "date_out_of_period", "non_integer_amount"]);
    expect(validateExtraction(input)).toEqual(a);
  });

  it("does not mutate its input", () => {
    const input = base();
    const snapshot = JSON.stringify(input, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    validateExtraction(input);
    expect(JSON.stringify(input, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(snapshot);
  });
});
