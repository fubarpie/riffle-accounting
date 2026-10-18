import { afterAll, describe, expect, it } from 'vitest';
import {
  allBalances, editTransaction, liveBalances, postTransaction, voidTransaction,
} from '../src/ledger.js';
import { withTenant } from '../src/tenant.js';
import { uuidv7 } from '../src/uuid.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

const base = async () => {
  const b = await makeBusiness();
  const ctx = { userId: b.userId, businessId: b.businessId };
  const a = (code: string) => b.accounts.get(code)!;
  return { ...b, ctx, a };
};

describe('double-entry invariants (enforced by the database)', () => {
  it('posts a balanced transaction and derives balances from lines', async () => {
    const { ctx, businessId, userId, a } = await base();
    await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-01-05', description: 'Sale',
      lines: [{ accountId: a('1010'), amount: 12_500n }, { accountId: a('4000'), amount: -12_500n }],
    }));
    const bal = await withTenant(app, ctx, (c) => liveBalances(c, businessId));
    expect(bal.get(a('1010'))).toBe(12_500n);
    expect(bal.get(a('4000'))).toBe(-12_500n);
  });

  it('rejects an unbalanced entry at commit even if app checks are bypassed', async () => {
    const { ctx, businessId, userId, a } = await base();
    await expect(withTenant(app, ctx, async (c) => {
      const t = uuidv7(); const e = uuidv7();
      await c.query(`INSERT INTO transactions (id,business_id,kind,date,created_by) VALUES ($1,$2,'journal','2026-01-01',$3)`, [t, businessId, userId]);
      await c.query(`INSERT INTO journal_entries (id,business_id,transaction_id,entry_date,created_by) VALUES ($1,$2,$3,'2026-01-01',$4)`, [e, businessId, t, userId]);
      await c.query(`INSERT INTO journal_lines (id,business_id,entry_id,account_id,amount_minor) VALUES ($1,$2,$3,$4,100),($5,$2,$3,$6,-99)`, [uuidv7(), businessId, e, a('1010'), uuidv7(), a('4000')]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('rejects an entry with fewer than two lines or no lines', async () => {
    const { ctx, businessId, userId } = await base();
    await expect(withTenant(app, ctx, async (c) => {
      const t = uuidv7();
      await c.query(`INSERT INTO transactions (id,business_id,kind,date,created_by) VALUES ($1,$2,'journal','2026-01-01',$3)`, [t, businessId, userId]);
      await c.query(`INSERT INTO journal_entries (id,business_id,transaction_id,entry_date,created_by) VALUES ($1,$2,$3,'2026-01-01',$4)`, [uuidv7(), businessId, t, userId]);
    })).rejects.toThrow(/at least two lines/);
  });

  it('rejects zero-amount lines', async () => {
    const { ctx, businessId, userId, a } = await base();
    await expect(withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'journal', date: '2026-01-01',
      lines: [{ accountId: a('1010'), amount: 0n }, { accountId: a('4000'), amount: 0n }],
    }))).rejects.toThrow(/non-zero/);
  });

  it('makes posted entries, lines and audit rows immutable', async () => {
    const { ctx, businessId, userId, a } = await base();
    await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-01-05',
      lines: [{ accountId: a('1010'), amount: 100n }, { accountId: a('4000'), amount: -100n }],
    }));
    for (const sql of [
      'UPDATE journal_lines SET amount_minor = 1',
      'DELETE FROM journal_lines',
      'UPDATE journal_entries SET entry_date = now()::date',
      'DELETE FROM journal_entries',
      `UPDATE audit_log SET action = 'x'`,
      'DELETE FROM audit_log',
    ]) {
      await expect(withTenant(app, ctx, (c) => c.query(sql)), sql).rejects.toThrow(/immutable|permission denied/);
    }
    // The triggers (not just missing grants) must block even the table owner.
    for (const sql of [
      'UPDATE journal_lines SET amount_minor = amount_minor',
      'DELETE FROM journal_lines',
      'UPDATE journal_entries SET entry_date = entry_date',
      'DELETE FROM journal_entries',
      'UPDATE audit_log SET action = action',
      'DELETE FROM audit_log',
      'TRUNCATE journal_lines',
      'TRUNCATE journal_entries',
      'TRUNCATE audit_log',
    ]) {
      await expect(admin.query(sql), `owner: ${sql}`).rejects.toThrow(/immutable|cannot truncate/);
    }
  });

  it('edits by reversal: history is kept, balances follow the new lines', async () => {
    const { ctx, businessId, userId, a } = await base();
    const { transactionId } = await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'withdrawal', date: '2026-02-01',
      lines: [{ accountId: a('6100'), amount: 50_000n }, { accountId: a('1010'), amount: -50_000n }],
    }));
    await withTenant(app, ctx, (c) => editTransaction(c, businessId, userId, transactionId, {
      lines: [{ accountId: a('6150'), amount: 42_000n }, { accountId: a('1010'), amount: -42_000n }],
    }));
    const live = await withTenant(app, ctx, (c) => liveBalances(c, businessId));
    expect(live.get(a('6100')) ?? 0n).toBe(0n);
    expect(live.get(a('6150'))).toBe(42_000n);
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM journal_entries WHERE transaction_id = $1', [transactionId]);
    expect(rows[0].n).toBe(3); // original, reversal, replacement
    const all = await withTenant(app, ctx, (c) => allBalances(c, businessId));
    expect(all.get(a('6100')) ?? 0n).toBe(0n); // reversal cancels the original
  });

  it('voids by reversal and removes the transaction from live balances', async () => {
    const { ctx, businessId, userId, a } = await base();
    const { transactionId } = await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-03-01',
      lines: [{ accountId: a('1010'), amount: 900n }, { accountId: a('4100'), amount: -900n }],
    }));
    await withTenant(app, ctx, (c) => voidTransaction(c, businessId, userId, transactionId));
    const live = await withTenant(app, ctx, (c) => liveBalances(c, businessId));
    expect(live.size).toBe(0);
    await expect(withTenant(app, ctx, (c) => editTransaction(c, businessId, userId, transactionId, { description: 'x' })))
      .rejects.toThrow(/voided/);
  });

  it('a failed post rolls back completely (no orphan transaction row)', async () => {
    const { ctx, businessId, userId, a } = await base();
    await expect(withTenant(app, ctx, async (c) => {
      await postTransaction(c, businessId, userId, {
        kind: 'deposit', date: '2026-01-01',
        lines: [{ accountId: a('1010'), amount: 5n }, { accountId: a('4000'), amount: -5n }],
      });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM transactions WHERE business_id = $1', [businessId]);
    expect(rows[0].n).toBe(0);
  });

  it('honours the reserved books lock date', async () => {
    const { ctx, businessId, userId, a } = await base();
    await admin.query(`UPDATE businesses SET books_locked_through = '2026-01-31' WHERE id = $1`, [businessId]);
    await expect(withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-01-31',
      lines: [{ accountId: a('1010'), amount: 1n }, { accountId: a('4000'), amount: -1n }],
    }))).rejects.toThrow(/locked/);
  });
});

