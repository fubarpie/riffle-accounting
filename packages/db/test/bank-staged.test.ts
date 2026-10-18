import { afterAll, describe, expect, it } from 'vitest';
import { ForbiddenError, withMembership } from '../src/access.js';
import { LedgerInputError, liveBalances } from '../src/ledger.js';
import {
  BANK_WRITER_ROLES, BankInputError, BooksLockedError, ConnectionDisabledError, MAX_IMPORT_BATCH, NotFoundError,
  StagedStateError, getStaged, importBatch, listStaged, postStaged, updateConnection, updateStaged,
} from '../src/index.js';
import { createRule, parseRuleDefinition } from '../src/rules/index.js';
import { admin, app, closePools } from './helpers.js';
import { addMember, bankSetup, tx } from './bank-helpers.js';

afterAll(closePools);

type S = Awaited<ReturnType<typeof bankSetup>>;
const imp = (s: S, ...t: Parameters<typeof importBatch>[4][number][]) =>
  s.run((c) => importBatch(c, s.businessId, s.userId, s.conn.id, t));
const count = async (s: S) =>
  (await admin.query('SELECT count(*)::int AS n FROM staged_transactions WHERE business_id = $1', [s.businessId])).rows[0].n as number;
const stagedByExt = async (s: S, ext: string) =>
  (await s.run((c) => listStaged(c, s.businessId))).find((r) => r.externalId === ext)!;
const actions = async (s: S) =>
  (await admin.query<{ action: string }>('SELECT action FROM audit_log WHERE business_id = $1 ORDER BY id', [s.businessId]))
    .rows.map((r) => r.action);

