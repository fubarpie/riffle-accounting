import { afterAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotAMemberError, withMembership } from '../src/access.js';
import {
  BANK_WRITER_ROLES, BankInputError, NotFoundError, SecretError, createConnection, getAccessUrl, getConnection,
  linkAccount, listConnections, listLinks, parseKeyring, recordSyncResult, rotateConnectionKeys,
  unlinkAccount, updateConnection,
} from '../src/index.js';
import { withTenant } from '../src/tenant.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';
import { SECRET_URL, addMember, bankSetup, newKey } from './bank-helpers.js';

afterAll(closePools);

const ALL_ROLES = ['owner', 'admin', 'bookkeeper', 'viewer'] as const;

describe('connection secrecy', () => {
  it('stores only ciphertext, round-trips via getAccessUrl, and never leaks it from list/get', async () => {
    const s = await bankSetup();
    const list = await s.run((c) => listConnections(c, s.businessId));
    const got = await s.run((c) => getConnection(c, s.businessId, s.conn.id));
    const serialised = JSON.stringify([s.conn, list, got]);
    expect(serialised).not.toMatch(/s3cretpass|bridge\.example|access_url|accessUrl/i);
    expect(Object.keys(got!)).not.toContain('accessUrl');
    expect(Object.keys(got!).filter((k) => /url|enc|cipher/i.test(k))).toEqual([]);
    expect(got!.keyId).toBe('1');

    const raw = await admin.query<{ access_url_enc: Buffer }>('SELECT access_url_enc FROM bank_connections WHERE id = $1', [s.conn.id]);
    expect(raw.rows[0]!.access_url_enc.includes(Buffer.from('s3cretpass'))).toBe(false);
    expect(await s.run((c) => getAccessUrl(c, s.businessId, s.conn.id, s.keyring))).toBe(SECRET_URL);
  });

  it('keeps the URL and ciphertext out of every audit row', async () => {
    const s = await bankSetup();
    const otherUrl = 'https://u2:othersecret@bridge.example.test/x';
    await s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { accessUrl: otherUrl, label: 'Renamed' }, s.keyring));
    await s.run((c) => recordSyncResult(c, s.businessId, s.userId, s.conn.id, { ok: false, error: 'HTTP 403' }));
    const { rows } = await admin.query('SELECT action, actor_user_id, before, after FROM audit_log WHERE business_id = $1', [s.businessId]);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/s3cretpass|othersecret|bridge\.example/);
    const ct = (await admin.query<{ access_url_enc: Buffer }>('SELECT access_url_enc FROM bank_connections WHERE id=$1', [s.conn.id])).rows[0]!.access_url_enc;
    expect(text).not.toContain(ct.toString('base64'));
    expect(text).not.toContain(ct.toString('hex'));
    const upd = rows.find((r) => r.action === 'bank_connection.update');
    expect(upd.after.accessUrlReplaced).toBe(true);
  });

  it('rejects ciphertext moved to another connection or tenant, tampered rows, and the wrong key', async () => {
    const s = await bankSetup();
    const other = await bankSetup();
    const stolen = (await admin.query<{ access_url_enc: Buffer; access_url_key_id: string }>(
      'SELECT access_url_enc, access_url_key_id FROM bank_connections WHERE id = $1', [s.conn.id])).rows[0]!;

    // Same key ring, different tenant: AAD binding must fail it.
    await admin.query('UPDATE bank_connections SET access_url_enc = $2 WHERE id = $1', [other.conn.id, stolen.access_url_enc]);
    await expect(other.run((c) => getAccessUrl(c, other.businessId, other.conn.id, s.keyring))).rejects.toThrow(SecretError);

    // Bit flip.
    const bad = Buffer.from(stolen.access_url_enc);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    await admin.query('UPDATE bank_connections SET access_url_enc = $2 WHERE id = $1', [s.conn.id, bad]);
    await expect(s.run((c) => getAccessUrl(c, s.businessId, s.conn.id, s.keyring))).rejects.toThrow(SecretError);

    // Restore, then use a different key under the same id.
    await admin.query('UPDATE bank_connections SET access_url_enc = $2 WHERE id = $1', [s.conn.id, stolen.access_url_enc]);
    const wrong = parseKeyring(`1:${newKey()}`);
    await expect(s.run((c) => getAccessUrl(c, s.businessId, s.conn.id, wrong))).rejects.toThrow(SecretError);
    await expect(s.run((c) => getAccessUrl(c, s.businessId, s.conn.id, s.keyring))).resolves.toBe(SECRET_URL);
  });

  it('DB constraints refuse a truncated blob or a malformed key id', async () => {
    const s = await bankSetup();
    await expect(admin.query('UPDATE bank_connections SET access_url_enc = $2 WHERE id = $1', [s.conn.id, Buffer.alloc(5)]))
      .rejects.toThrow(/check constraint/);
    await expect(admin.query(`UPDATE bank_connections SET access_url_key_id = 'bad id!' WHERE id = $1`, [s.conn.id]))
      .rejects.toThrow(/check constraint/);
  });
});

