import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../src/csv";
import { generalLedgerCsv, trialBalanceCsv } from "../src/report-csv";

describe("csvCell escaping", () => {
  it("passes plain text through", () => expect(csvCell("Cash on Hand")).toBe("Cash on Hand"));
  it("quotes commas, quotes, CR and LF; doubles embedded quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });
  it("renders null/undefined as empty and numbers/bigints verbatim", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(-12500)).toBe("-12500");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(12n)).toBe("12");
    expect(() => csvCell(Number.NaN)).toThrow(RangeError);
  });
  it("keeps unicode intact", () => expect(csvCell("Café – 日本")).toBe("Café – 日本"));
});

describe("spreadsheet formula injection guard", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://x\",\"y\")", "\t=1", "\r=1"])(
    "neutralises %j", (v) => {
      const out = csvCell(v);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replaceAll('""', '"') : out;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(v);
    });
  it("combines guarding with quoting", () => expect(csvCell("=A,B")).toBe('"\'=A,B"'));
  it("does not touch strings that merely contain those characters", () => {
    for (const v of ["a=b", "x+y", "e-mail", "me@x.test", " =1"]) expect(csvCell(v)).toBe(v);
  });
  it("does not prefix numeric cells (a negative amount is a sign, not a formula)", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(-5n)).toBe("-5");
  });
});

describe("toCsv", () => {
  it("joins with CRLF and ends with CRLF", () => {
    expect(toCsv([["a", "b"], [1, null]])).toBe("a,b\r\n1,\r\n");
  });
  it("is empty for no rows", () => expect(toCsv([])).toBe(""));
});

describe("report CSV layouts", () => {
  it("guards hostile account names and descriptions", () => {
    const csv = trialBalanceCsv({
      asOf: "2026-01-01",
      rows: [{ accountId: "x", code: "1", name: "=cmd|' /C calc'!A0", type: "asset", contra: false,
        debits: 5, credits: 0, debitBalance: 5, creditBalance: 0 }],
      totals: { debits: 5, credits: 5, debitBalance: 5, creditBalance: 5 },
    }, "USD");
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv.split("\r\n")[0]).toBe("Code,Account,Type,Currency,Debits,Credits,Debit balance,Credit balance");
    const gl = generalLedgerCsv({
      from: "2026-01-01", to: "2026-01-31",
      accounts: [{ accountId: "x", code: "1000", name: "Cash", type: "asset", contra: false, openingBalance: 0,
        totalDebits: 1, totalCredits: 0, closingBalance: 1,
        lines: [{ lineId: "l", entryId: "e", transactionId: "t", date: "2026-01-02", description: "@evil", memo: "ok, fine",
          debit: 1, credit: 0, balance: 1 }] }],
    }, "USD");
    expect(gl).toContain(",'@evil,");
    expect(gl).toContain('"ok, fine"');
  });
});
