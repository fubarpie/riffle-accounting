/**
 * AI-assisted statement upload (Phase 5): extraction storage, re-validation
 * and approval. See docs/adr/0011-ai-statement-upload.md.
 *
 * All functions take a PoolClient already inside withTenant/withMembership.
 *
 * Trust model: an extraction is untrusted candidate data. This module never
 * decides validity itself; the validation gate (packages/extractor) is passed
 * in as `gate`, so this package does not depend on the extractor. Whatever the
 * gate says is persisted, and the database CHECK constraints independently
 * refuse a staged/approved row whose gate failed.
 *
 * Approval writes NO journal lines directly: each postable line is staged in
 * staged_transactions (source 'statement') and posted by the same `postStaged`
 * used by the SimpleFIN import, so rules, the lock date, balance checks and
 * append-only guarantees apply unchanged.
 */
import type { PoolClient } from 'pg';
import { NotFoundError } from '../bank/connections.js';
import { postStaged } from '../bank/staged.js';
import { audit } from '../ledger.js';
import { normalSign } from '../reconciliation/store.js';
import type { AccountType, MembershipRole } from '../types.js';
import { uuidv7 } from '../uuid.js';

export const EXTRACTION_WRITER_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];
export const MAX_EXTRACTION_LINES = 2_000;
export const STAGED_SOURCE = 'statement';

export type ExtractionStatus = 'pending' | 'staged' | 'flagged' | 'approved' | 'rejected';

/** Invalid for the data (wrong account type, bad edit). HTTP 422. */
export class ExtractionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionInputError';
  }
}
/** Conflicts with current state (already rejected, already approved and edited). HTTP 409. */
export class ExtractionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionStateError';
  }
}

// ------------------------------------------------------------ gate contract
/** Structurally identical to the extractor package's GateInput, so `validateExtraction` plugs in directly. */
export interface GateRunInput {
  periodStart: string;
  periodEnd: string;
  openingBalance: bigint;
  closingBalance: bigint;
  lines: { date: string; amountMinor: bigint | null; alreadyRecorded: boolean }[];
  existing: { date: string; amountMinor: bigint }[];
  currency: { extracted: string | null; business: string };
}
export type Gate = (input: GateRunInput) => { ok: boolean };

