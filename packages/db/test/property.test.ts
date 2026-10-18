import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allBalances, editTransaction, liveBalances, postTransaction, voidTransaction, type LineInput,
} from '../src/ledger.js';
import { withTenant } from '../src/tenant.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

const CODES = ['1010', '1020', '2100', '3100', '4000', '5000', '6100', '6150'];

/** Arbitrary balanced set of lines: n-1 free amounts, the last one balances. */
const linesArb = fc
  .array(
    fc.record({
      code: fc.constantFrom(...CODES),
      amount: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((x) => x !== 0n),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .chain((ls) => {
    const sum = ls.reduce((s, l) => s + l.amount, 0n);
    return fc.constantFrom(...CODES).map((code) =>
      sum === 0n ? ls.concat({ code, amount: 1n }, { code, amount: -1n }) : ls.concat({ code, amount: -sum }),
    );
  });

type Op =
  | { t: 'post'; lines: { code: string; amount: bigint }[] }
  | { t: 'edit'; idx: number; lines: { code: string; amount: bigint }[] }
  | { t: 'meta'; idx: number }
  | { t: 'void'; idx: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: linesArb.map((lines): Op => ({ t: 'post', lines })) },
  { weight: 2, arbitrary: fc.record({ idx: fc.nat(50), lines: linesArb }).map((r): Op => ({ t: 'edit', ...r })) },
  { weight: 1, arbitrary: fc.nat(50).map((idx): Op => ({ t: 'meta', idx })) },
  { weight: 1, arbitrary: fc.nat(50).map((idx): Op => ({ t: 'void', idx })) },
);

describe('ledger properties (random postings, edits, voids)', () => {
  it('every entry sums to zero; the trial balance is zero; balances equal the model', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const { userId, businessId, accounts } = await makeBusiness();
        const ctx = { userId, businessId };
        const toLines = (ls: { code: string; amount: bigint }[]): LineInput[] =>
          ls.map((l) => ({ accountId: accounts.get(l.code)!, amount: l.amount }));

        // Model: live lines per transaction.
        const model: { id: string; lines: LineInput[]; voided: boolean }[] = [];
        const pick = (idx: number) => {
          const live = model.filter((m) => !m.voided);
          return live.length ? live[idx % live.length]! : undefined;
        };

        for (const op of ops) {
          await withTenant(app, ctx, async (c) => {
            if (op.t === 'post') {
              const lines = toLines(op.lines);
              const r = await postTransaction(c, businessId, userId, { kind: 'journal', date: '2026-01-15', lines });
              model.push({ id: r.transactionId, lines, voided: false });
              return;
            }
            const m = pick(op.idx);
            if (!m) return;
            if (op.t === 'edit') {
              const lines = toLines(op.lines);
              await editTransaction(c, businessId, userId, m.id, { lines });
              m.lines = lines;
            } else if (op.t === 'meta') {
              await editTransaction(c, businessId, userId, m.id, { description: 'renamed', notes: 'n' });
            } else {
              await voidTransaction(c, businessId, userId, m.id);
              m.voided = true;
            }
          });
        }

        // 1. Every entry sums to zero (checked independently of the trigger).
        const bad = await admin.query(
          `SELECT entry_id FROM journal_lines WHERE business_id=$1 GROUP BY entry_id HAVING sum(amount_minor) <> 0`, [businessId]);
        expect(bad.rowCount).toBe(0);

        // 2. Trial balance (all history) and live trial balance both sum to zero.
        const all = await withTenant(app, ctx, (c) => allBalances(c, businessId));
        const live = await withTenant(app, ctx, (c) => liveBalances(c, businessId));
        expect([...all.values()].reduce((s, x) => s + x, 0n)).toBe(0n);
        expect([...live.values()].reduce((s, x) => s + x, 0n)).toBe(0n);

        // 3. Live balances equal the model; reversals make history net to the same.
        const expected = new Map<string, bigint>();
        for (const m of model) if (!m.voided) for (const l of m.lines) {
          expected.set(l.accountId, (expected.get(l.accountId) ?? 0n) + l.amount);
        }
        for (const [id, v] of expected) expect(live.get(id) ?? 0n, 'live').toBe(v);
        for (const [id, v] of live) expect(expected.get(id) ?? 0n, 'live (reverse)').toBe(v);
        for (const [id, v] of all) expect(v, 'all-history').toBe(expected.get(id) ?? 0n);
      }),
      { numRuns: 25 },
    );
  });
});
