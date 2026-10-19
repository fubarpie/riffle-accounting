import { afterAll, describe, expect, it } from 'vitest';
import { postTransaction } from '../src/ledger.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

// All data here is synthetic.
type Biz = Awaited<ReturnType<typeof makeBusiness>>;

async function batch(b: Biz, sha = uuidv7().replace(/-/g, '').padEnd(64, '0')): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO import_batches (id, business_id, source, file_sha256, created_by)
     VALUES ($1,$2,'wave_journal',$3,$4)`, [id, b.businessId, sha, b.userId]);
  return id;
}

async function account(b: Biz, batchId: string, key: string): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO import_accounts (id, business_id, batch_id, source_name, match_key)
     VALUES ($1,$2,$3,$4,$4)`, [id, b.businessId, batchId, key]);
  return id;
}

/** Writes an entry and its lines in ONE transaction, so the deferred balance check runs at COMMIT. */
async function entry(
  b: Biz, batchId: string, acct: string, ext: string, status: 'valid' | 'invalid', amounts: bigint[],
): Promise<string> {
  const id = uuidv7();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO import_entries (id, business_id, batch_id, external_id, entry_date, status)
       VALUES ($1,$2,$3,$4,'2026-01-05',$5)`, [id, b.businessId, batchId, ext, status]);
    for (const [i, amt] of amounts.entries()) {
      await c.query(
        `INSERT INTO import_entry_lines (id, business_id, batch_id, entry_id, line_no, import_account_id, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [uuidv7(), b.businessId, batchId, id, i + 1, acct, amt.toString()]);
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

describe('import staging: entry balance', () => {
  it('commits a valid entry whose lines sum to zero (including 19-digit ids kept as text)', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const a = await account(b, bt, 'acct one');
    const big = '1234567890123456789';
    const id = await entry(b, bt, a, big, 'valid', [250n, -250n]);
    const { rows } = await admin.query('SELECT external_id FROM import_entries WHERE id = $1', [id]);
    expect(rows[0].external_id).toBe(big);
  });

  it('rejects, at commit, a valid entry that does not balance or has one line', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const a = await account(b, bt, 'acct one');
    await expect(entry(b, bt, a, 'X1', 'valid', [250n, -249n])).rejects.toThrow(/balance to zero/);
    await expect(entry(b, bt, a, 'X2', 'valid', [250n])).rejects.toThrow(/balance to zero/);
  });

  it('allows an unbalanced entry only when it is marked invalid', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const a = await account(b, bt, 'acct one');
    await expect(entry(b, bt, a, 'X3', 'invalid', [250n, -249n])).resolves.toBeTruthy();
  });

  it('refuses a zero-amount line and a duplicate external id in one batch', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const a = await account(b, bt, 'acct one');
    await expect(entry(b, bt, a, 'Z1', 'invalid', [0n, 1n])).rejects.toThrow();
    await entry(b, bt, a, 'D1', 'valid', [5n, -5n]);
    await expect(entry(b, bt, a, 'D1', 'valid', [5n, -5n])).rejects.toThrow();
  });
});