// ------------------------------------------------------------------- types
export interface Extraction {
  id: string;
  businessId: string;
  accountId: string;
  documentId: string | null;
  status: ExtractionStatus;
  extractorName: string;
  extractorModel: string;
  periodStart: string;
  periodEnd: string;
  openingBalanceMinor: bigint;
  closingBalanceMinor: bigint;
  currency: string | null;
  validation: unknown;
  validationOk: boolean;
  validatedAt: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionLine {
  id: string;
  extractionId: string;
  lineNo: number;
  date: string;
  description: string;
  /** Statement sign (positive raises the closing balance). */
  amountMinor: bigint;
  amountInvalid: boolean;
  alreadyRecorded: boolean;
  raw: unknown;
}

export interface NewExtractionLine {
  date: string;
  description: string;
  amountMinor: bigint;
  amountInvalid?: boolean;
  alreadyRecorded?: boolean;
  raw?: unknown;
}

export interface NewExtraction {
  id?: string;
  accountId: string;
  documentId?: string | null;
  extractorName: string;
  extractorModel: string;
  periodStart: string;
  periodEnd: string;
  openingBalanceMinor: bigint;
  closingBalanceMinor: bigint;
  currency?: string | null;
  lines: readonly NewExtractionLine[];
}

interface ExtractionRow {
  id: string; business_id: string; account_id: string; document_id: string | null; status: ExtractionStatus;
  extractor_name: string; extractor_model: string; period_start: string; period_end: string;
  opening: string; closing: string; currency: string | null; validation: unknown; validation_ok: boolean;
  validated_at: Date | null; created_by: string; approved_by: string | null; approved_at: Date | null;
  rejected_by: string | null; rejected_at: Date | null; created_at: Date; updated_at: Date;
}
const COLS = `id, business_id, account_id, document_id, status, extractor_name, extractor_model,
  to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end,
  opening_balance_minor::text AS opening, closing_balance_minor::text AS closing, currency, validation,
  validation_ok, validated_at, created_by, approved_by, approved_at, rejected_by, rejected_at, created_at, updated_at`;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toExtraction = (r: ExtractionRow): Extraction => ({
  id: r.id, businessId: r.business_id, accountId: r.account_id, documentId: r.document_id, status: r.status,
  extractorName: r.extractor_name, extractorModel: r.extractor_model, periodStart: r.period_start,
  periodEnd: r.period_end, openingBalanceMinor: BigInt(r.opening), closingBalanceMinor: BigInt(r.closing),
  currency: r.currency, validation: r.validation, validationOk: r.validation_ok, validatedAt: iso(r.validated_at),
  createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), rejectedBy: r.rejected_by,
  rejectedAt: iso(r.rejected_at), createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

interface LineRow {
  id: string; extraction_id: string; line_no: number; line_date: string; description: string;
  amount: string; amount_invalid: boolean; already_recorded: boolean; raw: unknown;
}
const LINE_COLS = `id, extraction_id, line_no, to_char(line_date,'YYYY-MM-DD') AS line_date, description,
  amount_minor::text AS amount, amount_invalid, already_recorded, raw`;
const toLine = (r: LineRow): ExtractionLine => ({
  id: r.id, extractionId: r.extraction_id, lineNo: r.line_no, date: r.line_date, description: r.description,
  amountMinor: BigInt(r.amount), amountInvalid: r.amount_invalid, alreadyRecorded: r.already_recorded, raw: r.raw,
});

// Postgres text/jsonb cannot hold NUL; statements are untrusted.
const clean = (s: string) => s.replaceAll('\u0000', '').slice(0, 1000);
const jsonSafe = (v: unknown): string =>
  (JSON.stringify(v ?? {}, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)) ?? '{}').replaceAll('\\u0000', '');

// --------------------------------------------------------------- account
async function accountFor(c: PoolClient, businessId: string, accountId: string, forUpdate = false) {
  const { rows } = await c.query<{ type: AccountType; contra: boolean; archived_at: Date | null }>(
    `SELECT type, contra, archived_at FROM accounts WHERE business_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [businessId, accountId]);
  if (!rows[0]) throw new NotFoundError('account');
  return { type: rows[0].type, archived: rows[0].archived_at !== null, sign: normalSign(rows[0].type, rows[0].contra) };
}

/** Everything the gate needs from the ledger: live lines on the account in the period, statement-signed. */
async function gateContext(
  c: PoolClient, businessId: string, accountId: string, periodStart: string, periodEnd: string,
) {
  const acct = await accountFor(c, businessId, accountId);
  const { rows: biz } = await c.query<{ currency: string }>('SELECT currency FROM businesses WHERE id = $1', [businessId]);
  const { rows } = await c.query<{ d: string; amount: string }>(
    `SELECT to_char(entry_date,'YYYY-MM-DD') AS d, amount_minor::text AS amount
       FROM live_journal_lines
      WHERE business_id = $1 AND account_id = $2 AND entry_date BETWEEN $3 AND $4
      ORDER BY entry_date, id`,
    [businessId, accountId, periodStart, periodEnd]);
  return {
    sign: acct.sign,
    businessCurrency: biz[0]?.currency ?? '',
    existing: rows.map((r) => ({ date: r.d, amountMinor: BigInt(r.amount) * acct.sign })),
  };
}

async function runGate(c: PoolClient, e: Extraction, lines: readonly ExtractionLine[], gate: Gate) {
  // A reversed/invalid period would make the BETWEEN meaningless; the gate flags it separately.
  const ctx = await gateContext(c, e.businessId, e.accountId, e.periodStart, e.periodEnd);
  const result = gate({
    periodStart: e.periodStart, periodEnd: e.periodEnd,
    openingBalance: e.openingBalanceMinor, closingBalance: e.closingBalanceMinor,
    lines: lines.map((l) => ({ date: l.date, amountMinor: l.amountInvalid ? null : l.amountMinor, alreadyRecorded: l.alreadyRecorded })),
    existing: ctx.existing,
    currency: { extracted: e.currency, business: ctx.businessCurrency },
  });
  return { result, ok: result.ok === true };
}

async function loadLines(c: PoolClient, businessId: string, extractionId: string): Promise<ExtractionLine[]> {
  const { rows } = await c.query<LineRow>(
    `SELECT ${LINE_COLS} FROM extraction_lines WHERE business_id = $1 AND extraction_id = $2 ORDER BY line_no`,
    [businessId, extractionId]);
  return rows.map(toLine);
}

async function insertLines(c: PoolClient, businessId: string, extractionId: string, lines: readonly NewExtractionLine[]) {
  if (lines.length === 0) return;
  await c.query(
    `INSERT INTO extraction_lines
       (id, business_id, extraction_id, line_no, line_date, description, amount_minor, amount_invalid, already_recorded, raw)
     SELECT u.id, $1::uuid, $2::uuid, u.line_no, u.d, u.descr, u.amount, u.invalid, u.recorded, u.raw
       FROM unnest($3::uuid[], $4::int[], $5::date[], $6::text[], $7::bigint[], $8::boolean[], $9::boolean[], $10::jsonb[])
            AS u(id, line_no, d, descr, amount, invalid, recorded, raw)`,
    [businessId, extractionId,
      lines.map(() => uuidv7()),
      lines.map((_l, i) => i + 1),
      lines.map((l) => l.date),
      lines.map((l) => clean(l.description)),
      lines.map((l) => (l.amountInvalid ? '0' : l.amountMinor.toString())),
      lines.map((l) => l.amountInvalid === true),
      lines.map((l) => l.alreadyRecorded === true),
      lines.map((l) => jsonSafe(l.raw))]);
}

const gateSummary = (result: unknown) => {
  const r = result as { ok?: boolean; reasons?: { code: string }[]; differenceMinor?: string };
  return { ok: r.ok === true, reasonCodes: (r.reasons ?? []).map((x) => x.code), differenceMinor: r.differenceMinor };
};

// ---------------------------------------------------------------- create
/**
 * Store a new extraction with its lines and run the gate. A passing gate gives
 * `staged`; anything else `flagged`. Nothing is ever staged on a failed gate.
 */
export async function createExtraction(
  c: PoolClient, businessId: string, actor: string, input: NewExtraction, gate: Gate,
): Promise<{ extraction: Extraction; lines: ExtractionLine[] }> {
  if (input.lines.length > MAX_EXTRACTION_LINES) throw new ExtractionInputError(`at most ${MAX_EXTRACTION_LINES} lines`);
  const acct = await accountFor(c, businessId, input.accountId, true);
  if (acct.type !== 'asset' && acct.type !== 'liability') {
    throw new ExtractionInputError('statements can only be uploaded for asset or liability accounts');
  }
  if (acct.archived) throw new ExtractionInputError('account is archived');

  const id = input.id ?? uuidv7();
  await c.query(
    `INSERT INTO statement_extractions
       (id, business_id, account_id, document_id, status, extractor_name, extractor_model, period_start, period_end,
        opening_balance_minor, closing_balance_minor, currency, created_by)
     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, businessId, input.accountId, input.documentId ?? null, input.extractorName, input.extractorModel,
      input.periodStart, input.periodEnd, input.openingBalanceMinor.toString(), input.closingBalanceMinor.toString(),
      input.currency ?? null, actor]);
  await insertLines(c, businessId, id, input.lines);
  const e = await revalidate(c, businessId, id, gate);
  await audit(c, businessId, actor, 'extraction.create', 'statement_extraction', id, undefined, {
    accountId: input.accountId, documentId: input.documentId ?? null, extractor: `${input.extractorName}/${input.extractorModel}`,
    status: e.extraction.status, lineCount: input.lines.length, gate: gateSummary(e.extraction.validation),
  });
  return e;
}

