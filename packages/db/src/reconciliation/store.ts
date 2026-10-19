/**
 * Account reconciliation: clear journal lines of an asset/liability account
 * against a statement. See docs/adr/0010-reconciliation-and-vault.md.
 *
 * All functions take a PoolClient already inside withTenant/withMembership.
 * Nothing here writes journal lines: a reconciliation only links existing,
 * live lines, so the ledger stays append-only (ADR 0004).
 */
import type { PoolClient } from 'pg';
import { audit } from '../ledger.js';
import { BooksLockedError } from '../bank/staged.js';
import { NotFoundError } from '../bank/connections.js';
import type { AccountType, MembershipRole } from '../types.js';
import { uuidv7 } from '../uuid.js';

export const RECONCILIATION_WRITER_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];
export const MAX_ITEMS_PER_CALL = 500;
export const MAX_CANDIDATES = 1_000;
/** Largest magnitude we accept for a statement balance (keeps sums far from bigint overflow). */
export const MAX_BALANCE_MINOR = 10n ** 15n;

export type ReconciliationStatus = 'draft' | 'completed' | 'voided';

/** The request is invalid for the data (bad balance, wrong account, line not eligible). HTTP 422. */
export class ReconciliationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationInputError';
  }
}
/** The request conflicts with current state (not a draft, already cleared elsewhere). HTTP 409. */
export class ReconciliationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationStateError';
  }
}

/**
 * Sign that turns a raw ledger amount (debit +, credit -) into the figure a
 * statement prints for the account. Debit-normal accounts (assets, expenses)
 * print debits as positive; credit-normal accounts (liabilities, equity,
 * income) print credits as positive. A contra account flips its type's side.
 */
export function normalSign(type: AccountType, contra: boolean): 1n | -1n {
  const debitNormal = type === 'asset' || type === 'expense';
  return debitNormal !== contra ? 1n : -1n;
}

/** closing - (opening + cleared). Zero means the book and the statement agree. */
export function reconciliationDifference(opening: bigint, cleared: bigint, closing: bigint): bigint {
  return closing - (opening + cleared);
}

