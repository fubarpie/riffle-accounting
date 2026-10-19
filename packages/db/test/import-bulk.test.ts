import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  autoMapImportAccounts, getBatch, searchImportEntries, setImportAccountsMapping, setImportEntriesExcluded,
} from '../src/imports/index.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

// All data here is synthetic.
type Biz = Awaited<ReturnType<typeof makeBusiness>>;
const tenant = <T>(b: Biz, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  withTenant(app, { userId: b.userId, businessId: b.businessId }, fn);

async function batch(b: Biz): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO import_batches (id, business_id, source, file_sha256, created_by)
     VALUES ($1,$2,'wave_journal',$3,$4)`, [id, b.businessId, uuidv7().replace(/-/g, '').padEnd(64, '0'), b.userId]);
  return id;
}

async function acct(b: Biz, batchId: string, name: string, group: string): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO import_accounts (id, business_id, batch_id, source_name, match_key, source_group)
     VALUES ($1,$2,$3,$4,$4,$5)`, [id, b.businessId, batchId, name, group]);
  return id;
}

/** One entry and its lines in ONE transaction, so the deferred balance check runs at COMMIT. */
async function entry(
  b: Biz, batchId: string, a: string, ext: string, description: string, status: 'valid' | 'invalid' | 'skipped', amounts: bigint[],
): Promise<string> {
  const id = uuidv7();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO import_entries (id, business_id, batch_id, external_id, entry_date, description, status)
       VALUES ($1,$2,$3,$4,'2026-01-05',$5,$6)`, [id, b.businessId, batchId, ext, description, status]);
    for (const [i, amt] of amounts.entries()) {
      await c.query(
        `INSERT INTO import_entry_lines (id, business_id, batch_id, entry_id, line_no, import_account_id, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [uuidv7(), b.businessId, batchId, id, i + 1, a, amt.toString()]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return id;
}

const info = async (id: string): Promise<{ name: string; type: string }> =>
  (await admin.query('SELECT name, type FROM accounts WHERE id = $1', [id])).rows[0];

describe('import bulk: auto-map accounts', () => {
  it('matches existing accounts, queues new ones, and reports what it will not guess', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const cashId = b.accounts.get('1010')!;
    const cash = await info(cashId);
    const income = await info(b.accounts.get('4000')!);
    const matched = await acct(b, bt, cash.name, cash.type);
    const fresh = await acct(b, bt, 'Brand New Thing', 'expense');
    const twin = await acct(b, bt, 'BRAND NEW THING', 'expense');
    const weird = await acct(b, bt, 'Weird', 'Other');
    const clash = await acct(b, bt, income.name, income.type === 'expense' ? 'asset' : 'expense');

    const r = await tenant(b, (c) => autoMapImportAccounts(c, b.businessId, b.userId, bt));
    expect(r.mappedExisting).toBe(1);
    expect(r.queuedCreate).toBe(1);
    expect(r.unresolved.map((u) => u.reason).sort()).toEqual(['duplicate_in_file', 'name_conflict', 'unknown_class']);

    const rows = (await admin.query(
      'SELECT id, target_account_id, create_name, create_type FROM import_accounts WHERE batch_id = $1', [bt])).rows;
    const by = new Map(rows.map((x) => [x.id as string, x]));
    expect(by.get(matched).target_account_id).toBe(cashId);
    const queuedRows = [by.get(fresh), by.get(twin)].filter((x) => x.create_name !== null);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0].create_type).toBe('expense');
    expect(by.get(weird).target_account_id).toBeNull();
    expect(by.get(weird).create_name).toBeNull();
    expect(by.get(clash).target_account_id).toBeNull();
    expect(by.get(clash).create_name).toBeNull();

    // Running it again changes nothing and does not queue the twin.
    const again = await tenant(b, (c) => autoMapImportAccounts(c, b.businessId, b.userId, bt));
    expect(again.mappedExisting).toBe(0);
    expect(again.queuedCreate).toBe(0);
    expect(again.unresolved).toHaveLength(3);
  });

  it('never changes a decision the reviewer already made', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const decided = await acct(b, bt, 'Brand New Thing', 'expense');
    await admin.query(
      `UPDATE import_accounts SET create_name = 'My own name', create_type = 'expense' WHERE id = $1`, [decided]);
    const r = await tenant(b, (c) => autoMapImportAccounts(c, b.businessId, b.userId, bt));
    expect(r.mappedExisting + r.queuedCreate).toBe(0);
    const row = (await admin.query('SELECT create_name FROM import_accounts WHERE id = $1', [decided])).rows[0];
    expect(row.create_name).toBe('My own name');
  });

  it('refuses once the batch is no longer staged', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    await admin.query(
      `UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now() WHERE id=$1`, [bt, b.userId]);
    await expect(tenant(b, (c) => autoMapImportAccounts(c, b.businessId, b.userId, bt))).rejects.toThrow(/can no longer be changed/);
  });
});