/** Run the gate on the stored data and persist verdict + status (open extractions only). */
async function revalidate(
  c: PoolClient, businessId: string, id: string, gate: Gate,
): Promise<{ extraction: Extraction; lines: ExtractionLine[] }> {
  const cur = await readOne(c, businessId, id, true);
  if (!cur) throw new NotFoundError('extraction');
  const { result, ok } = await runGate(c, cur.extraction, cur.lines, gate);
  const { rows } = await c.query<ExtractionRow>(
    `UPDATE statement_extractions
        SET status = $3, validation = $4::jsonb, validation_ok = $5, validated_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 RETURNING ${COLS}`,
    [businessId, id, ok ? 'staged' : 'flagged', jsonSafe(result), ok]);
  return { extraction: toExtraction(rows[0]!), lines: cur.lines };
}

// ----------------------------------------------------------------- reads
async function readOne(c: PoolClient, businessId: string, id: string, forUpdate: boolean) {
  const { rows } = await c.query<ExtractionRow>(
    `SELECT ${COLS} FROM statement_extractions WHERE business_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [businessId, id]);
  if (!rows[0]) return null;
  return { extraction: toExtraction(rows[0]), lines: await loadLines(c, businessId, id) };
}

export async function getExtraction(c: PoolClient, businessId: string, id: string) {
  return readOne(c, businessId, id, false);
}

export interface ListExtractionsOptions {
  status?: ExtractionStatus | undefined;
  accountId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
export async function listExtractions(c: PoolClient, businessId: string, opts: ListExtractionsOptions = {}): Promise<Extraction[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await c.query<ExtractionRow>(
    `SELECT ${COLS} FROM statement_extractions
      WHERE business_id = $1 AND ($2::extraction_status IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR account_id = $3)
      ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
    [businessId, opts.status ?? null, opts.accountId ?? null, limit, Math.max(opts.offset ?? 0, 0)]);
  return rows.map(toExtraction);
}