export interface Reconciliation {
  id: string;
  businessId: string;
  accountId: string;
  statementStart: string;
  statementEnd: string;
  openingBalanceMinor: bigint;
  closingBalanceMinor: bigint;
  status: ReconciliationStatus;
  completedAt: Date | null;
  completedBy: string | null;
  voidedAt: Date | null;
  voidedBy: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface LineView {
  lineId: string;
  transactionId: string;
  entryDate: string;
  description: string;
  memo: string;
  /** Raw ledger amount: debit positive, credit negative. */
  amountMinor: bigint;
  /** The same amount as the statement would print it (see normalSign). */
  statementAmountMinor: bigint;
}
export interface ClearedLine extends LineView {
  /** True when the line is no longer live (its transaction was edited or voided after clearing). Drafts only. */
  stale: boolean;
}
export interface CandidateLine extends LineView {
  /** Within [statement_start, statement_end]; earlier lines are outstanding carry-overs. */
  inWindow: boolean;
}

export interface ReconciliationSummary {
  openingBalanceMinor: bigint;
  closingBalanceMinor: bigint;
  clearedMinor: bigint;
  clearedCount: number;
  staleCount: number;
  /** closing - (opening + cleared). Completion requires 0. */
  differenceMinor: bigint;
}

export interface ReconciliationDetail {
  reconciliation: Reconciliation;
  summary: ReconciliationSummary;
  cleared: ClearedLine[];
  /** Live, uncleared lines of the account up to statement_end. Drafts only. */
  candidates: CandidateLine[];
  /** True when more candidates exist than were returned. */
  candidatesTruncated: boolean;
  /** Candidate line ids inside the statement window: the suggested set to clear. */
  suggestedLineIds: string[];
  /** Sum (statement sign) of the suggested lines; if opening + cleared + this = closing, clearing them all reconciles. */
  suggestedTotalMinor: bigint;
}

interface ReconRow {
  id: string; business_id: string; account_id: string; statement_start: string; statement_end: string;
  opening_balance_minor: string; closing_balance_minor: string; status: ReconciliationStatus;
  completed_at: Date | null; completed_by: string | null; voided_at: Date | null; voided_by: string | null;
  created_by: string; created_at: Date;
}
const RECON_COLS = `id, business_id, account_id, to_char(statement_start,'YYYY-MM-DD') AS statement_start,
  to_char(statement_end,'YYYY-MM-DD') AS statement_end, opening_balance_minor::text, closing_balance_minor::text,
  status, completed_at, completed_by, voided_at, voided_by, created_by, created_at`;

const toRecon = (r: ReconRow): Reconciliation => ({
  id: r.id, businessId: r.business_id, accountId: r.account_id,
  statementStart: r.statement_start, statementEnd: r.statement_end,
  openingBalanceMinor: BigInt(r.opening_balance_minor), closingBalanceMinor: BigInt(r.closing_balance_minor),
  status: r.status, completedAt: r.completed_at, completedBy: r.completed_by,
  voidedAt: r.voided_at, voidedBy: r.voided_by, createdBy: r.created_by, createdAt: r.created_at,
});

const snapshot = (r: Reconciliation) => ({
  accountId: r.accountId, statementStart: r.statementStart, statementEnd: r.statementEnd,
  openingBalanceMinor: r.openingBalanceMinor.toString(), closingBalanceMinor: r.closingBalanceMinor.toString(),
  status: r.status,
});

function checkBalance(v: bigint, name: string): void {
  if (v > MAX_BALANCE_MINOR || v < -MAX_BALANCE_MINOR) throw new ReconciliationInputError(`${name} is out of range`);
}

/** Lock the account row: serialises create/complete/void per account. Returns its sign. */
async function lockAccount(c: PoolClient, businessId: string, accountId: string) {
  const { rows } = await c.query<{ type: AccountType; contra: boolean; archived_at: Date | null }>(
    'SELECT type, contra, archived_at FROM accounts WHERE business_id = $1 AND id = $2 FOR UPDATE',
    [businessId, accountId]);
  const a = rows[0];
  if (!a) throw new NotFoundError('account');
  return { type: a.type, contra: a.contra, archived: a.archived_at !== null, sign: normalSign(a.type, a.contra) };
}

async function lastCompleted(c: PoolClient, businessId: string, accountId: string, excludeId?: string) {
  const { rows } = await c.query<{ id: string; closing: string; end: string }>(
    `SELECT id, closing_balance_minor::text AS closing, to_char(statement_end,'YYYY-MM-DD') AS "end"
       FROM reconciliations
      WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND ($3::uuid IS NULL OR id <> $3)
      ORDER BY statement_end DESC LIMIT 1`,
    [businessId, accountId, excludeId ?? null]);
  const r = rows[0];
  return r ? { id: r.id, closing: BigInt(r.closing), end: r.end } : null;
}

async function loadForUpdate(c: PoolClient, businessId: string, id: string): Promise<Reconciliation> {
  const { rows } = await c.query<ReconRow>(
    `SELECT ${RECON_COLS} FROM reconciliations WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!rows[0]) throw new NotFoundError('reconciliation');
  return toRecon(rows[0]);
}

export interface CreateReconciliationInput {
  accountId: string;
  statementStart: string;
  statementEnd: string;
  /**
   * Statement opening balance. After a completed reconciliation it must equal that
   * one's closing balance (and defaults to it). For the first one it defaults to 0.
   */
  openingBalanceMinor?: bigint | undefined;
  closingBalanceMinor: bigint;
}

export async function createReconciliation(
  c: PoolClient, businessId: string, actor: string, input: CreateReconciliationInput,
): Promise<Reconciliation> {
  if (input.statementEnd < input.statementStart) {
    throw new ReconciliationInputError('statementEnd must not be before statementStart');
  }
  checkBalance(input.closingBalanceMinor, 'closingBalance');
  if (input.openingBalanceMinor !== undefined) checkBalance(input.openingBalanceMinor, 'openingBalance');

  const account = await lockAccount(c, businessId, input.accountId);
  if (account.type !== 'asset' && account.type !== 'liability') {
    throw new ReconciliationInputError('only asset and liability accounts can be reconciled');
  }
  if (account.archived) throw new ReconciliationInputError('account is archived');

  const draft = await c.query<{ id: string }>(
    `SELECT id FROM reconciliations WHERE business_id = $1 AND account_id = $2 AND status = 'draft'`,
    [businessId, input.accountId]);
  if (draft.rows[0]) {
    throw new ReconciliationStateError(`account already has a draft reconciliation (${draft.rows[0].id}); complete or void it first`);
  }

  const prev = await lastCompleted(c, businessId, input.accountId);
  let opening = input.openingBalanceMinor ?? 0n;
  if (prev) {
    if (input.openingBalanceMinor !== undefined && input.openingBalanceMinor !== prev.closing) {
      throw new ReconciliationInputError(
        `opening balance must equal the previous reconciliation's closing balance (${prev.closing})`);
    }
    if (input.statementEnd <= prev.end) {
      throw new ReconciliationInputError(`statementEnd must be after the previous reconciliation's end (${prev.end})`);
    }
    opening = prev.closing;
  }