describe('importBatch', () => {
  it('stages new rows with signed bigint minor units and is idempotent on replay', async () => {
    const s = await bankSetup();
    const batch = [tx({ amountMinor: -1250n }), tx({ amountMinor: 500_000n, description: 'PAYROLL' }), tx({ amountMinor: -1n })];
    const r1 = await imp(s, ...batch);
    expect(r1).toEqual({ inserted: 3, duplicate: 0, updated: 0, skippedUnlinked: 0, unlinkedAccounts: [] });
    const r2 = await imp(s, ...batch);
    expect(r2).toEqual({ inserted: 0, duplicate: 3, updated: 0, skippedUnlinked: 0, unlinkedAccounts: [] });
    expect(await count(s)).toBe(3);

    const rows = await s.run((c) => listStaged(c, s.businessId));
    expect(rows.map((r) => r.amountMinor).sort()).toEqual([-1250n, -1n, 500_000n].sort());
    expect(rows.every((r) => r.status === 'new' && r.accountId === s.a('1010') && r.linkId === s.link.id && r.source === 'simplefin')).toBe(true);
    expect(rows.every((r) => r.transactionId === null)).toBe(true);
  });

  it('handles repeats inside one batch and large 64-bit-safe amounts', async () => {
    const s = await bankSetup();
    const t = tx({ amountMinor: 8_999_999_999_999_999n });
    const r = await imp(s, t, { ...t }, tx());
    expect(r).toMatchObject({ inserted: 2, duplicate: 1 });
    expect((await stagedByExt(s, t.externalId)).amountMinor).toBe(8_999_999_999_999_999n);
  });

  it('skips and reports transactions for provider accounts that are not linked', async () => {
    const s = await bankSetup();
    const r = await imp(s, tx(), tx({ externalAccountId: 'ZZZ' }), tx({ externalAccountId: 'ACT-9' }), tx({ externalAccountId: 'ZZZ' }));
    expect(r).toMatchObject({ inserted: 1, skippedUnlinked: 3, unlinkedAccounts: ['ACT-9', 'ZZZ'] });
    expect(await count(s)).toBe(1);
  });

  it('a 5-day overlap re-import adds only the new rows', async () => {
    const s = await bankSetup();
    const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;
    const all = Array.from({ length: 15 }, (_, i) => tx({ externalId: `OV-${i + 1}`, postedDate: day(i + 1) }));
    const first = await imp(s, ...all.slice(0, 10)); // days 1-10
    expect(first.inserted).toBe(10);
    const second = await imp(s, ...all.slice(5)); // days 6-15: 5 overlapping, 5 new
    expect(second).toMatchObject({ inserted: 5, duplicate: 5, updated: 0 });
    expect(await count(s)).toBe(15);
  });

  it('updates pending -> settled in place without duplicating', async () => {
    const s = await bankSetup();
    const pend = tx({ externalId: 'P-1', pending: true, amountMinor: -1000n, postedDate: '2026-03-10', description: 'HOTEL HOLD' });
    await imp(s, pend);
    expect(await imp(s, pend)).toMatchObject({ inserted: 0, duplicate: 1, updated: 0 }); // unchanged pending

    const settled = { ...pend, pending: false, amountMinor: -1187n, postedDate: '2026-03-12', description: 'HOTEL INN' };
    expect(await imp(s, settled)).toMatchObject({ inserted: 0, duplicate: 0, updated: 1 });
    expect(await count(s)).toBe(1);
    const row = await stagedByExt(s, 'P-1');
    expect(row).toMatchObject({ pending: false, amountMinor: -1187n, postedDate: '2026-03-12', description: 'HOTEL INN', status: 'new' });

    // Replaying the settled item changes nothing further, and a later "pending" echo never un-settles it.
    expect(await imp(s, settled)).toMatchObject({ updated: 0, duplicate: 1 });
    expect(await imp(s, pend)).toMatchObject({ updated: 0, duplicate: 1 });
    expect((await stagedByExt(s, 'P-1')).pending).toBe(false);

    const { rows } = await admin.query('SELECT before, after FROM audit_log WHERE business_id=$1 AND action=$2', [s.businessId, 'staged.pending_update']);
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ pending: true, amountMinor: '-1000' });
    expect(rows[0].after).toMatchObject({ pending: false, amountMinor: '-1187' });
  });

  it('settles a pending row inside the same batch and keeps person-made status/category', async () => {
    const s = await bankSetup();
    const p = tx({ externalId: 'P-2', pending: true });
    const r = await imp(s, p, { ...p, pending: false });
    expect(r).toMatchObject({ inserted: 1, duplicate: 1 });
    expect((await stagedByExt(s, 'P-2')).pending).toBe(false);

    const p3 = tx({ externalId: 'P-3', pending: true });
    await imp(s, p3);
    const id = (await stagedByExt(s, 'P-3')).id;
    await s.run((c) => updateStaged(c, s.businessId, s.userId, id, { status: 'ignored', categoryAccountId: s.a('6000') }));
    await imp(s, { ...p3, pending: false });
    expect(await stagedByExt(s, 'P-3')).toMatchObject({ pending: false, status: 'ignored', categoryAccountId: s.a('6000') });
  });

  it('never touches a row already posted to the ledger', async () => {
    const s = await bankSetup();
    const t = tx({ externalId: 'POSTED-1', amountMinor: -2000n });
    await imp(s, t);
    const id = (await stagedByExt(s, 'POSTED-1')).id;
    await s.run((c) => postStaged(c, s.businessId, s.userId, id));
    const r = await imp(s, { ...t, amountMinor: -9999n, description: 'CHANGED', pending: true });
    expect(r).toMatchObject({ inserted: 0, updated: 0, duplicate: 1 });
    expect(await stagedByExt(s, 'POSTED-1')).toMatchObject({ amountMinor: -2000n, status: 'posted', pending: false });
  });

  it('is idempotent per connection: the same external id on another connection is a different row', async () => {
    const s = await bankSetup();
    const { createConnection, linkAccount } = await import('../src/index.js');
    const c2 = await s.run((c) => createConnection(c, s.businessId, s.userId, { label: 'Second', accessUrl: 'https://u:p@h.example.test/' }, s.keyring));
    await s.run((c) => linkAccount(c, s.businessId, s.userId, { connectionId: c2.id, externalAccountId: 'ACT-1', accountId: s.a('1000') }));
    const t = tx({ externalId: 'SAME' });
    await imp(s, t);
    const r = await s.run((c) => importBatch(c, s.businessId, s.userId, c2.id, [t]));
    expect(r.inserted).toBe(1);
    expect(await count(s)).toBe(2);
  });

  it('validates untrusted input and normalises text instead of failing on database limits', async () => {
    const s = await bankSetup();
    const bad = (o: object) => imp(s, tx(o as never));
    await expect(bad({ postedDate: '2026-02-30' })).rejects.toThrow(BankInputError);
    await expect(bad({ postedDate: '03/10/2026' })).rejects.toThrow(BankInputError);
    await expect(bad({ externalId: '' })).rejects.toThrow(BankInputError);
    await expect(bad({ amountMinor: 12 })).rejects.toThrow(BankInputError); // number, not bigint
    await expect(bad({ amountMinor: 9_000_000_000_000_001n })).rejects.toThrow(BankInputError);
    await expect(bad({ pending: 'false' })).rejects.toThrow(BankInputError);
    await expect(bad({ description: null })).rejects.toThrow(BankInputError);
    await expect(bad({ raw: { big: 'x'.repeat(40_000) } })).rejects.toThrow(BankInputError);
    await expect(imp(s, ...Array.from({ length: MAX_IMPORT_BATCH + 1 }, () => tx()))).rejects.toThrow(BankInputError);
    expect(await count(s)).toBe(0);

    // Over-long descriptions are truncated; NUL bytes (rejected by Postgres) are stripped; bigint in raw is serialised.
    const odd = tx({ description: `${'d'.repeat(1500)}`, raw: { n: 5n, s: 'a\u0000b' } });
    const weird = tx({ description: 'x\u0000y' });
    const r = await imp(s, odd, weird);
    expect(r.inserted).toBe(2);
    expect((await stagedByExt(s, odd.externalId)).description).toHaveLength(1000);
    expect((await stagedByExt(s, weird.externalId)).description).toBe('xy');
    const got = await s.run((c) => getStaged(c, s.businessId, '0190a000-0000-7000-8000-0000000000ff'));
    expect(got).toBeUndefined();
    // Re-importing the same oversized description is still a duplicate, not a perpetual "update".
    expect(await imp(s, odd)).toMatchObject({ inserted: 0, duplicate: 1, updated: 0 });
  });

  it('refuses unknown and disabled connections', async () => {
    const s = await bankSetup();
    await expect(s.run((c) => importBatch(c, s.businessId, s.userId, '0190a000-0000-7000-8000-0000000000ff', [tx()])))
      .rejects.toThrow(NotFoundError);
    await s.run((c) => updateConnection(c, s.businessId, s.userId, s.conn.id, { status: 'disabled' }));
    await expect(imp(s, tx())).rejects.toThrow(ConnectionDisabledError);
    expect(await count(s)).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('another business cannot see, change, post or import into staged rows', async () => {
    const A = await bankSetup();
    const B = await bankSetup();
    const t = tx({ externalId: 'ISO-1' });
    await imp(A, t);
    const id = (await stagedByExt(A, 'ISO-1')).id;

    expect(await B.run((c) => listStaged(c, B.businessId))).toEqual([]);
    expect(await B.run((c) => getStaged(c, B.businessId, id))).toBeUndefined();
    await expect(B.run((c) => updateStaged(c, B.businessId, B.userId, id, { status: 'ignored' }))).rejects.toThrow(NotFoundError);
    await expect(B.run((c) => postStaged(c, B.businessId, B.userId, id))).rejects.toThrow(NotFoundError);
    // A connection id from another tenant is simply not found.
    await expect(B.run((c) => importBatch(c, B.businessId, B.userId, A.conn.id, [tx()]))).rejects.toThrow(NotFoundError);
    // Asking RLS directly: nothing visible, forging rows fails.
    expect((await B.run((c) => c.query('SELECT 1 FROM staged_transactions WHERE id = $1', [id]))).rowCount).toBe(0);
    await expect(B.run((c) => c.query(
      `INSERT INTO staged_transactions (id,business_id,connection_id,link_id,account_id,external_id,posted_date,amount_minor,created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'forged','2026-03-01',1,$5)`,
      [A.businessId, A.conn.id, A.link.id, A.a('1010'), B.userId]))).rejects.toThrow(/row-level security/);
    // Composite FKs: B cannot stage against A's account even with its own business id.
    await expect(B.run((c) => c.query(
      `INSERT INTO staged_transactions (id,business_id,connection_id,link_id,account_id,external_id,posted_date,amount_minor,created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'x','2026-03-01',1,$5)`,
      [B.businessId, B.conn.id, B.link.id, A.a('1010'), B.userId]))).rejects.toThrow(/foreign key/);

    expect(await stagedByExt(A, 'ISO-1')).toMatchObject({ status: 'new' });
    expect(await count(B)).toBe(0);
  });
});

