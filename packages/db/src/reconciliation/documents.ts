/** Statement vault metadata. File bytes live on disk; see apps/api/src/vault.ts. */
import type { PoolClient } from 'pg';
import { audit } from '../ledger.js';
import { NotFoundError } from '../bank/connections.js';
import { ReconciliationStateError } from './store.js';

export const STATEMENT_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/csv'] as const;
export type StatementContentType = (typeof STATEMENT_CONTENT_TYPES)[number];

export interface StatementDocument {
  id: string;
  businessId: string;
  reconciliationId: string | null;
  filename: string;
  contentType: StatementContentType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string;
  createdAt: Date;
}

interface DocRow {
  id: string; business_id: string; reconciliation_id: string | null; filename: string; content_type: StatementContentType;
  size_bytes: string; sha256: string; storage_key: string; uploaded_by: string; created_at: Date;
}
const COLS = 'id, business_id, reconciliation_id, filename, content_type, size_bytes::text, sha256, storage_key, uploaded_by, created_at';
const toDoc = (r: DocRow): StatementDocument => ({
  id: r.id, businessId: r.business_id, reconciliationId: r.reconciliation_id, filename: r.filename,
  contentType: r.content_type, sizeBytes: Number(r.size_bytes), sha256: r.sha256, storageKey: r.storage_key,
  uploadedBy: r.uploaded_by, createdAt: r.created_at,
});

export interface NewStatementDocument {
  id: string;
  /** null for a statement kept only for an AI extraction (Phase 5). */
  reconciliationId: string | null;
  filename: string;
  contentType: StatementContentType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

export async function insertStatementDocument(
  c: PoolClient, businessId: string, actor: string, d: NewStatementDocument,
): Promise<StatementDocument> {
  if (d.reconciliationId !== null) {
    const rec = await c.query<{ status: string }>(
      'SELECT status FROM reconciliations WHERE business_id = $1 AND id = $2 FOR SHARE', [businessId, d.reconciliationId]);
    if (!rec.rows[0]) throw new NotFoundError('reconciliation');
    if (rec.rows[0].status === 'voided') throw new ReconciliationStateError('reconciliation is voided');
  }
  const { rows } = await c.query<DocRow>(
    `INSERT INTO statement_documents (id, business_id, reconciliation_id, filename, content_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
    [d.id, businessId, d.reconciliationId, d.filename, d.contentType, d.sizeBytes, d.sha256, d.storageKey, actor]);
  const doc = toDoc(rows[0]!);
  await audit(c, businessId, actor, 'statement.upload', 'statement_document', doc.id, undefined,
    { reconciliationId: d.reconciliationId, filename: d.filename, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: d.sha256 });
  return doc;
}

export async function listStatementDocuments(
  c: PoolClient, businessId: string, reconciliationId: string,
): Promise<StatementDocument[]> {
  const { rows } = await c.query<DocRow>(
    `SELECT ${COLS} FROM statement_documents WHERE business_id = $1 AND reconciliation_id = $2 ORDER BY created_at, id`,
    [businessId, reconciliationId]);
  return rows.map(toDoc);
}

export async function getStatementDocument(
  c: PoolClient, businessId: string, reconciliationId: string, docId: string,
): Promise<StatementDocument | null> {
  const { rows } = await c.query<DocRow>(
    `SELECT ${COLS} FROM statement_documents WHERE business_id = $1 AND reconciliation_id = $2 AND id = $3`,
    [businessId, reconciliationId, docId]);
  return rows[0] ? toDoc(rows[0]) : null;
}

/** Delete the metadata row (draft reconciliations only; also enforced by trigger). Caller removes the file after commit. */
export async function deleteStatementDocument(
  c: PoolClient, businessId: string, actor: string, reconciliationId: string, docId: string,
): Promise<StatementDocument> {
  const rec = await c.query<{ status: string }>(
    'SELECT status FROM reconciliations WHERE business_id = $1 AND id = $2 FOR UPDATE', [businessId, reconciliationId]);
  if (!rec.rows[0]) throw new NotFoundError('reconciliation');
  const doc = await getStatementDocument(c, businessId, reconciliationId, docId);
  if (!doc) throw new NotFoundError('statement');
  if (rec.rows[0].status !== 'draft') {
    throw new ReconciliationStateError(`statements can only be deleted while the reconciliation is a draft (it is ${rec.rows[0].status})`);
  }
  await c.query('DELETE FROM statement_documents WHERE business_id = $1 AND id = $2', [businessId, docId]);
  await audit(c, businessId, actor, 'statement.delete', 'statement_document', docId,
    { reconciliationId, filename: doc.filename, sha256: doc.sha256 }, undefined);
  return doc;
}
