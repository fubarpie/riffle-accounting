// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bulk review tools for a staged import batch.
 *
 * Like the single-row tools in store.ts, nothing here touches the ledger. Every function runs inside the caller's
 * withMembership transaction, so a failure part-way leaves the batch exactly as it was.
 *
 *  - autoMapImportAccounts: decide every undecided account at once. Match an existing active account with the same
 *    name and the type the source class implies; otherwise queue a new account (created only at approval). Anything
 *    ambiguous or unrecognised is left undecided and reported. Existing decisions are never changed.
 *  - setImportEntriesExcluded: exclude or include many entries, chosen by id or by a filter. Skipped entries are
 *    never touched (they are never posted anyway).
 *  - setImportAccountsMapping: map or clear several accounts to one target, through the same checks as one account.
 *  - searchImportEntries: the entry list with a text search and a total, so the screen can offer "select all N".
 */
import type { PoolClient } from 'pg';
import { NotFoundError } from '../bank/connections.js';
import { audit } from '../ledger.js';
import type { AccountType } from '../types.js';
import { expectedAccountType } from './class.js';
import {
  ImportInputError, ImportStateError, getBatch, setAccountMapping,
  type ImportBlockers, type ImportCounts, type ImportEntry, type ImportEntryLine, type MappingDecision, type StageIssue,
} from './store.js';

export const MAX_BULK_ENTRY_IDS = 5_000;
export const MAX_BULK_ACCOUNT_IDS = 200;
const LIKE_ESCAPE = '!';

export interface ImportEntryFilter {
  status?: 'valid' | 'invalid' | 'skipped' | undefined;
  excluded?: boolean | undefined;
  /** Matches the description or the name of any account on the entry. Case-insensitive; wildcards are literal. */
  search?: string | undefined;
}

async function lockStaged(c: PoolClient, businessId: string, batchId: string): Promise<void> {
  const { rows } = await c.query<{ status: string }>(
    'SELECT status FROM import_batches WHERE business_id = $1 AND id = $2 FOR UPDATE', [businessId, batchId]);
  if (!rows[0]) throw new NotFoundError('import batch');
  if (rows[0].status !== 'staged') throw new ImportStateError(`this import batch is ${rows[0].status} and can no longer be changed`);
}

/** Extra WHERE conditions (each starting with AND) for an entry filter; appends to params. The entries table is aliased "e". */
function filterSql(f: ImportEntryFilter, params: unknown[]): string {
  let sql = '';
  if (f.status) { params.push(f.status); sql += ` AND e.status = $${params.length}::import_entry_status`; }
  if (f.excluded !== undefined) { params.push(f.excluded); sql += ` AND e.excluded = $${params.length}`; }
  const term = f.search?.trim();
  if (term) {
    const esc = new RegExp(`[${LIKE_ESCAPE}%_]`, 'g');
    params.push(`%${term.replace(esc, (m) => LIKE_ESCAPE + m)}%`);
    const n = params.length;
    sql += ` AND (e.description ILIKE $${n} ESCAPE '${LIKE_ESCAPE}' OR EXISTS (
        SELECT 1 FROM import_entry_lines l
          JOIN import_accounts a ON a.business_id = l.business_id AND a.id = l.import_account_id
         WHERE l.business_id = e.business_id AND l.entry_id = e.id AND a.source_name ILIKE $${n} ESCAPE '${LIKE_ESCAPE}'))`;
  }
  return sql;
}

