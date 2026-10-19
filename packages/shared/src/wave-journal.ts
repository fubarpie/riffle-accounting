// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parser for Wave "Accounts transactions" journal exports. See ADR 0012.
// Pure and deterministic: it reads text and returns staged accounts, staged
// entries and a list of issues. It never touches a database.

import { parseCsv } from "./csv";

export type WaveAccountClass = "asset" | "liability" | "equity" | "income" | "expense";

export interface WaveIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** 1-based CSV row number (header is row 1), when the issue is about one row. */
  row?: number;
  txId?: string;
}

export interface WaveLine {
  row: number;
  accountKey: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  description: string;
  lineDescription: string;
  memo: string;
}

export interface WaveStagedEntry {
  /** Wave Transaction ID, kept as text (19 digits exceed 2^53). */
  txId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  description: string;
  lines: WaveLine[];
  debitCents: number;
  creditCents: number;
  /** "invalid" entries cannot be approved until fixed or excluded. */
  status: "valid" | "invalid" | "skipped_zero";
}

export interface WaveStagedAccount {
  /** Normalised matching key. */
  key: string;
  /** First spelling seen, trimmed. Used for display. */
  displayName: string;
  /** Every distinct raw spelling, for the mapping report. */
  rawNames: string[];
  class: WaveAccountClass | null;
  waveGroup: string;
  waveTypes: string[];
  /** Optional account number (loan number, card suffix). Sensitive. */
  accountNumber: string | null;
}

export interface WaveJournalResult {
  accounts: WaveStagedAccount[];
  entries: WaveStagedEntry[];
  issues: WaveIssue[];
  rowCount: number;
}

/** Thrown when the file is not a Wave journal export at all. */
export class WaveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaveFormatError";
  }
}

const GROUP_TO_CLASS: Record<string, WaveAccountClass> = {
  asset: "asset",
  liability: "liability",
  equity: "equity",
  income: "income",
  expense: "expense",
};

/**
 * Normalise an account name for matching: Unicode compatibility form, dashes
 * to a plain hyphen, whitespace collapsed and trimmed, lower-cased.
 */
export function normalizeAccountName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Parse a decimal money string into integer cents without using floats.
 * Accepts an optional leading minus and at most two decimal places.
 * An empty string is zero. Returns null when the text is not valid money.
 */
export function parseCents(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0") || "0");
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) return null;
  // "-0.00" is zero, not negative zero.
  return m[1] === "-" && cents !== 0 ? -cents : cents;
}

function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const REQUIRED = {
  txId: "transaction id",
  date: "transaction date",
  account: "account name",
  description: "transaction description",
  lineDescription: "transaction line description",
  debit: "debit amount (two column approach)",
  credit: "credit amount (two column approach)",
  group: "account group",
  type: "account type",
} as const;

/**
 * Parse a Wave journal export. Columns are found by header name
 * (case-insensitive). The export has one header cell that is blank, so
 * nothing here depends on column position; the blank cell is ignored.
 */
