/**
 * Staging area for imported bank transactions, and the path from staging into
 * the ledger. All functions take a PoolClient already inside
 * withTenant/withMembership.
 *
 * Nothing here writes journal lines directly: `postStaged` calls the ledger's
 * `postTransaction`, so balance checks, the lock-date trigger and the
 * append-only guarantees apply unchanged.
 */
import type { PoolClient } from 'pg';
import { LedgerInputError, audit, postTransaction } from '../ledger.js';
import { appendNotes, evaluateRules } from '../rules/evaluator.js';
import { listRules, toEvaluable } from '../rules/store.js';
import type { TransactionKind } from '../types.js';
import { uuidv7 } from '../uuid.js';
import { BankInputError, NotFoundError } from './connections.js';

export type StagedStatus = 'new' | 'approved' | 'ignored' | 'posted';

export const MAX_IMPORT_BATCH = 5_000;
const MAX_RAW_BYTES = 32_768;
const MAX_DESCRIPTION = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The generic shape any importer (SimpleFIN client, Phase 5 statement parser) hands to the store. */
export interface ParsedTransaction {
  /** Provider's account id; resolved through bank_account_links. */
  externalAccountId: string;
  /** Provider's transaction id. With the connection, the idempotency key. */
  externalId: string;
  /** YYYY-MM-DD (UTC calendar date of posting; for pending items, the best known date). */
  postedDate: string;
  /** Signed minor units, positive = money into the account. */
  amountMinor: bigint;
  description: string;
  pending: boolean;
  /** Provider payload kept for audit/debug. Must be JSON-serialisable. */
  raw?: unknown;
}

export interface ImportResult {
  /** New rows staged. */
  inserted: number;
  /** Already staged and unchanged (overlap window, replays, repeats within the batch). */
  duplicate: number;
  /** Pending rows resolved/updated in place (pending -> posted, or changed pending amounts). */
  updated: number;
  /** Rows whose provider account has no link yet; not staged. */
  skippedUnlinked: number;
  unlinkedAccounts: string[];
}

export class ConnectionDisabledError extends Error {
  constructor() {
    super('bank connection is disabled');
    this.name = 'ConnectionDisabledError';
  }
}
export class StagedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagedStateError';
  }
}
export class BooksLockedError extends Error {
  constructor(readonly lockedThrough: string) {
    super(`books are locked through ${lockedThrough}`);
    this.name = 'BooksLockedError';
  }
}

function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

// Postgres text/jsonb cannot hold NUL; bank feeds are untrusted, so strip rather than fail the whole batch.
const stripNul = (v: string) => v.replaceAll('\u0000', '');