describe('postStaged', () => {
  const setupStaged = async (over: Parameters<typeof tx>[0] = {}) => {
    const s = await bankSetup();
    const t = tx(over);
    await imp(s, t);
    const row = await stagedByExt(s, t.externalId);
    return { s, t, row };
  };
  const lines = async (s: S, txnId: string) =>
    (await admin.query<{ account_id: string; amount_minor: string; entry_date: string }>(
      `SELECT l.account_id, l.amount_minor::text, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date
         FROM transactions t JOIN journal_entries e ON e.id = t.current_entry_id
         JOIN journal_lines l ON l.entry_id = e.id
        WHERE t.business_id = $1 AND t.id = $2 ORDER BY l.amount_minor`, [s.businessId, txnId])).rows;

  it('posts a balanced two-line entry through the ledger (spend -> Uncategorized Expense)', async () => {
    const { s, row } = await setupStaged({ amountMinor: -1250n, description: 'COFFEE SHOP' });
    const res = await s.run((c) => postStaged(c, s.businessId, s.userId, row.id));
    expect(res).toMatchObject({ categoryAccountId: s.a('6900'), categorySource: 'uncategorized', ruleIds: [] });

    const ls = await lines(s, res.transactionId);
    expect(ls).toEqual([
      { account_id: s.a('1010'), amount_minor: '-1250', entry_date: '2026-03-10' }, // bank credited
      { account_id: s.a('6900'), amount_minor: '1250', entry_date: '2026-03-10' },  // expense debited
    ]);
    expect(ls.reduce((n, l) => n + BigInt(l.amount_minor), 0n)).toBe(0n);

    const bal = await s.run((c) => liveBalances(c, s.businessId));
    expect(bal.get(s.a('1010'))).toBe(-1250n);
    expect(bal.get(s.a('6900'))).toBe(1250n);

    const after = await s.run((c) => getStaged(c, s.businessId, row.id));
    expect(after).toMatchObject({ status: 'posted', transactionId: res.transactionId, categoryAccountId: s.a('6900') });
    const kind = await admin.query('SELECT kind, description, created_by FROM transactions WHERE id = $1', [res.transactionId]);
    expect(kind.rows[0]).toEqual({ kind: 'withdrawal', description: 'COFFEE SHOP', created_by: s.userId });
    expect(await actions(s)).toEqual(expect.arrayContaining(['transaction.post', 'staged.post', 'bank_import.batch']));
  });

  it('deposits go to Uncategorized Income and debit the bank account', async () => {
    const { s, row } = await setupStaged({ amountMinor: 700_00n, description: 'CLIENT PAYMENT' });
    const res = await s.run((c) => postStaged(c, s.businessId, s.userId, row.id));
    expect(res.categoryAccountId).toBe(s.a('4900'));
    expect((await lines(s, res.transactionId)).map((l) => [l.account_id, l.amount_minor])).toEqual([
      [s.a('4900'), '-70000'], [s.a('1010'), '70000']]);
  });

  it('credit-card (liability) accounts keep the sign convention: a charge is a credit to the liability', async () => {
    const s = await bankSetup();
    const { linkAccount } = await import('../src/index.js');
    await s.run((c) => linkAccount(c, s.businessId, s.userId, { connectionId: s.conn.id, externalAccountId: 'CARD', accountId: s.a('2000') }));
    const t = tx({ externalAccountId: 'CARD', amountMinor: -4200n });
    await imp(s, t);
    const res = await s.run(async (c) => postStaged(c, s.businessId, s.userId, (await listStaged(c, s.businessId))[0]!.id));
    expect((await lines(s, res.transactionId)).map((l) => [l.account_id, l.amount_minor])).toEqual([
      [s.a('2000'), '-4200'], [s.a('6900'), '4200']]);
  });

  it('runs the Phase 2 rules: category, note and tag; a person-chosen category wins', async () => {
    const s = await bankSetup();
    const def = parseRuleDefinition({
      name: 'shell', conditions: [{ type: 'description', op: 'contains', value: 'shell' }],
      actions: [{ type: 'set_category', accountId: s.a('6000') }, { type: 'add_tag', tag: 'fuel' }, { type: 'add_note', text: 'auto' }],
    });
    const rule = await s.run((c) => createRule(c, s.businessId, s.userId, def));
    const t1 = tx({ description: 'SHELL OIL 12' });
    const t2 = tx({ description: 'SHELL OIL 13' });
    const t3 = tx({ description: 'NO MATCH' });
    await imp(s, t1, t2, t3);
    const [r1, r2, r3] = await Promise.all([t1, t2, t3].map((t) => stagedByExt(s, t.externalId)));

    const p1 = await s.run((c) => postStaged(c, s.businessId, s.userId, r1!.id));
    expect(p1).toMatchObject({ categoryAccountId: s.a('6000'), categorySource: 'rule', ruleIds: [rule.id] });
    const tags = await admin.query('SELECT tag FROM transaction_tags WHERE transaction_id = $1', [p1.transactionId]);
    expect(tags.rows).toEqual([{ tag: 'fuel' }]);
    const notes = await admin.query('SELECT notes FROM transactions WHERE id = $1', [p1.transactionId]);
    expect(notes.rows[0].notes).toContain('auto');

    const p2 = await s.run((c) => postStaged(c, s.businessId, s.userId, r2!.id, { categoryAccountId: s.a('6020') }));
    expect(p2).toMatchObject({ categoryAccountId: s.a('6020'), categorySource: 'chosen', ruleIds: [] });
    const p3 = await s.run((c) => postStaged(c, s.businessId, s.userId, r3!.id));
    expect(p3).toMatchObject({ categorySource: 'uncategorized', ruleIds: [] });

    // Rules still see the posted transaction as categorizable (deposit/withdrawal kind).
    const kinds = await admin.query('SELECT kind FROM transactions WHERE id = $1', [p1.transactionId]);
    expect(kinds.rows[0].kind).toBe('withdrawal');
  });

  it('falls back to Uncategorized when a rule points at an archived category', async () => {
    const s = await bankSetup();
    const def = parseRuleDefinition({
      name: 'r', conditions: [{ type: 'description', op: 'contains', value: 'acme' }],
      actions: [{ type: 'set_category', accountId: s.a('6000') }],
    });
    await s.run((c) => createRule(c, s.businessId, s.userId, def));
    await admin.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [s.a('6000')]);
    const t = tx({ description: 'ACME' });
    await imp(s, t);
    const res = await s.run(async (c) => postStaged(c, s.businessId, s.userId, (await listStaged(c, s.businessId))[0]!.id));
    expect(res.categorySource).toBe('uncategorized');
  });

  it('uses the category stored on the staged row by updateStaged', async () => {
    const { s, row } = await setupStaged();
    await s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'approved', categoryAccountId: s.a('6020') }));
    const res = await s.run((c) => postStaged(c, s.businessId, s.userId, row.id));
    expect(res).toMatchObject({ categoryAccountId: s.a('6020'), categorySource: 'chosen' });
  });

  it('refuses double-posting, pending, ignored, zero-amount and bad categories; nothing is half-written', async () => {
    const s = await bankSetup();
    const ok = tx(); const pend = tx({ pending: true }); const ign = tx(); const zero = tx({ amountMinor: 0n });
    await imp(s, ok, pend, ign, zero);
    const id = async (t: { externalId: string }) => (await stagedByExt(s, t.externalId)).id;
    await s.run(async (c) => updateStaged(c, s.businessId, s.userId, await id(ign), { status: 'ignored' }));

    await s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(ok)));
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(ok)))).rejects.toThrow(/already posted/);
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(pend)))).rejects.toThrow(/pending/);
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(ign)))).rejects.toThrow(/ignored/);
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(zero)))).rejects.toThrow(LedgerInputError);
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(pend)))).rejects.toBeInstanceOf(StagedStateError);
    await expect(s.run(async (c) => postStaged(c, s.businessId, s.userId, await id(zero), { categoryAccountId: s.a('6000') })))
      .rejects.toThrow(LedgerInputError);

    const fresh = tx(); await imp(s, fresh);
    const fid = await id(fresh);
    await expect(s.run((c) => postStaged(c, s.businessId, s.userId, fid, { categoryAccountId: s.a('1010') }))).rejects.toThrow(/bank account itself/);
    await expect(s.run((c) => postStaged(c, s.businessId, s.userId, fid, { categoryAccountId: '0190a000-0000-7000-8000-0000000000ff' }))).rejects.toThrow(BankInputError);
    expect(await stagedByExt(s, fresh.externalId)).toMatchObject({ status: 'new', transactionId: null });
    const n = await admin.query('SELECT count(*)::int AS n FROM transactions WHERE business_id = $1', [s.businessId]);
    expect(n.rows[0].n).toBe(1); // only the one good post
  });

  it('rejects posting into locked books (inclusive of the lock date) and leaves staging untouched', async () => {
    const s = await bankSetup();
    await admin.query(`UPDATE businesses SET books_locked_through = '2026-01-31' WHERE id = $1`, [s.businessId]);
    const on = tx({ postedDate: '2026-01-31' });
    const before = tx({ postedDate: '2026-01-15' });
    const after = tx({ postedDate: '2026-02-01' });
    await imp(s, on, before, after); // importing into locked periods is fine: staging is not the ledger
    for (const t of [on, before]) {
      const row = await stagedByExt(s, t.externalId);
      await expect(s.run((c) => postStaged(c, s.businessId, s.userId, row.id))).rejects.toThrow(BooksLockedError);
      expect(await stagedByExt(s, t.externalId)).toMatchObject({ status: 'new', transactionId: null });
    }
    const ok = await stagedByExt(s, after.externalId);
    await expect(s.run((c) => postStaged(c, s.businessId, s.userId, ok.id))).resolves.toMatchObject({ categorySource: 'uncategorized' });
    const n = await admin.query('SELECT count(*)::int AS n FROM transactions WHERE business_id = $1', [s.businessId]);
    expect(n.rows[0].n).toBe(1);
    // The lock error names the date.
    const row = await stagedByExt(s, on.externalId);
    await expect(s.run((c) => postStaged(c, s.businessId, s.userId, row.id))).rejects.toThrow(/2026-01-31/);
  });

  it('the lock date is enforced by the database even if the application pre-check is bypassed', async () => {
    const s = await bankSetup();
    const { postTransaction } = await import('../src/ledger.js');
    await admin.query(`UPDATE businesses SET books_locked_through = '2026-01-31' WHERE id = $1`, [s.businessId]);
    await expect(s.run((c) => postTransaction(c, s.businessId, s.userId, {
      kind: 'withdrawal', date: '2026-01-10',
      lines: [{ accountId: s.a('1010'), amount: -5n }, { accountId: s.a('6900'), amount: 5n }],
    }))).rejects.toThrow(/locked/);
  });

  it('refuses an archived bank account', async () => {
    const { s, row } = await setupStaged();
    await admin.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [s.a('1010')]);
    await expect(s.run((c) => postStaged(c, s.businessId, s.userId, row.id))).rejects.toThrow(/archived/);
  });
});