export function parseWaveJournal(text: string): WaveJournalResult {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) throw new WaveFormatError("File is empty");

  const names = header.map((h) => h.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [k, name] of Object.entries(REQUIRED)) {
    const idx = names.indexOf(name);
    if (idx === -1) throw new WaveFormatError(`Missing required column "${name}"`);
    col[k] = idx;
  }
  const oneCol = names.indexOf("amount (one column)");
  const memoCol = names.indexOf("notes / memo");
  const acctIdCol = names.indexOf("account id");

  const issues: WaveIssue[] = [];
  const accounts = new Map<string, WaveStagedAccount>();
  const entries = new Map<string, WaveStagedEntry>();
  const rowBad = new Set<string>();

  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "") : "");
  const flag = (issue: WaveIssue): void => {
    issues.push(issue);
    if (issue.severity === "error" && issue.txId) rowBad.add(issue.txId);
  };

  for (let n = 1; n < table.length; n++) {
    const r = table[n] as string[];
    const row = n + 1;
    const txId = cell(r, col.txId as number).trim();

    if (r.length !== header.length) {
      flag({ severity: "error", code: "ragged_row", row, ...(txId ? { txId } : {}),
        message: `Row has ${r.length} cells, expected ${header.length}` });
      continue;
    }
    if (!/^\d+$/.test(txId)) {
      flag({ severity: "error", code: "bad_transaction_id", row,
        message: "Transaction ID is missing or not digits" });
      continue;
    }

    const date = cell(r, col.date as number).trim();
    if (!isRealDate(date)) {
      flag({ severity: "error", code: "bad_date", row, txId, message: `Invalid date "${date}"` });
    }

    const rawName = cell(r, col.account as number);
    const key = normalizeAccountName(rawName);
    if (key === "") {
      flag({ severity: "error", code: "missing_account", row, txId, message: "Account name is empty" });
      continue;
    }

    const debit = parseCents(cell(r, col.debit as number));
    const credit = parseCents(cell(r, col.credit as number));
    if (debit === null || credit === null) {
      flag({ severity: "error", code: "bad_amount", row, txId, message: "Debit or credit is not a valid amount" });
      continue;
    }
    if (debit < 0 || credit < 0) {
      flag({ severity: "error", code: "negative_amount", row, txId, message: "Negative debit or credit" });
      continue;
    }
    if (debit > 0 && credit > 0) {
      flag({ severity: "error", code: "debit_and_credit", row, txId, message: "Line has both a debit and a credit" });
      continue;
    }

    // The one-column amount is signed per account and is not authoritative.
    // Compare magnitude only, and only warn.
    if (oneCol >= 0) {
      const one = parseCents(cell(r, oneCol));
      if (one !== null && Math.abs(one) !== Math.max(debit, credit)) {
        issues.push({ severity: "warning", code: "amount_mismatch", row, txId,
          message: "One-column amount differs from debit/credit; debit/credit used" });
      }
    }

    // Account bookkeeping.
    const group = cell(r, col.group as number).trim();
    const type = cell(r, col.type as number).trim();
    const cls = GROUP_TO_CLASS[group.toLowerCase()] ?? null;
    const acctNo = cell(r, acctIdCol).trim() || null;
    let acct = accounts.get(key);
    if (!acct) {
      acct = { key, displayName: rawName.trim().replace(/\s+/g, " "), rawNames: [], class: cls,
        waveGroup: group, waveTypes: [], accountNumber: acctNo };
      accounts.set(key, acct);
      if (cls === null) {
        issues.push({ severity: "error", code: "unknown_group", row,
          message: `Unknown account group for account "${acct.displayName}"` });
      }
    } else if (acct.waveGroup.toLowerCase() !== group.toLowerCase()) {
      flag({ severity: "error", code: "account_group_conflict", row, txId,
        message: `Account "${acct.displayName}" appears in two groups` });
    }
    if (!acct.rawNames.includes(rawName)) acct.rawNames.push(rawName);
    if (type && !acct.waveTypes.includes(type)) acct.waveTypes.push(type);
    if (acct.accountNumber === null && acctNo) acct.accountNumber = acctNo;

    // Entry bookkeeping.
    let entry = entries.get(txId);
    if (!entry) {
      entry = { txId, date, description: cell(r, col.description as number).trim(), lines: [],
        debitCents: 0, creditCents: 0, status: "valid" };
      entries.set(txId, entry);
    } else if (entry.date !== date) {
      flag({ severity: "error", code: "date_mismatch", row, txId,
        message: "Lines of one transaction have different dates" });
    }
    entry.lines.push({ row, accountKey: key, accountName: rawName.trim(), debitCents: debit,
      creditCents: credit, description: cell(r, col.description as number).trim(),
      lineDescription: cell(r, col.lineDescription as number).trim(), memo: cell(r, memoCol) });
    entry.debitCents += debit;
    entry.creditCents += credit;
  }

  // Finalise entry status.
  for (const e of entries.values()) {
    if (e.debitCents === 0 && e.creditCents === 0) {
      e.status = "skipped_zero";
      issues.push({ severity: "warning", code: "zero_entry", txId: e.txId, message: "Zero-amount entry skipped" });
    } else if (e.debitCents !== e.creditCents) {
      e.status = "invalid";
      issues.push({ severity: "error", code: "unbalanced", txId: e.txId,
        message: `Debits ${e.debitCents} and credits ${e.creditCents} (cents) differ` });
    } else if (e.lines.length < 2) {
      e.status = "invalid";
      issues.push({ severity: "error", code: "single_line", txId: e.txId, message: "Entry has fewer than two lines" });
    } else if (rowBad.has(e.txId)) {
      e.status = "invalid";
    }
  }
  // A transaction whose only rows were rejected has no entry; mark none, issues already cover it.
  for (const id of rowBad) {
    const e = entries.get(id);
    if (e && e.status === "valid") e.status = "invalid";
  }

  return {
    accounts: [...accounts.values()],
    entries: [...entries.values()],
    issues,
    rowCount: table.length - 1,
  };
}