function validateParsed(t: ParsedTransaction, i: number): string {
  const at = `transactions[${i}]`;
  if (typeof t.externalId !== 'string' || typeof t.externalAccountId !== 'string' || typeof t.description !== 'string') {
    throw new BankInputError(`${at} ids and description must be strings`);
  }
  if (typeof t.pending !== 'boolean') throw new BankInputError(`${at}.pending must be a boolean`);
  if (!t.externalId || t.externalId.length > 200) throw new BankInputError(`${at}.externalId must be 1-200 characters`);
  if (!t.externalAccountId || t.externalAccountId.length > 200) {
    throw new BankInputError(`${at}.externalAccountId must be 1-200 characters`);
  }
  if (!isRealDate(t.postedDate)) throw new BankInputError(`${at}.postedDate must be a valid YYYY-MM-DD date`);
  if (typeof t.amountMinor !== 'bigint') throw new BankInputError(`${at}.amountMinor must be a bigint`);
  if (t.amountMinor > 9_000_000_000_000_000n || t.amountMinor < -9_000_000_000_000_000n) {
    throw new BankInputError(`${at}.amountMinor is out of range`);
  }
  const raw = JSON.stringify(t.raw ?? {}, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  if (raw === undefined || Buffer.byteLength(raw) > MAX_RAW_BYTES) throw new BankInputError(`${at}.raw is too large`);
  // JSON.stringify escapes NUL as \u0000, which jsonb rejects.
  return raw.replaceAll('\\u0000', '');
}

const keyOf = (t: { externalId: string }) => t.externalId;

/**
 * Stage a batch of parsed transactions for one connection, idempotently.
 *
 *  - New (connection, externalId) -> inserted (`ON CONFLICT DO NOTHING`).
 *  - Same key again -> duplicate, nothing changes. Re-importing the 5-day
 *    overlap window, or the very same batch, is therefore a no-op.
 *  - Same key, existing row still pending and the bank now reports different
 *    data (settled, amount changed) -> that row is updated in place, never
 *    duplicated. Rows already posted to the ledger are never touched.
 *  - Provider account without a link -> skipped and reported.
 */
export async function importBatch(
  c: PoolClient, businessId: string, actor: string, connectionId: string,
  transactions: readonly ParsedTransaction[],
): Promise<ImportResult> {
  if (transactions.length > MAX_IMPORT_BATCH) throw new BankInputError(`at most ${MAX_IMPORT_BATCH} transactions per batch`);
  const raws = transactions.map(validateParsed);
  // Normalise untrusted text once, so the stored value and the duplicate comparison agree.
  transactions = transactions.map((t) => ({
    ...t, externalId: stripNul(t.externalId), externalAccountId: stripNul(t.externalAccountId),
    description: stripNul(t.description).slice(0, MAX_DESCRIPTION),
  }));

  const { rows: conn } = await c.query<{ status: string }>(
    'SELECT status FROM bank_connections WHERE business_id = $1 AND id = $2 FOR SHARE', [businessId, connectionId]);
  if (!conn[0]) throw new NotFoundError('bank connection');
  if (conn[0].status === 'disabled') throw new ConnectionDisabledError();

  const { rows: linkRows } = await c.query<{ id: string; external_account_id: string; account_id: string }>(
    'SELECT id, external_account_id, account_id FROM bank_account_links WHERE business_id = $1 AND connection_id = $2',
    [businessId, connectionId]);
  const links = new Map(linkRows.map((l) => [l.external_account_id, l]));

  const result: ImportResult = { inserted: 0, duplicate: 0, updated: 0, skippedUnlinked: 0, unlinkedAccounts: [] };
  const unlinked = new Set<string>();

  // Collapse repeats inside the batch: first wins, unless a later copy settles a pending one.
  const byKey = new Map<string, { t: ParsedTransaction; raw: string }>();
  transactions.forEach((t, i) => {
    if (!links.has(t.externalAccountId)) {
      result.skippedUnlinked++;
      unlinked.add(t.externalAccountId);
      return;
    }
    const prior = byKey.get(keyOf(t));
    if (!prior) { byKey.set(keyOf(t), { t, raw: raws[i]! }); return; }
    result.duplicate++;
    if (prior.t.pending && !t.pending) byKey.set(keyOf(t), { t, raw: raws[i]! });
  });
  result.unlinkedAccounts = [...unlinked].sort();
  const items = [...byKey.values()];

  if (items.length > 0) {
    const { rows: ins } = await c.query<{ external_id: string }>(
      `INSERT INTO staged_transactions
         (id, business_id, connection_id, source, link_id, account_id, external_id, posted_date,
          amount_minor, description, pending, raw, created_by)
       SELECT u.id, $1::uuid, $2::uuid, 'simplefin', u.link_id, u.account_id, u.external_id, u.posted_date,
              u.amount_minor, u.description, u.pending, u.raw, $3::uuid
         FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::date[], $9::bigint[],
                     $10::text[], $11::boolean[], $12::jsonb[])
              AS u(id, link_id, account_id, external_id, posted_date, amount_minor, description, pending, raw)
       ON CONFLICT DO NOTHING
       RETURNING external_id`,
      [businessId, connectionId, actor,
        items.map(() => uuidv7()),
        items.map((x) => links.get(x.t.externalAccountId)!.id),
        items.map((x) => links.get(x.t.externalAccountId)!.account_id),
        items.map((x) => x.t.externalId),
        items.map((x) => x.t.postedDate),
        items.map((x) => x.t.amountMinor.toString()),
        items.map((x) => x.t.description),
        items.map((x) => x.t.pending),
        items.map((x) => x.raw)]);
    result.inserted = ins.length;
    const insertedIds = new Set(ins.map((r) => r.external_id));

    // Anything that conflicted already exists: resolve pending rows, count the rest as duplicates.
    const existingKeys = items.filter((x) => !insertedIds.has(x.t.externalId));
    if (existingKeys.length > 0) {
      const { rows: existing } = await c.query<{
        id: string; external_id: string; pending: boolean; status: StagedStatus;
        posted_date: string; amount_minor: string; description: string;
      }>(
        `SELECT id, external_id, pending, status, to_char(posted_date,'YYYY-MM-DD') AS posted_date,
                amount_minor::text, description
           FROM staged_transactions
          WHERE business_id = $1 AND connection_id = $2 AND external_id = ANY($3::text[]) FOR UPDATE`,
        [businessId, connectionId, existingKeys.map((x) => x.t.externalId)]);
      const exMap = new Map(existing.map((e) => [e.external_id, e]));
      for (const { t, raw } of existingKeys) {
        const ex = exMap.get(t.externalId);
        const changed = ex !== undefined && ex.pending && ex.status !== 'posted' && (
          ex.pending !== t.pending || ex.posted_date !== t.postedDate
          || ex.amount_minor !== t.amountMinor.toString() || ex.description !== t.description);
        if (!ex || !changed) { result.duplicate++; continue; }
        await c.query(
          `UPDATE staged_transactions
              SET pending = $3, posted_date = $4, amount_minor = $5, description = $6, raw = $7::jsonb,
                  updated_at = now()
            WHERE business_id = $1 AND id = $2`,
          [businessId, ex.id, t.pending, t.postedDate, t.amountMinor.toString(), t.description, raw]);
        await audit(c, businessId, actor, 'staged.pending_update', 'staged_transaction', ex.id,
          { pending: ex.pending, postedDate: ex.posted_date, amountMinor: ex.amount_minor },
          { pending: t.pending, postedDate: t.postedDate, amountMinor: t.amountMinor.toString() });
        result.updated++;
      }
    }
  }

  await audit(c, businessId, actor, 'bank_import.batch', 'bank_connection', connectionId, undefined, { ...result });
  return result;
}

// ------------------------------------------------------------------ reads

export interface StagedTransaction {
  id: string;
  businessId: string;
  connectionId: string | null;
  source: string;
  linkId: string | null;
  accountId: string;
  externalId: string;
  postedDate: string;
  amountMinor: bigint;
  description: string;
  pending: boolean;
  status: StagedStatus;
  categoryAccountId: string | null;
  transactionId: string | null;
  importedAt: string;
}

interface StagedRow {
  id: string; business_id: string; connection_id: string | null; source: string; link_id: string | null;
  account_id: string; external_id: string; posted_date: string; amount_minor: string; description: string;
  pending: boolean; status: StagedStatus; category_account_id: string | null; transaction_id: string | null;
  imported_at: Date;
}
// `raw` is omitted from list results (can be large); use getStaged(.., {raw: true}).
const STAGED_COLUMNS = `id, business_id, connection_id, source, link_id, account_id, external_id,
  to_char(posted_date,'YYYY-MM-DD') AS posted_date, amount_minor::text AS amount_minor, description, pending,
  status, category_account_id, transaction_id, imported_at`;

const toStaged = (r: StagedRow): StagedTransaction => ({
  id: r.id, businessId: r.business_id, connectionId: r.connection_id, source: r.source, linkId: r.link_id,
  accountId: r.account_id, externalId: r.external_id, postedDate: r.posted_date, amountMinor: BigInt(r.amount_minor),
  description: r.description, pending: r.pending, status: r.status, categoryAccountId: r.category_account_id,
  transactionId: r.transaction_id, importedAt: r.imported_at.toISOString(),
});

export interface ListStagedOptions {
  status?: StagedStatus;
  connectionId?: string;
  limit?: number;
  offset?: number;
}

export async function listStaged(c: PoolClient, businessId: string, opts: ListStagedOptions = {}): Promise<StagedTransaction[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await c.query<StagedRow>(
    `SELECT ${STAGED_COLUMNS} FROM staged_transactions
      WHERE business_id = $1 AND ($2::staged_status IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR connection_id = $3)
      ORDER BY posted_date DESC, id DESC LIMIT $4 OFFSET $5`,
    [businessId, opts.status ?? null, opts.connectionId ?? null, limit, Math.max(opts.offset ?? 0, 0)]);
  return rows.map(toStaged);
}

export async function getStaged(
  c: PoolClient, businessId: string, id: string,
): Promise<(StagedTransaction & { raw: unknown }) | undefined> {
  const { rows } = await c.query<StagedRow & { raw: unknown }>(
    `SELECT ${STAGED_COLUMNS}, raw FROM staged_transactions WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ? { ...toStaged(rows[0]), raw: rows[0].raw } : undefined;
}

// ----------------------------------------------------------- state changes

export interface StagedPatch {
  /** new <-> approved <-> ignored. `posted` is reached only through postStaged. */
  status?: 'new' | 'approved' | 'ignored';
  /** Chosen category; null clears it. */
  categoryAccountId?: string | null;
}

export async function updateStaged(
  c: PoolClient, businessId: string, actor: string, id: string, patch: StagedPatch,
): Promise<StagedTransaction> {
  const { rows } = await c.query<StagedRow>(
    `SELECT ${STAGED_COLUMNS} FROM staged_transactions WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!rows[0]) throw new NotFoundError('staged transaction');
  const before = toStaged(rows[0]);
  if (before.status === 'posted') throw new StagedStateError('transaction is already posted');
  if (patch.status !== undefined && !['new', 'approved', 'ignored'].includes(patch.status)) {
    throw new BankInputError('status must be new, approved or ignored');
  }
  if (patch.status === 'approved' && before.pending) {
    throw new StagedStateError('a pending transaction cannot be approved until the bank settles it');
  }
  if (patch.categoryAccountId) await assertUsableAccount(c, businessId, patch.categoryAccountId, before.accountId);
  const category = patch.categoryAccountId === undefined ? before.categoryAccountId : patch.categoryAccountId;
  const status = patch.status ?? before.status;
  const { rows: out } = await c.query<StagedRow>(
    `UPDATE staged_transactions SET status = $3, category_account_id = $4, updated_at = now()
      WHERE business_id = $1 AND id = $2 RETURNING ${STAGED_COLUMNS}`, [businessId, id, status, category]);
  const after = toStaged(out[0]!);
  await audit(c, businessId, actor, 'staged.update', 'staged_transaction', id,
    { status: before.status, categoryAccountId: before.categoryAccountId },
    { status: after.status, categoryAccountId: after.categoryAccountId });
  return after;
}

async function assertUsableAccount(c: PoolClient, businessId: string, accountId: string, bankAccountId: string): Promise<void> {
  if (accountId === bankAccountId) throw new BankInputError('category cannot be the bank account itself');
  const { rows } = await c.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM accounts WHERE business_id = $1 AND id = $2', [businessId, accountId]);
  if (!rows[0]) throw new BankInputError('category account not found');
  if (rows[0].archived_at) throw new BankInputError('category account is archived');
}

// ----------------------------------------------------------------- posting

export interface PostStagedOptions {
  /** Overrides the staged row's chosen category. */
  categoryAccountId?: string;
}

export interface PostStagedResult {
  transactionId: string;
  entryId: string;
  categoryAccountId: string;
  /** Where the category came from. */
  categorySource: 'chosen' | 'rule' | 'uncategorized';
  ruleIds: string[];
}

/**
 * Post a staged transaction to the ledger as a two-line balanced entry: the
 * linked bank/card account against the category. Category precedence:
 *  1. one chosen by a person (option or the staged row),
 *  2. the Phase 2 rules engine (also contributes notes and tags),
 *  3. the system Uncategorized Income (4900) / Expense (6900) account.
 *
 * The signed amount is used as-is on the bank line (asset: debit = money in;
 * liability: credit = charge, which is also negative), and negated on the
 * category line. Refuses pending rows, ignored rows and anything already posted.
 * Lock date is checked up front and again by the database trigger.
 */
export async function postStaged(
  c: PoolClient, businessId: string, actor: string, id: string, opts: PostStagedOptions = {},
): Promise<PostStagedResult> {
  const { rows } = await c.query<StagedRow>(
    `SELECT ${STAGED_COLUMNS} FROM staged_transactions WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!rows[0]) throw new NotFoundError('staged transaction');
  const s = toStaged(rows[0]);
  if (s.status === 'posted') throw new StagedStateError('transaction is already posted');
  if (s.status === 'ignored') throw new StagedStateError('transaction is ignored; un-ignore it first');
  if (s.pending) throw new StagedStateError('transaction is still pending at the bank');
  if (s.amountMinor === 0n) throw new LedgerInputError('zero-amount transactions cannot be posted; ignore it');

  const { rows: biz } = await c.query<{ locked: string | null }>(
    `SELECT to_char(books_locked_through,'YYYY-MM-DD') AS locked FROM businesses WHERE id = $1`, [businessId]);
  const locked = biz[0]?.locked;
  if (locked && s.postedDate <= locked) throw new BooksLockedError(locked);

  const { rows: bank } = await c.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM accounts WHERE business_id = $1 AND id = $2', [businessId, s.accountId]);
  if (!bank[0]) throw new BankInputError('bank account not found');
  if (bank[0].archived_at) throw new BankInputError('bank account is archived');

  const abs = s.amountMinor < 0n ? -s.amountMinor : s.amountMinor;
  let categoryId = opts.categoryAccountId ?? s.categoryAccountId;
  let source: PostStagedResult['categorySource'] = 'chosen';
  let ruleIds: string[] = [];
  let notes = '';
  let tags: string[] = [];
  if (categoryId) {
    await assertUsableAccount(c, businessId, categoryId, s.accountId);
  } else {
    const rules = (await listRules(c, businessId)).map(toEvaluable);
    const ev = evaluateRules(rules, {
      id: s.id, description: s.description, notes: '', date: s.postedDate, amount: abs,
      accountIds: [s.accountId], tags: [], categorizable: true, categoryAccountId: null,
    });
    ruleIds = ev.matchedRuleIds;
    notes = appendNotes('', ev.notes);
    tags = ev.tags.map((t) => t.tag);
    if (ev.category) {
      const { rows: ok } = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE business_id = $1 AND id = $2 AND archived_at IS NULL
            AND type IN ('income','expense') AND id <> $3`, [businessId, ev.category.accountId, s.accountId]);
      if (ok[0]) { categoryId = ev.category.accountId; source = 'rule'; }
    }
    if (!categoryId) {
      const code = s.amountMinor > 0n ? '4900' : '6900';
      const { rows: fb } = await c.query<{ id: string }>(
        'SELECT id FROM accounts WHERE business_id = $1 AND code = $2 AND archived_at IS NULL', [businessId, code]);
      if (!fb[0]) throw new BankInputError(`system account ${code} (uncategorized) is missing`);
      categoryId = fb[0].id;
      source = 'uncategorized';
    }
  }

  const { rows: cat } = await c.query<{ type: string }>(
    'SELECT type FROM accounts WHERE business_id = $1 AND id = $2', [businessId, categoryId]);
  const catType = cat[0]!.type;
  // 'deposit'/'withdrawal' keep the transaction categorizable by rules later.
  const kind: TransactionKind = catType === 'income' || catType === 'expense'
    ? (s.amountMinor > 0n ? 'deposit' : 'withdrawal')
    : catType === 'asset' || catType === 'liability' ? 'transfer' : 'journal';

  let posted: { transactionId: string; entryId: string };
  try {
    posted = await postTransaction(c, businessId, actor, {
      kind, date: s.postedDate, description: s.description, notes,
      lines: [
        { accountId: s.accountId, amount: s.amountMinor, memo: s.description.slice(0, 200) },
        { accountId: categoryId, amount: -s.amountMinor, memo: s.description.slice(0, 200) },
      ],
    });
  } catch (err) {
    if ((err as { code?: string }).code === '55000' && locked) throw new BooksLockedError(locked);
    throw err;
  }

  for (const tag of tags) {
    await c.query(
      `INSERT INTO transaction_tags (business_id, transaction_id, tag) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [businessId, posted.transactionId, tag]);
  }
  await c.query(
    `UPDATE staged_transactions SET status = 'posted', transaction_id = $3, category_account_id = $4, updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, id, posted.transactionId, categoryId]);
  await audit(c, businessId, actor, 'staged.post', 'staged_transaction', id,
    { status: s.status, categoryAccountId: s.categoryAccountId },
    { status: 'posted', transactionId: posted.transactionId, categoryAccountId: categoryId,
      categorySource: source, ruleIds, tags });
  return { ...posted, categoryAccountId: categoryId, categorySource: source, ruleIds };
}
