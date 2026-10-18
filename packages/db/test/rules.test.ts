import { afterAll, describe, expect, it } from 'vitest';
import { liveBalances, postTransaction, editTransaction, voidTransaction } from '../src/ledger.js';
import {
  RuleValidationError, applyRules, createRule, deleteRule, listRules, parseRuleDefinition, previewRules,
  toEvaluable, updateRule,
} from '../src/rules/index.js';
import { withTenant } from '../src/tenant.js';
import { admin, app, closePools, makeBusiness } from './helpers.js';

afterAll(closePools);

const setup = async () => {
  const b = await makeBusiness();
  const ctx = { userId: b.userId, businessId: b.businessId };
  const a = (code: string) => b.accounts.get(code)!;
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, ctx, fn);
  const post = (desc: string, amount: bigint, date = '2026-03-15', kind: 'withdrawal' | 'deposit' = 'withdrawal') =>
    run((c) => postTransaction(c, b.businessId, b.userId, {
      kind, date, description: desc,
      lines: kind === 'withdrawal'
        ? [{ accountId: a('6020'), amount }, { accountId: a('1010'), amount: -amount }]
        : [{ accountId: a('1010'), amount }, { accountId: a('4300'), amount: -amount }],
    })).then((r) => r.transactionId);
  const def = (o: object) => parseRuleDefinition({
    name: 'r', conditions: [{ type: 'description', op: 'contains', value: 'shell' }],
    actions: [{ type: 'set_category', accountId: a('6000') }], ...o,
  });
  return { ...b, a, run, post, def };
};

describe('rules table', () => {
  it('is RLS-isolated per business and audits create/update/delete', async () => {
    const s1 = await setup();
    const s2 = await setup();
    const rule = await s1.run((c) => createRule(c, s1.businessId, s1.userId, s1.def({})));
    await s1.run((c) => updateRule(c, s1.businessId, s1.userId, rule.id, { enabled: false }));
    expect(await s2.run((c) => listRules(c, s2.businessId))).toEqual([]);
    // Even asking for business 1's rows inside business 2's context returns nothing.
    expect((await s2.run((c) => c.query('SELECT id FROM rules WHERE id = $1', [rule.id]))).rowCount).toBe(0);
    await expect(s2.run((c) => c.query(
      `INSERT INTO rules (id,business_id,name,conditions,actions,created_by) VALUES (gen_random_uuid(),$1,'x','[{}]','[{}]',$2)`,
      [s1.businessId, s2.userId]))).rejects.toThrow(/row-level security/);
    await s1.run((c) => deleteRule(c, s1.businessId, s1.userId, rule.id));
    const { rows } = await admin.query('SELECT action FROM audit_log WHERE business_id=$1 AND entity=$2 ORDER BY id', [s1.businessId, 'rule']);
    expect(rows.map((r) => r.action)).toEqual(['rule.create', 'rule.update', 'rule.delete']);
  });

  it('rejects category targets that are not active income/expense accounts, and unknown accounts', async () => {
    const s = await setup();
    await expect(s.run((c) => createRule(c, s.businessId, s.userId,
      s.def({ actions: [{ type: 'set_category', accountId: s.a('1010') }] })))).rejects.toThrow(RuleValidationError);
    await expect(s.run((c) => createRule(c, s.businessId, s.userId,
      s.def({ conditions: [{ type: 'account', accountId: '0190a000-0000-7000-8000-0000000000ff' }] })))).rejects.toThrow(/no such account/);
  });
});

