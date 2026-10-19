// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  canApprove, canReject, draftToPatch, emptyLine, generalReasons, isDirty, isEditable, isValidDate, isWriter,
  previewDifference, readGate, reasonsForLine, toDraft, type Draft,
} from "../src/draft";
import type { Extraction, ExtractionDetail, ExtractionStatus } from "../src/types";

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    id: "e1", businessId: "b1", accountId: "a1", documentId: null, status: "staged", extractorName: "mock", extractorModel: "m",
    periodStart: "2026-01-01", periodEnd: "2026-01-31", openingBalanceMinor: "100000", closingBalanceMinor: "97450",
    currency: "USD", validation: { ok: true, reasons: [] }, validationOk: true, validatedAt: null, createdBy: "u1",
    approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
    ...over,
  };
}
function detail(over: Partial<Extraction> = {}): ExtractionDetail {
  return {
    extraction: extraction(over),
    lines: [
      { id: "l2", extractionId: "e1", lineNo: 2, date: "2026-01-10", description: "Rent", amountMinor: "-3000", amountInvalid: false, alreadyRecorded: false },
      { id: "l1", extractionId: "e1", lineNo: 1, date: "2026-01-05", description: "Sale", amountMinor: "450", amountInvalid: false, alreadyRecorded: true },
    ],
  };
}

describe("readGate", () => {
  it("reads a well-formed result", () => {
    const g = readGate(extraction({
      validationOk: false,
      validation: { ok: false, differenceMinor: "-55", reasons: [
        { code: "balance_mismatch", message: "off" }, { code: "zero_amount", message: "zero", lineIndex: 1 },
      ] },
    }));
    expect(g.ok).toBe(false);
    expect(g.differenceMinor).toBe("-55");
    expect(generalReasons(g).map((r) => r.code)).toEqual(["balance_mismatch"]);
    expect(reasonsForLine(g, 1).map((r) => r.code)).toEqual(["zero_amount"]);
    expect(reasonsForLine(g, 0)).toEqual([]);
  });

  it.each([null, undefined, "text", 5, [], {}, { reasons: "nope" }, { reasons: [null, 3, { code: 1 }, { message: "x" }] }])(
    "survives malformed validation %j", (validation) => {
      const g = readGate(extraction({ validation, validationOk: false }));
      expect(g.reasons).toEqual([]);
      expect(g.differenceMinor).toBeNull();
      expect(g.ok).toBe(false);
    });

  it("takes ok from the column, not from the JSON", () => {
    expect(readGate(extraction({ validation: { ok: true, reasons: [] }, validationOk: false })).ok).toBe(false);
  });
});

describe("permissions", () => {
  it("lets owners, admins and bookkeepers write, not viewers", () => {
    expect(isWriter("owner")).toBe(true);
    expect(isWriter("admin")).toBe(true);
    expect(isWriter("bookkeeper")).toBe(true);
    expect(isWriter("viewer")).toBe(false);
    expect(isWriter(undefined)).toBe(false);
  });

  it("allows editing only while open", () => {
    const open: ExtractionStatus[] = ["pending", "staged", "flagged"];
    for (const s of open) expect(isEditable(s)).toBe(true);
    expect(isEditable("approved")).toBe(false);
    expect(isEditable("rejected")).toBe(false);
  });

  it("approves only a clean, staged, saved extraction for a writer", () => {
    const ok = extraction();
    expect(canApprove(ok, "bookkeeper", false)).toBe(true);
    expect(canApprove(ok, "viewer", false)).toBe(false);
    expect(canApprove(ok, undefined, false)).toBe(false);
    expect(canApprove(ok, "owner", true)).toBe(false); // unsaved edits
    expect(canApprove(extraction({ status: "flagged", validationOk: false }), "owner", false)).toBe(false);
    expect(canApprove(extraction({ status: "staged", validationOk: false }), "owner", false)).toBe(false);
    expect(canApprove(extraction({ status: "approved" }), "owner", false)).toBe(false);
    expect(canApprove(extraction({ status: "rejected" }), "owner", false)).toBe(false);
  });

  it("rejects only open extractions", () => {
    expect(canReject(extraction({ status: "flagged" }), "admin")).toBe(true);
    expect(canReject(extraction({ status: "approved" }), "admin")).toBe(false);
    expect(canReject(extraction({ status: "rejected" }), "admin")).toBe(false);
    expect(canReject(extraction({ status: "flagged" }), "viewer")).toBe(false);
  });
});

