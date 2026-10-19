// SPDX-License-Identifier: AGPL-3.0-or-later
// All data in this file is synthetic. Do not paste real exports here.
import { afterAll, describe, expect, it } from 'vitest';
import {
  ImportApprovalBlockedError, ImportInputError, ImportStateError, approveBatch, expectedAccountType, getBatch,
  setAccountMapping, setEntryExcluded, stageBatch, type StageInput,
} from '../src/imports/index.js';
import { liveBalances } from '../src/ledger.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

type Biz = Awaited<ReturnType<typeof makeBusiness>>;
const sha = () => uuidv7().replace(/-/g, '').padEnd(64, '0');
const tenant = <T>(b: Biz, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { userId: b.userId, businessId: b.businessId }, fn);

interface EntrySpec { id: string; date: string; amount: bigint; status?: 'valid' | 'invalid' }

/**
 * Two accounts: "Test Bank" (class Asset) and "Test Sales" (class Income).
 * Each entry debits the bank and credits sales by `amount`.
 */
function input(entries: EntrySpec[], over: Partial<StageInput> = {}): StageInput {
  return {
    source: 'wave_journal', fileSha256: sha(), summary: {},
    accounts: [
      { key: 'test bank', name: 'Test Bank', group: 'Asset', type: 'Cash and Bank', accountRef: null },
      { key: 'test sales', name: 'Test Sales', group: 'Income', type: 'Income', accountRef: null },
    ],
    entries: entries.map((e) => ({
      externalId: e.id, date: e.date, description: `synthetic ${e.id}`,
      status: e.status ?? 'valid', issues: [],
      lines: [
        { accountKey: 'test bank', amountMinor: e.amount, memo: '' },
        { accountKey: 'test sales', amountMinor: -e.amount, memo: '' },
      ],
    })),
    ...over,
  };
}

async function stage(b: Biz, entries: EntrySpec[], over: Partial<StageInput> = {}): Promise<{ id: string; accts: Map<string, string> }> {
  const { batch } = await tenant(b, (c) => stageBatch(c, b.businessId, b.userId, input(entries, over)));
  const { accounts } = await tenant(b, (c) => getBatch(c, b.businessId, batch.id));
  return { id: batch.id, accts: new Map(accounts.map((a) => [a.sourceName, a.id])) };
}

/** Bank -> existing Checking (asset); Sales -> a new income account. */
async function mapAll(b: Biz, bt: { id: string; accts: Map<string, string> }): Promise<void> {
  await tenant(b, async (c) => {
    await setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Bank')!,
      { kind: 'target', accountId: b.accounts.get('1010')! });
    await setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Sales')!,
      { kind: 'create', name: 'Imported Sales', type: 'income' });
  });
}

const txCount = async (b: Biz): Promise<number> =>
  Number((await admin.query('SELECT count(*) FROM transactions WHERE business_id = $1', [b.businessId])).rows[0].count);

async function blockers(b: Biz, id: string) {
  try {
    await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, id));
  } catch (e) {
    if (e instanceof ImportApprovalBlockedError) return e.blockers;
    throw e;
  }
  throw new Error('expected approval to be blocked');
}

describe('expectedAccountType', () => {
  it('maps the source class, case-insensitively, and returns null for anything else', () => {
    expect(expectedAccountType('Asset')).toBe('asset');
    expect(expectedAccountType(' LIABILITY ')).toBe('liability');
    expect(expectedAccountType('Income')).toBe('income');
    expect(expectedAccountType('')).toBeNull();
    expect(expectedAccountType('Something else')).toBeNull();
  });
});

