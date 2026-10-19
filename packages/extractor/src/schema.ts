// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { isIsoDate, parseMinorInteger } from "./amount.js";
import { ExtractorError, MAX_LINES, type ExtractionResult } from "./types.js";

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");
/** Balances must be exact integers (number or digit string): there is no sensible way to store anything else. */
const balance = z.union([z.number().int().safe(), z.string().regex(/^-?\d{1,18}$/)]);

/**
 * Strict schema for anything an extractor returns. Unknown keys are rejected,
 * not ignored: a model that adds fields (or tries to smuggle instructions in
 * them) fails closed. Line amounts stay loose on purpose; the gate flags
 * non-integers rather than the parser discarding the whole extraction.
 */
export const extractionResultSchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  openingBalance: balance,
  closingBalance: balance,
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  lines: z.array(z.object({
    date: isoDate,
    description: z.string().max(1000),
    amountMinor: z.union([z.number().finite(), z.string().max(40)]),
  }).strict()).max(MAX_LINES),
}).strict();

/** Parse untrusted JSON into an ExtractionResult or throw ExtractorError("output"). */
export function parseExtractionResult(value: unknown): ExtractionResult {
  const r = extractionResultSchema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first ? first.path.join(".") || "(root)" : "(root)";
    throw new ExtractorError("output", `Extractor output failed validation at ${where}: ${first?.message ?? "invalid"}`);
  }
  return r.data as ExtractionResult;
}

/** Strip NUL/control characters (Postgres cannot store NUL; control chars are never wanted in descriptions). */
export function cleanText(s: string, max = 1000): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface DraftLine {
  date: string;
  description: string;
  /** 0n when `amountInvalid`. */
  amountMinor: bigint;
  amountInvalid: boolean;
  /** The extractor's line exactly as received, kept for audit. */
  raw: unknown;
}
export interface Draft {
  periodStart: string;
  periodEnd: string;
  openingBalance: bigint;
  closingBalance: bigint;
  currency: string | null;
  lines: DraftLine[];
}

/** Turn a parsed result into storable values. Invalid amounts are kept visible (flagged), never coerced. */
export function toDraft(r: ExtractionResult): Draft {
  const opening = parseMinorInteger(r.openingBalance);
  const closing = parseMinorInteger(r.closingBalance);
  if (opening === null || closing === null) throw new ExtractorError("output", "Statement balances must be integers in minor units within range");
  return {
    periodStart: r.periodStart, periodEnd: r.periodEnd, openingBalance: opening, closingBalance: closing,
    currency: r.currency ? r.currency.toUpperCase() : null,
    lines: r.lines.map((l) => {
      const a = parseMinorInteger(l.amountMinor);
      return {
        date: l.date, description: cleanText(l.description), amountMinor: a ?? 0n, amountInvalid: a === null,
        raw: { date: l.date, description: l.description, amountMinor: l.amountMinor },
      };
    }),
  };
}