describe("toDraft", () => {
  it("orders lines by line number and shows decimals", () => {
    const d = toDraft(detail(), 2);
    expect(d.opening).toBe("1000.00");
    expect(d.closing).toBe("974.50");
    expect(d.lines.map((l) => l.description)).toEqual(["Sale", "Rent"]);
    expect(d.lines.map((l) => l.amount)).toEqual(["4.50", "-30.00"]);
    expect(d.lines[0]?.alreadyRecorded).toBe(true);
  });

  it("gives every line a distinct key", () => {
    const keys = toDraft(detail(), 2).lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isDirty", () => {
  it("is false for an untouched copy and ignores keys", () => {
    const a = toDraft(detail(), 2);
    const b = toDraft(detail(), 2); // new keys
    expect(isDirty(a, b)).toBe(false);
  });

  it("detects edits, additions and removals", () => {
    const base = toDraft(detail(), 2);
    expect(isDirty({ ...base, closing: "1.00" }, base)).toBe(true);
    expect(isDirty({ ...base, lines: [...base.lines, emptyLine("2026-01-31")] }, base)).toBe(true);
    expect(isDirty({ ...base, lines: base.lines.slice(1) }, base)).toBe(true);
    const flipped = base.lines.map((l, i) => (i === 0 ? { ...l, alreadyRecorded: !l.alreadyRecorded } : l));
    expect(isDirty({ ...base, lines: flipped }, base)).toBe(true);
  });

  it("is false after adding then removing a line", () => {
    const base = toDraft(detail(), 2);
    const added = { ...base, lines: [...base.lines, emptyLine("2026-01-31")] };
    expect(isDirty({ ...added, lines: added.lines.slice(0, -1) }, base)).toBe(false);
  });
});

describe("isValidDate", () => {
  it("accepts real dates only", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-1")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
});

describe("draftToPatch", () => {
  it("builds the API body with exact minor-unit strings", () => {
    const r = draftToPatch(toDraft(detail(), 2), 2);
    expect(r).toEqual({
      ok: true,
      body: {
        periodStart: "2026-01-01", periodEnd: "2026-01-31", openingBalance: "100000", closingBalance: "97450",
        lines: [
          { date: "2026-01-05", description: "Sale", amountMinor: "450", alreadyRecorded: true },
          { date: "2026-01-10", description: "Rent", amountMinor: "-3000", alreadyRecorded: false },
        ],
      },
    });
  });

  it("reports every problem and sends nothing", () => {
    const d: Draft = {
      periodStart: "nope", periodEnd: "2026-01-31", opening: "1.234", closing: "10",
      lines: [
        { key: "a", date: "2026-02-30", description: "x", amount: "1", alreadyRecorded: false },
        { key: "b", date: "2026-01-02", description: "y".repeat(1001), amount: "abc", alreadyRecorded: false },
      ],
    };
    const r = draftToPatch(d, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => `${e.field}${e.lineIndex ?? ""}`).sort()).toEqual(["lines0", "lines1", "lines1", "opening", "periodStart"].sort());
  });

  it("rejects too many lines", () => {
    const lines = Array.from({ length: 2001 }, () => emptyLine("2026-01-01")).map((l) => ({ ...l, amount: "1" }));
    const r = draftToPatch({ periodStart: "2026-01-01", periodEnd: "2026-01-31", opening: "0", closing: "20.01", lines }, 2);
    expect(r.ok).toBe(false);
  });

  it("treats a blank new line as an error, not as zero", () => {
    const base = toDraft(detail(), 2);
    const r = draftToPatch({ ...base, lines: [...base.lines, emptyLine("2026-01-31")] }, 2);
    expect(r.ok).toBe(false);
  });
});

describe("previewDifference", () => {
  it("is zero when the lines explain the balance movement", () => {
    // 1000.00 + 4.50 - 30.00 = 974.50
    expect(previewDifference(toDraft(detail(), 2), 2)).toBe("0");
  });

  it("shows the gap in minor units", () => {
    const d = toDraft(detail(), 2);
    expect(previewDifference({ ...d, closing: "974.55" }, 2)).toBe("-5");
    expect(previewDifference({ ...d, closing: "974.40" }, 2)).toBe("10");
  });

  it("is null while anything is unparsable", () => {
    const d = toDraft(detail(), 2);
    expect(previewDifference({ ...d, closing: "" }, 2)).toBeNull();
    expect(previewDifference({ ...d, lines: [...d.lines, emptyLine("2026-01-31")] }, 2)).toBeNull();
  });

  it("stays exact with huge amounts", () => {
    const d: Draft = {
      periodStart: "2026-01-01", periodEnd: "2026-01-31", opening: "0.00", closing: "90071992547409.93",
      lines: [{ key: "k", date: "2026-01-02", description: "", amount: "90071992547409.92", alreadyRecorded: false }],
    };
    expect(previewDifference(d, 2)).toBe("-1");
  });
});
