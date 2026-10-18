import type { PoolClient } from 'pg';
import type { AccountType } from '../types.js';
import { type AccountRef, type Minor, assertRange, signed, toMinor } from './shared.js';

export interface ProfitLossRow extends AccountRef {
  /** Natural-sign amount: income positive when earned, expense positive when incurred. */
  amount: Minor;
}

export interface ProfitLoss {
  from: string;
  to: string;
  income: ProfitLossRow[];
  expenses: ProfitLossRow[];
  totals: { income: Minor; expenses: Minor; netIncome: Minor };
}

/** Profit and loss over [from, to] inclusive, accrual basis (by entry date, not cash movement). */
export async function profitLoss(c: PoolClient, businessId: string, from: string, to: string): Promise<ProfitLoss> {
  assertRange(from, to);
  const { rows } = await c.query<{
    id: string; code: string | null; name: string; type: AccountType; contra: boolean; net: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.contra, SUM(l.amount_minor)::text AS net
       FROM accounts a
       JOIN live_journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
      WHERE a.business_id = $1 AND a.type IN ('income', 'expense')
        AND l.entry_date BETWEEN $2::date AND $3::date
      GROUP BY a.id
      ORDER BY a.code NULLS LAST, a.name, a.id`,
    [businessId, from, to]);

  const income: ProfitLossRow[] = [];
  const expenses: ProfitLossRow[] = [];
  for (const r of rows) {
    const row: ProfitLossRow = {
      accountId: r.id, code: r.code, name: r.name, type: r.type, contra: r.contra,
      amount: signed(toMinor(r.net), r.type),
    };
    (r.type === 'income' ? income : expenses).push(row);
  }
  const sum = (xs: ProfitLossRow[]): Minor => xs.reduce((s, x) => s + x.amount, 0);
  const totals = { income: sum(income), expenses: sum(expenses), netIncome: sum(income) - sum(expenses) };
  return { from, to, income, expenses, totals };
}