describe('import staging: batch lifecycle', () => {
  it('refuses the same file twice, but allows it again after the first batch is rejected', async () => {
    const b = await makeBusiness();
    const sha = 'a'.repeat(64);
    const first = await batch(b, sha);
    await expect(batch(b, sha)).rejects.toThrow();
    await admin.query(
      `UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now() WHERE id=$1`,
      [first, b.userId]);
    await expect(batch(b, sha)).resolves.toBeTruthy();
  });

  it('freezes a batch and all of its rows once it is approved or rejected', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const a = await account(b, bt, 'acct one');
    const e = await entry(b, bt, a, 'F1', 'valid', [7n, -7n]);
    await admin.query(
      `UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now() WHERE id=$1`,
      [bt, b.userId]);
    await expect(admin.query('UPDATE import_entries SET excluded = true WHERE id = $1', [e])).rejects.toThrow(/cannot change/);
    await expect(admin.query('DELETE FROM import_accounts WHERE id = $1', [a])).rejects.toThrow(/cannot change/);
    await expect(admin.query(`UPDATE import_batches SET summary = '{"x":1}' WHERE id = $1`, [bt])).rejects.toThrow(/immutable/);
    await expect(admin.query('DELETE FROM import_batches WHERE id = $1', [bt])).rejects.toThrow(/cannot be deleted/);
  });

  it('cannot start non-staged, and cannot change provenance', async () => {
    const b = await makeBusiness();
    await expect(admin.query(
      `INSERT INTO import_batches (id, business_id, source, file_sha256, created_by, status, approved_by, approved_at)
       VALUES ($1,$2,'wave_journal',$3,$4,'approved',$4,now())`,
      [uuidv7(), b.businessId, 'b'.repeat(64), b.userId])).rejects.toThrow(/start staged/);
    const bt = await batch(b);
    await expect(admin.query(`UPDATE import_batches SET source = 'other' WHERE id = $1`, [bt])).rejects.toThrow(/provenance/);
  });
});

describe('import staging: account rows', () => {
  it('keeps at most 4 characters of an account number', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    await expect(admin.query(
      `INSERT INTO import_accounts (id, business_id, batch_id, source_name, match_key, account_ref_last4)
       VALUES ($1,$2,$3,'n','n','12345')`, [uuidv7(), b.businessId, bt])).rejects.toThrow();
  });

  it('allows mapping to an existing account OR creating one, never both', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const ok = (extra: string, params: unknown[]) => admin.query(
      `INSERT INTO import_accounts (id, business_id, batch_id, source_name, match_key ${extra.split('|')[0]})
       VALUES ($1,$2,$3,$4,$4 ${extra.split('|')[1]})`, [uuidv7(), b.businessId, bt, ...params]);
    const existing = b.accounts.get('1010')!;
    await expect(ok(',target_account_id|,$5', ['m1', existing])).resolves.toBeTruthy();
    await expect(ok(',create_name,create_type|,$5,$6', ['m2', 'New', 'expense'])).resolves.toBeTruthy();
    await expect(ok(',target_account_id,create_name,create_type|,$5,$6,$7', ['m3', existing, 'New', 'expense'])).rejects.toThrow();
    await expect(ok(',create_name|,$5', ['m4', 'New'])).rejects.toThrow();
  });
});

describe('import staging: imported_refs and tenancy', () => {
  it('records posted source ids once and never lets them change', async () => {
    const b = await makeBusiness();
    const bt = await batch(b);
    const { transactionId } = await withTenant(app, { userId: b.userId, businessId: b.businessId }, (c) =>
      postTransaction(c, b.businessId, b.userId, {
        kind: 'journal', date: '2026-01-05',
        lines: [{ accountId: b.accounts.get('1010')!, amount: 100n }, { accountId: b.accounts.get('4000')!, amount: -100n }],
      }));
    const ins = () => admin.query(
      `INSERT INTO imported_refs (business_id, source, external_id, transaction_id, batch_id)
       VALUES ($1,'wave_journal','R1',$2,$3)`, [b.businessId, transactionId, bt]);
    await ins();
    await expect(ins()).rejects.toThrow();
    await expect(admin.query(`UPDATE imported_refs SET external_id = 'R2' WHERE external_id = 'R1'`)).rejects.toThrow(/immutable/);
    await expect(admin.query(`DELETE FROM imported_refs WHERE external_id = 'R1'`)).rejects.toThrow(/immutable/);
  });

  it('hides one business’s staging rows from another', async () => {
    const A = await makeBusiness();
    const B = await makeBusiness();
    const bt = await batch(A);
    const seenByB = await withTenant(app, { userId: B.userId, businessId: B.businessId }, (c) =>
      c.query('SELECT id FROM import_batches WHERE id = $1', [bt]));
    expect(seenByB.rowCount).toBe(0);
  });
});
