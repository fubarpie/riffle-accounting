// SPDX-License-Identifier: AGPL-3.0-or-later
// All data in this file is synthetic. Do not paste real exports here.
import { parseWaveJournal } from "@riffle/shared";
import { describe, expect, it } from "vitest";
import { toStageInput } from "../src/wave-stage";

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
  id: string; date?: string; acct: string; desc?: string; lineDesc?: string; dr?: string; cr?: string;
  memo?: string; group: string; type?: string; acctId?: string;
}
function line(l: L): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return [
    l.id, l.date ?? "2024-01-15", q(l.acct), q(l.desc ?? "Test"), q(l.lineDesc ?? ""), l.dr ?? l.cr ?? "", "",
    l.dr ?? "", l.cr ?? "", "", "", "", "", "", q(l.memo ?? ""), "", "", "", "2024-02-01",
    "2024-02-01", l.group, l.type ?? "Type", l.acctId ?? "",
  ].join(",");
}
const file = (...ls: L[]): string => [HEADER, ...ls.map(line)].join("\r\n") + "\r\n";
const SHA = "0".repeat(64);
const ID19 = "1234567890123456789";
const FAKE_NUMBER = "9999888877776666";

describe("toStageInput", () => {
  it("turns debits positive and credits negative, keeping 19-digit ids as text", () => {
    const text = file(
      { id: ID19, acct: "Test Checking", dr: "100.05", group: "Asset", acctId: FAKE_NUMBER },
      { id: ID19, acct: "Test Income", cr: "100.05", group: "Income" },
    );
    const out = toStageInput(parseWaveJournal(text), SHA);
    expect(out.source).toBe("wave_journal");
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0]!;
    expect(e.externalId).toBe(ID19);
    expect(e.status).toBe("valid");
    expect(e.date).toBe("2024-01-15");
    expect(e.lines.map((l) => l.amountMinor)).toEqual([10005n, -10005n]);
    expect(e.lines.reduce((s, l) => s + l.amountMinor, 0n)).toBe(0n);
    expect(out.accounts.map((a) => a.name).sort()).toEqual(["Test Checking", "Test Income"]);
  });

  it("marks an unbalanced entry invalid and attaches the parser's finding to that entry only", () => {
    const text = file(
      { id: "1", acct: "Test Checking", dr: "10.00", group: "Asset" },
      { id: "1", acct: "Test Income", cr: "9.00", group: "Income" },
      { id: "2", acct: "Test Checking", dr: "5.00", group: "Asset" },
      { id: "2", acct: "Test Income", cr: "5.00", group: "Income" },
    );
    const out = toStageInput(parseWaveJournal(text), SHA);
    const bad = out.entries.find((e) => e.externalId === "1")!;
    const good = out.entries.find((e) => e.externalId === "2")!;
    expect(bad.status).toBe("invalid");
    expect(bad.issues.length).toBeGreaterThan(0);
    expect(bad.issues.every((i) => typeof i.code === "string" && i.message.length > 0)).toBe(true);
    expect(good.status).toBe("valid");
    expect(good.issues).toEqual([]);
  });

  it("maps a zero-amount entry to 'skipped'", () => {
    const text = file(
      { id: "3", acct: "Test Checking", dr: "0.00", group: "Asset" },
      { id: "3", acct: "Test Income", cr: "0.00", group: "Income" },
    );
    const out = toStageInput(parseWaveJournal(text), SHA);
    expect(out.entries[0]!.status).toBe("skipped");
  });

  it("never puts an account number or row amounts into the summary", () => {
    const text = file(
      { id: "4", acct: "Test Loan", cr: "250.00", group: "Liability", acctId: FAKE_NUMBER },
      { id: "4", acct: "Test Checking", dr: "250.00", group: "Asset" },
    );
    const out = toStageInput(parseWaveJournal(text), SHA);
    const summary = JSON.stringify(out.summary);
    expect(summary).not.toContain(FAKE_NUMBER);
    expect(summary).not.toContain("250");
    expect(out.summary).toMatchObject({ parser: "wave_journal", parsed: { entries: 1, accounts: 2 } });
    // The mapper hands the number on; the store is what keeps only the last 4 characters.
    expect(out.accounts.find((a) => a.name === "Test Loan")!.accountRef).toBe(FAKE_NUMBER);
  });

  it("joins the line description and memo into one bounded memo", () => {
    const long = "x".repeat(1500);
    const text = file(
      { id: "5", acct: "Test Checking", dr: "1.00", lineDesc: "Part A", memo: "Note B", group: "Asset" },
      { id: "5", acct: "Test Income", cr: "1.00", memo: long, group: "Income" },
    );
    const lines = toStageInput(parseWaveJournal(text), SHA).entries[0]!.lines;
    expect(lines[0]!.memo).toBe("Part A | Note B");
    expect(lines[1]!.memo.length).toBe(1000);
  });
});
