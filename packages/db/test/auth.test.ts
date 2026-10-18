import { afterAll, describe, expect, it } from 'vitest';
import {
  EmailTakenError, ForbiddenError, NotAMemberError, createSession, createUser, deleteSession,
  findUserByEmail, purgeExpiredSessions, resolveSession, withMembership,
} from '../src/index.js';
import { admin, app, closePools, makeBusiness, makeUser } from './helpers.js';

afterAll(closePools);

describe('users and sessions', () => {
  it('normalises email and rejects duplicates case-insensitively', async () => {
    const e = `Mixed-${Date.now()}@Example.test`;
    const u = await createUser(app, { email: e, name: ' Ann ', passwordHash: 'x' });
    expect(u.email).toBe(e.toLowerCase());
    expect(u.name).toBe('Ann');
    await expect(createUser(app, { email: e.toUpperCase(), name: 'B', passwordHash: 'x' }))
      .rejects.toBeInstanceOf(EmailTakenError);
    expect((await findUserByEmail(app, e.toUpperCase()))?.id).toBe(u.id);
  });

  it('stores only a hash of the session token', async () => {
    const id = await makeUser();
    const { token } = await createSession(app, id);
    const { rows } = await admin.query('SELECT token_hash FROM sessions WHERE user_id=$1', [id]);
    expect(rows[0].token_hash.toString('utf8')).not.toContain(token);
    expect((await resolveSession(app, token))?.user.id).toBe(id);
  });

  it('rejects unknown, deleted and expired tokens', async () => {
    const id = await makeUser();
    expect(await resolveSession(app, 'nope')).toBeUndefined();
    const a = await createSession(app, id);
    await deleteSession(app, a.token);
    expect(await resolveSession(app, a.token)).toBeUndefined();
    const b = await createSession(app, id);
    await admin.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id=$1`, [id]);
    expect(await resolveSession(app, b.token)).toBeUndefined();
    expect(await purgeExpiredSessions(app)).toBeGreaterThanOrEqual(1);
  });

  it('slides expiry only when the session is stale', async () => {
    const id = await makeUser();
    const { token } = await createSession(app, id);
    expect((await resolveSession(app, token))?.refreshed).toBe(false);
    await admin.query(`UPDATE sessions SET last_used_at = now() - interval '2 hours' WHERE user_id=$1`, [id]);
    expect((await resolveSession(app, token))?.refreshed).toBe(true);
  });

  it('the app role cannot reassign a session to another user', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await createSession(app, a);
    await expect(app.query('UPDATE sessions SET user_id=$1 WHERE user_id=$2', [b, a])).rejects.toThrow(/permission denied/);
  });
});

describe('withMembership', () => {
  it('runs for permitted roles scoped to the business', async () => {
    const { userId, businessId } = await makeBusiness();
    const n = await withMembership(app, userId, businessId, ['owner'], async (c, a) => {
      expect(a.role).toBe('owner');
      return (await c.query('SELECT count(*)::int AS n FROM accounts')).rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });

  it('hides businesses from non-members and blocks low roles', async () => {
    const { userId, businessId } = await makeBusiness();
    const stranger = await makeUser();
    await expect(withMembership(app, stranger, businessId, ['owner'], async () => 1))
      .rejects.toBeInstanceOf(NotAMemberError);
    await admin.query(`INSERT INTO memberships (id, user_id, business_id, role)
      VALUES (gen_random_uuid(), $1, $2, 'viewer')`, [stranger, businessId]);
    await expect(withMembership(app, stranger, businessId, ['owner', 'admin'], async () => 1))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(withMembership(app, stranger, businessId, ['viewer'], async () => 1)).resolves.toBe(1);
    expect(userId).toBeTruthy();
  });
});
