import type { PoolClient } from 'pg';
import type { AccountType } from '../types.js';
import { type AccountRef, type Minor, assertDate, signed, toMinor } from './shared.js';

export interface BalanceSheetRow extends AccountRef {
  /** Natural-sign balance (contra accounts therefore show as negative). */
  amount: Minor;
}

export interface BalanceSheet {
  asOf: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  /**
   * Cumulative income minus expense through the date. Riffle has no period
   * close, so this is shown as a synthetic equity line and is what makes
   * assets = liabilities + equity hold at any date.
   */
  currentEarnings: Minor;
  totals: { assets: Minor; liabilities: Minor; equity: Minor; liabilitiesAndEquity: Minor };
}

/** Balance sheet as of a date (inclusive), accrual basis. */
export async function balanceSheet(c: PoolClient, businessId: string, asOf: string): Promise<BalanceSheet> {
  assertDate(asOf, 'asOf');
  const { rows } = await c.query<{
    id: string; code: string | null; name: string; type: AccountType; contra: boolean; net: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.contra, SUM(l.amount_minor)::text AS net
       FROM accounts a
       JOIN live_journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
      WHERE a.business_id = $1 AND l.entry_date <= $2::date
      GROUP BY a.id
      ORDER BY a.code NULLS LAST, a.name, a.id`,
    [businessId, asOf]);

  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];
  let currentEarnings = 0;
  for (const r of rows) {
    const net = toMinor(r.net);
    if (r.type === 'income' || r.type === 'expense') {
      currentEarnings -= net; // income is credit-negative, expense debit-positive
      continue;
    }
    const row: BalanceSheetRow = {
      accountId: r.id, code: r.code, name: r.name, type: r.type, contra: r.contra,
      amount: signed(net, r.type),
    };
    (r.type === 'asset' ? assets : r.type === 'liability' ? liabilities : equity).push(row);
  }
  const sum = (xs: BalanceSheetRow[]): Minor => xs.reduce((s, x) => s + x.amount, 0);
  const totals = {
    assets: sum(assets),
    liabilities: sum(liabilities),
    equity: sum(equity) + currentEarnings,
    liabilitiesAndEquity: sum(liabilities) + sum(equity) + currentEarnings,
  };
  return { asOf, assets, liabilities, equity, currentEarnings, totals };
}