describe('key rotation', () => {
  it('keeps old rows readable once a new key is added at the head', async () => {
    const s = await bankSetup();
    const oldKey = newKey(); const newK = newKey();
    const oldRing = parseKeyring(`1:${oldKey}`);
    const conn = await s.run((c) => createConnection(c, s.businessId, s.userId, { label: 'rot', accessUrl: SECRET_URL }, oldRing));
    expect(conn.keyId).toBe('1');
    const both = parseKeyring(`2:${newK},1:${oldKey}`);

    // Old rows still readable after the new key is added at the head.
    await expect(s.run((c) => getAccessUrl(c, s.businessId, conn.id, both))).resolves.toBe(SECRET_URL);
  });

  it('rotates every connection of the business and records audit rows', async () => {
    const s = await bankSetup();
    const key1 = newKey(); const key2 = newKey();
    const ring1 = parseKeyring(`1:${key1}`);
    await admin.query('DELETE FROM bank_account_links WHERE business_id = $1', [s.businessId]);
    await admin.query('DELETE FROM bank_connections WHERE business_id = $1', [s.businessId]);
    const ids: string[] = [];
    for (const label of ['a', 'b']) {
      const c1 = await s.run((c) => createConnection(c, s.businessId, s.userId, { label, accessUrl: `https://u:${label}pw@h.example.test/` }, ring1));
      ids.push(c1.id);
    }
    const ring2 = parseKeyring(`2:${key2},1:${key1}`);
    expect(await s.run((c) => rotateConnectionKeys(c, s.businessId, s.userId, ring2))).toBe(2);
    expect(await s.run((c) => rotateConnectionKeys(c, s.businessId, s.userId, ring2))).toBe(0);

    const rows = (await admin.query<{ access_url_key_id: string }>(
      'SELECT access_url_key_id FROM bank_connections WHERE business_id = $1', [s.businessId])).rows;
    expect(rows.map((r) => r.access_url_key_id)).toEqual(['2', '2']);
    // Old key can now be dropped.
    const only2 = parseKeyring(`2:${key2}`);
    await expect(s.run((c) => getAccessUrl(c, s.businessId, ids[0]!, only2))).resolves.toBe('https://u:apw@h.example.test/');
    const audits = await admin.query('SELECT action, before, after FROM audit_log WHERE business_id=$1 AND action = $2',
      [s.businessId, 'bank_connection.rotate_key']);
    expect(audits.rowCount).toBe(2);
    expect(audits.rows[0].before).toEqual({ keyId: '1' });
    expect(audits.rows[0].after).toEqual({ keyId: '2' });
  });
});

