// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Approval of a staged import batch (Phase 6, ADR 0012).
 *
 * Approval is all-or-nothing. Every check runs BEFORE the first write, and the
 * whole thing runs inside the caller's withMembership transaction, so a batch
 * either posts completely or leaves the ledger untouched.
 *
 * Defaults (decided with the owner; each is flagged in the PR):
 *  1. The source system's account class (Wave "Account Group") is kept on the
 *     staged account (import_accounts.source_group).
 *  2. An account may only be mapped to, or created as, the matching type.
 *     A mismatch blocks approval; it is never coerced.
 *  3. Any entry dated on or before the books lock date blocks the whole batch.
 *     Nothing is posted silently and nothing is excluded automatically: the
 *     reviewer excludes those entries or moves the lock date, then approves.
 */
import type { PoolClient } from 'pg';
import { NotFoundError } from '../bank/connections.js';
import { audit, postTransaction } from '../ledger.js';
import type { AccountType } from '../types.js';
import { uuidv7 } from '../uuid.js';
import { expectedAccountType } from './class.js';
import { ImportStateError, type ImportBatch, type ImportCounts, getBatch } from './store.js';

export interface ClassMismatch {
  importAccountId: string;
  sourceName: string;
  sourceGroup: string;
  expected: AccountType;
  actual: AccountType;
}

export interface ApprovalBlockers {
  /** Invalid entries the reviewer has neither fixed nor excluded. */
  invalidEntries: number;
  /** Accounts used by entries to be posted that have no mapping or create decision. */
  unmappedAccounts: { importAccountId: string; sourceName: string }[];
  /** Mapped to an account that has since been archived. */
  archivedTargets: { importAccountId: string; sourceName: string }[];
  classMismatches: ClassMismatch[];
  /** Entries dated on or before the lock date. */
  lockedEntries: { count: number; lockedThrough: string; earliest: string } | null;
  /** Nothing would be posted (every entry excluded, skipped or already imported). */
  nothingToPost: boolean;
}

/** Approval refused; `blockers` says why. HTTP 409 with the report in the body. */
export class ImportApprovalBlockedError extends ImportStateError {
  constructor(readonly blockers: ApprovalBlockers) {
    super('this import cannot be approved yet; see blockers');
    this.name = 'ImportApprovalBlockedError';
  }
}

export interface ApprovalResult {
  batch: ImportBatch;
  counts: ImportCounts;
  posted: number;
  accountsCreated: number;
  /** Valid entries skipped because an earlier import already posted them. */
  alreadyImported: number;
}

interface AcctRow {
  id: string; source_name: string; source_group: string;
  target_account_id: string | null; create_name: string | null; create_type: AccountType | null;
  target_type: AccountType | null; target_archived: boolean | null;
}
interface EntryRow {
  id: string; external_id: string; date: string; description: string; already: boolean;
}
interface LineRow { entry_id: string; import_account_id: string; amount_minor: string; memo: string }