describe('import approval: success path', () => {
  it('posts every valid entry, creates the account, records refs, and freezes the batch', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [
      { id: 'E1', date: '2026-02-01', amount: 10_000n },
      { id: 'E2', date: '2026-02-02', amount: 2_550n },
    ]);
    await mapAll(b, bt);

    const res = await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id));
    expect(res).toMatchObject({ posted: 2, accountsCreated: 1, alreadyImported: 0 });
    expect(res.batch.status).toBe('approved');
    expect(await txCount(b)).toBe(2);

    const refs = await admin.query('SELECT external_id FROM imported_refs WHERE business_id = $1 ORDER BY external_id', [b.businessId]);
    expect(refs.rows.map((r) => r.external_id)).toEqual(['E1', 'E2']);

    const created = await admin.query(`SELECT id, type, currency FROM accounts WHERE business_id = $1 AND name = 'Imported Sales'`, [b.businessId]);
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0].type).toBe('income');

    const bal = await tenant(b, (c) => liveBalances(c, b.businessId));
    expect(bal.get(b.accounts.get('1010')!)).toBe(12_550n);
    expect(bal.get(created.rows[0].id)).toBe(-12_550n);
    // Whole ledger still balances.
    expect([...bal.values()].reduce((s, v) => s + v, 0n)).toBe(0n);

    // Entries point at their transactions; the approved batch can no longer change.
    const linked = await admin.query(
      'SELECT count(*) FROM import_entries WHERE business_id = $1 AND transaction_id IS NOT NULL', [b.businessId]);
    expect(Number(linked.rows[0].count)).toBe(2);
    const anyEntry = (await admin.query('SELECT id FROM import_entries WHERE batch_id = $1 LIMIT 1', [bt.id])).rows[0].id;
    await expect(tenant(b, (c) => setEntryExcluded(c, b.businessId, b.userId, bt.id, anyEntry, true)))
      .rejects.toBeInstanceOf(ImportStateError);
  });

  it('writes audit rows for the created account and for the approval', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'A1', date: '2026-02-01', amount: 100n }]);
    await mapAll(b, bt);
    await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id));
    const { rows } = await admin.query(
      `SELECT action FROM audit_log WHERE business_id = $1 AND action IN ('account.create','import.approve','transaction.post')`,
      [b.businessId]);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('account.create');
    expect(actions).toContain('import.approve');
    expect(actions.filter((a) => a === 'transaction.post')).toHaveLength(1);
  });

  it('leaves excluded entries out, and an excluded invalid entry does not block', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [
      { id: 'K1', date: '2026-02-01', amount: 500n },
      { id: 'K2', date: '2026-02-02', amount: 700n },
      { id: 'K3', date: '2026-02-03', amount: 900n, status: 'invalid' },
    ]);
    await mapAll(b, bt);
    const entries = await admin.query(
      'SELECT id, external_id FROM import_entries WHERE business_id = $1 AND batch_id = $2', [b.businessId, bt.id]);
    const idOf = (ext: string) => entries.rows.find((r) => r.external_id === ext).id as string;

    expect((await blockers(b, bt.id)).invalidEntries).toBe(1);
    await tenant(b, (c) => setEntryExcluded(c, b.businessId, b.userId, bt.id, idOf('K3'), true));
    await tenant(b, (c) => setEntryExcluded(c, b.businessId, b.userId, bt.id, idOf('K2'), true));

    const res = await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id));
    expect(res.posted).toBe(1);
    const refs = await admin.query('SELECT external_id FROM imported_refs WHERE business_id = $1', [b.businessId]);
    expect(refs.rows.map((r) => r.external_id)).toEqual(['K1']);
  });
});

