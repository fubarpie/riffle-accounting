import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { uuidv7 } from './uuid.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
}

export class EmailTakenError extends Error {}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only rewrite last_used_at/expires_at when the session is this stale. */
const TOUCH_AFTER_MS = 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function toUser(r: { id: string; email: string; name: string; password_hash: string | null }): UserRow {
  return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash };
}

export async function createUser(
  pool: Pool, input: { email: string; name: string; passwordHash: string },
): Promise<UserRow> {
  const id = uuidv7();
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, password_hash`,
      [id, normalizeEmail(input.email), input.name.trim(), input.passwordHash],
    );
    return toUser(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new EmailTakenError('email already registered');
    throw err;
  }
}

export async function findUserByEmail(pool: Pool, email: string): Promise<UserRow | undefined> {
  const { rows } = await pool.query(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1', [normalizeEmail(email)]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

export async function countUsers(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

/** Create a session and return the raw token (shown once, never stored). */
export async function createSession(
  pool: Pool, userId: string, userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (id, token_hash, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [uuidv7(), hashToken(token), userId, expiresAt, userAgent?.slice(0, 300) ?? null],
  );
  return { token, expiresAt };
}

export interface SessionUser {
  user: Omit<UserRow, 'passwordHash'>;
  expiresAt: Date;
  /** True when the sliding expiry was extended, so the cookie should be re-sent. */
  refreshed: boolean;
}

/** Resolve a raw token to its user, enforcing expiry and sliding it forward. */
export async function resolveSession(pool: Pool, token: string): Promise<SessionUser | undefined> {
  const { rows } = await pool.query(
    `SELECT s.id AS sid, s.expires_at, s.last_used_at, u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return undefined;
  let expiresAt: Date = r.expires_at;
  let refreshed = false;
  if (Date.now() - new Date(r.last_used_at).getTime() > TOUCH_AFTER_MS) {
    expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('UPDATE sessions SET last_used_at = now(), expires_at = $2 WHERE id = $1', [r.sid, expiresAt]);
    refreshed = true;
  }
  return { user: { id: r.id, email: r.email, name: r.name }, expiresAt, refreshed };
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Housekeeping: drop expired sessions. Safe to call from the worker. */
export async function purgeExpiredSessions(pool: Pool): Promise<number> {
  const res = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  return res.rowCount ?? 0;
}