describe('applying rules', () => {
  it('recategorises through reversal: posted lines are never modified, balances move, audit written', async () => {
    const s = await setup();
    const id = await s.post('SHELL OIL 1', 4_500n);
    const rule = await s.run((c) => createRule(c, s.businessId, s.userId, s.def({
      actions: [{ type: 'set_category', accountId: s.a('6000') }, { type: 'add_note', text: 'auto' }, { type: 'add_tag', tag: 'Fuel' }],
    })));
    const before = (await admin.query('SELECT id, account_id, amount_minor::text FROM journal_lines WHERE business_id=$1 ORDER BY id', [s.businessId])).rows;

    const res = await s.run((c) => applyRules(c, s.businessId, s.userId, {}));
    expect(res.applied).toEqual([{ transactionId: id, ruleIds: [rule.id], category: true, notes: 1, tags: 1 }]);

    const after = (await admin.query('SELECT id, account_id, amount_minor::text FROM journal_lines WHERE business_id=$1 ORDER BY id', [s.businessId])).rows;
    expect(after.slice(0, before.length)).toEqual(before); // original lines untouched
    expect(after.length).toBe(before.length + 4); // reversal (2) + replacement (2)
    const { rows: entries } = await admin.query('SELECT reverses_entry_id FROM journal_entries WHERE business_id=$1', [s.businessId]);
    expect(entries.filter((e) => e.reverses_entry_id).length).toBe(1);

    const bal = await s.run((c) => liveBalances(c, s.businessId));
    expect(bal.get(s.a('6020')) ?? 0n).toBe(0n);
    expect(bal.get(s.a('6000'))).toBe(4_500n);
    expect(bal.get(s.a('1010'))).toBe(-4_500n);

    const t = (await admin.query('SELECT notes FROM transactions WHERE id=$1', [id])).rows[0];
    expect(t.notes).toBe('auto');
    expect((await admin.query('SELECT tag FROM transaction_tags WHERE transaction_id=$1', [id])).rows).toEqual([{ tag: 'fuel' }]);
    const actions = (await admin.query('SELECT action FROM audit_log WHERE business_id=$1 AND entity_id=$2', [s.businessId, id])).rows.map((r) => r.action);
    expect(actions).toContain('transaction.rule_apply');
    expect(actions).toContain('transaction.edit');
    const ra = (await admin.query(`SELECT actor_user_id, after FROM audit_log WHERE entity_id=$1 AND action='transaction.rule_apply'`, [id])).rows[0];
    expect(ra.actor_user_id).toBe(s.userId);
    expect(ra.after.ruleIds).toEqual([rule.id]);

    // Idempotent: a second run changes nothing.
    const again = await s.run((c) => applyRules(c, s.businessId, s.userId, {}));
    expect(again.applied).toEqual([]);
  });

  it('dry run writes nothing', async () => {
    const s = await setup();
    await s.post('SHELL OIL 2', 1_000n);
    const rule = await s.run((c) => createRule(c, s.businessId, s.userId, s.def({})));
    const counts = async () => (await admin.query(
      `SELECT (SELECT count(*) FROM journal_lines WHERE business_id=$1) l, (SELECT count(*) FROM audit_log WHERE business_id=$1) a,
              (SELECT count(*) FROM transaction_tags WHERE business_id=$1) g`, [s.businessId])).rows[0];
    const was = await counts();
    const out = await s.run((c) => previewRules(c, s.businessId, [toEvaluable(rule)], {}));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.evaluation.category?.accountId).toBe(s.a('6000'));
    expect(await counts()).toEqual(was);
  });

  it('skips splits/transfers for category but still adds tags; skips voided transactions', async () => {
    const s = await setup();
    const split = await s.run((c) => postTransaction(c, s.businessId, s.userId, {
      kind: 'withdrawal', date: '2026-03-01', description: 'shell split',
      lines: [{ accountId: s.a('6020'), amount: 600n }, { accountId: s.a('6000'), amount: 400n }, { accountId: s.a('1010'), amount: -1_000n }],
    }));
    const voided = await s.post('shell voided', 100n);
    await s.run((c) => voidTransaction(c, s.businessId, s.userId, voided));
    await s.run((c) => createRule(c, s.businessId, s.userId, s.def({
      actions: [{ type: 'set_category', accountId: s.a('6010') }, { type: 'add_tag', tag: 'seen' }],
    })));
    const res = await s.run((c) => applyRules(c, s.businessId, s.userId, {}));
    expect(res.scanned).toBe(1);
    expect(res.skipped).toEqual([{ transactionId: split.transactionId, reason: 'not_categorizable' }]);
    expect(res.applied).toMatchObject([{ transactionId: split.transactionId, category: false, tags: 1 }]);
  });

  it('first-priority rule wins the category; disabled rules do nothing', async () => {
    const s = await setup();
    const id = await s.post('shell 3', 700n);
    await s.run(async (c) => {
      await createRule(c, s.businessId, s.userId, s.def({ name: 'second', priority: 20, actions: [{ type: 'set_category', accountId: s.a('6010') }] }));
      await createRule(c, s.businessId, s.userId, s.def({ name: 'first', priority: 10, actions: [{ type: 'set_category', accountId: s.a('6000') }] }));
      await createRule(c, s.businessId, s.userId, s.def({ name: 'off', priority: 1, enabled: false, actions: [{ type: 'set_category', accountId: s.a('5100') }] }));
    });
    await s.run((c) => applyRules(c, s.businessId, s.userId, { transactionIds: [id] }));
    const bal = await s.run((c) => liveBalances(c, s.businessId));
    expect(bal.get(s.a('6000'))).toBe(700n);
    expect(bal.get(s.a('6010')) ?? 0n).toBe(0n);
    expect(bal.get(s.a('5100')) ?? 0n).toBe(0n);
  });

  it('skips a transaction inside locked books without failing the batch', async () => {
    const s = await setup();
    const old = await s.post('shell old', 100n, '2025-01-10');
    const recent = await s.post('shell new', 200n, '2026-03-10');
    await admin.query(`UPDATE businesses SET books_locked_through='2025-12-31' WHERE id=$1`, [s.businessId]);
    await s.run((c) => createRule(c, s.businessId, s.userId, s.def({})));
    const res = await s.run((c) => applyRules(c, s.businessId, s.userId, {}));
    expect(res.skipped).toEqual([{ transactionId: old, reason: 'books_locked' }]);
    expect(res.applied.map((a) => a.transactionId)).toEqual([recent]);
  });

  it('never targets another business\'s transactions', async () => {
    const s1 = await setup();
    const s2 = await setup();
    const id2 = await s2.post('shell other', 100n);
    await s1.run((c) => createRule(c, s1.businessId, s1.userId, s1.def({})));
    const res = await s1.run((c) => applyRules(c, s1.businessId, s1.userId, { transactionIds: [id2] }));
    expect(res.scanned).toBe(0);
  });
});

it('keeps the edit-by-reversal op usable on a transaction after rules ran', async () => {
  const s = await setup();
  const id = await s.post('shell 9', 300n);
  await s.run((c) => createRule(c, s.businessId, s.userId, s.def({})));
  await s.run((c) => applyRules(c, s.businessId, s.userId, {}));
  await s.run((c) => editTransaction(c, s.businessId, s.userId, id, { description: 'edited' }));
});