describe('import approval: blockers (nothing is written)', () => {
  const untouched = async (b: Biz, id: string) => {
    expect(await txCount(b)).toBe(0);
    expect(Number((await admin.query('SELECT count(*) FROM imported_refs WHERE business_id = $1', [b.businessId])).rows[0].count)).toBe(0);
    expect((await admin.query('SELECT status FROM import_batches WHERE id = $1', [id])).rows[0].status).toBe('staged');
    expect(Number((await admin.query(`SELECT count(*) FROM accounts WHERE business_id = $1 AND name = 'Imported Sales'`, [b.businessId])).rows[0].count)).toBe(0);
  };

  it('reports unmapped accounts', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'U1', date: '2026-02-01', amount: 100n }]);
    const r = await blockers(b, bt.id);
    expect(r.unmappedAccounts.map((a) => a.sourceName).sort()).toEqual(['Test Bank', 'Test Sales']);
    await untouched(b, bt.id);
  });

  it('refuses an account class mismatch at mapping time (422) and at approval time', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'M1', date: '2026-02-01', amount: 100n }]);
    // At mapping time: "Test Sales" is Income; mapping it to the Checking asset is refused.
    await expect(tenant(b, (c) => setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Sales')!,
      { kind: 'target', accountId: b.accounts.get('1010')! }))).rejects.toBeInstanceOf(ImportInputError);
    await expect(tenant(b, (c) => setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Sales')!,
      { kind: 'create', name: 'Wrong', type: 'expense' }))).rejects.toThrow(/must map to a income account/);

    // At approval time: simulate a mapping that predates the check by writing it directly.
    await admin.query(
      'UPDATE import_accounts SET target_account_id = $2 WHERE id = $1', [bt.accts.get('Test Sales'), b.accounts.get('1010')]);
    await admin.query(
      'UPDATE import_accounts SET target_account_id = $2 WHERE id = $1', [bt.accts.get('Test Bank'), b.accounts.get('1010')]);
    const r = await blockers(b, bt.id);
    expect(r.classMismatches).toEqual([expect.objectContaining({
      sourceName: 'Test Sales', sourceGroup: 'Income', expected: 'income', actual: 'asset',
    })]);
    await untouched(b, bt.id);
  });

  it('does not judge an account whose source class is unrecognised', async () => {
    const b = await makeBusiness();
    const over = input([{ id: 'G1', date: '2026-02-01', amount: 100n }]);
    over.accounts[1]!.group = 'Mystery';
    const { batch } = await tenant(b, (c) => stageBatch(c, b.businessId, b.userId, over));
    const { accounts } = await tenant(b, (c) => getBatch(c, b.businessId, batch.id));
    const id = (n: string) => accounts.find((a) => a.sourceName === n)!.id;
    await tenant(b, async (c) => {
      await setAccountMapping(c, b.businessId, b.userId, batch.id, id('Test Bank'), { kind: 'target', accountId: b.accounts.get('1010')! });
      await setAccountMapping(c, b.businessId, b.userId, batch.id, id('Test Sales'), { kind: 'create', name: 'Anything', type: 'expense' });
    });
    await expect(tenant(b, (c) => approveBatch(c, b.businessId, b.userId, batch.id))).resolves.toMatchObject({ posted: 1 });
  });

  it('blocks the whole batch when any entry is on or before the lock date, and names the earliest', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [
      { id: 'L1', date: '2026-01-31', amount: 100n }, // equal to the lock date: locked
      { id: 'L2', date: '2026-01-15', amount: 100n },
      { id: 'L3', date: '2026-02-10', amount: 100n }, // fine
    ]);
    await mapAll(b, bt);
    await admin.query(`UPDATE businesses SET books_locked_through = '2026-01-31' WHERE id = $1`, [b.businessId]);
    const r = await blockers(b, bt.id);
    expect(r.lockedEntries).toEqual({ count: 2, lockedThrough: '2026-01-31', earliest: '2026-01-15' });
    await untouched(b, bt.id);

    // Excluding the locked entries (the reviewer's choice) unblocks the rest.
    const ids = await admin.query(
      `SELECT id FROM import_entries WHERE business_id = $1 AND batch_id = $2 AND external_id IN ('L1','L2')`, [b.businessId, bt.id]);
    for (const row of ids.rows) await tenant(b, (c) => setEntryExcluded(c, b.businessId, b.userId, bt.id, row.id, true));
    await expect(tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id))).resolves.toMatchObject({ posted: 1 });
  });

  it('blocks on an archived target account', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'R1', date: '2026-02-01', amount: 100n }]);
    await mapAll(b, bt);
    await admin.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [b.accounts.get('1010')]);
    const r = await blockers(b, bt.id);
    expect(r.archivedTargets.map((a) => a.sourceName)).toEqual(['Test Bank']);
    await untouched(b, bt.id);
  });

  it('blocks a batch with nothing to post', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'N1', date: '2026-02-01', amount: 100n }]);
    await mapAll(b, bt);
    const eid = (await admin.query('SELECT id FROM import_entries WHERE batch_id = $1', [bt.id])).rows[0].id;
    await tenant(b, (c) => setEntryExcluded(c, b.businessId, b.userId, bt.id, eid, true));
    expect((await blockers(b, bt.id)).nothingToPost).toBe(true);
  });
});

