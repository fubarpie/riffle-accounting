// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The validation gate (ADR 0011). A pure function: no I/O, no clock, no
 * randomness, so it is exhaustively unit-testable and its verdict is
 * reproducible. An extraction is stageable only when `ok` is true.
 *
 * Checks:
 *  1. every amount is an exact integer count of minor units;
 *  2. sum(line amounts) == closing - opening, exactly (bigint, no rounding);
 *  3. every line date is a real date inside [periodStart, periodEnd];
 *  4. no line duplicates a transaction already on the account (matched as a
 *     multiset on date + amount, so two genuine identical purchases are fine
 *     when the ledger holds only one of them). A person resolves a duplicate by
 *     marking the line `alreadyRecorded`, which keeps it in the sum but stops it
 *     being posted again;
 *  5. period sanity, at least one line, no zero-amount postable lines, and a
 *     currency stated by the statement must equal the business currency.
 */
import { isIsoDate, parseMinorInteger } from "./amount.js";
import { MAX_LINES } from "./types.js";

export type GateReasonCode =
  | "invalid_period"
  | "no_lines"
  | "too_many_lines"
  | "non_integer_amount"
  | "zero_amount"
  | "invalid_date"
  | "date_out_of_period"
  | "balance_mismatch"
  | "duplicate_existing"
  | "currency_mismatch";

export interface GateReason {
  code: GateReasonCode;
  message: string;
  /** 0-based position of the offending line, when the reason is about one line. */
  lineIndex?: number;
}

export interface GateLine {
  date: string;
  /** bigint for a valid integer; anything else (null, number with fraction, string…) is rejected. */
  amountMinor: unknown;
  /** Already in the ledger: counts toward the balance check, is not posted, is not duplicate-checked. */
  alreadyRecorded?: boolean;
}

export interface ExistingTransaction {
  date: string;
  /** Statement-signed amount (same sign convention as the lines). */
  amountMinor: bigint;
}

export interface GateInput {
  periodStart: string;
  periodEnd: string;
  openingBalance: bigint;
  closingBalance: bigint;
  lines: readonly GateLine[];
  /** Live transactions already on the account within the period. */
  existing: readonly ExistingTransaction[];
  /** Currency the statement states (if any) and the business currency. */
  currency?: { extracted?: string | null | undefined; business: string } | undefined;
}

export interface GateResult {
  ok: boolean;
  reasons: GateReason[];
  /** Decimal strings (bigint is not JSON). */
  sumMinor: string;
  expectedMinor: string;
  differenceMinor: string;
  lineCount: number;
}

export function validateExtraction(input: GateInput): GateResult {
  const reasons: GateReason[] = [];
  const { lines } = input;

  const periodOk = isIsoDate(input.periodStart) && isIsoDate(input.periodEnd) && input.periodStart <= input.periodEnd;
  if (!periodOk) {
    reasons.push({ code: "invalid_period", message: "The statement period must be two valid dates with the start on or before the end." });
  }
  if (lines.length === 0) reasons.push({ code: "no_lines", message: "The extraction has no transaction lines." });
  if (lines.length > MAX_LINES) reasons.push({ code: "too_many_lines", message: `At most ${MAX_LINES} lines are allowed.` });

  let sum = 0n;
  const amounts: (bigint | null)[] = lines.map((l) => parseMinorInteger(l.amountMinor));
  lines.forEach((l, i) => {
    const a = amounts[i]!;
    if (a === null) {
      reasons.push({ code: "non_integer_amount", lineIndex: i, message: `Line ${i + 1}: the amount is not an exact whole number of minor units.` });
    } else {
      sum += a;
      if (a === 0n && !l.alreadyRecorded) {
        reasons.push({ code: "zero_amount", lineIndex: i, message: `Line ${i + 1}: a zero amount cannot be posted; remove it or mark it already recorded.` });
      }
    }
    if (typeof l.date !== "string" || !isIsoDate(l.date)) {
      reasons.push({ code: "invalid_date", lineIndex: i, message: `Line ${i + 1}: the date is not a valid YYYY-MM-DD date.` });
    } else if (periodOk && (l.date < input.periodStart || l.date > input.periodEnd)) {
      reasons.push({ code: "date_out_of_period", lineIndex: i, message: `Line ${i + 1}: ${l.date} is outside the statement period ${input.periodStart} to ${input.periodEnd}.` });
    }
  });

  const expected = input.closingBalance - input.openingBalance;
  const difference = sum - expected;
  if (difference !== 0n) {
    reasons.push({
      code: "balance_mismatch",
      message: `The lines add up to ${sum} but closing minus opening balance is ${expected} (difference ${difference}, in minor units).`,
    });
  }

  // Multiset duplicate detection against the ledger, in line order (deterministic).
  const pool = new Map<string, number>();
  for (const e of input.existing) {
    const k = `${e.date}|${e.amountMinor}`;
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  lines.forEach((l, i) => {
    const a = amounts[i];
    if (a === null || a === undefined || l.alreadyRecorded) return;
    const k = `${l.date}|${a}`;
    const left = pool.get(k) ?? 0;
    if (left > 0) {
      pool.set(k, left - 1);
      reasons.push({
        code: "duplicate_existing", lineIndex: i,
        message: `Line ${i + 1}: a transaction with the same date and amount is already on this account. If it is the same one, mark the line already recorded.`,
      });
    }
  });

  const c = input.currency;
  if (c?.extracted && c.extracted.toUpperCase() !== c.business.toUpperCase()) {
    reasons.push({
      code: "currency_mismatch",
      message: `The statement is in ${c.extracted.toUpperCase()} but this business uses ${c.business.toUpperCase()}.`,
    });
  }

  return {
    ok: reasons.length === 0,
    reasons,
    sumMinor: sum.toString(),
    expectedMinor: expected.toString(),
    differenceMinor: difference.toString(),
    lineCount: lines.length,
  };
}