describe('business and account rules', () => {
  it('freezes business currency once entries exist', async () => {
    const { ctx, businessId, userId, a } = await base();
    await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-01-05',
      lines: [{ accountId: a('1010'), amount: 1n }, { accountId: a('4000'), amount: -1n }],
    }));
    await expect(admin.query(`UPDATE businesses SET currency = 'EUR' WHERE id = $1`, [businessId]))
      .rejects.toThrow(/cannot change once entries exist/);
  });

  it('rejects accounts whose currency differs from the business', async () => {
    const { ctx, businessId } = await base();
    await expect(withTenant(app, ctx, (c) => c.query(
      `INSERT INTO accounts (id,business_id,name,type,currency) VALUES ($1,$2,'Euro cash','asset','EUR')`,
      [uuidv7(), businessId]))).rejects.toThrow(/currency/);
  });

  it('freezes account type once it has lines and protects system accounts', async () => {
    const { ctx, businessId, userId, a } = await base();
    await withTenant(app, ctx, (c) => postTransaction(c, businessId, userId, {
      kind: 'deposit', date: '2026-01-05',
      lines: [{ accountId: a('1010'), amount: 1n }, { accountId: a('4000'), amount: -1n }],
    }));
    await expect(withTenant(app, ctx, (c) => c.query(`UPDATE accounts SET type='expense' WHERE id=$1`, [a('1010')])))
      .rejects.toThrow(/type cannot change/);
    await withTenant(app, ctx, (c) => c.query(`UPDATE accounts SET type='liability' WHERE id=$1`, [a('1020')])); // unused: allowed
    await expect(withTenant(app, ctx, (c) => c.query(`UPDATE accounts SET archived_at=now() WHERE id=$1`, [a('3800')])))
      .rejects.toThrow(/system accounts/);
  });

  it('keeps at least one owner', async () => {
    const { ctx, businessId, userId } = await base();
    await expect(withTenant(app, ctx, (c) => c.query('DELETE FROM memberships WHERE business_id=$1 AND user_id=$2', [businessId, userId])))
      .rejects.toThrow(/at least one owner/);
    await expect(withTenant(app, ctx, (c) => c.query(`UPDATE memberships SET role='viewer' WHERE business_id=$1`, [businessId])))
      .rejects.toThrow(/at least one owner/);
  });
});
