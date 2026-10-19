// SPDX-License-Identifier: AGPL-3.0-or-later
// All data in this file is synthetic. Do not paste real exports here.
import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "./csv";
import {
  WaveFormatError,
  normalizeAccountName,
  parseCents,
  parseWaveJournal,
} from "./wave-journal";

const HEADER = [
  "Transaction ID", "Transaction Date", "Account Name", "Transaction Description",
  "Transaction Line Description", "Amount (One column)", "",
  "Debit Amount (Two Column Approach)", "Credit Amount (Two Column Approach)",
  "Other Accounts for this Transaction", "Customer", "Vendor", "Invoice Number",
  "Bill Number", "Notes / Memo", "Amount Before Sales Tax", "Sales Tax Amount",
  "Sales Tax Name", "Transaction Date Added", "Transaction Date Last Modified",
  "Account Group", "Account Type", "Account ID",
].join(",");

interface L {
  id: string; date?: string; acct: string; desc?: string; one?: string;
  dr?: string; cr?: string; memo?: string; group: string; type?: string; acctId?: string;
}
function line(l: L): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return [
    l.id, l.date ?? "2024-01-15", q(l.acct), q(l.desc ?? "Test"), "", l.one ?? "", "",
    l.dr ?? "", l.cr ?? "", "", "", "", "", "", q(l.memo ?? ""), "", "", "", "2024-02-01",
    "2024-02-01", l.group, l.type ?? "Type", l.acctId ?? "",
  ].join(",");
}
const file = (...ls: L[]): string => [HEADER, ...ls.map(line)].join("\r\n") + "\r\n";

const BIG = "9007199254740993"; // 2^53 + 1, not representable as a Number
const BIG19 = "1234567890123456789";

