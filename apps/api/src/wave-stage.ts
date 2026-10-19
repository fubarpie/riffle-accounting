// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StageEntryInput, StageInput, StageIssue } from "@riffle/db";
import type { WaveJournalResult, WaveLine } from "@riffle/shared";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LOOSE_ISSUES = 100;

function realIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function cents(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new Error("parser produced a non-integer amount");
  return BigInt(n);
}
function memoOf(l: WaveLine): string {
  const parts = [l.lineDescription, l.memo].map((p) => p.trim()).filter((p) => p.length > 0);
  return cap(parts.join(" | "), 1000);
}

/**
 * Convert the Wave parser's output into the parser-agnostic shape the staging
 * store takes. Pure: no I/O, no clock. Debits become positive amounts and
 * credits negative, in integer cents (the store's convention).
 *
 * The summary carries counts and parser issues only. Issue messages name
 * accounts but never contain account numbers; the file's rows are not copied.
 */
export function toStageInput(result: WaveJournalResult, fileSha256: string): StageInput {
  const byTx = new Map<string, StageIssue[]>();
  const loose: StageIssue[] = [];
  let errors = 0;
  let warnings = 0;
  for (const i of result.issues) {
    if (i.severity === "error") errors += 1; else warnings += 1;
    const issue: StageIssue = {
      severity: i.severity, code: i.code, message: cap(i.message, 500),
      ...(i.row !== undefined && { row: i.row }),
    };
    if (i.txId) {
      const list = byTx.get(i.txId) ?? [];
      list.push(issue);
      byTx.set(i.txId, list);
    } else {
      loose.push(issue);
    }
  }

  const entries: StageEntryInput[] = result.entries.map((e) => {
    const issues = [...(byTx.get(e.txId) ?? [])];
    let status: StageEntryInput["status"] = e.status === "skipped_zero" ? "skipped" : e.status;
    const date = realIsoDate(e.date) ? e.date : null;
    if (date === null && status === "valid") {
      status = "invalid";
      issues.push({ severity: "error", code: "bad_date", message: "The entry date could not be read" });
    }
    return {
      externalId: e.txId,
      date,
      description: cap(e.description, 1000),
      status,
      issues,
      lines: e.lines.map((l) => ({
        accountKey: l.accountKey,
        amountMinor: cents(l.debitCents) - cents(l.creditCents),
        memo: memoOf(l),
      })),
    };
  });

  return {
    source: "wave_journal",
    fileSha256,
    summary: {
      parser: "wave_journal",
      rowCount: result.rowCount,
      parsed: { entries: result.entries.length, accounts: result.accounts.length },
      issues: { errors, warnings },
      unattributedIssueCount: loose.length,
      unattributedIssues: loose.slice(0, MAX_LOOSE_ISSUES),
    },
    accounts: result.accounts.map((a) => ({
      key: a.key,
      name: a.displayName,
      group: a.waveGroup,
      type: a.waveTypes.join("; "),
      accountRef: a.accountNumber,
    })),
    entries,
  };
}