describe('updateStaged', () => {
  it('moves new <-> approved <-> ignored, sets/clears the category, and cannot touch posted or pending-approve', async () => {
    const s = await bankSetup();
    const t = tx(); const p = tx({ pending: true }); await imp(s, t, p);
    const row = await stagedByExt(s, t.externalId);
    const prow = await stagedByExt(s, p.externalId);

    const a = await s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'approved', categoryAccountId: s.a('6000') }));
    expect(a).toMatchObject({ status: 'approved', categoryAccountId: s.a('6000') });
    const cleared = await s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { categoryAccountId: null }));
    expect(cleared).toMatchObject({ status: 'approved', categoryAccountId: null });
    await s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'ignored' }));
    await s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'new' }));

    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'posted' as never }))).rejects.toThrow(BankInputError);
    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { categoryAccountId: s.a('1010') }))).rejects.toThrow(BankInputError);
    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, prow.id, { status: 'approved' }))).rejects.toThrow(StagedStateError);
    // A pending row may still be ignored.
    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, prow.id, { status: 'ignored' }))).resolves.toMatchObject({ status: 'ignored' });

    await s.run((c) => postStaged(c, s.businessId, s.userId, row.id));
    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, row.id, { status: 'ignored' }))).rejects.toThrow(/already posted/);
    await expect(s.run((c) => updateStaged(c, s.businessId, s.userId, '0190a000-0000-7000-8000-0000000000ff', {}))).rejects.toThrow(NotFoundError);
  });

  it('lists with status/connection filters and paging, omits raw, and returns raw from getStaged', async () => {
    const s = await bankSetup();
    const ts = [tx({ postedDate: '2026-03-01', raw: { k: 1 } }), tx({ postedDate: '2026-03-02' }), tx({ postedDate: '2026-03-03' })];
    await imp(s, ...ts);
    const all = await s.run((c) => listStaged(c, s.businessId));
    expect(all.map((r) => r.postedDate)).toEqual(['2026-03-03', '2026-03-02', '2026-03-01']);
    expect(Object.keys(all[0]!)).not.toContain('raw');
    await s.run((c) => updateStaged(c, s.businessId, s.userId, all[0]!.id, { status: 'ignored' }));
    expect(await s.run((c) => listStaged(c, s.businessId, { status: 'ignored' }))).toHaveLength(1);
    expect(await s.run((c) => listStaged(c, s.businessId, { status: 'new', limit: 1, offset: 1 }))).toHaveLength(1);
    expect(await s.run((c) => listStaged(c, s.businessId, { connectionId: '0190a000-0000-7000-8000-0000000000ff' }))).toEqual([]);
    const withRaw = await s.run((c) => getStaged(c, s.businessId, all[2]!.id));
    expect(withRaw!.raw).toEqual({ k: 1 });
  });
});

