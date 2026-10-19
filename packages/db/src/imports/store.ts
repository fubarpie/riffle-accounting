// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Staging for imports from other bookkeeping systems (Phase 6, ADR 0012).
 *
 * All functions take a PoolClient already inside withTenant/withMembership.
 *
 * Nothing here touches the ledger. A batch is a candidate reading of an
 * uploaded file; a reviewer maps its accounts and excludes entries, and a later
 * step (approval) posts the survivors through the normal ledger path. This
 * module is deliberately parser-agnostic: the caller converts whatever the
 * parser produced into StageInput, so this package does not depend on it.
 *
 * Privacy: the file is not stored. Only parsed rows are, and of any account
 * reference only the last 4 characters (sliced HERE, so a careless caller
 * cannot persist a full number).
 */
import type { PoolClient } from 'pg';
import { NotFoundError } from '../bank/connections.js';
import { audit } from '../ledger.js';
import type { AccountType, MembershipRole } from '../types.js';
import { uuidv7 } from '../uuid.js';
import { expectedAccountType } from './class.js';

export const IMPORT_WRITER_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];
export const MAX_IMPORT_ENTRIES = 20_000;
export const MAX_IMPORT_LINES = 100_000;
export const MAX_IMPORT_ACCOUNTS = 2_000;
const CHUNK = 5_000;
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

/** Invalid for the data (bad mapping, unbalanced "valid" entry). HTTP 422. */
export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportInputError';
  }
}
/** Conflicts with current state (already staged, batch no longer staged). HTTP 409. */
export class ImportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportStateError';
  }
}

// ------------------------------------------------------------------ input
export interface StageIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  row?: number | undefined;
}
export interface StageAccountInput {
  /** Normalized matching key; lines refer to accounts by this. */
  key: string;
  name: string;
  group: string;
  type: string;
  /** May be a full account number; only the last 4 characters are kept. */
  accountRef: string | null;
}
export interface StageLineInput {
  accountKey: string;
  /** Debit positive, credit negative, in integer minor units. */
  amountMinor: bigint;
  memo: string;
}
export interface StageEntryInput {
  externalId: string;
  /** ISO date, or null when it could not be read (then status must not be 'valid'). */
  date: string | null;
  description: string;
  status: 'valid' | 'invalid' | 'skipped';
  issues: StageIssue[];
  lines: StageLineInput[];
}
export interface StageInput {
  source: string;
  fileSha256: string;
  /** Parser report. Must not contain row data beyond what the issues already say. */
  summary: Record<string, unknown>;
  accounts: StageAccountInput[];
  entries: StageEntryInput[];
}

// ------------------------------------------------------------------ views
export type ImportBatchStatus = 'staged' | 'approved' | 'rejected';
export interface ImportBatch {
  id: string;
  source: string;
  fileSha256: string;
  status: ImportBatchStatus;
  summary: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
}
export interface ImportAccount {
  id: string;
  sourceName: string;
  sourceGroup: string;
  sourceType: string;
  accountRefLast4: string | null;
  targetAccountId: string | null;
  createName: string | null;
  createType: AccountType | null;
  lineCount: number;
}
export interface ImportEntryLine {
  lineNo: number;
  importAccountId: string;
  amountMinor: string;
  memo: string;
}
export interface ImportEntry {
  id: string;
  externalId: string;
  date: string | null;
  description: string;
  status: 'valid' | 'invalid' | 'skipped';
  issues: StageIssue[];
  excluded: boolean;
  transactionId: string | null;
  lines: ImportEntryLine[];
}
export interface ImportCounts {
  entries: number;
  valid: number;
  invalid: number;
  skipped: number;
  excluded: number;
}
/** What would stop approval right now. Informational; approval re-checks everything. */
export interface ImportBlockers {
  invalidEntries: number;
  unmappedAccounts: number;
  ready: boolean;
}

export type MappingDecision =
  | { kind: 'target'; accountId: string }
  | { kind: 'create'; name: string; type: AccountType }
  | { kind: 'clear' };