describe('import bulk: exclude and search', () => {
  it('excludes by filter and by id, leaves skipped entries alone, and searches descriptions and account names', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const bank = await acct(b, bt, 'Zebra Bank', 'asset');
    const e1 = await entry(b, bt, bank, 'E1', 'Stripe payout', 'valid', [100n, -100n]);
    const e2 = await entry(b, bt, bank, 'E2', 'Stripe fee', 'valid', [5n, -5n]);
    const other = await acct(b, bt, 'Rent Expense', 'expense');
    const e3 = await entry(b, bt, other, 'E3', 'Monthly rent', 'valid', [50n, -50n]);
    await entry(b, bt, other, 'E4', 'Odd row', 'skipped', []);

    const byText = await tenant(b, (c) => searchImportEntries(c, b.businessId, bt, { search: 'stripe' }));
    expect(byText.total).toBe(2);
    const byAccount = await tenant(b, (c) => searchImportEntries(c, b.businessId, bt, { search: 'rent expense' }));
    expect(byAccount.entries.map((e) => e.id)).toEqual([e3]);
    const wildcard = await tenant(b, (c) => searchImportEntries(c, b.businessId, bt, { search: '%' }));
    expect(wildcard.total).toBe(0);

    const ex = await tenant(b, (c) =>
      setImportEntriesExcluded(c, b.businessId, b.userId, bt, { filter: { search: 'stripe' } }, true));
    expect(ex.changed).toBe(2);
    expect(ex.counts.excluded).toBe(2);

    const back = await tenant(b, (c) =>
      setImportEntriesExcluded(c, b.businessId, b.userId, bt, { ids: [e1, e2] }, false));
    expect(back.changed).toBe(2);
    const noop = await tenant(b, (c) =>
      setImportEntriesExcluded(c, b.businessId, b.userId, bt, { ids: [e1, e2] }, false));
    expect(noop.changed).toBe(0);

    const everything = await tenant(b, (c) => setImportEntriesExcluded(c, b.businessId, b.userId, bt, { filter: {} }, true));
    expect(everything.changed).toBe(3);
    const skipped = await admin.query(`SELECT excluded FROM import_entries WHERE batch_id = $1 AND status = 'skipped'`, [bt]);
    expect(skipped.rows[0].excluded).toBe(false);
  });

  it('rejects an empty id list and a batch that is no longer staged', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    await expect(tenant(b, (c) => setImportEntriesExcluded(c, b.businessId, b.userId, bt, { ids: [] }, true))).rejects.toThrow(/choose between/);
    await admin.query(
      `UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now() WHERE id=$1`, [bt, b.userId]);
    await expect(tenant(b, (c) => setImportEntriesExcluded(c, b.businessId, b.userId, bt, { filter: {} }, true)))
      .rejects.toThrow(/can no longer be changed/);
  });
});

describe('import bulk: map several accounts', () => {
  it('maps and clears together, and rolls everything back if one is refused', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const cashId = b.accounts.get('1010')!;
    const cash = await info(cashId);
    const a1 = await acct(b, bt, 'M1', cash.type);
    const a2 = await acct(b, bt, 'M2', cash.type);
    const wrong = await acct(b, bt, 'M3', cash.type === 'expense' ? 'asset' : 'expense');

    const ok = await tenant(b, (c) =>
      setImportAccountsMapping(c, b.businessId, b.userId, bt, [a1, a2], { kind: 'target', accountId: cashId }));
    expect(ok.updated).toBe(2);
    const cleared = await tenant(b, (c) => setImportAccountsMapping(c, b.businessId, b.userId, bt, [a1, a2], { kind: 'clear' }));
    expect(cleared.updated).toBe(2);

    await expect(tenant(b, (c) =>
      setImportAccountsMapping(c, b.businessId, b.userId, bt, [a1, wrong], { kind: 'target', accountId: cashId })))
      .rejects.toThrow(/must map to/);
    const row = (await admin.query('SELECT target_account_id FROM import_accounts WHERE id = $1', [a1])).rows[0];
    expect(row.target_account_id).toBeNull();
    const detail = await tenant(b, (c) => getBatch(c, b.businessId, bt));
    expect(detail.accounts.filter((a) => a.targetAccountId !== null)).toHaveLength(0);
  });
});