describe('tenant isolation (RLS)', () => {
  it('another business cannot list, get, decrypt, update, link or write rows of a connection', async () => {
    const A = await bankSetup();
    const B = await bankSetup();

    expect((await B.run((c) => listConnections(c, B.businessId))).map((x) => x.id)).toEqual([B.conn.id]);
    // Asking for A's id with B's own business id finds nothing.
    expect(await B.run((c) => getConnection(c, B.businessId, A.conn.id))).toBeUndefined();
    await expect(B.run((c) => getAccessUrl(c, B.businessId, A.conn.id, A.keyring))).rejects.toThrow(NotFoundError);
    expect(await B.run((c) => updateConnection(c, B.businessId, B.userId, A.conn.id, { status: 'disabled' }, A.keyring))).toBeUndefined();
    expect(await B.run((c) => recordSyncResult(c, B.businessId, B.userId, A.conn.id, { ok: true }))).toBeUndefined();
    await expect(B.run((c) => linkAccount(c, B.businessId, B.userId, {
      connectionId: A.conn.id, externalAccountId: 'x', accountId: B.a('1010'),
    }))).rejects.toThrow(NotFoundError);
    expect(await B.run((c) => listLinks(c, B.businessId, A.conn.id))).toEqual([]);
    expect(await B.run((c) => unlinkAccount(c, B.businessId, B.userId, A.link.id))).toBe(false);

    // Even with B's context, A's business id yields nothing, and forging a row is refused by RLS.
    for (const t of ['bank_connections', 'bank_account_links', 'staged_transactions']) {
      const r = await B.run((c) => c.query(`SELECT 1 FROM ${t} WHERE business_id = $1`, [A.businessId]));
      expect(r.rowCount, t).toBe(0);
    }
    await expect(B.run((c) => c.query(
      `INSERT INTO bank_connections (id, business_id, label, access_url_enc, access_url_key_id, created_by)
       VALUES (gen_random_uuid(), $1, 'x', $2, '1', $3)`, [A.businessId, Buffer.alloc(40), B.userId]))).rejects.toThrow(/row-level security/);

    // A's connection is untouched.
    expect((await A.run((c) => getConnection(c, A.businessId, A.conn.id)))!.status).toBe('active');
  });

  it('cannot link a ledger account that belongs to another business', async () => {
    const A = await bankSetup();
    const B = await makeBusiness();
    await expect(A.run((c) => linkAccount(c, A.businessId, A.userId, {
      connectionId: A.conn.id, externalAccountId: 'ACT-9', accountId: B.accounts.get('1010')!,
    }))).rejects.toThrow(BankInputError);
  });

  it('a non-member is rejected before any data access', async () => {
    const A = await bankSetup();
    const B = await makeBusiness();
    await expect(withMembership(app, B.userId, A.businessId, ALL_ROLES, (c) => listConnections(c, A.businessId)))
      .rejects.toThrow(NotAMemberError);
  });
});

describe('roles', () => {
  it('viewers may read connections but are denied the writer gate; writers pass', async () => {
    const s = await bankSetup();
    const viewer = await addMember(s.businessId, 'viewer');
    const bookkeeper = await addMember(s.businessId, 'bookkeeper');
    const admin_ = await addMember(s.businessId, 'admin');

    const seen = await withMembership(app, viewer, s.businessId, ALL_ROLES, (c) => listConnections(c, s.businessId));
    expect(seen.map((x) => x.id)).toEqual([s.conn.id]);
    expect(JSON.stringify(seen)).not.toContain('s3cretpass');

    await expect(s.asWriter(viewer, (c) => createConnection(c, s.businessId, viewer, { label: 'v', accessUrl: SECRET_URL }, s.keyring)))
      .rejects.toThrow(ForbiddenError);
    await expect(s.asWriter(viewer, (c) => getAccessUrl(c, s.businessId, s.conn.id, s.keyring))).rejects.toThrow(ForbiddenError);
    await expect(s.asWriter(viewer, (c) => updateConnection(c, s.businessId, viewer, s.conn.id, { status: 'disabled' })))
      .rejects.toThrow(ForbiddenError);
    expect((await s.run((c) => getConnection(c, s.businessId, s.conn.id)))!.status).toBe('active');
    expect(BANK_WRITER_ROLES).toEqual(['owner', 'admin', 'bookkeeper']);

    for (const u of [s.userId, admin_, bookkeeper]) {
      await expect(s.asWriter(u, (c) => getConnection(c, s.businessId, s.conn.id))).resolves.toBeDefined();
    }
  });
});