// ---------------------------------------------------------------- helpers
interface BatchRow {
  id: string; source: string; file_sha256: string; status: ImportBatchStatus; summary: Record<string, unknown>;
  created_by: string; created_at: Date; approved_at: Date | null; rejected_at: Date | null;
}
const BATCH_COLS = 'id, source, file_sha256, status, summary, created_by, created_at, approved_at, rejected_at';
const toBatch = (r: BatchRow): ImportBatch => ({
  id: r.id, source: r.source, fileSha256: r.file_sha256, status: r.status, summary: r.summary,
  createdBy: r.created_by, createdAt: r.created_at, approvedAt: r.approved_at, rejectedAt: r.rejected_at,
});

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function lockBatch(c: PoolClient, businessId: string, batchId: string): Promise<ImportBatchStatus> {
  const { rows } = await c.query<{ status: ImportBatchStatus }>(
    'SELECT status FROM import_batches WHERE business_id = $1 AND id = $2 FOR UPDATE', [businessId, batchId]);
  if (!rows[0]) throw new NotFoundError('import batch');
  return rows[0].status;
}
async function lockStagedBatch(c: PoolClient, businessId: string, batchId: string): Promise<void> {
  const status = await lockBatch(c, businessId, batchId);
  if (status !== 'staged') throw new ImportStateError(`this import batch is ${status} and can no longer be changed`);
}

