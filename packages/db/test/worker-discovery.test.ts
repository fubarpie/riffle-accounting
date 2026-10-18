import { afterAll, describe, expect, it } from 'vitest';
import { bankSetup } from './bank-helpers.js';
import { admin, app, closePools } from './helpers.js';

afterAll(closePools);

const FN = 'riffle_worker_bank_connections';

describe('riffle_worker_bank_connections (migration 0005)', () => {
  it('returns connections across businesses to riffle_app, without tenant context', async () => {
    const a = await bankSetup();
    const b = await bankSetup();
    const { rows } = await app.query(`SELECT * FROM ${FN}()`);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a.conn.id, b.conn.id]));
    const ra = rows.find((r) => r.id === a.conn.id);
    expect(ra).toMatchObject({
      business_id: a.businessId, created_by: a.userId, status: 'active', schedule_minute: 7, last_synced_at: null,
    });
    expect(rows.find((r) => r.id === b.conn.id).business_id).toBe(b.businessId);
  });

  it('filters by id', async () => {
    const a = await bankSetup();
    await bankSetup();
    const { rows } = await app.query(`SELECT * FROM ${FN}($1::uuid)`, [a.conn.id]);
    expect(rows.map((r) => r.id)).toEqual([a.conn.id]);
    const none = await app.query(`SELECT * FROM ${FN}($1::uuid)`, ['00000000-0000-4000-8000-000000000000']);
    expect(none.rows).toHaveLength(0);
  });

  it('exposes no secret or free-text column and leaks no ciphertext', async () => {
    const a = await bankSetup();
    const { rows, fields } = await app.query(`SELECT * FROM ${FN}($1::uuid)`, [a.conn.id]);
    expect(fields.map((f) => f.name).sort()).toEqual(
      ['business_id', 'created_by', 'id', 'last_synced_at', 'schedule_minute', 'status', 'updated_at']);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('s3cretpass');
    expect(text).not.toMatch(/access_url/);
  });

  it('does not widen direct table access for riffle_app', async () => {
    await bankSetup();
    const { rows } = await app.query('SELECT id FROM bank_connections');
    expect(rows).toHaveLength(0); // RLS: no tenant set
  });

  it('is not executable by PUBLIC and is SECURITY DEFINER with a pinned search_path', async () => {
    const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[]; acl: string[] }>(
      `SELECT prosecdef, proconfig, proacl::text[] AS acl FROM pg_proc WHERE proname = $1`, [FN]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.proconfig.join(',')).toContain('search_path=public, pg_temp');
    // A PUBLIC grant renders as an ACL entry with an empty grantee ("=X/owner").
    expect(rows[0]!.acl.some((e) => e.startsWith('=')), 'PUBLIC must not have EXECUTE').toBe(false);
    expect(rows[0]!.acl.some((e) => e.startsWith('riffle_app='))).toBe(true);
  });

  it('the owner-role policy lets a non-superuser, non-BYPASSRLS owner read past FORCE RLS', async () => {
    // Embedded Postgres runs as a superuser, which bypasses RLS and would hide a
    // broken policy. Replay the migration's policy for a throwaway ordinary role.
    const a = await bankSetup();
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('CREATE ROLE tmp_worker_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await c.query('GRANT SELECT ON bank_connections TO tmp_worker_owner');
      await c.query('CREATE POLICY tmp_policy ON bank_connections FOR SELECT TO tmp_worker_owner USING (true)');
      await c.query('SET LOCAL ROLE tmp_worker_owner');
      const seen = await c.query('SELECT id FROM bank_connections WHERE id = $1', [a.conn.id]);
      expect(seen.rows).toHaveLength(1);
      await c.query('RESET ROLE');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