  const id = uuidv7();
  const { rows } = await c.query<ReconRow>(
    `INSERT INTO reconciliations (id, business_id, account_id, statement_start, statement_end,
        opening_balance_minor, closing_balance_minor, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${RECON_COLS}`,
    [id, businessId, input.accountId, input.statementStart, input.statementEnd,
      opening.toString(), input.closingBalanceMinor.toString(), actor]);
  const rec = toRecon(rows[0]!);
  await audit(c, businessId, actor, 'reconciliation.create', 'reconciliation', id, undefined, snapshot(rec));
  return rec;
}

export async function listReconciliations(
  c: PoolClient, businessId: string, filter: { accountId?: string | undefined; status?: ReconciliationStatus | undefined } = {},
): Promise<Reconciliation[]> {
  const { rows } = await c.query<ReconRow>(
    `SELECT ${RECON_COLS} FROM reconciliations
      WHERE business_id = $1 AND ($2::uuid IS NULL OR account_id = $2) AND ($3::reconciliation_status IS NULL OR status = $3)
      ORDER BY statement_end DESC, id DESC LIMIT 500`,
    [businessId, filter.accountId ?? null, filter.status ?? null]);
  return rows.map(toRecon);
}

interface LineRow {
  line_id: string; transaction_id: string; entry_date: string; description: string; memo: string; amount: string;
  live?: boolean;
}
const toLineView = (r: LineRow, sign: bigint): LineView => {
  const amount = BigInt(r.amount);
  return {
    lineId: r.line_id, transactionId: r.transaction_id, entryDate: r.entry_date,
    description: r.description, memo: r.memo, amountMinor: amount, statementAmountMinor: amount * sign,
  };
};

export async function getReconciliation(
  c: PoolClient, businessId: string, id: string,
): Promise<ReconciliationDetail | null> {
  const { rows } = await c.query<ReconRow>(
    `SELECT ${RECON_COLS} FROM reconciliations WHERE business_id = $1 AND id = $2`, [businessId, id]);
  if (!rows[0]) return null;
  const rec = toRecon(rows[0]);
  const { sign } = await lockless(c, businessId, rec.accountId);

  const items = await c.query<LineRow>(
    `SELECT l.id AS line_id, e.transaction_id, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date,
            t.description, l.memo, l.amount_minor::text AS amount, (lv.id IS NOT NULL) AS live
       FROM reconciliation_items i
       JOIN journal_lines l   ON l.business_id = i.business_id AND l.id = i.line_id
       JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.entry_id
       JOIN transactions t    ON t.business_id = e.business_id AND t.id = e.transaction_id
       LEFT JOIN live_journal_lines lv ON lv.business_id = l.business_id AND lv.id = l.id
      WHERE i.business_id = $1 AND i.reconciliation_id = $2
      ORDER BY e.entry_date, l.id`,
    [businessId, id]);
  const cleared: ClearedLine[] = items.rows.map((r) => ({
    ...toLineView(r, sign), stale: rec.status === 'draft' && !r.live,
  }));
  // A draft counts only live lines. Completed reconciliations are frozen (the reversal guard
  // keeps their lines live), so every item counts.
  const counted = cleared.filter((l) => !l.stale);
  const clearedMinor = counted.reduce((s, l) => s + l.statementAmountMinor, 0n);

  let candidates: CandidateLine[] = [];
  let truncated = false;
  if (rec.status === 'draft') {
    const cand = await c.query<LineRow>(
      `SELECT l.id AS line_id, l.transaction_id, to_char(l.entry_date,'YYYY-MM-DD') AS entry_date,
              t.description, l.memo, l.amount_minor::text AS amount
         FROM live_journal_lines l
         JOIN transactions t ON t.business_id = l.business_id AND t.id = l.transaction_id
        WHERE l.business_id = $1 AND l.account_id = $2 AND l.entry_date <= $3
          AND NOT EXISTS (SELECT 1 FROM reconciliation_items i
                           WHERE i.business_id = l.business_id AND i.line_id = l.id AND i.voided_at IS NULL)
        ORDER BY l.entry_date, l.id LIMIT ${MAX_CANDIDATES + 1}`,
      [businessId, rec.accountId, rec.statementEnd]);
    truncated = cand.rows.length > MAX_CANDIDATES;
    candidates = cand.rows.slice(0, MAX_CANDIDATES).map((r) => ({
      ...toLineView(r, sign), inWindow: r.entry_date >= rec.statementStart,
    }));
  }
  const suggested = candidates.filter((l) => l.inWindow);

  return {
    reconciliation: rec,
    summary: {
      openingBalanceMinor: rec.openingBalanceMinor, closingBalanceMinor: rec.closingBalanceMinor,
      clearedMinor, clearedCount: counted.length, staleCount: cleared.length - counted.length,
      differenceMinor: reconciliationDifference(rec.openingBalanceMinor, clearedMinor, rec.closingBalanceMinor),
    },
    cleared, candidates, candidatesTruncated: truncated,
    suggestedLineIds: suggested.map((l) => l.lineId),
    suggestedTotalMinor: suggested.reduce((s, l) => s + l.statementAmountMinor, 0n),
  };
}