// ------------------------------------------------------------------ stage
/** Validate and store a parsed file as a new 'staged' batch. Returns the batch with its counts. */
export async function stageBatch(
  c: PoolClient, businessId: string, actor: string, input: StageInput,
): Promise<{ batch: ImportBatch; counts: ImportCounts; blockers: ImportBlockers }> {
  if (!SOURCE_RE.test(input.source)) throw new ImportInputError('invalid import source');
  if (!SHA_RE.test(input.fileSha256)) throw new ImportInputError('invalid file hash');
  if (input.entries.length === 0) throw new ImportInputError('the file contains no entries');
  if (input.entries.length > MAX_IMPORT_ENTRIES) throw new ImportInputError(`at most ${MAX_IMPORT_ENTRIES} entries per file`);
  if (input.accounts.length > MAX_IMPORT_ACCOUNTS) throw new ImportInputError(`at most ${MAX_IMPORT_ACCOUNTS} accounts per file`);

  // Account ids are assigned here; lines refer to accounts by key.
  const accountIds = new Map<string, string>();
  for (const a of input.accounts) {
    if (accountIds.has(a.key)) throw new ImportInputError('duplicate account in file');
    if (a.key.length < 1 || a.key.length > 200 || a.name.trim().length < 1 || a.name.length > 200) {
      throw new ImportInputError('an account name is empty or longer than 200 characters');
    }
    accountIds.set(a.key, uuidv7());
  }

  const seenExternal = new Set<string>();
  let lineTotal = 0;
  for (const e of input.entries) {
    if (e.externalId.length < 1 || e.externalId.length > 64) throw new ImportInputError('an entry id is empty or longer than 64 characters');
    if (seenExternal.has(e.externalId)) throw new ImportInputError('the same entry id appears twice in the file');
    seenExternal.add(e.externalId);
    if (e.date !== null && !ISO_DATE_RE.test(e.date)) throw new ImportInputError('an entry date is not YYYY-MM-DD');
    for (const l of e.lines) {
      if (!accountIds.has(l.accountKey)) throw new ImportInputError('an entry refers to an account that is not in the file');
    }
    lineTotal += e.lines.length;
    if (e.status === 'valid') {
      // Checked here for a clear 422; the database re-checks at COMMIT.
      const nonZero = e.lines.filter((l) => l.amountMinor !== 0n);
      const sum = nonZero.reduce((s, l) => s + l.amountMinor, 0n);
      if (e.date === null || nonZero.length < 2 || sum !== 0n) {
        throw new ImportInputError('an entry marked valid does not have a date and two or more lines that balance');
      }
    }
  }
  if (lineTotal > MAX_IMPORT_LINES) throw new ImportInputError(`at most ${MAX_IMPORT_LINES} lines per file`);

  // A file already staged (and not rejected) is refused; the unique index backs this up under a race.
  const dup = await c.query<{ id: string }>(
    `SELECT id FROM import_batches WHERE business_id = $1 AND source = $2 AND file_sha256 = $3 AND status <> 'rejected'`,
    [businessId, input.source, input.fileSha256]);
  if (dup.rows[0]) throw new ImportStateError('this file has already been staged; reject that batch first to stage it again');

  // Entries already posted by an earlier import are pre-excluded, so overlapping files are safe.
  const already = new Set<string>();
  for (const part of chunks([...seenExternal], 10_000)) {
    const { rows } = await c.query<{ external_id: string }>(
      'SELECT external_id FROM imported_refs WHERE business_id = $1 AND source = $2 AND external_id = ANY($3::text[])',
      [businessId, input.source, part]);
    for (const r of rows) already.add(r.external_id);
  }

  const batchId = uuidv7();
  const summary = {
    ...input.summary,
    staged: {
      accounts: input.accounts.length,
      entries: input.entries.length,
      lines: lineTotal,
      alreadyImported: already.size,
    },
  };
  try {
    await c.query(
      `INSERT INTO import_batches (id, business_id, source, file_sha256, status, summary, created_by)
       VALUES ($1,$2,$3,$4,'staged',$5::jsonb,$6)`,
      [batchId, businessId, input.source, input.fileSha256, JSON.stringify(summary), actor]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ImportStateError('this file has already been staged; reject that batch first to stage it again');
    }
    throw err;
  }

  await c.query(
    `INSERT INTO import_accounts (id, business_id, batch_id, source_name, match_key, source_group, source_type, account_ref_last4)
     SELECT a.id, $1, $2, a.source_name, a.match_key, a.source_group, a.source_type, a.last4
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS a(id, source_name, match_key, source_group, source_type, last4)`,
    [businessId, batchId,
      input.accounts.map((a) => accountIds.get(a.key)!),
      input.accounts.map((a) => a.name.trim()),
      input.accounts.map((a) => a.key),
      input.accounts.map((a) => a.group.slice(0, 100)),
      input.accounts.map((a) => a.type.slice(0, 100)),
      input.accounts.map((a) => (a.accountRef && a.accountRef.length > 0 ? a.accountRef.slice(-4) : null))]);

  const entryIds = new Map<string, string>();
  for (const e of input.entries) entryIds.set(e.externalId, uuidv7());

  for (const part of chunks(input.entries)) {
    await c.query(
      `INSERT INTO import_entries
         (id, business_id, batch_id, external_id, entry_date, description, status, issues, excluded)
       SELECT e.id, $1, $2, e.external_id, e.entry_date, e.description, e.status::import_entry_status, e.issues::jsonb, e.excluded
         FROM unnest($3::uuid[], $4::text[], $5::date[], $6::text[], $7::text[], $8::text[], $9::boolean[])
           AS e(id, external_id, entry_date, description, status, issues, excluded)`,
      [businessId, batchId,
        part.map((e) => entryIds.get(e.externalId)!),
        part.map((e) => e.externalId),
        part.map((e) => e.date),
        part.map((e) => e.description.slice(0, 1000)),
        part.map((e) => e.status),
        part.map((e) => JSON.stringify(
          already.has(e.externalId)
            ? [...e.issues, { severity: 'warning', code: 'already_imported', message: 'This entry was posted by an earlier import and is excluded' }]
            : e.issues)),
        part.map((e) => already.has(e.externalId))]);
  }

  // Zero-amount lines are dropped (the table forbids them); line numbers are renumbered per entry.
  const lineRows: { id: string; entryId: string; no: number; acct: string; amount: string; memo: string }[] = [];
  for (const e of input.entries) {
    let no = 0;
    for (const l of e.lines) {
      if (l.amountMinor === 0n) continue;
      no += 1;
      lineRows.push({
        id: uuidv7(), entryId: entryIds.get(e.externalId)!, no, acct: accountIds.get(l.accountKey)!,
        amount: l.amountMinor.toString(), memo: l.memo.slice(0, 1000),
      });
    }
  }
  for (const part of chunks(lineRows)) {
    await c.query(
      `INSERT INTO import_entry_lines (id, business_id, batch_id, entry_id, line_no, import_account_id, amount_minor, memo)
       SELECT l.id, $1, $2, l.entry_id, l.line_no, l.import_account_id, l.amount_minor, l.memo
         FROM unnest($3::uuid[], $4::uuid[], $5::int[], $6::uuid[], $7::bigint[], $8::text[])
           AS l(id, entry_id, line_no, import_account_id, amount_minor, memo)`,
      [businessId, batchId,
        part.map((r) => r.id), part.map((r) => r.entryId), part.map((r) => r.no),
        part.map((r) => r.acct), part.map((r) => r.amount), part.map((r) => r.memo)]);
  }

  const detail = await readBatch(c, businessId, batchId);
  await audit(c, businessId, actor, 'import.stage', 'import_batch', batchId, undefined, {
    source: input.source, counts: detail.counts, blockers: detail.blockers, alreadyImported: already.size,
  });
  return detail;
}

