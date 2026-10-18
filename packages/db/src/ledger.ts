import type { Pool, PoolClient } from 'pg';
import { seedDefaultChart } from './chart.js';
import { withTenant } from './tenant.js';
import type { TransactionKind } from './types.js';
import { uuidv7 } from './uuid.js';

export interface LineInput {
  accountId: string;
  /** Signed minor units: debit positive, credit negative. Non-zero. */
  amount: bigint;
  memo?: string;
}

export class LedgerInputError extends Error {}

/** Application-level validation. The database re-checks everything at commit. */
export function validateLines(lines: readonly LineInput[]): void {
  if (lines.length < 2) throw new LedgerInputError('an entry needs at least two lines');
  let sum = 0n;
  for (const l of lines) {
    if (l.amount === 0n) throw new LedgerInputError('line amounts must be non-zero');
    sum += l.amount;
  }
  if (sum !== 0n) throw new LedgerInputError(`entry is unbalanced by ${sum}`);
}

async function audit(
  c: PoolClient, businessId: string, actor: string, action: string,
  entity: string, entityId: string, before: unknown, after: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (id, business_id, actor_user_id, action, entity, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), businessId, actor, action, entity, entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after)],
  );
}

async function insertEntry(
  c: PoolClient, businessId: string, txnId: string, date: string, actor: string,
  lines: readonly LineInput[], reverses?: string,
): Promise<string> {
  const entryId = uuidv7();
  await c.query(
    `INSERT INTO journal_entries (id, business_id, transaction_id, entry_date, reverses_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entryId, businessId, txnId, date, reverses ?? null, actor],
  );
  for (const l of lines) {
    await c.query(
      `INSERT INTO journal_lines (id, business_id, entry_id, account_id, amount_minor, memo)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv7(), businessId, entryId, l.accountId, l.amount.toString(), l.memo ?? ''],
    );
  }
  return entryId;
}

async function entryLines(c: PoolClient, entryId: string): Promise<LineInput[]> {
  const { rows } = await c.query<{ account_id: string; amount_minor: string; memo: string }>(
    'SELECT account_id, amount_minor, memo FROM journal_lines WHERE entry_id = $1 ORDER BY id',
    [entryId],
  );
  return rows.map((r) => ({ accountId: r.account_id, amount: BigInt(r.amount_minor), memo: r.memo }));
}

export interface CreateBusinessInput {
  name: string;
  /** ISO 4217. Fixed once the business has entries. */
  currency: string;
}

/** Create a business, make `userId` its owner, seed the default chart. */
export async function createBusiness(pool: Pool, userId: string, input: CreateBusinessInput): Promise<string> {
  const businessId = uuidv7();
  await withTenant(pool, { userId }, async (c) => {
    await c.query('INSERT INTO businesses (id, name, currency) VALUES ($1,$2,$3)',
      [businessId, input.name, input.currency]);
    // Business now exists; scope the rest of this transaction to it.
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);
    await c.query(`INSERT INTO memberships (id, user_id, business_id, role) VALUES ($1,$2,$3,'owner')`,
      [uuidv7(), userId, businessId]);
    await seedDefaultChart(c, businessId, input.currency);
    await audit(c, businessId, userId, 'business.create', 'business', businessId, undefined,
      { name: input.name, currency: input.currency });
  });
  return businessId;
}

export interface PostInput {
  kind: TransactionKind;
  date: string; // YYYY-MM-DD
  description?: string;
  notes?: string;
  lines: readonly LineInput[];
}