/** Account sign without taking a row lock (read paths). */
async function lockless(c: PoolClient, businessId: string, accountId: string) {
  const { rows } = await c.query<{ type: AccountType; contra: boolean }>(
    'SELECT type, contra FROM accounts WHERE business_id = $1 AND id = $2', [businessId, accountId]);
  if (!rows[0]) throw new NotFoundError('account');
  return { sign: normalSign(rows[0].type, rows[0].contra) };
}

export interface ItemChanges {
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
}

/** Add and/or remove cleared lines on a draft. Adding an already-added line and removing an absent one are no-ops. */
export async function setReconciliationItems(
  c: PoolClient, businessId: string, actor: string, id: string, changes: ItemChanges,
): Promise<{ added: string[]; removed: string[] }> {
  const add = [...new Set(changes.add ?? [])];
  const remove = [...new Set(changes.remove ?? [])];
  if (add.length > MAX_ITEMS_PER_CALL || remove.length > MAX_ITEMS_PER_CALL) {
    throw new ReconciliationInputError(`at most ${MAX_ITEMS_PER_CALL} lines per call`);
  }
  if (add.some((x) => remove.includes(x))) throw new ReconciliationInputError('a line cannot be added and removed in one call');

  const rec = await loadForUpdate(c, businessId, id);
  if (rec.status !== 'draft') throw new ReconciliationStateError(`reconciliation is ${rec.status}, not a draft`);

  const removed: string[] = [];
  if (remove.length) {
    const r = await c.query<{ line_id: string }>(
      `DELETE FROM reconciliation_items WHERE business_id = $1 AND reconciliation_id = $2 AND line_id = ANY($3::uuid[])
       RETURNING line_id`, [businessId, id, remove]);
    removed.push(...r.rows.map((x) => x.line_id));
  }

  const added: string[] = [];
  if (add.length) {
    // live_journal_lines is RLS-scoped, so another tenant's line ids look exactly like unknown ones.
    const live = await c.query<{ id: string; account_id: string; entry_date: string }>(
      `SELECT id, account_id, to_char(entry_date,'YYYY-MM-DD') AS entry_date
         FROM live_journal_lines WHERE business_id = $1 AND id = ANY($2::uuid[])`, [businessId, add]);
    const byId = new Map(live.rows.map((r) => [r.id, r]));
    const taken = await c.query<{ line_id: string; reconciliation_id: string }>(
      `SELECT line_id, reconciliation_id FROM reconciliation_items
        WHERE business_id = $1 AND line_id = ANY($2::uuid[]) AND voided_at IS NULL`, [businessId, add]);
    const takenBy = new Map(taken.rows.map((r) => [r.line_id, r.reconciliation_id]));

    for (const lineId of add) {
      const line = byId.get(lineId);
      if (!line) throw new ReconciliationInputError(`line ${lineId} was not found or is no longer live`);
      if (line.account_id !== rec.accountId) {
        throw new ReconciliationInputError(`line ${lineId} belongs to a different account`);
      }
      if (line.entry_date > rec.statementEnd) {
        throw new ReconciliationInputError(`line ${lineId} is dated after the statement end (${rec.statementEnd})`);
      }
      const holder = takenBy.get(lineId);
      if (holder === id) continue; // already in this reconciliation
      if (holder) throw new ReconciliationStateError(`line ${lineId} is already cleared by reconciliation ${holder}`);
    }
    for (const lineId of add) {
      if (takenBy.get(lineId) === id) continue;
      try {
        await c.query(
          `INSERT INTO reconciliation_items (id, business_id, reconciliation_id, line_id, created_by)
           VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), businessId, id, lineId, actor]);
      } catch (err) {
        // A concurrent reconciliation won the race for this line (partial unique index).
        if ((err as { code?: string }).code === '23505') {
          throw new ReconciliationStateError(`line ${lineId} is already cleared by another reconciliation`);
        }
        throw err;
      }
      added.push(lineId);
    }
  }
  if (added.length || removed.length) {
    await audit(c, businessId, actor, 'reconciliation.items', 'reconciliation', id, undefined, { added, removed });
  }
  return { added, removed };
}

/**
 * Complete a draft. Requires: every cleared line still live, the opening balance
 * equal to the previous completed closing, the end after the previous end, and
 * difference == 0 (opening + cleared == closing).
 */
export async function completeReconciliation(
  c: PoolClient, businessId: string, actor: string, id: string,
): Promise<ReconciliationDetail> {
  const first = await loadForUpdate(c, businessId, id);
  // Serialise with other completions on the same account, then re-read under the lock.
  await lockAccount(c, businessId, first.accountId);
  const rec = await loadForUpdate(c, businessId, id);
  if (rec.status !== 'draft') throw new ReconciliationStateError(`reconciliation is ${rec.status}, not a draft`);

  const prev = await lastCompleted(c, businessId, rec.accountId);
  if (prev) {
    if (rec.openingBalanceMinor !== prev.closing) {
      throw new ReconciliationStateError(
        `opening balance ${rec.openingBalanceMinor} no longer matches the previous reconciliation's closing balance ${prev.closing}; void this draft and start again`);
    }
    if (rec.statementEnd <= prev.end) {
      throw new ReconciliationStateError(`statement end must be after the previous reconciliation's end (${prev.end})`);
    }
  }

  const detail = await getReconciliation(c, businessId, id);
  const { summary } = detail!;
  if (summary.staleCount > 0) {
    throw new ReconciliationInputError(
      `${summary.staleCount} cleared line(s) were edited or voided after clearing; remove them and re-clear the replacements`);
  }
  if (summary.differenceMinor !== 0n) {
    throw new ReconciliationInputError(
      `cannot complete: difference is ${summary.differenceMinor} (opening ${summary.openingBalanceMinor} + cleared ${summary.clearedMinor} != closing ${summary.closingBalanceMinor})`);
  }

  await c.query(
    `UPDATE reconciliations SET status = 'completed', completed_at = now(), completed_by = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, id, actor]);
  await audit(c, businessId, actor, 'reconciliation.complete', 'reconciliation', id,
    { status: 'draft' }, { status: 'completed', clearedCount: summary.clearedCount, clearedMinor: summary.clearedMinor.toString() });
  return (await getReconciliation(c, businessId, id))!;
}

/**
 * Void a draft or completed reconciliation, releasing its lines. A completed one
 * can only be voided newest-first (so opening balances keep chaining) and not
 * while books are locked through its statement end.
 */
export async function voidReconciliation(
  c: PoolClient, businessId: string, actor: string, id: string,
): Promise<ReconciliationDetail> {
  const first = await loadForUpdate(c, businessId, id);
  await lockAccount(c, businessId, first.accountId);
  const rec = await loadForUpdate(c, businessId, id);
  if (rec.status === 'voided') throw new ReconciliationStateError('reconciliation is already voided');

  if (rec.status === 'completed') {
    const later = await c.query(
      `SELECT 1 FROM reconciliations WHERE business_id = $1 AND account_id = $2 AND status = 'completed' AND statement_end > $3 LIMIT 1`,
      [businessId, rec.accountId, rec.statementEnd]);
    if (later.rowCount) {
      throw new ReconciliationStateError('a later reconciliation is completed for this account; void that one first');
    }
    const { rows } = await c.query<{ locked: string | null }>(
      `SELECT to_char(books_locked_through,'YYYY-MM-DD') AS locked FROM businesses WHERE id = $1`, [businessId]);
    const locked = rows[0]?.locked;
    if (locked && rec.statementEnd <= locked) throw new BooksLockedError(locked);
  }

  await c.query(
    `UPDATE reconciliations SET status = 'voided', voided_at = now(), voided_by = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, id, actor]);
  const released = await c.query(
    `UPDATE reconciliation_items SET voided_at = now()
      WHERE business_id = $1 AND reconciliation_id = $2 AND voided_at IS NULL`, [businessId, id]);
  await audit(c, businessId, actor, 'reconciliation.void', 'reconciliation', id,
    { status: rec.status }, { status: 'voided', releasedLines: released.rowCount ?? 0 });
  return (await getReconciliation(c, businessId, id))!;
}
