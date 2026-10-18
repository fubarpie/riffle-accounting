import { afterAll, describe, expect, it } from 'vitest';
import { postTransaction } from '../src/ledger.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, closePools, makeBusiness, makeUser } from './helpers.js';

afterAll(closePools);

const TENANT_TABLES = ['accounts', 'transactions', 'journal_entries', 'journal_lines', 'audit_log'] as const;

async function twoBusinesses() {
  const A = await makeBusiness();
  const B = await makeBusiness();
  for (const X of [A, B]) {
    await withTenant(app, { userId: X.userId, businessId: X.businessId }, (c) =>
      postTransaction(c, X.businessId, X.userId, {
        kind: 'deposit', date: '2026-01-05',
        lines: [{ accountId: X.accounts.get('1010')!, amount: 100n }, { accountId: X.accounts.get('4000')!, amount: -100n }],
      }));
  }
  return { A, B };
}

describe('catalog guard: no unprotected tenant table', () => {
  it('every table with a business_id column has RLS enabled, forced, and a policy', async () => {
    const { rows } = await admin.query<{ t: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns k
                      WHERE k.table_schema='public' AND k.table_name=c.relname AND k.column_name='business_id')`);
    const names = rows.map((r) => r.t).sort();
    expect(names).toEqual(expect.arrayContaining([...TENANT_TABLES, 'memberships']));
    for (const r of rows) {
      expect(r.rls, `${r.t} must ENABLE RLS`).toBe(true);
      expect(r.policies, `${r.t} must have a policy`).toBeGreaterThan(0);
      if (r.t !== 'memberships') expect(r.forced, `${r.t} must FORCE RLS`).toBe(true);
    }
  });

  it('the app role is not a superuser, does not bypass RLS, and owns nothing', async () => {
    const { rows } = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='riffle_app'`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='riffle_app'`);
    expect(owned.rows[0].n).toBe(0);
  });
});

describe.each(TENANT_TABLES)('cross-tenant isolation on %s', (table) => {
  it('user of A cannot read, insert, update or delete B rows', async () => {
    const { A, B } = await twoBusinesses();
    const ctxA = { userId: A.userId, businessId: A.businessId };

    const seen = await withTenant(app, ctxA, (c) => c.query(`SELECT business_id FROM ${table} WHERE business_id = $1`, [B.businessId]));
    expect(seen.rowCount).toBe(0);
    const all = await withTenant(app, ctxA, (c) => c.query(`SELECT DISTINCT business_id FROM ${table}`));
    expect(all.rows.map((r) => r.business_id)).toEqual([A.businessId]);

    // UPDATE/DELETE silently match nothing (or are denied by grants/immutability).
    const upd = await withTenant(app, ctxA, (c) => c.query('SAVEPOINT s').then(() =>
      c.query(`UPDATE ${table} SET business_id = business_id WHERE business_id = $1`, [B.businessId]))
      .catch(async (e) => { await c.query('ROLLBACK TO s'); return { rowCount: 0, e }; }));
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(app, ctxA, (c) => c.query('SAVEPOINT s').then(() =>
      c.query(`DELETE FROM ${table} WHERE business_id = $1`, [B.businessId]))
      .catch(async (e) => { await c.query('ROLLBACK TO s'); return { rowCount: 0, e }; }));
    expect(del.rowCount).toBe(0);

    // B's data is intact.
    const intact = await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [B.businessId]);
    expect(intact.rows[0].n).toBeGreaterThan(0);
  });

  it('no app.business_id means no rows', async () => {
    await twoBusinesses();
    const { userId } = await makeBusiness();
    const r = await withTenant(app, { userId }, (c) => c.query(`SELECT 1 FROM ${table}`));
    expect(r.rowCount).toBe(0);
  });
});

describe('forged business_id', () => {
  it('cannot insert a row for another business while scoped to your own', async () => {
    const { A, B } = await twoBusinesses();
    await expect(withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) =>
      c.query(`INSERT INTO accounts (id,business_id,name,type,currency) VALUES ($1,$2,'Evil','asset','USD')`, [uuidv7(), B.businessId])))
      .rejects.toThrow(/row-level security/);
    await expect(withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) =>
      c.query(`INSERT INTO audit_log (id,business_id,action,entity) VALUES ($1,$2,'x','y')`, [uuidv7(), B.businessId])))
      .rejects.toThrow(/row-level security/);
  });

  it('cannot move a row into another business via UPDATE', async () => {
    const { A, B } = await twoBusinesses();
    await expect(withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) =>
      c.query(`UPDATE accounts SET business_id = $1 WHERE business_id = $2`, [B.businessId, A.businessId])))
      .rejects.toThrow(/row-level security/);
  });

  it('composite FKs make cross-business references impossible even for the owner role', async () => {
    const { A, B } = await twoBusinesses();
    await expect(admin.query(
      `INSERT INTO journal_lines (id,business_id,entry_id,account_id,amount_minor)
       SELECT $1, $2, e.id, $3, 5 FROM journal_entries e WHERE e.business_id = $2 LIMIT 1`,
      [uuidv7(), A.businessId, B.accounts.get('1010')])).rejects.toThrow(/foreign key/);
    await expect(admin.query(
      `INSERT INTO accounts (id,business_id,name,type,currency,parent_id) VALUES ($1,$2,'x','asset','USD',$3)`,
      [uuidv7(), A.businessId, B.accounts.get('1010')])).rejects.toThrow(/foreign key/);
  });

  it('the setting does not leak across pooled connections', async () => {
    const { A } = await twoBusinesses();
    await withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) => c.query('SELECT 1'));
    const r = await app.query(`SELECT current_setting('app.business_id', true) AS b`);
    expect(r.rows[0].b === null || r.rows[0].b === '').toBe(true);
    const rows = await app.query('SELECT 1 FROM accounts');
    expect(rows.rowCount).toBe(0);
  });
});

describe('businesses and memberships', () => {
  it('a user sees only businesses they belong to', async () => {
    const { A, B } = await twoBusinesses();
    const r = await withTenant(app, { userId: A.userId }, (c) => c.query('SELECT id FROM businesses'));
    expect(r.rows.map((x) => x.id)).toEqual([A.businessId]);
    const m = await withTenant(app, { userId: B.userId }, (c) => c.query('SELECT business_id FROM memberships'));
    expect(m.rows.map((x) => x.business_id)).toEqual([B.businessId]);
  });

  it('an outsider cannot add themselves to an existing business', async () => {
    const { A } = await twoBusinesses();
    const mallory = await makeUser('mallory');
    await expect(withTenant(app, { userId: mallory }, (c) =>
      c.query(`INSERT INTO memberships (id,user_id,business_id,role) VALUES ($1,$2,$3,'owner')`, [uuidv7(), mallory, A.businessId])))
      .rejects.toThrow(/row-level security/);
    // ...nor while scoped to a business they merely claim
    await expect(withTenant(app, { userId: mallory, businessId: undefined }, (c) =>
      c.query(`UPDATE memberships SET role='owner' WHERE business_id=$1`, [A.businessId])))
      .resolves.toMatchObject({ rowCount: 0 });
  });

  it('cannot create a business without an authenticated user context', async () => {
    await expect(app.query(`INSERT INTO businesses (id,name,currency) VALUES ($1,'x','USD')`, [uuidv7()]))
      .rejects.toThrow(/row-level security/);
  });

  it('the app role cannot touch ledger tables beyond its grants', async () => {
    const { A } = await twoBusinesses();
    await expect(withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) => c.query('DELETE FROM transactions')))
      .rejects.toThrow(/permission denied/);
    await expect(withTenant(app, { userId: A.userId, businessId: A.businessId }, (c) => c.query('DELETE FROM accounts')))
      .rejects.toThrow(/permission denied/);
  });
});
