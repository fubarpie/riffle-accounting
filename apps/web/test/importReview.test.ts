// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  canApproveBatch, canRejectBatch, choiceValue, describeBlockers, hasBlockers, isMapped, parseChoice, suggestedType,
  summarizeApproval, toDecision,
} from "../src/importReview";
import type { ApprovalBlockers, ImportBatch } from "../src/types";

const none: ApprovalBlockers = {
  invalidEntries: 0, unmappedAccounts: [], archivedTargets: [], classMismatches: [], lockedEntries: null, nothingToPost: false,
};
const batch = (status: ImportBatch["status"]): ImportBatch => ({
  id: "b", source: "wave_journal", fileSha256: "x", status, summary: {}, createdBy: "u", createdAt: "2030-01-01T00:00:00Z", approvedAt: null, rejectedAt: null,
});

describe("describeBlockers", () => {
  it("is empty when nothing blocks", () => {
    expect(describeBlockers(none)).toEqual([]);
    expect(hasBlockers(none)).toBe(false);
  });

  it("reports every reason at once, with singular and plural wording", () => {
    const out = describeBlockers({
      invalidEntries: 1,
      unmappedAccounts: [{ importAccountId: "1", sourceName: "Sample Bank" }, { importAccountId: "2", sourceName: "Sample Card" }],
      archivedTargets: [{ importAccountId: "3", sourceName: "Old Fund" }],
      classMismatches: [{ importAccountId: "4", sourceName: "Sample Rent", sourceGroup: "income", expected: "income", actual: "expense" }],
      lockedEntries: { count: 3, lockedThrough: "2030-03-31", earliest: "2030-01-05" },
      nothingToPost: true,
    });
    expect(out).toHaveLength(6);
    expect(out[0]).toContain("1 entry has problems");
    expect(out[1]).toContain("2 accounts are not mapped yet");
    expect(out[1]).toContain('"Sample Bank", "Sample Card"');
    expect(out[2]).toContain("Old Fund");
    expect(out[3]).toContain("expected income");
    expect(out[3]).toContain("Nothing is changed automatically");
    expect(out[4]).toContain("3 entries are dated on or before the books lock date (2030-03-31)");
    expect(out[4]).toContain("earliest is 2030-01-05");
    expect(out[5]).toContain("Nothing would be posted");
  });

  it("shortens long account lists", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ importAccountId: String(i), sourceName: `Acct ${i}` }));
    const [line] = describeBlockers({ ...none, unmappedAccounts: many });
    expect(line).toContain("8 accounts are not mapped");
    expect(line).toContain("and 3 more");
    expect(line).not.toContain("Acct 7");
  });

  it("names a blank class instead of printing nothing", () => {
    const [line] = describeBlockers({ ...none, classMismatches: [{ importAccountId: "1", sourceName: "Misc", sourceGroup: "", expected: "asset", actual: "expense" }] });
    expect(line).toContain("unclassified");
  });
});

describe("mapping choices", () => {
  it("round-trips the select value", () => {
    expect(choiceValue({ targetAccountId: "abc", createName: null })).toBe("target:abc");
    expect(choiceValue({ targetAccountId: null, createName: "New" })).toBe("create");
    expect(choiceValue({ targetAccountId: null, createName: null })).toBe("");
    expect(parseChoice("target:abc")).toEqual({ kind: "target", accountId: "abc" });
    expect(parseChoice("create")).toEqual({ kind: "create" });
    expect(parseChoice("")).toEqual({ kind: "none" });
    expect(parseChoice("target:")).toEqual({ kind: "none" });
  });

  it("suggests a type only for a recognised class", () => {
    expect(suggestedType("Expense")).toBe("expense");
    expect(suggestedType(" asset ")).toBe("asset");
    expect(suggestedType("")).toBeUndefined();
    expect(suggestedType("Property")).toBeUndefined();
  });

  it("builds the request body, or says what is missing", () => {
    expect(toDecision({ kind: "none" }, "", "")).toEqual({ kind: "clear" });
    expect(toDecision({ kind: "target", accountId: "a" }, "", "")).toEqual({ kind: "target", accountId: "a" });
    expect(toDecision({ kind: "create" }, "  Supplies  ", "expense")).toEqual({ kind: "create", name: "Supplies", type: "expense" });
    expect(toDecision({ kind: "create" }, "   ", "expense")).toEqual({ error: "Give the new account a name." });
    expect(toDecision({ kind: "create" }, "Supplies", "")).toEqual({ error: "Choose a type for the new account." });
  });

  it("knows whether an account is mapped", () => {
    expect(isMapped({ targetAccountId: null, createName: null })).toBe(false);
    expect(isMapped({ targetAccountId: "x", createName: null })).toBe(true);
    expect(isMapped({ targetAccountId: null, createName: "n" })).toBe(true);
  });
});

describe("who may act", () => {
  it("lets writers approve a staged batch only", () => {
    expect(canApproveBatch(batch("staged"), "bookkeeper", true)).toBe(true);
    expect(canApproveBatch(batch("staged"), "viewer", true)).toBe(false);
    expect(canApproveBatch(batch("staged"), undefined, true)).toBe(false);
    expect(canApproveBatch(batch("approved"), "owner", true)).toBe(false);
    expect(canApproveBatch(batch("staged"), "owner", false)).toBe(false);
    expect(canRejectBatch(batch("staged"), "admin")).toBe(true);
    expect(canRejectBatch(batch("rejected"), "admin")).toBe(false);
    expect(canRejectBatch(batch("staged"), "viewer")).toBe(false);
  });
});

describe("summarizeApproval", () => {
  it("mentions only what happened", () => {
    expect(summarizeApproval({ posted: 1, accountsCreated: 0, alreadyImported: 0 })).toBe("Posted 1 entry.");
    expect(summarizeApproval({ posted: 40, accountsCreated: 2, alreadyImported: 3 }))
      .toBe("Posted 40 entries, created 2 accounts, skipped 3 entries an earlier import already posted.");
  });
});
