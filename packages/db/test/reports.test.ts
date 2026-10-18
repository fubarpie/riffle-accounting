import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { editTransaction, postTransaction, voidTransaction } from '../src/ledger.js';
import {
  assertRange, balanceSheet, generalLedger, naturalSign, profitLoss, taxSummary, toMinor, trialBalance,
} from '../src/reports/index.js';
import { withTenant } from '../src/tenant.js';
import { app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

/** Probe once so the DB-backed suite skips cleanly (instead of failing) when Postgres is unreachable. */
async function postgresAvailable(): Promise<boolean> {
  const url = process.env.TEST_ADMIN_URL;
  if (!url) return false;
  const probe = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await probe.query('SELECT 1 FROM live_journal_lines LIMIT 0');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const hasPg = await postgresAvailable();

describe('report helpers (no database)', () => {
  it('toMinor parses integers and rejects unsafe magnitudes', () => {
    expect(toMinor('-12500')).toBe(-12500);
    expect(toMinor(null)).toBe(0);
    expect(() => toMinor('9007199254740993')).toThrow(RangeError);
  });
  it('naturalSign is +1 for debit-normal and -1 for credit-normal types', () => {
    expect(['asset', 'expense'].map((t) => naturalSign(t as 'asset'))).toEqual([1, 1]);
    expect(['liability', 'equity', 'income'].map((t) => naturalSign(t as 'asset'))).toEqual([-1, -1, -1]);
  });
  it('assertRange rejects bad or inverted dates', () => {
    expect(() => assertRange('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => assertRange('2026-03-02', '2026-03-01')).toThrow(RangeError);
    expect(() => assertRange("2026-01-01'; DROP TABLE accounts;--", '2026-03-01')).toThrow(RangeError);
    expect(() => assertRange('2026-03-01', '2026-03-01')).not.toThrow();
  });
});

async function fixture() {
  const b = await makeBusiness();
  const ctx = { userId: b.userId, businessId: b.businessId };
  const a = (code: string) => b.accounts.get(code)!;
  const post = (date: string, description: string, lines: [string, bigint][], kind: 'deposit' | 'journal' = 'journal') =>
    withTenant(app, ctx, (c) => postTransaction(c, b.businessId, b.userId, {
      kind, date, description, lines: lines.map(([code, amount]) => ({ accountId: a(code), amount })),
    }));

  await post('2026-01-02', 'Owner contribution', [['1010', 100_000n], ['3100', -100_000n]], 'deposit');
  // Accrual: revenue and sales tax recognised on invoice, no cash yet.
  await post('2026-01-10', 'Invoice 1', [['1100', 50_000n], ['4000', -45_000n], ['2200', -5_000n]]);
  await post('2026-02-05', 'Rent', [['6100', 30_000n], ['1010', -30_000n]]);
  const voided = await post('2026-02-10', 'Mistake', [['6000', 999n], ['1010', -999n]]);
  await withTenant(app, ctx, (c) => voidTransaction(c, b.businessId, b.userId, voided.transactionId));
  const edited = await post('2026-02-15', 'Consulting', [['1010', 12_345n], ['4100', -12_345n]]);
  await withTenant(app, ctx, (c) => editTransaction(c, b.businessId, b.userId, edited.transactionId, {
    lines: [{ accountId: a('1010'), amount: 20_000n }, { accountId: a('4100'), amount: -20_000n }],
  }));
  await post('2026-02-20', 'Business tax', [['6130', 777n], ['1010', -777n]]);
  await post('2026-03-01', 'Remit sales tax', [['2200', 5_000n], ['1010', -5_000n]]);
  return { ...b, ctx, a };
}

describe.skipIf(!hasPg)('reports (PostgreSQL)', () => {
  it('trial balance: debits equal credits, excludes voided and superseded entries', async () => {
    const { ctx, businessId, a } = await fixture();
    for (const asOf of ['2026-01-01', '2026-01-31', '2026-02-28', '2026-12-31']) {
      const tb = await withTenant(app, ctx, (c) => trialBalance(c, businessId, asOf));
      expect(tb.totals.debits).toBe(tb.totals.credits);
      expect(tb.totals.debitBalance).toBe(tb.totals.creditBalance);
      for (const r of tb.rows) expect(r.debitBalance === 0 || r.creditBalance === 0).toBe(true);
    }
    const tb = await withTenant(app, ctx, (c) => trialBalance(c, businessId, '2026-12-31'));
    const row = (code: string) => tb.rows.find((r) => r.accountId === a(code))!;
    expect(row('1010')).toMatchObject({ debits: 120_000, credits: 35_777, debitBalance: 84_223 });
    expect(row('4100').creditBalance).toBe(20_000);
    expect(tb.rows.find((r) => r.accountId === a('6000'))).toBeUndefined(); // voided: no live lines
    expect((await withTenant(app, ctx, (c) => trialBalance(c, businessId, '2026-01-01'))).rows).toEqual([]);
  });

  it('profit & loss: accrual basis over a date range', async () => {
    const { ctx, businessId, a } = await fixture();
    const all = await withTenant(app, ctx, (c) => profitLoss(c, businessId, '2026-01-01', '2026-12-31'));
    expect(all.totals).toEqual({ income: 65_000, expenses: 30_777, netIncome: 34_223 });
    const jan = await withTenant(app, ctx, (c) => profitLoss(c, businessId, '2026-01-01', '2026-01-31'));
    // Invoice revenue counts in January although no cash has been received.
    expect(jan.totals).toEqual({ income: 45_000, expenses: 0, netIncome: 45_000 });
    expect(jan.income[0]).toMatchObject({ accountId: a('4000'), amount: 45_000 });
    const feb = await withTenant(app, ctx, (c) => profitLoss(c, businessId, '2026-02-01', '2026-02-28'));
    expect(feb.totals).toEqual({ income: 20_000, expenses: 30_777, netIncome: -10_777 });
  });

  it('balance sheet: assets = liabilities + equity at every date', async () => {
    const { ctx, businessId } = await fixture();
    for (const asOf of ['2026-01-02', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-31']) {
      const bs = await withTenant(app, ctx, (c) => balanceSheet(c, businessId, asOf));
      expect(bs.totals.assets).toBe(bs.totals.liabilities + bs.totals.equity);
      expect(bs.totals.assets).toBe(bs.totals.liabilitiesAndEquity);
    }
    const jan = await withTenant(app, ctx, (c) => balanceSheet(c, businessId, '2026-01-31'));
    expect(jan.totals).toEqual({ assets: 150_000, liabilities: 5_000, equity: 145_000, liabilitiesAndEquity: 150_000 });
    expect(jan.currentEarnings).toBe(45_000);
  });

  it('general ledger: opening balance, running balance, account filter', async () => {
    const { ctx, businessId, a } = await fixture();
    const gl = await withTenant(app, ctx, (c) => generalLedger(c, businessId, '2026-02-01', '2026-02-28', a('1010')));
    expect(gl.accounts).toHaveLength(1);
    const acct = gl.accounts[0]!;
    expect(acct.openingBalance).toBe(100_000);
    expect(acct.lines.map((l) => [l.date, l.description, l.balance])).toEqual([
      ['2026-02-05', 'Rent', 70_000],
      ['2026-02-15', 'Consulting', 90_000],
      ['2026-02-20', 'Business tax', 89_223],
    ]);
    expect(acct.closingBalance).toBe(89_223);
    expect(acct.totalDebits).toBe(20_000);
    expect(acct.totalCredits).toBe(30_777);
    // A credit-normal account runs in its natural sign.
    const rev = await withTenant(app, ctx, (c) => generalLedger(c, businessId, '2026-01-01', '2026-12-31', a('4000')));
    expect(rev.accounts[0]!.closingBalance).toBe(45_000);
    const everything = await withTenant(app, ctx, (c) => generalLedger(c, businessId, '2026-01-01', '2026-12-31'));
    expect(everything.accounts.length).toBeGreaterThan(5);
    expect(everything.accounts.reduce((s, x) => s + x.totalDebits - x.totalCredits, 0)).toBe(0);
  });

  it('tax summary: defaults to tax-named accounts, or an explicit selection', async () => {
    const { ctx, businessId, a } = await fixture();
    const t = await withTenant(app, ctx, (c) => taxSummary(c, businessId, '2026-01-01', '2026-03-31'));
    expect(t.selection).toBe('name-match');
    expect(t.rows.map((r) => [r.accountId, r.debits, r.credits, r.net])).toEqual([
      [a('2200'), 5_000, 5_000, 0],
      [a('6130'), 777, 0, 777],
    ]);
    const jan = await withTenant(app, ctx, (c) => taxSummary(c, businessId, '2026-01-01', '2026-01-31', [a('2200')]));
    expect(jan.selection).toBe('accounts');
    expect(jan.rows).toMatchObject([{ credits: 5_000, net: 5_000 }]);
  });

  it('tenant isolation: RLS hides another business even when its id is passed', async () => {
    const A = await fixture();
    const B = await makeBusiness();
    const asB = { userId: B.userId, businessId: B.businessId };
    const asNobody = { userId: B.userId };
    expect((await withTenant(app, asB, (c) => trialBalance(c, A.businessId, '2026-12-31'))).rows).toEqual([]);
    expect((await withTenant(app, asB, (c) => profitLoss(c, A.businessId, '2026-01-01', '2026-12-31'))).totals.netIncome).toBe(0);
    expect((await withTenant(app, asB, (c) => generalLedger(c, A.businessId, '2026-01-01', '2026-12-31'))).accounts).toEqual([]);
    expect((await withTenant(app, asNobody, (c) => trialBalance(c, A.businessId, '2026-12-31'))).rows).toEqual([]);
    // B's own books are unaffected by A's activity.
    expect((await withTenant(app, asB, (c) => trialBalance(c, B.businessId, '2026-12-31'))).rows).toEqual([]);
  });
});