// ------------------------------------------------------------------ search
export async function searchImportEntries(
  c: PoolClient, businessId: string, batchId: string,
  opts: ImportEntryFilter & { limit?: number | undefined; offset?: number | undefined } = {},
): Promise<{ entries: ImportEntry[]; total: number }> {
  const exists = await c.query('SELECT 1 FROM import_batches WHERE business_id = $1 AND id = $2', [businessId, batchId]);
  if (!exists.rows[0]) throw new NotFoundError('import batch');
  const params: unknown[] = [businessId, batchId];
  const where = `e.business_id = $1 AND e.batch_id = $2${filterSql(opts, params)}`;
  const total = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM import_entries e WHERE ${where}`, params);
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 200), Math.max(opts.offset ?? 0, 0));
  const { rows } = await c.query<{
    id: string; external_id: string; entry_date: string | null; description: string; status: ImportEntry['status'];
    issues: StageIssue[]; excluded: boolean; transaction_id: string | null; lines: ImportEntryLine[];
  }>(
    `SELECT e.id, e.external_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.description, e.status,
            e.issues, e.excluded, e.transaction_id,
            coalesce((SELECT json_agg(json_build_object(
                        'lineNo', l.line_no, 'importAccountId', l.import_account_id,
                        'amountMinor', l.amount_minor::text, 'memo', l.memo) ORDER BY l.line_no)
                        FROM import_entry_lines l
                       WHERE l.business_id = e.business_id AND l.entry_id = e.id), '[]'::json) AS lines
       FROM import_entries e
      WHERE ${where}
      ORDER BY e.entry_date NULLS LAST, e.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return {
    total: Number(total.rows[0]?.n ?? 0),
    entries: rows.map((r) => ({
      id: r.id, externalId: r.external_id, date: r.entry_date, description: r.description, status: r.status,
      issues: r.issues, excluded: r.excluded, transactionId: r.transaction_id, lines: r.lines,
    })),
  };
}

// ----------------------------------------------------------- bulk exclude
export type EntryTarget = { ids: string[] } | { filter: ImportEntryFilter };

/** Exclude or include many entries at once. Returns how many actually changed. */
export async function setImportEntriesExcluded(
  c: PoolClient, businessId: string, actor: string, batchId: string, target: EntryTarget, excluded: boolean,
): Promise<{ changed: number; counts: ImportCounts; blockers: ImportBlockers }> {
  if ('ids' in target && (target.ids.length < 1 || target.ids.length > MAX_BULK_ENTRY_IDS)) {
    throw new ImportInputError(`choose between 1 and ${MAX_BULK_ENTRY_IDS} entries`);
  }
  await lockStaged(c, businessId, batchId);
  const params: unknown[] = [businessId, batchId, excluded];
  let where = `e.business_id = $1 AND e.batch_id = $2 AND e.excluded <> $3 AND e.status <> 'skipped'`;
  if ('ids' in target) {
    params.push(target.ids);
    where += ` AND e.id = ANY($${params.length}::uuid[])`;
  } else {
    where += filterSql(target.filter, params);
  }
  const res = await c.query<{ id: string }>(`UPDATE import_entries e SET excluded = $3 WHERE ${where} RETURNING e.id`, params);
  if (res.rowCount) {
    await audit(c, businessId, actor, excluded ? 'import.exclude' : 'import.include', 'import_batch', batchId, undefined, {
      bulk: true, changed: res.rowCount, by: 'ids' in target ? 'ids' : 'filter',
      ...('filter' in target ? { filter: target.filter } : {}),
    });
  }
  const detail = await getBatch(c, businessId, batchId);
  return { changed: res.rowCount ?? 0, counts: detail.counts, blockers: detail.blockers };
}

// -------------------------------------------------------------- bulk map
/** Map several import accounts to one existing account, or clear them. All or none: the first refusal rolls back everything. */
export async function setImportAccountsMapping(
  c: PoolClient, businessId: string, actor: string, batchId: string, accountIds: string[],
  decision: Extract<MappingDecision, { kind: 'target' } | { kind: 'clear' }>,
): Promise<{ updated: number; counts: ImportCounts; blockers: ImportBlockers }> {
  const ids = [...new Set(accountIds)];
  if (ids.length < 1 || ids.length > MAX_BULK_ACCOUNT_IDS) {
    throw new ImportInputError(`choose between 1 and ${MAX_BULK_ACCOUNT_IDS} accounts`);
  }
  for (const id of ids) await setAccountMapping(c, businessId, actor, batchId, id, decision);
  const detail = await getBatch(c, businessId, batchId);
  return { updated: ids.length, counts: detail.counts, blockers: detail.blockers };
}