export async function approveBatch(
  c: PoolClient, businessId: string, actor: string, batchId: string,
): Promise<ApprovalResult> {
  // Serialises concurrent approvals of the same batch; the loser sees 'approved'.
  const head = await c.query<{ status: string; source: string }>(
    'SELECT status, source FROM import_batches WHERE business_id = $1 AND id = $2 FOR UPDATE', [businessId, batchId]);
  if (!head.rows[0]) throw new NotFoundError('import batch');
  if (head.rows[0].status !== 'staged') {
    throw new ImportStateError(`this import batch is ${head.rows[0].status} and can no longer be changed`);
  }
  const source = head.rows[0].source;

  // ---------------------------------------------------------------- read
  const invalid = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM import_entries
      WHERE business_id = $1 AND batch_id = $2 AND status = 'invalid' AND NOT excluded`, [businessId, batchId]);
  const entries = (await c.query<EntryRow>(
    `SELECT e.id, e.external_id, to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.description,
            (r.external_id IS NOT NULL) AS already
       FROM import_entries e
       LEFT JOIN imported_refs r
              ON r.business_id = e.business_id AND r.source = $3 AND r.external_id = e.external_id
      WHERE e.business_id = $1 AND e.batch_id = $2 AND e.status = 'valid' AND NOT e.excluded
      ORDER BY e.entry_date, e.id`, [businessId, batchId, source])).rows;
  const toPost = entries.filter((e) => !e.already);
  const alreadyImported = entries.length - toPost.length;

  const lines = (await c.query<LineRow>(
    `SELECT l.entry_id, l.import_account_id, l.amount_minor::text AS amount_minor, l.memo
       FROM import_entry_lines l
       JOIN import_entries e ON e.business_id = l.business_id AND e.id = l.entry_id
      WHERE l.business_id = $1 AND l.batch_id = $2 AND e.status = 'valid' AND NOT e.excluded
      ORDER BY l.entry_id, l.line_no`, [businessId, batchId])).rows;
  const linesByEntry = new Map<string, LineRow[]>();
  for (const l of lines) {
    const list = linesByEntry.get(l.entry_id);
    if (list) list.push(l); else linesByEntry.set(l.entry_id, [l]);
  }
  const usedAccountIds = new Set<string>();
  for (const e of toPost) for (const l of linesByEntry.get(e.id) ?? []) usedAccountIds.add(l.import_account_id);

  const accounts = (await c.query<AcctRow>(
    `SELECT a.id, a.source_name, a.source_group, a.target_account_id, a.create_name, a.create_type,
            t.type AS target_type, (t.archived_at IS NOT NULL) AS target_archived
       FROM import_accounts a
       LEFT JOIN accounts t ON t.business_id = a.business_id AND t.id = a.target_account_id
      WHERE a.business_id = $1 AND a.batch_id = $2`, [businessId, batchId])).rows
    .filter((a) => usedAccountIds.has(a.id));

  const lockRow = await c.query<{ locked: string | null }>(
    `SELECT to_char(books_locked_through, 'YYYY-MM-DD') AS locked FROM businesses WHERE id = $1`, [businessId]);
  const locked = lockRow.rows[0]?.locked ?? null;
  const lockedDates = locked ? toPost.map((e) => e.date).filter((d) => d <= locked).sort() : [];

  // -------------------------------------------------------------- blockers
  const blockers: ApprovalBlockers = {
    invalidEntries: Number(invalid.rows[0]?.n ?? 0),
    unmappedAccounts: [],
    archivedTargets: [],
    classMismatches: [],
    lockedEntries: locked && lockedDates.length > 0
      ? { count: lockedDates.length, lockedThrough: locked, earliest: lockedDates[0]! } : null,
    nothingToPost: toPost.length === 0,
  };
  for (const a of accounts) {
    const actual: AccountType | null = a.target_account_id ? a.target_type : a.create_type;
    if (!a.target_account_id && !a.create_name) {
      blockers.unmappedAccounts.push({ importAccountId: a.id, sourceName: a.source_name });
      continue;
    }
    if (a.target_account_id && a.target_archived) {
      blockers.archivedTargets.push({ importAccountId: a.id, sourceName: a.source_name });
    }
    const expected = expectedAccountType(a.source_group);
    if (expected && actual && expected !== actual) {
      blockers.classMismatches.push({
        importAccountId: a.id, sourceName: a.source_name, sourceGroup: a.source_group, expected, actual,
      });
    }
  }
  if (blockers.invalidEntries > 0 || blockers.unmappedAccounts.length > 0 || blockers.archivedTargets.length > 0
      || blockers.classMismatches.length > 0 || blockers.lockedEntries || blockers.nothingToPost) {
    throw new ImportApprovalBlockedError(blockers);
  }

  // ----------------------------------------------------------------- write
  const currency = (await c.query<{ currency: string }>(
    'SELECT currency FROM businesses WHERE id = $1', [businessId])).rows[0]!.currency;
  const resolved = new Map<string, string>(); // import account id -> ledger account id
  let accountsCreated = 0;
  for (const a of accounts) {
    if (a.target_account_id) { resolved.set(a.id, a.target_account_id); continue; }
    const id = uuidv7();
    await c.query(
      'INSERT INTO accounts (id, business_id, name, type, currency) VALUES ($1,$2,$3,$4,$5)',
      [id, businessId, a.create_name, a.create_type, currency]);
    // Record the outcome as a mapping (the table forbids target + create at once).
    await c.query(
      `UPDATE import_accounts SET target_account_id = $3, create_name = NULL, create_type = NULL, updated_at = now()
        WHERE business_id = $1 AND id = $2`, [businessId, a.id, id]);
    await audit(c, businessId, actor, 'account.create', 'account', id, undefined,
      { name: a.create_name, type: a.create_type, currency, via: 'import', batchId });
    resolved.set(a.id, id);
    accountsCreated += 1;
  }

  try {
    for (const e of toPost) {
      const { transactionId } = await postTransaction(c, businessId, actor, {
        kind: 'journal',
        date: e.date,
        description: e.description,
        notes: `Imported from ${source} (source id ${e.external_id})`,
        lines: (linesByEntry.get(e.id) ?? []).map((l) => ({
          accountId: resolved.get(l.import_account_id)!, amount: BigInt(l.amount_minor), memo: l.memo,
        })),
      });
      await c.query(
        'UPDATE import_entries SET transaction_id = $3 WHERE business_id = $1 AND id = $2', [businessId, e.id, transactionId]);
      await c.query(
        `INSERT INTO imported_refs (business_id, source, external_id, transaction_id, batch_id)
         VALUES ($1,$2,$3,$4,$5)`, [businessId, source, e.external_id, transactionId, batchId]);
    }
  } catch (err) {
    // Two batches racing to post the same source entry: the second one loses and rolls back.
    if ((err as { code?: string }).code === '23505') {
      throw new ImportStateError('another import already posted some of these entries; review and try again');
    }
    throw err;
  }

  await c.query(
    `UPDATE import_batches SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, batchId, actor]);
  await audit(c, businessId, actor, 'import.approve', 'import_batch', batchId, { status: 'staged' },
    { status: 'approved', posted: toPost.length, accountsCreated, alreadyImported });

  const detail = await getBatch(c, businessId, batchId);
  return {
    batch: detail.batch, counts: detail.counts, posted: toPost.length, accountsCreated, alreadyImported,
  };
}