describe('import approval: idempotency and concurrency', () => {
  it('pre-excludes at staging what an earlier import posted, so a file of only repeats has nothing to post', async () => {
    const b = await makeBusiness();
    const first = await stage(b, [{ id: 'P1', date: '2026-02-01', amount: 100n }]);
    await mapAll(b, first);
    await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, first.id));

    const again = await stage(b, [{ id: 'P1', date: '2026-02-01', amount: 100n }]);
    const created = (await admin.query(`SELECT id FROM accounts WHERE business_id = $1 AND name = 'Imported Sales'`, [b.businessId])).rows[0].id;
    await tenant(b, async (c) => {
      await setAccountMapping(c, b.businessId, b.userId, again.id, again.accts.get('Test Bank')!, { kind: 'target', accountId: b.accounts.get('1010')! });
      await setAccountMapping(c, b.businessId, b.userId, again.id, again.accts.get('Test Sales')!, { kind: 'target', accountId: created });
    });
    expect((await blockers(b, again.id)).nothingToPost).toBe(true);
    expect(await txCount(b)).toBe(1);
  });

  it('backstop: skips an entry another batch posted after this one was staged, and posts the rest', async () => {
    const b = await makeBusiness();
    const income = b.accounts.get('4000');
    expect(income).toBeTruthy();
    // Two overlapping files staged BEFORE either is approved, so staging cannot pre-exclude the repeat.
    const one = await stage(b, [
      { id: 'Q1', date: '2026-02-01', amount: 100n },
      { id: 'Q2', date: '2026-02-02', amount: 200n },
    ]);
    const two = await stage(b, [
      { id: 'Q2', date: '2026-02-02', amount: 200n },
      { id: 'Q3', date: '2026-02-03', amount: 300n },
    ]);
    for (const bt of [one, two]) {
      await tenant(b, async (c) => {
        await setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Bank')!, { kind: 'target', accountId: b.accounts.get('1010')! });
        await setAccountMapping(c, b.businessId, b.userId, bt.id, bt.accts.get('Test Sales')!, { kind: 'target', accountId: income! });
      });
    }
    await expect(tenant(b, (c) => approveBatch(c, b.businessId, b.userId, one.id))).resolves.toMatchObject({ posted: 2 });
    const res = await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, two.id));
    expect(res).toMatchObject({ posted: 1, alreadyImported: 1, accountsCreated: 0 });
    expect(await txCount(b)).toBe(3);
    const refs = await admin.query('SELECT external_id FROM imported_refs WHERE business_id = $1 ORDER BY external_id', [b.businessId]);
    expect(refs.rows.map((r) => r.external_id)).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it('refuses to approve twice', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [{ id: 'T1', date: '2026-02-01', amount: 100n }]);
    await mapAll(b, bt);
    await tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id));
    await expect(tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id))).rejects.toBeInstanceOf(ImportStateError);
    expect(await txCount(b)).toBe(1);
  });

  it('lets exactly one of two simultaneous approvals win, with no duplicate postings', async () => {
    const b = await makeBusiness();
    const bt = await stage(b, [
      { id: 'C1', date: '2026-02-01', amount: 100n },
      { id: 'C2', date: '2026-02-02', amount: 200n },
    ]);
    await mapAll(b, bt);
    const results = await Promise.allSettled([
      tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id)),
      tenant(b, (c) => approveBatch(c, b.businessId, b.userId, bt.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ImportStateError);
    expect(await txCount(b)).toBe(2);
  });

  it('does not let another business approve or see a batch', async () => {
    const a = await makeBusiness();
    const other = await makeBusiness();
    const bt = await stage(a, [{ id: 'X1', date: '2026-02-01', amount: 100n }]);
    await mapAll(a, bt);
    await expect(tenant(other, (c) => approveBatch(c, other.businessId, other.userId, bt.id))).rejects.toThrow(/not found/i);
    expect(await txCount(a)).toBe(0);
  });
});