describe('roles', () => {
  it('viewers can read staged rows but are denied by the writer gate for import, update and post', async () => {
    const s = await bankSetup();
    const viewer = await addMember(s.businessId, 'viewer');
    const bookkeeper = await addMember(s.businessId, 'bookkeeper');
    const t = tx(); await imp(s, t);
    const row = await stagedByExt(s, t.externalId);

    const seen = await withMembership(app, viewer, s.businessId, ['owner', 'admin', 'bookkeeper', 'viewer'], (c) => listStaged(c, s.businessId));
    expect(seen).toHaveLength(1);
    await expect(s.asWriter(viewer, (c) => importBatch(c, s.businessId, viewer, s.conn.id, [tx()]))).rejects.toThrow(ForbiddenError);
    await expect(s.asWriter(viewer, (c) => updateStaged(c, s.businessId, viewer, row.id, { status: 'ignored' }))).rejects.toThrow(ForbiddenError);
    await expect(s.asWriter(viewer, (c) => postStaged(c, s.businessId, viewer, row.id))).rejects.toThrow(ForbiddenError);
    expect(await stagedByExt(s, t.externalId)).toMatchObject({ status: 'new' });
    expect(await count(s)).toBe(1);

    // A bookkeeper may; the audit trail names them.
    await s.asWriter(bookkeeper, (c) => postStaged(c, s.businessId, bookkeeper, row.id));
    const a = await admin.query('SELECT actor_user_id FROM audit_log WHERE business_id=$1 AND action=$2', [s.businessId, 'staged.post']);
    expect(a.rows).toEqual([{ actor_user_id: bookkeeper }]);
    expect(BANK_WRITER_ROLES).not.toContain('viewer');
  });
});

