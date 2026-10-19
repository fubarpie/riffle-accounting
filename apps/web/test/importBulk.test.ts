import { describe, expect, it } from "vitest";
import { allPicked, summarizeAutoMap, summarizeBulkExclude, toggleId } from "../src/importBulk";

describe("summarizeAutoMap", () => {
  it("says what was matched and queued, and that creation waits for approval", () => {
    const text = summarizeAutoMap({ mappedExisting: 3, queuedCreate: 1, unresolved: [] });
    expect(text).toContain("3 accounts matched to existing accounts");
    expect(text).toContain("1 new account queued, created only when you approve");
  });

  it("names the accounts that still need a decision, and caps the list", () => {
    const unresolved = Array.from({ length: 7 }, (_, i) => ({
      importAccountId: `id${i}`, sourceName: `Acct ${i}`, sourceGroup: "Other", reason: "unknown_class" as const,
    }));
    const text = summarizeAutoMap({ mappedExisting: 0, queuedCreate: 0, unresolved });
    expect(text).toContain("Nothing could be mapped automatically.");
    expect(text).toContain("7 accounts still need your decision");
    expect(text).toContain('"Acct 0"');
    expect(text).not.toContain('"Acct 6"');
    expect(text).toContain("and 2 more");
  });

  it("reports when there was nothing to do", () => {
    expect(summarizeAutoMap({ mappedExisting: 0, queuedCreate: 0, unresolved: [] })).toBe("Every account already has a decision.");
  });
});

describe("selection helpers", () => {
  it("toggles without mutating the original", () => {
    const a = new Set(["x"]);
    const b = toggleId(a, "y");
    expect([...a]).toEqual(["x"]);
    expect([...b].sort()).toEqual(["x", "y"]);
    expect([...toggleId(b, "x")]).toEqual(["y"]);
  });

  it("treats an empty page as not all selected", () => {
    expect(allPicked([], new Set())).toBe(false);
    expect(allPicked(["a", "b"], new Set(["a", "b", "c"]))).toBe(true);
    expect(allPicked(["a", "b"], new Set(["a"]))).toBe(false);
  });
});

describe("summarizeBulkExclude", () => {
  it("handles zero, one and many", () => {
    expect(summarizeBulkExclude(0, true)).toContain("already excluded");
    expect(summarizeBulkExclude(1, false)).toBe("1 entry included.");
    expect(summarizeBulkExclude(12, true)).toBe("12 entries excluded.");
  });
});
