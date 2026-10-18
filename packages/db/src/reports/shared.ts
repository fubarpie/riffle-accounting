import type { AccountType } from '../types.js';

/** Integer minor units (e.g. cents). Never a float. */
export type Minor = number;

/** Convert a Postgres bigint/numeric text value to integer minor units, refusing silent precision loss. */
export function toMinor(text: string | null | undefined): Minor {
  const v = BigInt(text ?? '0');
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('amount exceeds the safe integer range');
  }
  return Number(v);
}

/**
 * Sign that turns a debit-positive ledger sum into the account's natural
 * balance: debit-normal types (asset, expense) as-is, credit-normal types
 * (liability, equity, income) negated. Contra accounts need no special case:
 * their natural balance simply comes out with the opposite sign.
 */
export function naturalSign(type: AccountType): 1 | -1 {
  return type === 'asset' || type === 'expense' ? 1 : -1;
}

/** Apply a natural sign without ever producing -0. */
export function signed(n: Minor, type: AccountType): Minor {
  return n * naturalSign(type) || 0;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Dates are plain calendar dates, passed to SQL as text and cast with ::date. */
export function assertDate(value: string, name: string): void {
  // Round-trip so impossible dates such as 2026-02-30 are rejected, not rolled over.
  const d = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} must be a YYYY-MM-DD date`);
  }
}

export function assertRange(from: string, to: string): void {
  assertDate(from, 'from');
  assertDate(to, 'to');
  if (from > to) throw new RangeError('from must not be after to');
}

export interface AccountRef {
  accountId: string;
  code: string | null;
  name: string;
  type: AccountType;
  contra: boolean;
}