describe("parseCsv", () => {
  it("handles quotes, commas, embedded newlines and CRLF", () => {
    const rows = parseCsv('a,"b,1","line1\nline2","say ""hi"""\r\nx,y,z,w\r\n');
    expect(rows).toEqual([["a", "b,1", "line1\nline2", 'say "hi"'], ["x", "y", "z", "w"]]);
  });
  it("strips a BOM, keeps empty cells, drops blank lines", () => {
    expect(parseCsv("\ufeffa,,c\n\n,\n")).toEqual([["a", "", "c"], ["", ""]]);
  });
  it("keeps a final row without a trailing newline", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("throws on an unterminated quote", () => {
    expect(() => parseCsv('a,"b')).toThrow(CsvError);
  });
});

describe("parseCents", () => {
  it("parses decimals exactly", () => {
    expect(parseCents("2500.00")).toBe(250000);
    expect(parseCents("0.1")).toBe(10);
    expect(parseCents("1683.98")).toBe(168398);
    expect(parseCents("-7.05")).toBe(-705);
    expect(parseCents("")).toBe(0);
  });
  it("treats -0.00 as zero", () => {
    expect(Object.is(parseCents("-0.00"), 0)).toBe(true);
  });
  it("rejects junk and sub-cent precision", () => {
    expect(parseCents("1.234")).toBeNull();
    expect(parseCents("$5")).toBeNull();
    expect(parseCents("1e3")).toBeNull();
  });
});

describe("normalizeAccountName", () => {
  it("collapses spaces and maps en-dashes", () => {
    expect(normalizeAccountName("  Office \u2013  Supplies  ")).toBe("office - supplies");
    expect(normalizeAccountName("Office - Supplies")).toBe("office - supplies");
  });
});

describe("parseWaveJournal", () => {
  const balanced = file(
    { id: BIG19, acct: "Example Bank", dr: "100.00", group: "Asset", type: "Cash and Bank", one: "100.00" },
    { id: BIG19, acct: "Sample Income", cr: "100.00", group: "Income", type: "Income", one: "100.00" },
  );

  it("keeps 19-digit transaction ids as exact text", () => {
    const r = parseWaveJournal(balanced);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.txId).toBe(BIG19);
    expect(r.entries[0]?.status).toBe("valid");
  });

  it("does not collide ids that differ only past 2^53", () => {
    const r = parseWaveJournal(file(
      { id: BIG, acct: "A", dr: "1.00", group: "Asset" },
      { id: BIG, acct: "B", cr: "1.00", group: "Income" },
      { id: "9007199254740992", acct: "A", dr: "2.00", group: "Asset" },
      { id: "9007199254740992", acct: "B", cr: "2.00", group: "Income" },
    ));
    expect(r.entries.map((e) => e.txId)).toEqual([BIG, "9007199254740992"]);
  });

  it("works with a blank header cell and maps groups to classes", () => {
    const r = parseWaveJournal(balanced);
    expect(r.accounts.map((a) => [a.displayName, a.class])).toEqual([
      ["Example Bank", "asset"], ["Sample Income", "income"],
    ]);
  });

  it("reads quoted multi-line memos and commas in names", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Acme, Inc.", dr: "5.00", memo: "line one\nline two, with comma", group: "Expense" },
      { id: "1", acct: "Example Bank", cr: "5.00", group: "Asset" },
    ));
    expect(r.entries[0]?.lines[0]?.memo).toBe("line one\nline two, with comma");
    expect(r.entries[0]?.lines[0]?.accountName).toBe("Acme, Inc.");
  });

  it("merges account spellings that differ by spacing and dashes", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Office \u2013 Supplies ", dr: "5.00", group: "Expense" },
      { id: "1", acct: "Example Bank", cr: "5.00", group: "Asset" },
      { id: "2", acct: "Office  -  Supplies", dr: "6.00", group: "Expense" },
      { id: "2", acct: "Example Bank", cr: "6.00", group: "Asset" },
    ));
    const a = r.accounts.find((x) => x.key === "office - supplies");
    expect(r.accounts).toHaveLength(2);
    expect(a?.rawNames).toHaveLength(2);
    expect(a?.displayName).toBe("Office \u2013 Supplies");
  });

  it("flags an unbalanced entry as invalid", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "A", dr: "10.00", group: "Asset" },
      { id: "1", acct: "B", cr: "9.99", group: "Income" },
    ));
    expect(r.entries[0]?.status).toBe("invalid");
    expect(r.issues.some((i) => i.code === "unbalanced" && i.txId === "1")).toBe(true);
  });

  it("uses debit/credit, not the signed one-column amount", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Loan", dr: "25.00", one: "-25.00", group: "Liability" },
      { id: "1", acct: "Equity", cr: "25.00", one: "25.00", group: "Equity" },
    ));
    expect(r.entries[0]?.status).toBe("valid");
    expect(r.entries[0]?.lines[0]?.debitCents).toBe(2500);
    expect(r.issues.filter((i) => i.code === "amount_mismatch")).toHaveLength(0);
  });

  it("warns when the one-column magnitude disagrees", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "A", dr: "25.00", one: "26.00", group: "Asset" },
      { id: "1", acct: "B", cr: "25.00", group: "Income" },
    ));
    expect(r.issues.some((i) => i.code === "amount_mismatch")).toBe(true);
    expect(r.entries[0]?.status).toBe("valid");
  });

  it("skips zero-amount entries with a warning", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "A", dr: "0.00", group: "Asset" },
      { id: "1", acct: "B", cr: "-0.00", group: "Income" },
    ));
    expect(r.entries[0]?.status).toBe("skipped_zero");
    expect(r.issues.find((i) => i.code === "zero_entry")?.severity).toBe("warning");
  });

  it("rejects negative and two-sided lines", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "A", dr: "-5.00", group: "Asset" },
      { id: "1", acct: "B", cr: "5.00", group: "Income" },
      { id: "2", acct: "A", dr: "5.00", cr: "5.00", group: "Asset" },
      { id: "2", acct: "B", cr: "0.00", group: "Income" },
    ));
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["negative_amount", "debit_and_credit"]));
    for (const e of r.entries) expect(e.status).not.toBe("valid");
  });

  it("flags bad dates, including impossible ones, and mixed dates", () => {
    const r = parseWaveJournal(file(
      { id: "1", date: "2024-02-30", acct: "A", dr: "1.00", group: "Asset" },
      { id: "1", date: "2024-02-30", acct: "B", cr: "1.00", group: "Income" },
      { id: "2", date: "2024-01-01", acct: "A", dr: "1.00", group: "Asset" },
      { id: "2", date: "2024-01-02", acct: "B", cr: "1.00", group: "Income" },
    ));
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["bad_date", "date_mismatch"]));
    expect(r.entries.every((e) => e.status === "invalid")).toBe(true);
  });

  it("errors when one account name appears in two groups", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Mixed", dr: "1.00", group: "Asset" },
      { id: "1", acct: "Other", cr: "1.00", group: "Income" },
      { id: "2", acct: "Mixed", dr: "1.00", group: "Expense" },
      { id: "2", acct: "Other", cr: "1.00", group: "Income" },
    ));
    expect(r.issues.some((i) => i.code === "account_group_conflict")).toBe(true);
    expect(r.entries.find((e) => e.txId === "2")?.status).toBe("invalid");
  });

  it("keeps the account number but never puts it in issue text", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Example Loan", dr: "1.00", group: "Liability", acctId: "000111222" },
      { id: "1", acct: "B", cr: "2.00", group: "Income" },
    ));
    expect(r.accounts.find((a) => a.key === "example loan")?.accountNumber).toBe("000111222");
    expect(JSON.stringify(r.issues)).not.toContain("000111222");
  });

  it("imports Transfer Clearing legs as ordinary entries", () => {
    const r = parseWaveJournal(file(
      { id: "1", acct: "Bank A", cr: "50.00", group: "Asset", type: "Cash and Bank" },
      { id: "1", acct: "Transfer Clearing", dr: "50.00", group: "Asset", type: "Transfers" },
      { id: "2", acct: "Bank B", dr: "50.00", group: "Asset", type: "Cash and Bank" },
      { id: "2", acct: "Transfer Clearing", cr: "50.00", group: "Asset", type: "Transfers" },
    ));
    expect(r.entries.every((e) => e.status === "valid")).toBe(true);
    expect(r.accounts.filter((a) => a.key === "transfer clearing")).toHaveLength(1);
  });

  it("flags a ragged row instead of misreading it", () => {
    const r = parseWaveJournal(HEADER + "\r\n1,2024-01-01,A,desc\r\n");
    expect(r.issues[0]?.code).toBe("ragged_row");
    expect(r.entries).toHaveLength(0);
  });

  it("rejects files that are not journal exports", () => {
    expect(() => parseWaveJournal("")).toThrow(WaveFormatError);
    expect(() => parseWaveJournal("a,b,c\n1,2,3\n")).toThrow(/Missing required column/);
  });

  it("treats a header-only file as an empty batch", () => {
    const r = parseWaveJournal(HEADER + "\r\n");
    expect(r.entries).toEqual([]);
    expect(r.accounts).toEqual([]);
    expect(r.rowCount).toBe(0);
  });
});