/** Post a new transaction with its first entry. Call inside withTenant. */
export async function postTransaction(
  c: PoolClient, businessId: string, actor: string, input: PostInput,
): Promise<{ transactionId: string; entryId: string }> {
  validateLines(input.lines);
  const transactionId = uuidv7();
  await c.query(
    `INSERT INTO transactions (id, business_id, kind, date, description, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [transactionId, businessId, input.kind, input.date, input.description ?? '', input.notes ?? '', actor],
  );
  const entryId = await insertEntry(c, businessId, transactionId, input.date, actor, input.lines);
  await c.query('UPDATE transactions SET current_entry_id = $1 WHERE business_id = $2 AND id = $3',
    [entryId, businessId, transactionId]);
  await audit(c, businessId, actor, 'transaction.post', 'transaction', transactionId, undefined,
    { ...input, lines: input.lines.map((l) => ({ ...l, amount: l.amount.toString() })) });
  return { transactionId, entryId };
}

export interface EditInput {
  date?: string;
  description?: string;
  notes?: string;
  /** If given, replaces the posted lines (reverse + repost). */
  lines?: readonly LineInput[];
}

async function loadLive(c: PoolClient, businessId: string, transactionId: string) {
  const { rows } = await c.query<{ current_entry_id: string | null; voided_at: Date | null; date: string }>(
    `SELECT current_entry_id, voided_at, to_char(date,'YYYY-MM-DD') AS date
       FROM transactions WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, transactionId],
  );
  const row = rows[0];
  if (!row) throw new LedgerInputError('transaction not found');
  if (row.voided_at || !row.current_entry_id) throw new LedgerInputError('transaction is voided');
  return { entryId: row.current_entry_id, date: row.date };
}

/**
 * Edit a transaction. Metadata changes update the transaction row; line or date
 * changes insert a reversing entry plus a replacement, never mutating history.
 */
export async function editTransaction(
  c: PoolClient, businessId: string, actor: string, transactionId: string, edit: EditInput,
): Promise<void> {
  const live = await loadLive(c, businessId, transactionId);
  if (edit.lines) validateLines(edit.lines);

  if (edit.lines || (edit.date && edit.date !== live.date)) {
    const oldLines = await entryLines(c, live.entryId);
    const date = edit.date ?? live.date;
    await insertEntry(c, businessId, transactionId, date, actor,
      oldLines.map((l) => ({ ...l, amount: -l.amount })), live.entryId);
    const newEntry = await insertEntry(c, businessId, transactionId, date, actor, edit.lines ?? oldLines);
    await c.query(
      'UPDATE transactions SET current_entry_id = $1, date = $2, updated_at = now() WHERE business_id = $3 AND id = $4',
      [newEntry, date, businessId, transactionId]);
  }
  if (edit.description !== undefined || edit.notes !== undefined) {
    await c.query(
      `UPDATE transactions SET description = coalesce($1, description), notes = coalesce($2, notes),
         updated_at = now() WHERE business_id = $3 AND id = $4`,
      [edit.description ?? null, edit.notes ?? null, businessId, transactionId]);
  }
  await audit(c, businessId, actor, 'transaction.edit', 'transaction', transactionId, undefined,
    { ...edit, lines: edit.lines?.map((l) => ({ ...l, amount: l.amount.toString() })) });
}

/** Void a transaction by reversing its live entry. History is retained. */
export async function voidTransaction(
  c: PoolClient, businessId: string, actor: string, transactionId: string,
): Promise<void> {
  const live = await loadLive(c, businessId, transactionId);
  const lines = await entryLines(c, live.entryId);
  await insertEntry(c, businessId, transactionId, live.date, actor,
    lines.map((l) => ({ ...l, amount: -l.amount })), live.entryId);
  await c.query(
    `UPDATE transactions SET current_entry_id = NULL, voided_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, transactionId]);
  await audit(c, businessId, actor, 'transaction.void', 'transaction', transactionId, undefined, undefined);
}

/** Balance per account over live (non-reversed, non-voided) lines. */
export async function liveBalances(c: PoolClient, businessId: string): Promise<Map<string, bigint>> {
  const { rows } = await c.query<{ account_id: string; s: string }>(
    `SELECT account_id, sum(amount_minor)::text AS s FROM live_journal_lines
      WHERE business_id = $1 GROUP BY account_id`, [businessId]);
  return new Map(rows.map((r) => [r.account_id, BigInt(r.s)]));
}

/** Balance per account over every line, including reversed history. */
export async function allBalances(c: PoolClient, businessId: string): Promise<Map<string, bigint>> {
  const { rows } = await c.query<{ account_id: string; s: string }>(
    `SELECT account_id, sum(amount_minor)::text AS s FROM journal_lines
      WHERE business_id = $1 GROUP BY account_id`, [businessId]);
  return new Map(rows.map((r) => [r.account_id, BigInt(r.s)]));
}
