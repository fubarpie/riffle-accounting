/**
 * Bank connections and account links. Every function takes a PoolClient that
 * is already inside withTenant/withMembership (RLS-confined, role checked).
 *
 * The encrypted access URL is selected by exactly one function,
 * `getAccessUrl`. Every other query names its columns explicitly, so the
 * ciphertext cannot reach a list/get result, a log line or an audit row.
 */
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { audit } from '../ledger.js';
import type { MembershipRole } from '../types.js';
import { uuidv7 } from '../uuid.js';
import { type Keyring, decryptSecret, encryptSecret, loadKeyring, needsRotation } from './secrets.js';

/** Roles that may create/change connections and import. Viewers may read. */
export const BANK_WRITER_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];

export type BankConnectionStatus = 'active' | 'disabled' | 'error';

export class BankInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankInputError';
  }
}
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Public shape of a connection. Deliberately has no access URL field. */
export interface BankConnection {
  id: string;
  businessId: string;
  label: string;
  status: BankConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  scheduleMinute: number;
  /** Key version the stored secret is encrypted under. Not secret. */
  keyId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnRow {
  id: string; business_id: string; label: string; status: BankConnectionStatus;
  last_synced_at: Date | null; last_error: string | null; schedule_minute: number;
  access_url_key_id: string; created_by: string; created_at: Date; updated_at: Date;
}

// Explicit column list: access_url_enc is intentionally absent.
const CONN_COLUMNS = `id, business_id, label, status, last_synced_at, last_error, schedule_minute,
  access_url_key_id, created_by, created_at, updated_at`;

function toConnection(r: ConnRow): BankConnection {
  return {
    id: r.id, businessId: r.business_id, label: r.label, status: r.status,
    lastSyncedAt: r.last_synced_at?.toISOString() ?? null, lastError: r.last_error,
    scheduleMinute: r.schedule_minute, keyId: r.access_url_key_id, createdBy: r.created_by,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

/** Audit-safe view: no secret, only whether it changed. */
const snapshot = (c: BankConnection) => ({
  label: c.label, status: c.status, scheduleMinute: c.scheduleMinute, keyId: c.keyId,
  lastSyncedAt: c.lastSyncedAt, lastError: c.lastError,
});

/** Ciphertext is bound to its row, so it cannot be replayed onto another connection or tenant. */
const aadFor = (businessId: string, connectionId: string) => `riffle:bank_connection:${businessId}:${connectionId}`;

function validateAccessUrl(url: string): void {
  if (url.length > 2048) throw new BankInputError('access URL is too long');
  let u: URL;
  try { u = new URL(url); } catch { throw new BankInputError('access URL is not a valid URL'); }
  if (u.protocol !== 'https:') throw new BankInputError('access URL must use https');
}

function validateLabel(label: string): string {
  const l = label.trim();
  if (l.length === 0 || l.length > 120) throw new BankInputError('label must be 1-120 characters');
  return l;
}

function validateMinute(m: number): number {
  if (!Number.isInteger(m) || m < 0 || m > 59) throw new BankInputError('scheduleMinute must be an integer 0-59');
  return m;
}

// ------------------------------------------------------------ connections

export interface CreateConnectionInput {
  label: string;
  /** The SimpleFIN access URL (contains credentials). Encrypted before storage. */
  accessUrl: string;
  scheduleMinute?: number;
}

export async function createConnection(
  c: PoolClient, businessId: string, actor: string, input: CreateConnectionInput,
  keyring: Keyring = loadKeyring(),
): Promise<BankConnection> {
  const label = validateLabel(input.label);
  validateAccessUrl(input.accessUrl);
  const minute = validateMinute(input.scheduleMinute ?? randomInt(60));
  const id = uuidv7();
  const enc = encryptSecret(input.accessUrl, keyring, aadFor(businessId, id));
  const { rows } = await c.query<ConnRow>(
    `INSERT INTO bank_connections
       (id, business_id, label, access_url_enc, access_url_key_id, schedule_minute, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CONN_COLUMNS}`,
    [id, businessId, label, enc.data, enc.keyId, minute, actor]);
  const conn = toConnection(rows[0]!);
  await audit(c, businessId, actor, 'bank_connection.create', 'bank_connection', id, undefined, snapshot(conn));
  return conn;
}

export async function listConnections(c: PoolClient, businessId: string): Promise<BankConnection[]> {
  const { rows } = await c.query<ConnRow>(
    `SELECT ${CONN_COLUMNS} FROM bank_connections WHERE business_id = $1 ORDER BY created_at, id`, [businessId]);
  return rows.map(toConnection);
}

export async function getConnection(c: PoolClient, businessId: string, id: string): Promise<BankConnection | undefined> {
  const { rows } = await c.query<ConnRow>(
    `SELECT ${CONN_COLUMNS} FROM bank_connections WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ? toConnection(rows[0]) : undefined;
}

export interface UpdateConnectionPatch {
  label?: string;
  status?: BankConnectionStatus;
  scheduleMinute?: number;
  /** Replace the stored access URL (re-encrypted under the current key). */
  accessUrl?: string;
}

export async function updateConnection(
  c: PoolClient, businessId: string, actor: string, id: string, patch: UpdateConnectionPatch,
  /** Only needed (and only loaded from the environment) when `patch.accessUrl` is set. */
  keyring?: Keyring,
): Promise<BankConnection | undefined> {
  const { rows: cur } = await c.query<ConnRow>(
    `SELECT ${CONN_COLUMNS} FROM bank_connections WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!cur[0]) return undefined;
  const before = toConnection(cur[0]);
  const label = patch.label === undefined ? before.label : validateLabel(patch.label);
  const minute = patch.scheduleMinute === undefined ? before.scheduleMinute : validateMinute(patch.scheduleMinute);
  const status = patch.status ?? before.status;
  if (!['active', 'disabled', 'error'].includes(status)) throw new BankInputError('invalid status');

  let enc: { data: Buffer; keyId: string } | null = null;
  if (patch.accessUrl !== undefined) {
    validateAccessUrl(patch.accessUrl);
    enc = encryptSecret(patch.accessUrl, keyring ?? loadKeyring(), aadFor(businessId, id));
  }
  // Re-enabling clears a stale error message.
  const clearError = status === 'active' && before.status !== 'active';
  const { rows } = await c.query<ConnRow>(
    `UPDATE bank_connections
        SET label = $3, status = $4, schedule_minute = $5,
            access_url_enc = coalesce($6, access_url_enc),
            access_url_key_id = coalesce($7, access_url_key_id),
            last_error = CASE WHEN $8 THEN NULL ELSE last_error END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2 RETURNING ${CONN_COLUMNS}`,
    [businessId, id, label, status, minute, enc?.data ?? null, enc?.keyId ?? null, clearError]);
  const after = toConnection(rows[0]!);
  await audit(c, businessId, actor, 'bank_connection.update', 'bank_connection', id,
    snapshot(before), { ...snapshot(after), accessUrlReplaced: enc !== null });
  return after;
}

/**
 * Record the outcome of a sync attempt. Success clears the error and stamps
 * `last_synced_at`; failure stores a (truncated) message and flips the
 * connection to `error` unless it was disabled by a person.
 */
export async function recordSyncResult(
  c: PoolClient, businessId: string, actor: string, id: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<BankConnection | undefined> {
  const { rows: cur } = await c.query<ConnRow>(
    `SELECT ${CONN_COLUMNS} FROM bank_connections WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!cur[0]) return undefined;
  const before = toConnection(cur[0]);
  const { rows } = result.ok
    ? await c.query<ConnRow>(
      `UPDATE bank_connections SET last_synced_at = now(), last_error = NULL,
              status = CASE WHEN status = 'error' THEN 'active'::bank_connection_status ELSE status END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2 RETURNING ${CONN_COLUMNS}`, [businessId, id])
    : await c.query<ConnRow>(
      `UPDATE bank_connections SET last_error = $3,
              status = CASE WHEN status = 'disabled' THEN status ELSE 'error'::bank_connection_status END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2 RETURNING ${CONN_COLUMNS}`,
      [businessId, id, result.error.slice(0, 1000)]);
  const after = toConnection(rows[0]!);
  await audit(c, businessId, actor, result.ok ? 'bank_connection.sync_ok' : 'bank_connection.sync_error',
    'bank_connection', id, snapshot(before), snapshot(after));
  return after;
}

/**
 * INTERNAL: the only function that decrypts. For the sync worker; never wire
 * its result into an API response or a log. Throws SecretError if the
 * ciphertext, key or row binding does not authenticate.
 */
export async function getAccessUrl(
  c: PoolClient, businessId: string, id: string, keyring: Keyring = loadKeyring(),
): Promise<string> {
  const { rows } = await c.query<{ access_url_enc: Buffer; access_url_key_id: string }>(
    'SELECT access_url_enc, access_url_key_id FROM bank_connections WHERE business_id = $1 AND id = $2',
    [businessId, id]);
  if (!rows[0]) throw new NotFoundError('bank connection');
  return decryptSecret(rows[0].access_url_enc, rows[0].access_url_key_id, keyring, aadFor(businessId, id));
}

/**
 * Re-encrypt every connection not under the current key. Run after adding a
 * new key at the head of RIFFLE_SECRET_KEY; once it returns 0 remaining the
 * old key can be dropped. Returns the number of rows rewritten.
 */
export async function rotateConnectionKeys(
  c: PoolClient, businessId: string, actor: string, keyring: Keyring = loadKeyring(),
): Promise<number> {
  const { rows } = await c.query<{ id: string; access_url_key_id: string }>(
    'SELECT id, access_url_key_id FROM bank_connections WHERE business_id = $1 FOR UPDATE', [businessId]);
  let n = 0;
  for (const r of rows) {
    if (!needsRotation(r.access_url_key_id, keyring)) continue;
    const url = await getAccessUrl(c, businessId, r.id, keyring);
    const enc = encryptSecret(url, keyring, aadFor(businessId, r.id));
    await c.query(
      `UPDATE bank_connections SET access_url_enc = $3, access_url_key_id = $4, updated_at = now()
        WHERE business_id = $1 AND id = $2`, [businessId, r.id, enc.data, enc.keyId]);
    await audit(c, businessId, actor, 'bank_connection.rotate_key', 'bank_connection', r.id,
      { keyId: r.access_url_key_id }, { keyId: enc.keyId });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ links

export interface BankAccountLink {
  id: string;
  businessId: string;
  connectionId: string;
  externalAccountId: string;
  externalName: string;
  accountId: string;
  createdAt: string;
}

interface LinkRow {
  id: string; business_id: string; connection_id: string; external_account_id: string;
  external_name: string; account_id: string; created_at: Date;
}
const LINK_COLUMNS = 'id, business_id, connection_id, external_account_id, external_name, account_id, created_at';
const toLink = (r: LinkRow): BankAccountLink => ({
  id: r.id, businessId: r.business_id, connectionId: r.connection_id,
  externalAccountId: r.external_account_id, externalName: r.external_name,
  accountId: r.account_id, createdAt: r.created_at.toISOString(),
});

/** A feed can only be linked to an active asset (bank) or liability (card/loan) account. */
async function assertLinkableAccount(c: PoolClient, businessId: string, accountId: string): Promise<void> {
  const { rows } = await c.query<{ type: string; archived_at: Date | null }>(
    'SELECT type, archived_at FROM accounts WHERE business_id = $1 AND id = $2', [businessId, accountId]);
  const a = rows[0];
  if (!a) throw new BankInputError('ledger account not found');
  if (a.archived_at) throw new BankInputError('ledger account is archived');
  if (a.type !== 'asset' && a.type !== 'liability') {
    throw new BankInputError('a bank feed must be linked to an asset or liability account');
  }
}

/** Link (or re-point) a provider account to a ledger account. Unique per connection. */
export async function linkAccount(
  c: PoolClient, businessId: string, actor: string,
  input: { connectionId: string; externalAccountId: string; externalName?: string; accountId: string },
): Promise<BankAccountLink> {
  if (!input.externalAccountId || input.externalAccountId.length > 200) {
    throw new BankInputError('externalAccountId must be 1-200 characters');
  }
  if (!(await getConnection(c, businessId, input.connectionId))) throw new NotFoundError('bank connection');
  await assertLinkableAccount(c, businessId, input.accountId);
  const { rows: prev } = await c.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM bank_account_links
      WHERE business_id = $1 AND connection_id = $2 AND external_account_id = $3 FOR UPDATE`,
    [businessId, input.connectionId, input.externalAccountId]);
  const { rows } = await c.query<LinkRow>(
    `INSERT INTO bank_account_links
       (id, business_id, connection_id, external_account_id, external_name, account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (connection_id, external_account_id)
       DO UPDATE SET account_id = EXCLUDED.account_id,
                     external_name = EXCLUDED.external_name, updated_at = now()
     RETURNING ${LINK_COLUMNS}`,
    [uuidv7(), businessId, input.connectionId, input.externalAccountId,
      (input.externalName ?? '').slice(0, 200), input.accountId, actor]);
  const link = toLink(rows[0]!);
  await audit(c, businessId, actor, prev[0] ? 'bank_link.update' : 'bank_link.create', 'bank_account_link', link.id,
    prev[0] ? { accountId: prev[0].account_id } : undefined,
    { connectionId: link.connectionId, externalAccountId: link.externalAccountId, accountId: link.accountId });
  return link;
}

export async function listLinks(c: PoolClient, businessId: string, connectionId?: string): Promise<BankAccountLink[]> {
  const { rows } = await c.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM bank_account_links
      WHERE business_id = $1 AND ($2::uuid IS NULL OR connection_id = $2) ORDER BY created_at, id`,
    [businessId, connectionId ?? null]);
  return rows.map(toLink);
}

/** Remove a link. Fails (FK) if staged rows still reference it; ignore or post them first. */
export async function unlinkAccount(c: PoolClient, businessId: string, actor: string, linkId: string): Promise<boolean> {
  const { rows } = await c.query<LinkRow>(
    `DELETE FROM bank_account_links WHERE business_id = $1 AND id = $2 RETURNING ${LINK_COLUMNS}`, [businessId, linkId]);
  if (!rows[0]) return false;
  await audit(c, businessId, actor, 'bank_link.delete', 'bank_account_link', linkId,
    { connectionId: rows[0].connection_id, externalAccountId: rows[0].external_account_id, accountId: rows[0].account_id },
    undefined);
  return true;
}
