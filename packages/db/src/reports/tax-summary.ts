import type { PoolClient } from 'pg';
import type { AccountType } from '../types.js';
import { type AccountRef, type Minor, assertRange, signed, toMinor } from './shared.js';

export interface TaxSummaryRow extends AccountRef {
  debits: Minor;
  credits: Minor;
  /** Period movement in the account's natural sign (e.g. sales tax collected, positive, on a liability). */
  net: Minor;
}

export interface TaxSummary {
  from: string;
  to: string;
  /** How rows were chosen: explicit account ids, or accounts whose name contains "tax". */
  selection: 'accounts' | 'name-match';
  rows: TaxSummaryRow[];
  totals: { debits: Minor; credits: Minor };
}

/**
 * Jurisdiction-agnostic tax summary: period debits, credits and net movement
 * per account over [from, to], accrual basis. Riffle has no tax-code model
 * yet (ADR 0008), so the accounts are chosen by the caller (`accountIds`) or,
 * by default, every account whose name contains "tax" (e.g. Sales Tax
 * Payable, Taxes). Accounts with no activity in the period are omitted.
 */
export async function taxSummary(
  c: PoolClient, businessId: string, from: string, to: string, accountIds?: readonly string[],
): Promise<TaxSummary> {
  assertRange(from, to);
  const explicit = accountIds && accountIds.length > 0 ? [...accountIds] : null;
  const { rows } = await c.query<{
    id: string; code: string | null; name: string; type: AccountType; contra: boolean; debits: string; credits: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.contra,
            COALESCE(SUM(l.amount_minor) FILTER (WHERE l.amount_minor > 0), 0)::text AS debits,
            COALESCE(-SUM(l.amount_minor) FILTER (WHERE l.amount_minor < 0), 0)::text AS credits
       FROM accounts a
       JOIN live_journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
      WHERE a.business_id = $1 AND l.entry_date BETWEEN $2::date AND $3::date
        AND (CASE WHEN $4::uuid[] IS NULL THEN a.name ILIKE '%tax%' ELSE a.id = ANY($4::uuid[]) END)
      GROUP BY a.id
      ORDER BY a.code NULLS LAST, a.name, a.id`,
    [businessId, from, to, explicit]);

  const totals = { debits: 0, credits: 0 };
  const out = rows.map((r): TaxSummaryRow => {
    const debits = toMinor(r.debits);
    const credits = toMinor(r.credits);
    totals.debits += debits;
    totals.credits += credits;
    return {
      accountId: r.id, code: r.code, name: r.name, type: r.type, contra: r.contra,
      debits, credits, net: signed(debits - credits, r.type),
    };
  });
  return { from, to, selection: explicit ? 'accounts' : 'name-match', rows: out, totals };
}
