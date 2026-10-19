// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deterministic CSV statement parser: no AI involved. Its output goes through
 * the same strict schema and validation gate as any model's.
 *
 * Supported: a header row; delimiter , ; or tab; RFC 4180 quoting; dates as
 * YYYY-MM-DD or M/D/YYYY; one signed Amount column, or Debit/Credit columns
 * (credit/deposit positive, debit/withdrawal negative); an optional running
 * Balance column from which opening/closing balances are derived.
 *
 * Anything it cannot read unambiguously is rejected (ExtractorError "input"),
 * never guessed.
 */
import { decimalToMinorString, isIsoDate } from "./amount.js";
import { parseExtractionResult, cleanText } from "./schema.js";
import { ExtractorError, MAX_LINES, type ExtractInput, type ExtractionResult, type Extractor } from "./types.js";

export interface CsvOptions {
  /** Business currency; decides the number of decimals. */
  currency: string;
  periodStart?: string | undefined;
  periodEnd?: string | undefined;
  openingBalance?: bigint | undefined;
  closingBalance?: bigint | undefined;
}

const ALIASES = {
  date: ["date", "posted date", "posting date", "transaction date", "post date"],
  description: ["description", "memo", "payee", "details", "name", "narrative"],
  amount: ["amount"],
  debit: ["debit", "withdrawal", "withdrawals"],
  credit: ["credit", "deposit", "deposits"],
  balance: ["balance", "running balance"],
} as const;

/** RFC 4180 reader. Returns rows of cells; blank lines are dropped. */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_LINES + 1) throw new ExtractorError("input", `CSV has more than ${MAX_LINES} rows`);
    } else cell += ch;
  }
  if (quoted) throw new ExtractorError("input", "CSV has an unterminated quoted field");
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function pickDelimiter(headerLine: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, headerLine.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

function parseDate(raw: string, rowNo: number): string {
  const s = raw.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(s);
  if (iso && isIsoDate(iso[1]!)) return iso[1]!;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const d = `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
    if (isIsoDate(d)) return d;
  }
  throw new ExtractorError("input", `CSV row ${rowNo}: unrecognised date "${s.slice(0, 40)}" (use YYYY-MM-DD or M/D/YYYY)`);
}

export function parseCsvStatement(input: string, opts: CsvOptions): ExtractionResult {
  const text = input.replace(/^\uFEFF/, "");
  const headerLine = text.split(/\r?\n/, 1)[0] ?? "";
  const rows = parseCsvRows(text, pickDelimiter(headerLine));
  if (rows.length < 2) throw new ExtractorError("input", "CSV needs a header row and at least one transaction");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const find = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const idx = {
    date: find(ALIASES.date), description: find(ALIASES.description), amount: find(ALIASES.amount),
    debit: find(ALIASES.debit), credit: find(ALIASES.credit), balance: find(ALIASES.balance),
  };
  if (idx.date < 0) throw new ExtractorError("input", "CSV has no date column");
  if (idx.amount < 0 && idx.debit < 0 && idx.credit < 0) throw new ExtractorError("input", "CSV has no amount (or debit/credit) column");

  const money = (cell: string | undefined, rowNo: number, what: string): string | null => {
    const v = (cell ?? "").trim();
    if (v === "") return null;
    const m = decimalToMinorString(v, opts.currency);
    if (m === null) throw new ExtractorError("input", `CSV row ${rowNo}: ${what} "${v.slice(0, 40)}" is not a number`);
    return m;
  };

  interface Row { date: string; description: string; amount: string; balance: bigint | null }
  let parsed: Row[] = [];
  rows.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    let amount: string | null;
    if (idx.amount >= 0) amount = money(cells[idx.amount], rowNo, "amount");
    else {
      const cr = money(cells[idx.credit], rowNo, "credit");
      const dr = money(cells[idx.debit], rowNo, "debit");
      const isZero = (v: string) => /^-?0*(\.0*)?$/.test(v);
      const negate = (v: string) => (v.startsWith("-") ? v.slice(1) : `-${v}`);
      if (cr !== null && dr !== null && !isZero(cr) && !isZero(dr)) {
        throw new ExtractorError("input", `CSV row ${rowNo}: both debit and credit are filled in`);
      }
      // Inexact decimals pass through untouched so the gate flags them.
      amount = cr !== null && !isZero(cr) ? cr : dr !== null ? (isZero(dr) ? "0" : negate(dr)) : cr;
    }
    if (amount === null) throw new ExtractorError("input", `CSV row ${rowNo}: amount is empty`);
    const bal = idx.balance >= 0 ? money(cells[idx.balance], rowNo, "balance") : null;
    parsed.push({
      date: parseDate(cells[idx.date] ?? "", rowNo),
      description: cleanText(idx.description >= 0 ? (cells[idx.description] ?? "") : ""),
      amount,
      balance: bal !== null && /^-?\d+$/.test(bal) ? BigInt(bal) : null,
    });
  });
  if (parsed.length > MAX_LINES) throw new ExtractorError("input", `CSV has more than ${MAX_LINES} transactions`);

  // Newest-first exports are reversed to chronological order (running balances need it).
  if (parsed.length > 1 && parsed[0]!.date > parsed[parsed.length - 1]!.date) parsed = parsed.reverse();

  const first = parsed[0]!;
  const last = parsed[parsed.length - 1]!;
  const firstAmount = /^-?\d+$/.test(first.amount) ? BigInt(first.amount) : null;
  const derivedOpening = first.balance !== null && firstAmount !== null ? first.balance - firstAmount : undefined;
  const opening = opts.openingBalance ?? derivedOpening;
  const closing = opts.closingBalance ?? (last.balance ?? undefined);
  if (opening === undefined || closing === undefined) {
    throw new ExtractorError("input",
      "CSV has no running balance column, so supply openingBalance and closingBalance (minor units) with the upload");
  }
  return parseExtractionResult({
    periodStart: opts.periodStart ?? first.date,
    periodEnd: opts.periodEnd ?? last.date,
    openingBalance: opening.toString(),
    closingBalance: closing.toString(),
    currency: undefined,
    lines: parsed.map((r) => ({ date: r.date, description: r.description, amountMinor: r.amount })),
  });
}

/** Extractor wrapper so CSV travels the same path as every other source. */
export class CsvExtractor implements Extractor {
  readonly name = "csv";
  readonly model = "riffle-csv-1";
  constructor(private readonly opts: CsvOptions) {}

  async extract(input: ExtractInput): Promise<ExtractionResult> {
    let text = input.text;
    if (text === undefined && input.bytes) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
      } catch {
        throw new ExtractorError("input", "CSV must be UTF-8 text");
      }
    }
    if (text === undefined) throw new ExtractorError("input", "No CSV content");
    return parseCsvStatement(text, this.opts);
  }
}