describe('audit trail', () => {
  it('writes an entry for every import, update and post, with the actor', async () => {
    const s = await bankSetup();
    const t = tx(); const t2 = tx({ pending: true });
    await imp(s, t, t2);
    await imp(s, t, { ...t2, pending: false });
    const id = (await stagedByExt(s, t.externalId)).id;
    await s.run((c) => updateStaged(c, s.businessId, s.userId, id, { status: 'approved' }));
    await s.run((c) => postStaged(c, s.businessId, s.userId, id));

    expect((await actions(s)).filter((a) => !a.startsWith('bank_connection') && !a.startsWith('bank_link') && a !== 'business.create')).toEqual([
      'bank_import.batch', 'staged.pending_update', 'bank_import.batch', 'staged.update', 'transaction.post', 'staged.post',
    ]);
    const batch = await admin.query(
      `SELECT after, actor_user_id FROM audit_log WHERE business_id=$1 AND action='bank_import.batch' ORDER BY id`, [s.businessId]);
    expect(batch.rows[0].after).toMatchObject({ inserted: 2, duplicate: 0 });
    expect(batch.rows[1].after).toMatchObject({ inserted: 0, duplicate: 1, updated: 1 });
    expect(batch.rows.every((r) => r.actor_user_id === s.userId)).toBe(true);
    const post = await admin.query(`SELECT before, after FROM audit_log WHERE business_id=$1 AND action='staged.post'`, [s.businessId]);
    expect(post.rows[0].before).toMatchObject({ status: 'approved' });
    expect(post.rows[0].after).toMatchObject({ status: 'posted', categorySource: 'uncategorized' });
  });
});

