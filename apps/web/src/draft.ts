// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_AMOUNT_DIGITS, minorToDecimal, parseDecimalToMinor } from "./money";
import type { Extraction, ExtractionDetail, ExtractionStatus, GateReason, GateView, PatchBody, Role } from "./types";

export const MAX_LINES = 2_000;
export const MAX_DESCRIPTION = 1_000;

// -------------------------------------------------------------------- gate

/** Reads the stored validation result defensively: it is JSON from the database, not a trusted type. */
export function readGate(extraction: Pick<Extraction, "validation" | "validationOk">): GateView {
  const v = extraction.validation;
  const reasons: GateReason[] = [];
  let differenceMinor: string | null = null;
  if (v && typeof v === "object") {
    const o = v as { reasons?: unknown; differenceMinor?: unknown };
    if (Array.isArray(o.reasons)) {
      for (const r of o.reasons) {
        if (r && typeof r === "object" && typeof (r as GateReason).code === "string" && typeof (r as GateReason).message === "string") {
          const { code, message, lineIndex } = r as GateReason;
          reasons.push(typeof lineIndex === "number" ? { code, message, lineIndex } : { code, message });
        }
      }
    }
    if (typeof o.differenceMinor === "string") differenceMinor = o.differenceMinor;
  }
  return { ok: extraction.validationOk, reasons, differenceMinor };
}

export function reasonsForLine(gate: GateView, index: number): GateReason[] {
  return gate.reasons.filter((r) => r.lineIndex === index);
}

export function generalReasons(gate: GateView): GateReason[] {
  return gate.reasons.filter((r) => r.lineIndex === undefined);
}

// ----------------------------------------------------------- permissions

export const isWriter = (role: Role | undefined): boolean => role === "owner" || role === "admin" || role === "bookkeeper";

/** Pending, staged and flagged extractions can still be corrected; approved and rejected ones are final. */
export const isEditable = (status: ExtractionStatus): boolean => status === "pending" || status === "staged" || status === "flagged";

export const STATUS_LABEL: Record<ExtractionStatus, string> = {
  pending: "Pending",
  staged: "Ready to approve",
  flagged: "Needs attention",
  approved: "Approved",
  rejected: "Rejected",
};

/** Only a staged extraction that passed the gate and has no unsaved edits can be approved. */
export function canApprove(extraction: Extraction, role: Role | undefined, dirty: boolean): boolean {
  return isWriter(role) && !dirty && extraction.status === "staged" && extraction.validationOk;
}

export const canReject = (extraction: Extraction, role: Role | undefined): boolean =>
  isWriter(role) && isEditable(extraction.status);

// ------------------------------------------------------------------ draft

export interface DraftLine { key: string; date: string; description: string; amount: string; alreadyRecorded: boolean }
export interface Draft { periodStart: string; periodEnd: string; opening: string; closing: string; lines: DraftLine[] }

let keySeq = 0;
export const newKey = (): string => `l${++keySeq}`;

export function emptyLine(date: string): DraftLine {
  return { key: newKey(), date, description: "", amount: "", alreadyRecorded: false };
}

export function toDraft(detail: ExtractionDetail, exponent: number): Draft {
  const e = detail.extraction;
  return {
    periodStart: e.periodStart,
    periodEnd: e.periodEnd,
    opening: minorToDecimal(e.openingBalanceMinor, exponent),
    closing: minorToDecimal(e.closingBalanceMinor, exponent),
    lines: [...detail.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({
      key: newKey(), date: l.date, description: l.description, amount: minorToDecimal(l.amountMinor, exponent), alreadyRecorded: l.alreadyRecorded,
    })),
  };
}

/** Equality ignoring the React keys, so adding then removing a line is not "unsaved". */
export function isDirty(a: Draft, b: Draft): boolean {
  const strip = (d: Draft) => JSON.stringify({ ...d, lines: d.lines.map(({ key: _k, ...rest }) => rest) });
  return strip(a) !== strip(b);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface DraftError { field: "periodStart" | "periodEnd" | "opening" | "closing" | "lines"; lineIndex?: number; message: string }

export type PatchResult = { ok: true; body: PatchBody } | { ok: false; errors: DraftError[] };

/** Turns what the person typed into the PATCH body, or says exactly what is wrong. Nothing is rounded or guessed. */
export function draftToPatch(draft: Draft, exponent: number): PatchResult {
  const errors: DraftError[] = [];
  if (!isValidDate(draft.periodStart)) errors.push({ field: "periodStart", message: "Enter a valid start date." });
  if (!isValidDate(draft.periodEnd)) errors.push({ field: "periodEnd", message: "Enter a valid end date." });
  const opening = parseDecimalToMinor(draft.opening, exponent);
  const closing = parseDecimalToMinor(draft.closing, exponent);
  if (opening === null) errors.push({ field: "opening", message: amountHint(exponent) });
  if (closing === null) errors.push({ field: "closing", message: amountHint(exponent) });
  if (draft.lines.length > MAX_LINES) errors.push({ field: "lines", message: `At most ${MAX_LINES} lines are allowed.` });

  const lines: NonNullable<PatchBody["lines"]> = [];
  draft.lines.forEach((l, i) => {
    const amount = parseDecimalToMinor(l.amount, exponent);
    if (!isValidDate(l.date)) errors.push({ field: "lines", lineIndex: i, message: `Line ${i + 1}: enter a valid date.` });
    if (amount === null) errors.push({ field: "lines", lineIndex: i, message: `Line ${i + 1}: ${amountHint(exponent)}` });
    if (l.description.length > MAX_DESCRIPTION) errors.push({ field: "lines", lineIndex: i, message: `Line ${i + 1}: the description is longer than ${MAX_DESCRIPTION} characters.` });
    if (amount !== null) lines.push({ date: l.date, description: l.description, amountMinor: amount, alreadyRecorded: l.alreadyRecorded });
  });

  if (errors.length > 0 || opening === null || closing === null) return { ok: false, errors };
  return { ok: true, body: { periodStart: draft.periodStart, periodEnd: draft.periodEnd, openingBalance: opening, closingBalance: closing, lines } };
}

function amountHint(exponent: number): string {
  return exponent === 0
    ? `Enter a whole number of up to ${MAX_AMOUNT_DIGITS} digits.`
    : `Enter an exact amount with at most ${exponent} decimal places.`;
}

/**
 * Preview only: sum of the lines minus (closing - opening), in minor units, or null while any field
 * is not yet a valid amount. The server's gate is the authority and re-checks on every save.
 */
export function previewDifference(draft: Draft, exponent: number): string | null {
  const opening = parseDecimalToMinor(draft.opening, exponent);
  const closing = parseDecimalToMinor(draft.closing, exponent);
  if (opening === null || closing === null) return null;
  let sum = 0n;
  for (const l of draft.lines) {
    const a = parseDecimalToMinor(l.amount, exponent);
    if (a === null) return null;
    sum += BigInt(a);
  }
  return (sum - (BigInt(closing) - BigInt(opening))).toString();
}
