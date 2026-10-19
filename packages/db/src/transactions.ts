import type { PoolClient } from 'pg';
import type { TransactionKind } from './types.js';

export type TransactionStatusFilter = 'live' | 'voided' | 'all';
export type TransactionSort = 'date' | 'amount' | 'description';

export interface TransactionListQuery {
  /** Case-insensitive text search over description, notes and line memos. */
  q?: string | undefined;
  /** Inclusive calendar dates (YYYY-MM-DD). */
  from?: string | undefined;
  to?: string | undefined;
  kind?: TransactionKind | undefined;
  /** Only transactions with a line on this account. */
  accountId?: string | undefined;
  status?: TransactionStatusFilter | undefined;
  sort?: TransactionSort | undefined;
  dir?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface TransactionAccountLine {
  accountId: string;
  code: string | null;
  name: string;
  /** Signed minor units as a string: debit positive, credit negative. */
  amountMinor: string;
}

export interface TransactionRow {
  id: string;
  kind: TransactionKind;
  date: string;
  description: string;
  notes: string;
  voided: boolean;
  /** Gross debit total in minor units. Null for a voided transaction (it has no live entry). */
  amountMinor: string | null;
  accounts: TransactionAccountLine[];
}

export interface TransactionList {
  total: number;
  limit: number;
  offset: number;
  transactions: TransactionRow[];
}

export const TRANSACTION_MAX_LIMIT = 100;
export const TRANSACTION_DEFAULT_LIMIT = 50;

/** Escape LIKE wildcards so user text is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Whitelisted ORDER BY fragments; user input never reaches the SQL text.
 * They sort on the numeric `base` columns. The outer SELECT must not reuse
 * those names for text casts, or ORDER BY would sort the text instead.
 */
const ORDER: Record<TransactionSort, (dir: 'ASC' | 'DESC') => string> = {
  date: (d) => `date ${d}, created_at ${d}, id ${d}`,
  amount: (d) => `amount_minor ${d} NULLS LAST, date DESC, id DESC`,
  description: (d) => `lower(description) ${d}, date DESC, id DESC`,
};

/**
 * Page through a business's transactions with search, filters and sorting.
 * Reads through the caller's tenant-scoped client, so RLS confines it to the
 * business; the explicit business_id predicates are belt and braces.
 */
export async function listTransactions(
  c: PoolClient, businessId: string, query: TransactionListQuery = {},
): Promise<TransactionList> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? TRANSACTION_DEFAULT_LIMIT), 1), TRANSACTION_MAX_LIMIT);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const status = query.status ?? 'live';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = ORDER[query.sort ?? 'date'](dir);

  const params: unknown[] = [businessId];
  const where: string[] = ['t.business_id = $1'];
  const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };

  if (status === 'live') where.push('t.voided_at IS NULL');
  else if (status === 'voided') where.push('t.voided_at IS NOT NULL');
  if (query.from) where.push(`t.date >= ${add(query.from)}::date`);
  if (query.to) where.push(`t.date <= ${add(query.to)}::date`);
  if (query.kind) where.push(`t.kind = ${add(query.kind)}::transaction_kind`);
  if (query.accountId) {
    const p = add(query.accountId);
    where.push(`EXISTS (SELECT 1 FROM journal_lines l WHERE l.business_id = t.business_id
                          AND l.entry_id = t.current_entry_id AND l.account_id = ${p}::uuid)`);
  }
  const text = query.q?.trim();
  if (text) {
    const p = add(`%${escapeLike(text)}%`);
    where.push(`(t.description ILIKE ${p} OR t.notes ILIKE ${p}
                 OR EXISTS (SELECT 1 FROM journal_lines l WHERE l.business_id = t.business_id
                              AND l.entry_id = t.current_entry_id AND l.memo ILIKE ${p}))`);
  }
  const whereSql = where.join(' AND ');

  const count = await c.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM transactions t WHERE ${whereSql}`, params);
  const total = Number(count.rows[0]?.n ?? 0);

  const limitP = `$${params.length + 1}`;
  const offsetP = `$${params.length + 2}`;
  const page = await c.query<{
    id: string; kind: TransactionKind; date: string; description: string; notes: string;
    voided: boolean; amount_text: string | null;
  }>(
    `WITH base AS (
       SELECT t.id, t.kind::text AS kind, t.date::text AS date, t.description, t.notes,
              t.created_at, t.voided_at IS NOT NULL AS voided,
              (SELECT SUM(l.amount_minor) FILTER (WHERE l.amount_minor > 0)
                 FROM journal_lines l
                WHERE l.business_id = t.business_id AND l.entry_id = t.current_entry_id) AS amount_minor
         FROM transactions t WHERE ${whereSql})
     SELECT id, kind, date, description, notes, voided, amount_minor::text AS amount_text
       FROM base ORDER BY ${orderBy} LIMIT ${limitP} OFFSET ${offsetP}`,
    [...params, limit, offset]);

  const ids = page.rows.map((r) => r.id);
  const byTxn = new Map<string, TransactionAccountLine[]>();
  if (ids.length > 0) {
    const lines = await c.query<{
      transaction_id: string; account_id: string; code: string | null; name: string; amount: string;
    }>(
      `SELECT t.id AS transaction_id, a.id AS account_id, a.code, a.name,
              SUM(l.amount_minor)::text AS amount
         FROM transactions t
         JOIN journal_lines l ON l.business_id = t.business_id AND l.entry_id = t.current_entry_id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE t.business_id = $1 AND t.id = ANY($2::uuid[])
        GROUP BY t.id, a.id
        ORDER BY t.id, SUM(l.amount_minor) DESC, a.code NULLS LAST, a.id`,
      [businessId, ids]);
    for (const l of lines.rows) {
      const entry: TransactionAccountLine = { accountId: l.account_id, code: l.code, name: l.name, amountMinor: l.amount };
      const list = byTxn.get(l.transaction_id);
      if (list) list.push(entry); else byTxn.set(l.transaction_id, [entry]);
    }
  }

  return {
    total, limit, offset,
    transactions: page.rows.map((r): TransactionRow => ({
      id: r.id, kind: r.kind, date: r.date, description: r.description, notes: r.notes,
      voided: r.voided, amountMinor: r.amount_text, accounts: byTxn.get(r.id) ?? [],
    })),
  };
}