describe('status / transaction_id CHECK consistency', () => {
  const insertRaw = (s: S, over: Record<string, unknown>) => {
    const row = {
      id: crypto.randomUUID(), external_id: `chk-${crypto.randomUUID()}`, status: 'new', pending: false,
      transaction_id: null as string | null, source: 'simplefin', connection_id: s.conn.id as string | null, ...over,
    };
    return admin.query(
      `INSERT INTO staged_transactions
         (id, business_id, connection_id, source, link_id, account_id, external_id, posted_date, amount_minor, pending, status, transaction_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-03-01',100,$8,$9,$10,$11)`,
      [row.id, s.businessId, row.connection_id, row.source, s.link.id, s.a('1010'), row.external_id, row.pending, row.status, row.transaction_id, s.userId]);
  };
  const realTxn = async (s: S) => {
    const { postTransaction } = await import('../src/ledger.js');
    return (await s.run((c) => postTransaction(c, s.businessId, s.userId, {
      kind: 'journal', date: '2026-03-01',
      lines: [{ accountId: s.a('1010'), amount: 1n }, { accountId: s.a('4300'), amount: -1n }],
    }))).transactionId;
  };

  it('requires status = posted exactly when transaction_id is set, and never allows pending + posted', async () => {
    const s = await bankSetup();
    const txnId = await realTxn(s);
    await expect(insertRaw(s, { status: 'posted', transaction_id: null })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { status: 'new', transaction_id: txnId })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { status: 'approved', transaction_id: txnId })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { status: 'posted', transaction_id: txnId, pending: true })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { source: 'simplefin', connection_id: null })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { source: 'Bad Source!' })).rejects.toThrow(/check constraint/);
    await expect(insertRaw(s, { status: 'bogus' })).rejects.toThrow(/invalid input value for enum/);
    await expect(insertRaw(s, { status: 'posted', transaction_id: txnId })).resolves.toBeDefined();
    // One staged row per ledger transaction.
    await expect(insertRaw(s, { status: 'posted', transaction_id: txnId })).rejects.toThrow(/duplicate key/);
  });

  it('keeps application transitions inside the CHECK: posting sets status and transaction_id together', async () => {
    const s = await bankSetup();
    const ts = [tx(), tx(), tx()];
    await imp(s, ...ts);
    for (const t of ts.slice(0, 2)) await s.run(async (c) => postStaged(c, s.businessId, s.userId, (await stagedByExt(s, t.externalId)).id));
    await s.run(async (c) => updateStaged(c, s.businessId, s.userId, (await stagedByExt(s, ts[2]!.externalId)).id, { status: 'ignored' }));
    const bad = await admin.query(
      `SELECT count(*)::int AS n FROM staged_transactions WHERE business_id = $1
        AND ((status = 'posted') <> (transaction_id IS NOT NULL) OR (pending AND status = 'posted'))`, [s.businessId]);
    expect(bad.rows[0].n).toBe(0);
  });

  it('freezes posted rows: even the table owner cannot edit them', async () => {
    const s = await bankSetup();
    const t = tx(); await imp(s, t);
    const id = (await stagedByExt(s, t.externalId)).id;
    await s.run((c) => postStaged(c, s.businessId, s.userId, id));
    await expect(admin.query(`UPDATE staged_transactions SET description = 'x' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(s.run((c) => c.query(`UPDATE staged_transactions SET amount_minor = 1 WHERE id = $1`, [id]))).rejects.toThrow(/immutable/);
    await expect(s.run((c) => c.query(`DELETE FROM staged_transactions WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('enforces the (connection, external id) idempotency key, including connection-less sources', async () => {
    const s = await bankSetup();
    await insertRaw(s, { external_id: 'dup' });
    await expect(insertRaw(s, { external_id: 'dup' })).rejects.toThrow(/duplicate key/);
    await insertRaw(s, { source: 'statement', connection_id: null, external_id: 'dup' });
    await expect(insertRaw(s, { source: 'statement', connection_id: null, external_id: 'dup' })).rejects.toThrow(/duplicate key/);
  });
});