// ------------------------------------------------------------------- read
async function countsFor(c: PoolClient, businessId: string, batchId: string): Promise<{ counts: ImportCounts; blockers: ImportBlockers }> {
  const { rows } = await c.query<{ status: string; excluded: boolean; n: string }>(
    `SELECT status, excluded, count(*)::text AS n FROM import_entries
      WHERE business_id = $1 AND batch_id = $2 GROUP BY status, excluded`, [businessId, batchId]);
  const counts: ImportCounts = { entries: 0, valid: 0, invalid: 0, skipped: 0, excluded: 0 };
  let openInvalid = 0;
  for (const r of rows) {
    const n = Number(r.n);
    counts.entries += n;
    if (r.status === 'valid') counts.valid += n;
    else if (r.status === 'invalid') counts.invalid += n;
    else counts.skipped += n;
    if (r.excluded) counts.excluded += n;
    else if (r.status === 'invalid') openInvalid += n;
  }
  const un = await c.query<{ n: string }>(
    `SELECT count(DISTINCT a.id)::text AS n
       FROM import_accounts a
       JOIN import_entry_lines l ON l.business_id = a.business_id AND l.import_account_id = a.id
       JOIN import_entries e ON e.business_id = l.business_id AND e.id = l.entry_id
      WHERE a.business_id = $1 AND a.batch_id = $2
        AND a.target_account_id IS NULL AND a.create_name IS NULL
        AND e.status = 'valid' AND NOT e.excluded`, [businessId, batchId]);
  const unmappedAccounts = Number(un.rows[0]?.n ?? 0);
  const postable = counts.valid - rows.filter((r) => r.status === 'valid' && r.excluded).reduce((s, r) => s + Number(r.n), 0);
  return {
    counts,
    blockers: { invalidEntries: openInvalid, unmappedAccounts, ready: openInvalid === 0 && unmappedAccounts === 0 && postable > 0 },
  };
}