// -------------------------------------------------------------- auto-map
export type AutoMapReason = 'unknown_class' | 'name_conflict' | 'duplicate_in_file' | 'ambiguous';
export interface AutoMapUnresolved {
  importAccountId: string;
  sourceName: string;
  sourceGroup: string;
  reason: AutoMapReason;
}
export interface AutoMapResult {
  mappedExisting: number;
  queuedCreate: number;
  unresolved: AutoMapUnresolved[];
  counts: ImportCounts;
  blockers: ImportBlockers;
}

const nameKey = (s: string): string => s.trim().toLowerCase();

export async function autoMapImportAccounts(
  c: PoolClient, businessId: string, actor: string, batchId: string,
): Promise<AutoMapResult> {
  await lockStaged(c, businessId, batchId);
  const open = await c.query<{ id: string; source_name: string; source_group: string }>(
    `SELECT id, source_name, source_group FROM import_accounts
      WHERE business_id = $1 AND batch_id = $2 AND target_account_id IS NULL AND create_name IS NULL
      ORDER BY source_group, source_name, id FOR UPDATE`, [businessId, batchId]);
  const existing = await c.query<{ id: string; name: string; type: AccountType; archived: boolean }>(
    'SELECT id, name, type, archived_at IS NOT NULL AS archived FROM accounts WHERE business_id = $1', [businessId]);
  const byName = new Map<string, typeof existing.rows>();
  for (const a of existing.rows) {
    const list = byName.get(nameKey(a.name));
    if (list) list.push(a); else byName.set(nameKey(a.name), [a]);
  }
  // Names already queued for creation in this batch count too, so running this twice never queues a duplicate.
  const claimed = new Set<string>();
  const queued = await c.query<{ create_name: string }>(
    'SELECT create_name FROM import_accounts WHERE business_id = $1 AND batch_id = $2 AND create_name IS NOT NULL', [businessId, batchId]);
  for (const q of queued.rows) claimed.add(nameKey(q.create_name));

  let mappedExisting = 0;
  let queuedCreate = 0;
  const unresolved: AutoMapUnresolved[] = [];
  for (const a of open.rows) {
    const skip = (reason: AutoMapReason) => unresolved.push({
      importAccountId: a.id, sourceName: a.source_name, sourceGroup: a.source_group, reason });
    const expected = expectedAccountType(a.source_group);
    if (!expected) { skip('unknown_class'); continue; }
    const key = nameKey(a.source_name);
    const same = byName.get(key) ?? [];
    const matches = same.filter((x) => !x.archived && x.type === expected);
    if (matches.length === 1) {
      await c.query(
        `UPDATE import_accounts SET target_account_id = $4, updated_at = now()
          WHERE business_id = $1 AND batch_id = $2 AND id = $3`, [businessId, batchId, a.id, matches[0]!.id]);
      mappedExisting += 1;
    } else if (matches.length > 1) {
      skip('ambiguous');
    } else if (same.length > 0) {
      // The name is taken by an account of another type (or an archived one): never guess.
      skip('name_conflict');
    } else if (claimed.has(key)) {
      skip('duplicate_in_file');
    } else {
      const name = a.source_name.trim();
      await c.query(
        `UPDATE import_accounts SET create_name = $4, create_type = $5::account_type, updated_at = now()
          WHERE business_id = $1 AND batch_id = $2 AND id = $3`, [businessId, batchId, a.id, name, expected]);
      claimed.add(key);
      queuedCreate += 1;
    }
  }
  if (mappedExisting + queuedCreate > 0) {
    await audit(c, businessId, actor, 'import.automap', 'import_batch', batchId, undefined,
      { mappedExisting, queuedCreate, unresolved: unresolved.length });
  }
  const detail = await getBatch(c, businessId, batchId);
  return { mappedExisting, queuedCreate, unresolved, counts: detail.counts, blockers: detail.blockers };
}