describe('connection lifecycle, links and audit', () => {
  it('validates input', async () => {
    const s = await bankSetup();
    const mk = (o: Partial<{ label: string; accessUrl: string; scheduleMinute: number }>) =>
      s.run((c) => createConnection(c, s.businessId, s.userId, { label: 'x', accessUrl: SECRET_URL, ...o }, s.keyring));
    await expect(mk({ label: '  ' })).rejects.toThrow(BankInputError);
    await expect(mk({ label: 'x'.repeat(121) })).rejects.toThrow(BankInputError);
    await expect(mk({ accessUrl: 'not a url' })).rejects.toThrow(BankInputError);
    await expect(mk({ accessUrl: 'http://u:p@insecure.example.test/' })).rejects.toThrow(BankInputError);
    await expect(mk({ scheduleMinute: 60 })).rejects.toThrow(BankInputError);
    await expect(mk({ scheduleMinute: -1 })).rejects.toThrow(BankInputError);
    await expect(mk({ scheduleMinute: 1.5 })).rejects.toThrow(BankInputError);
    await expect(s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { status: 'bogus' as never }))).rejects.toThrow(BankInputError);
  });

  it('records status transitions, sync results and link changes, each with an audit row', async () => {
    const s = await bankSetup();
    const fail = await s.run((c) => recordSyncResult(c, s.businessId, s.userId, s.conn.id, { ok: false, error: 'x'.repeat(2000) }));
    expect(fail).toMatchObject({ status: 'error' });
    expect(fail!.lastError).toHaveLength(1000);
    const ok = await s.run((c) => recordSyncResult(c, s.businessId, s.userId, s.conn.id, { ok: true }));
    expect(ok).toMatchObject({ status: 'active', lastError: null });
    expect(ok!.lastSyncedAt).not.toBeNull();

    await s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { status: 'disabled' }));
    // A failed sync must not resurrect a connection a person disabled.
    const stillOff = await s.run((c) => recordSyncResult(c, s.businessId, s.userId, s.conn.id, { ok: false, error: 'boom' }));
    expect(stillOff!.status).toBe('disabled');

    const other = s.a('6020'); // expense: not linkable
    await expect(s.run((c) => linkAccount(c, s.businessId, s.userId, {
      connectionId: s.conn.id, externalAccountId: 'ACT-2', accountId: other,
    }))).rejects.toThrow(/asset or liability/);
    const card = s.a('2000'); // liability: linkable
    const l2 = await s.run((c) => linkAccount(c, s.businessId, s.userId, { connectionId: s.conn.id, externalAccountId: 'ACT-1', accountId: card }));
    expect(l2.id).toBe(s.link.id); // re-point, not duplicate
    expect(await s.run((c) => listLinks(c, s.businessId, s.conn.id))).toHaveLength(1);
    expect(await s.run((c) => unlinkAccount(c, s.businessId, s.userId, s.link.id))).toBe(true);

    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE business_id = $1 AND action LIKE 'bank_%' ORDER BY id`, [s.businessId]);
    expect(rows.map((r) => r.action)).toEqual([
      'bank_connection.create', 'bank_link.create', 'bank_connection.sync_error', 'bank_connection.sync_ok',
      'bank_connection.update', 'bank_connection.sync_error', 'bank_link.update', 'bank_link.delete',
    ]);
    const actors = await admin.query('SELECT DISTINCT actor_user_id FROM audit_log WHERE business_id = $1 AND action LIKE $2', [s.businessId, 'bank_%']);
    expect(actors.rows).toEqual([{ actor_user_id: s.userId }]);
  });

  it('status-only updates and sync results need no key material in the environment', async () => {
    const s = await bankSetup();
    const saved = process.env.RIFFLE_SECRET_KEY;
    delete process.env.RIFFLE_SECRET_KEY;
    try {
      await expect(s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { label: 'no key needed' })))
        .resolves.toMatchObject({ label: 'no key needed' });
      await expect(s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { accessUrl: SECRET_URL })))
        .rejects.toThrow(/RIFFLE_SECRET_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.RIFFLE_SECRET_KEY = saved;
    }
  });

  it('rolls back audit and data together when an operation fails', async () => {
    const s = await bankSetup();
    const before = (await admin.query('SELECT count(*)::int AS n FROM audit_log WHERE business_id=$1', [s.businessId])).rows[0].n;
    await expect(withTenant(app, s.ctx, async (c) => {
      await updateConnection(c, s.businessId, s.userId, s.conn.id, { label: 'changed' });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect((await s.run((c) => getConnection(c, s.businessId, s.conn.id)))!.label).toBe('Main bank');
    expect((await admin.query('SELECT count(*)::int AS n FROM audit_log WHERE business_id=$1', [s.businessId])).rows[0].n).toBe(before);
  });
});