async function readBatch(
  c: PoolClient, businessId: string, batchId: string, forUpdate = false,
): Promise<{ batch: ImportBatch; counts: ImportCounts; blockers: ImportBlockers }> {
  const { rows } = await c.query<BatchRow>(
    `SELECT ${BATCH_COLS} FROM import_batches WHERE business_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [businessId, batchId]);
  if (!rows[0]) throw new NotFoundError('import batch');
  return { batch: toBatch(rows[0]), ...(await countsFor(c, businessId, batchId)) };
}

export async function listBatches(
  c: PoolClient, businessId: string,
  opts: { status?: ImportBatchStatus | undefined; limit?: number | undefined; offset?: number | undefined } = {},
): Promise<ImportBatch[]> {
  const params: unknown[] = [businessId];
  let where = 'business_id = $1';
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500), Math.max(opts.offset ?? 0, 0));
  const { rows } = await c.query<BatchRow>(
    `SELECT ${BATCH_COLS} FROM import_batches WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map(toBatch);
}

export async function getBatch(
  c: PoolClient, businessId: string, batchId: string,
): Promise<{ batch: ImportBatch; counts: ImportCounts; blockers: ImportBlockers; accounts: ImportAccount[] }> {
  const detail = await readBatch(c, businessId, batchId);
  const { rows } = await c.query<{
    id: string; source_name: string; source_group: string; source_type: string; account_ref_last4: string | null;
    target_account_id: string | null; create_name: string | null; create_type: AccountType | null; line_count: string;
  }>(
    `SELECT a.id, a.source_name, a.source_group, a.source_type, a.account_ref_last4,
            a.target_account_id, a.create_name, a.create_type, coalesce(l.n, 0)::text AS line_count
       FROM import_accounts a
       LEFT JOIN (SELECT import_account_id, count(*) AS n FROM import_entry_lines
                   WHERE business_id = $1 AND batch_id = $2 GROUP BY import_account_id) l
              ON l.import_account_id = a.id
      WHERE a.business_id = $1 AND a.batch_id = $2
      ORDER BY a.source_group, a.source_name`, [businessId, batchId]);
  return {
    ...detail,
    accounts: rows.map((r) => ({
      id: r.id, sourceName: r.source_name, sourceGroup: r.source_group, sourceType: r.source_type,
      accountRefLast4: r.account_ref_last4, targetAccountId: r.target_account_id,
      createName: r.create_name, createType: r.create_type, lineCount: Number(r.line_count),
    })),
  };
}

export async function listEntries(
  c: PoolClient, businessId: string, batchId: string,
  opts: { status?: 'valid' | 'invalid' | 'skipped' | undefined; excluded?: boolean | undefined; limit?: number | undefined; offset?: number | undefined } = {},
): Promise<ImportEntry[]> {
  const exists = await c.query('SELECT 1 FROM import_batches WHERE business_id = $1 AND id = $2', [businessId, batchId]);
  if (!exists.rows[0]) throw new NotFoundError('import batch');
  const params: unknown[] = [businessId, batchId];
  let where = 'e.business_id = $1 AND e.batch_id = $2';
  if (opts.status) { params.push(opts.status); where += ` AND e.status = $${params.length}::import_entry_status`; }
  if (opts.excluded !== undefined) { params.push(opts.excluded); where += ` AND e.excluded = $${params.length}`; }
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
  return rows.map((r) => ({
    id: r.id, externalId: r.external_id, date: r.entry_date, description: r.description, status: r.status,
    issues: r.issues, excluded: r.excluded, transactionId: r.transaction_id, lines: r.lines,
  }));
}

// ----------------------------------------------------------------- change
/** Decide what an imported account becomes: an existing account, a new one, or undecided again. */
/** Default 2: an account may only be mapped to, or created as, the type its source class implies. */
function assertClassMatches(src: { source_name: string; source_group: string }, actual: AccountType): void {
  const expected = expectedAccountType(src.source_group);
  if (expected && expected !== actual) {
    throw new ImportInputError(
      `"${src.source_name}" is a ${src.source_group} account in the source, so it must map to a ${expected} account, not ${actual}`);
  }
}

export async function setAccountMapping(
  c: PoolClient, businessId: string, actor: string, batchId: string, importAccountId: string, decision: MappingDecision,
): Promise<ImportAccount> {
  await lockStagedBatch(c, businessId, batchId);
  const cur = await c.query<{
    target_account_id: string | null; create_name: string | null; create_type: string | null;
    source_name: string; source_group: string;
  }>(
    `SELECT target_account_id, create_name, create_type, source_name, source_group FROM import_accounts
      WHERE business_id = $1 AND batch_id = $2 AND id = $3 FOR UPDATE`, [businessId, batchId, importAccountId]);
  if (!cur.rows[0]) throw new NotFoundError('import account');

  let target: string | null = null;
  let createName: string | null = null;
  let createType: AccountType | null = null;
  if (decision.kind === 'target') {
    const acct = await c.query<{ archived: boolean; type: AccountType }>(
      'SELECT archived_at IS NOT NULL AS archived, type FROM accounts WHERE business_id = $1 AND id = $2',
      [businessId, decision.accountId]);
    if (!acct.rows[0]) throw new NotFoundError('account');
    if (acct.rows[0].archived) throw new ImportInputError('account is archived');
    assertClassMatches(cur.rows[0], acct.rows[0].type);
    target = decision.accountId;
  } else if (decision.kind === 'create') {
    createName = decision.name.trim();
    if (createName.length < 1 || createName.length > 200) throw new ImportInputError('account name must be 1 to 200 characters');
    if (!ACCOUNT_TYPES.includes(decision.type)) throw new ImportInputError('invalid account type');
    createType = decision.type;
    assertClassMatches(cur.rows[0], decision.type);
  }
  await c.query(
    `UPDATE import_accounts SET target_account_id = $4, create_name = $5, create_type = $6::account_type, updated_at = now()
      WHERE business_id = $1 AND batch_id = $2 AND id = $3`,
    [businessId, batchId, importAccountId, target, createName, createType]);
  await audit(c, businessId, actor, 'import.map', 'import_account', importAccountId,
    { targetAccountId: cur.rows[0].target_account_id, createName: cur.rows[0].create_name, createType: cur.rows[0].create_type },
    { batchId, targetAccountId: target, createName, createType });
  const found = (await getBatch(c, businessId, batchId)).accounts.find((a) => a.id === importAccountId);
  return found!;
}

/** Leave an entry out of the import (or put it back). Works on any entry, so invalid ones can be cleared. */
export async function setEntryExcluded(
  c: PoolClient, businessId: string, actor: string, batchId: string, entryId: string, excluded: boolean,
): Promise<{ entryId: string; excluded: boolean; counts: ImportCounts; blockers: ImportBlockers }> {
  await lockStagedBatch(c, businessId, batchId);
  const { rows } = await c.query<{ excluded: boolean }>(
    `UPDATE import_entries e SET excluded = $4
       FROM (SELECT id, excluded FROM import_entries WHERE business_id = $1 AND batch_id = $2 AND id = $3 FOR UPDATE) old
      WHERE e.business_id = $1 AND e.batch_id = $2 AND e.id = old.id
      RETURNING old.excluded AS excluded`, [businessId, batchId, entryId, excluded]);
  if (!rows[0]) throw new NotFoundError('import entry');
  if (rows[0].excluded !== excluded) {
    await audit(c, businessId, actor, excluded ? 'import.exclude' : 'import.include', 'import_entry', entryId,
      { excluded: rows[0].excluded }, { batchId, excluded });
  }
  return { entryId, excluded, ...(await countsFor(c, businessId, batchId)) };
}

/** Throw the staged batch away. Rows stay for audit; a rejected file can be staged again. */
export async function rejectBatch(
  c: PoolClient, businessId: string, actor: string, batchId: string,
): Promise<{ batch: ImportBatch; counts: ImportCounts; blockers: ImportBlockers }> {
  await lockStagedBatch(c, businessId, batchId);
  await c.query(
    `UPDATE import_batches SET status = 'rejected', rejected_by = $3, rejected_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`, [businessId, batchId, actor]);
  const detail = await readBatch(c, businessId, batchId);
  await audit(c, businessId, actor, 'import.reject', 'import_batch', batchId, { status: 'staged' }, { status: 'rejected' });
  return detail;
}