// ---------------------------------------------------------------- update
export interface ExtractionPatch {
  periodStart?: string;
  periodEnd?: string;
  openingBalanceMinor?: bigint;
  closingBalanceMinor?: bigint;
  /** Replaces the whole line set (renumbered 1..n in the given order). */
  lines?: readonly NewExtractionLine[];
}

/** Correct an open extraction and re-run the gate. The only way a flagged extraction becomes approvable. */
export async function updateExtraction(
  c: PoolClient, businessId: string, actor: string, id: string, patch: ExtractionPatch, gate: Gate,
): Promise<{ extraction: Extraction; lines: ExtractionLine[] }> {
  const cur = await readOne(c, businessId, id, true);
  if (!cur) throw new NotFoundError('extraction');
  const before = cur.extraction;
  if (before.status === 'approved' || before.status === 'rejected') {
    throw new ExtractionStateError(`extraction is ${before.status} and can no longer be edited`);
  }
  if (patch.lines && patch.lines.length > MAX_EXTRACTION_LINES) throw new ExtractionInputError(`at most ${MAX_EXTRACTION_LINES} lines`);
  await c.query(
    `UPDATE statement_extractions
        SET period_start = $3, period_end = $4, opening_balance_minor = $5, closing_balance_minor = $6, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, id, patch.periodStart ?? before.periodStart, patch.periodEnd ?? before.periodEnd,
      (patch.openingBalanceMinor ?? before.openingBalanceMinor).toString(),
      (patch.closingBalanceMinor ?? before.closingBalanceMinor).toString()]);
  if (patch.lines) {
    await c.query('DELETE FROM extraction_lines WHERE business_id = $1 AND extraction_id = $2', [businessId, id]);
    await insertLines(c, businessId, id, patch.lines);
  }
  const after = await revalidate(c, businessId, id, gate);
  await audit(c, businessId, actor, 'extraction.update', 'statement_extraction', id,
    { status: before.status, periodStart: before.periodStart, periodEnd: before.periodEnd,
      openingBalanceMinor: before.openingBalanceMinor.toString(), closingBalanceMinor: before.closingBalanceMinor.toString(),
      lineCount: cur.lines.length },
    { status: after.extraction.status, periodStart: after.extraction.periodStart, periodEnd: after.extraction.periodEnd,
      openingBalanceMinor: after.extraction.openingBalanceMinor.toString(),
      closingBalanceMinor: after.extraction.closingBalanceMinor.toString(),
      lineCount: after.lines.length, linesReplaced: patch.lines !== undefined,
      gate: gateSummary(after.extraction.validation) });
  return after;
}

// --------------------------------------------------------------- approve
export type ApproveOutcome =
  | { outcome: 'approved'; extraction: Extraction; lines: ExtractionLine[]; posted: number; skipped: number; transactionIds: string[] }
  | { outcome: 'already_approved'; extraction: Extraction; lines: ExtractionLine[] }
  | { outcome: 'not_approvable'; extraction: Extraction; lines: ExtractionLine[] };

/**
 * Approve: re-run the gate NOW (the ledger may have changed since upload), and
 * only if it still passes post every non-`alreadyRecorded` line, all in the
 * caller's single transaction. Idempotent: a second call on an approved
 * extraction changes nothing and reports `already_approved`. A failing gate
 * persists the new verdict (flagged) and posts nothing.
 *
 * Any error thrown while posting (locked books, archived account...) propagates
 * and rolls the whole transaction back: either every line posts or none does.
 */
export async function approveExtraction(
  c: PoolClient, businessId: string, actor: string, id: string, gate: Gate,
): Promise<ApproveOutcome> {
  const cur = await readOne(c, businessId, id, true); // row lock serialises concurrent approvals
  if (!cur) throw new NotFoundError('extraction');
  if (cur.extraction.status === 'approved') return { outcome: 'already_approved', ...cur };
  if (cur.extraction.status === 'rejected') throw new ExtractionStateError('extraction is rejected');

  const re = await revalidate(c, businessId, id, gate);
  if (!re.extraction.validationOk) {
    await audit(c, businessId, actor, 'extraction.approve_refused', 'statement_extraction', id, undefined,
      { gate: gateSummary(re.extraction.validation) });
    return { outcome: 'not_approvable', ...re };
  }

  const acct = await accountFor(c, businessId, re.extraction.accountId, true);
  const transactionIds: string[] = [];
  let skipped = 0;
  for (const l of re.lines) { // ORDER BY line_no (loadLines): deterministic posting order
    if (l.alreadyRecorded) { skipped++; continue; }
    const stagedId = uuidv7();
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO staged_transactions
         (id, business_id, connection_id, source, link_id, account_id, external_id, posted_date,
          amount_minor, description, pending, raw, created_by)
       VALUES ($1,$2,NULL,$3,NULL,$4,$5,$6,$7,$8,false,$9::jsonb,$10)
       ON CONFLICT DO NOTHING RETURNING id`,
      [stagedId, businessId, STAGED_SOURCE, re.extraction.accountId, `${id}:${l.lineNo}`, l.date,
        // Statement sign -> ledger sign (debit +). postStaged uses this as-is on the account line.
        (l.amountMinor * acct.sign).toString(), l.description,
        jsonSafe({ extractionId: id, lineNo: l.lineNo, line: l.raw }), actor]);
    if (!rows[0]) throw new ExtractionStateError(`line ${l.lineNo} was already staged by another process`);
    const posted = await postStaged(c, businessId, actor, stagedId);
    transactionIds.push(posted.transactionId);
  }

  const { rows: done } = await c.query<ExtractionRow>(
    `UPDATE statement_extractions SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 RETURNING ${COLS}`, [businessId, id, actor]);
  await audit(c, businessId, actor, 'extraction.approve', 'statement_extraction', id,
    { status: re.extraction.status },
    { status: 'approved', posted: transactionIds.length, skippedAlreadyRecorded: skipped, transactionIds });
  return { outcome: 'approved', extraction: toExtraction(done[0]!), lines: re.lines, posted: transactionIds.length, skipped, transactionIds };
}

// ---------------------------------------------------------------- reject
/** Reject an open extraction. Idempotent on rejected; refused once approved. */
export async function rejectExtraction(
  c: PoolClient, businessId: string, actor: string, id: string,
): Promise<{ extraction: Extraction; lines: ExtractionLine[]; alreadyRejected: boolean }> {
  const cur = await readOne(c, businessId, id, true);
  if (!cur) throw new NotFoundError('extraction');
  if (cur.extraction.status === 'rejected') return { ...cur, alreadyRejected: true };
  if (cur.extraction.status === 'approved') throw new ExtractionStateError('extraction is already approved');
  const { rows } = await c.query<ExtractionRow>(
    `UPDATE statement_extractions SET status = 'rejected', rejected_by = $3, rejected_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 RETURNING ${COLS}`, [businessId, id, actor]);
  await audit(c, businessId, actor, 'extraction.reject', 'statement_extraction', id,
    { status: cur.extraction.status }, { status: 'rejected' });
  return { extraction: toExtraction(rows[0]!), lines: cur.lines, alreadyRejected: false };
}
