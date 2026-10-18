import type { PoolClient } from 'pg';
import type { AccountType } from '../types.js';
import { type AccountRef, type Minor, assertDate, toMinor } from './shared.js';

export interface TrialBalanceRow extends AccountRef {
  /** Gross debits and credits posted up to the date (credits as a positive number). */
  debits: Minor;
  credits: Minor;
  /** Net balance shown in one column: debitBalance XOR creditBalance is non-zero. */
  debitBalance: Minor;
  creditBalance: Minor;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totals: { debits: Minor; credits: Minor; debitBalance: Minor; creditBalance: Minor };
}

/** Trial balance as of a date (inclusive), accrual basis: every live line dated on or before it. */
export async function trialBalance(c: PoolClient, businessId: string, asOf: string): Promise<TrialBalance> {
  assertDate(asOf, 'asOf');
  const { rows } = await c.query<{
    id: string; code: string | null; name: string; type: AccountType; contra: boolean; debits: string; credits: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.contra,
            COALESCE(SUM(l.amount_minor) FILTER (WHERE l.amount_minor > 0), 0)::text AS debits,
            COALESCE(-SUM(l.amount_minor) FILTER (WHERE l.amount_minor < 0), 0)::text AS credits
       FROM accounts a
       JOIN live_journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
      WHERE a.business_id = $1 AND l.entry_date <= $2::date
      GROUP BY a.id
      ORDER BY a.code NULLS LAST, a.name, a.id`,
    [businessId, asOf]);

  const totals = { debits: 0, credits: 0, debitBalance: 0, creditBalance: 0 };
  const out = rows.map((r): TrialBalanceRow => {
    const debits = toMinor(r.debits);
    const credits = toMinor(r.credits);
    const net = debits - credits;
    const row: TrialBalanceRow = {
      accountId: r.id, code: r.code, name: r.name, type: r.type, contra: r.contra,
      debits, credits, debitBalance: Math.max(net, 0), creditBalance: Math.max(-net, 0),
    };
    totals.debits += debits;
    totals.credits += credits;
    totals.debitBalance += row.debitBalance;
    totals.creditBalance += row.creditBalance;
    return row;
  });
  return { asOf, rows: out, totals };
}
