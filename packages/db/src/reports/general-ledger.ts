import type { PoolClient } from 'pg';
import type { AccountType } from '../types.js';
import { type AccountRef, type Minor, assertRange, naturalSign, signed, toMinor } from './shared.js';

export interface LedgerLine {
  lineId: string;
  entryId: string;
  transactionId: string;
  date: string;
  description: string;
  memo: string;
  debit: Minor;
  credit: Minor;
  /** Running natural-sign balance after this line. */
  balance: Minor;
}

export interface LedgerAccount extends AccountRef {
  openingBalance: Minor;
  lines: LedgerLine[];
  totalDebits: Minor;
  totalCredits: Minor;
  closingBalance: Minor;
}

export interface GeneralLedger {
  from: string;
  to: string;
  accounts: LedgerAccount[];
}

/**
 * General ledger over [from, to]. With `accountId` it is the transaction
 * detail for that single account (empty `accounts` if it does not exist in
 * this business). Without it, every account with an opening balance or
 * activity is included. Opening balance = all live lines dated before `from`.
 */
export async function generalLedger(
  c: PoolClient, businessId: string, from: string, to: string, accountId?: string,
): Promise<GeneralLedger> {
  assertRange(from, to);
  const acct = accountId ?? null;

  const opening = await c.query<{
    id: string; code: string | null; name: string; type: AccountType; contra: boolean; net: string;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.contra,
            COALESCE(SUM(l.amount_minor) FILTER (WHERE l.entry_date < $2::date), 0)::text AS net
       FROM accounts a
       LEFT JOIN live_journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
                                     AND l.entry_date <= $3::date
      WHERE a.business_id = $1 AND ($4::uuid IS NULL OR a.id = $4::uuid)
      GROUP BY a.id
     HAVING COUNT(l.id) > 0 OR $4::uuid IS NOT NULL
      ORDER BY a.code NULLS LAST, a.name, a.id`,
    [businessId, from, to, acct]);

  const lines = await c.query<{
    id: string; entry_id: string; transaction_id: string; account_id: string; date: string;
    description: string; memo: string; amount: string;
  }>(
    `SELECT l.id, l.entry_id, l.transaction_id, l.account_id, l.entry_date::text AS date,
            t.description, l.memo, l.amount_minor::text AS amount
       FROM live_journal_lines l
       JOIN transactions t ON t.business_id = l.business_id AND t.id = l.transaction_id
      WHERE l.business_id = $1 AND l.entry_date BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR l.account_id = $4::uuid)
      ORDER BY l.entry_date, l.entry_id, l.id`,
    [businessId, from, to, acct]);

  const byAccount = new Map<string, typeof lines.rows>();
  for (const l of lines.rows) {
    const list = byAccount.get(l.account_id);
    if (list) list.push(l); else byAccount.set(l.account_id, [l]);
  }

  const accounts = opening.rows.map((r): LedgerAccount => {
    const sign = naturalSign(r.type);
    const openingBalance = signed(toMinor(r.net), r.type);
    let balance = openingBalance;
    let totalDebits = 0;
    let totalCredits = 0;
    const out = (byAccount.get(r.id) ?? []).map((l): LedgerLine => {
      const amount = toMinor(l.amount);
      const debit = amount > 0 ? amount : 0;
      const credit = amount < 0 ? -amount : 0;
      totalDebits += debit;
      totalCredits += credit;
      balance += amount * sign;
      return {
        lineId: l.id, entryId: l.entry_id, transactionId: l.transaction_id, date: l.date,
        description: l.description, memo: l.memo, debit, credit, balance,
      };
    });
    return {
      accountId: r.id, code: r.code, name: r.name, type: r.type, contra: r.contra,
      openingBalance, lines: out, totalDebits, totalCredits, closingBalance: balance,
    };
  });
  return { from, to, accounts };
}
