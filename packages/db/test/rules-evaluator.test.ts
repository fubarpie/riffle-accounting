import { describe, expect, it } from 'vitest';
import {
  RuleValidationError, evaluateRules, matchesCondition, parseRuleDefinition, regexProblem,
  ruleMatches, runOrder, appendNotes,
  type Condition, type EvaluableRule, type TransactionFacts,
} from '../src/rules/index.js';

const ACC_A = '0190a000-0000-7000-8000-00000000000a';
const ACC_B = '0190a000-0000-7000-8000-00000000000b';
const CAT_1 = '0190a000-0000-7000-8000-000000000001';
const CAT_2 = '0190a000-0000-7000-8000-000000000002';

const txn = (o: Partial<TransactionFacts> = {}): TransactionFacts => ({
  id: 't1', description: 'SHELL OIL 5521 Grand Junction', notes: '', date: '2026-03-15', amount: 4_500n,
  accountIds: [ACC_A], tags: [], categorizable: true, categoryAccountId: null, ...o,
});
const rule = (o: Partial<EvaluableRule> & Pick<EvaluableRule, 'id'>): EvaluableRule => ({
  name: o.id, priority: 100, strict: true, enabled: true,
  conditions: [{ type: 'description', op: 'contains', value: 'shell' }],
  actions: [{ type: 'add_tag', tag: 'fuel' }], ...o,
});
const m = (c: Condition, t = txn()) => matchesCondition(c, t);

describe('conditions', () => {
  it('description contains / starts_with, case-insensitive by default', () => {
    expect(m({ type: 'description', op: 'contains', value: 'oil 55' })).toBe(true);
    expect(m({ type: 'description', op: 'starts_with', value: 'shell' })).toBe(true);
    expect(m({ type: 'description', op: 'starts_with', value: 'oil' })).toBe(false);
    expect(m({ type: 'description', op: 'contains', value: 'shell', caseSensitive: true })).toBe(false);
    expect(m({ type: 'description', op: 'contains', value: 'SHELL', caseSensitive: true })).toBe(true);
  });
  it('description regex, with stateless matching across calls', () => {
    const c: Condition = { type: 'description', op: 'regex', value: '^shell\\s+oil\\s+\\d{4}' };
    expect([m(c), m(c), m(c)]).toEqual([true, true, true]);
    expect(m({ type: 'description', op: 'regex', value: '^oil' })).toBe(false);
    expect(m({ type: 'description', op: 'regex', value: '(' })).toBe(false); // uncompilable never matches
  });
  it('amount equals / gt / lt / between (inclusive)', () => {
    expect(m({ type: 'amount', op: 'equals', value: '4500' })).toBe(true);
    expect(m({ type: 'amount', op: 'gt', value: '4500' })).toBe(false);
    expect(m({ type: 'amount', op: 'gt', value: '4499' })).toBe(true);
    expect(m({ type: 'amount', op: 'lt', value: '4501' })).toBe(true);
    expect(m({ type: 'amount', op: 'between', min: '4500', max: '4500' })).toBe(true);
    expect(m({ type: 'amount', op: 'between', min: '1', max: '4499' })).toBe(false);
  });
  it('account matches any account the transaction touches', () => {
    expect(m({ type: 'account', accountId: ACC_A })).toBe(true);
    expect(m({ type: 'account', accountId: ACC_B })).toBe(false);
  });
  it('date equals / before / after (strict) / between (inclusive)', () => {
    expect(m({ type: 'date', op: 'equals', value: '2026-03-15' })).toBe(true);
    expect(m({ type: 'date', op: 'before', value: '2026-03-15' })).toBe(false);
    expect(m({ type: 'date', op: 'after', value: '2026-03-14' })).toBe(true);
    expect(m({ type: 'date', op: 'between', min: '2026-03-15', max: '2026-03-15' })).toBe(true);
    expect(m({ type: 'date', op: 'between', min: '2026-03-16', max: '2026-04-01' })).toBe(false);
  });
});

describe('strict vs non-strict', () => {
  const conds: Condition[] = [
    { type: 'description', op: 'contains', value: 'shell' },
    { type: 'amount', op: 'gt', value: '10000' },
  ];
  it('strict requires all conditions, non-strict any', () => {
    expect(ruleMatches({ strict: true, conditions: conds }, txn())).toBe(false);
    expect(ruleMatches({ strict: false, conditions: conds }, txn())).toBe(true);
    expect(ruleMatches({ strict: false, conditions: [conds[1]!] }, txn())).toBe(false);
  });
  it('a rule with no conditions never matches', () => {
    expect(ruleMatches({ strict: true, conditions: [] }, txn())).toBe(false);
    expect(ruleMatches({ strict: false, conditions: [] }, txn())).toBe(false);
  });
});

describe('ordering and actions', () => {
  it('runs enabled rules in priority order, stable on ties; skips disabled', () => {
    const rs = [rule({ id: 'c', priority: 5 }), rule({ id: 'a', priority: 1 }), rule({ id: 'x', priority: 0, enabled: false }), rule({ id: 'b', priority: 5 })];
    expect(runOrder(rs).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
  it('first matching category setter wins; later ones are reported as overridden', () => {
    const rs = [
      rule({ id: 'late', priority: 20, actions: [{ type: 'set_category', accountId: CAT_2 }] }),
      rule({ id: 'early', priority: 10, actions: [{ type: 'set_category', accountId: CAT_1 }] }),
    ];
    const e = evaluateRules(rs, txn());
    expect(e.category).toEqual({ accountId: CAT_1, ruleId: 'early' });
    expect(e.overridden).toEqual([{ accountId: CAT_2, ruleId: 'late' }]);
    expect(e.matchedRuleIds).toEqual(['early', 'late']);
  });
  it('no change when the winning category is already set', () => {
    const e = evaluateRules([rule({ id: 'r', actions: [{ type: 'set_category', accountId: CAT_1 }] })],
      txn({ categoryAccountId: CAT_1 }));
    expect(e.category).toBeNull();
  });
  it('reports, but does not apply, a category on an uncategorizable transaction', () => {
    const e = evaluateRules([rule({ id: 'r', actions: [{ type: 'set_category', accountId: CAT_1 }, { type: 'add_tag', tag: 'x' }] })],
      txn({ categorizable: false }));
    expect(e.category).toBeNull();
    expect(e.uncategorizable).toEqual({ accountId: CAT_1, ruleId: 'r' });
    expect(e.tags).toEqual([{ tag: 'x', ruleId: 'r' }]); // other actions still run
  });
  it('accumulates notes and tags across rules, de-duplicated and idempotent', () => {
    const rs = [
      rule({ id: 'r1', priority: 1, actions: [{ type: 'add_note', text: 'Fuel' }, { type: 'add_tag', tag: ' Fuel ' }] }),
      rule({ id: 'r2', priority: 2, actions: [{ type: 'add_note', text: 'Fuel' }, { type: 'add_note', text: 'Check receipt' }, { type: 'add_tag', tag: 'vehicle' }] }),
    ];
    const e = evaluateRules(rs, txn());
    expect(e.notes.map((n) => n.text)).toEqual(['Fuel', 'Check receipt']);
    expect(e.tags.map((t) => t.tag)).toEqual(['fuel', 'vehicle']);
    const again = evaluateRules(rs, txn({ notes: appendNotes('', e.notes), tags: ['fuel', 'vehicle'] }));
    expect(again.notes).toEqual([]);
    expect(again.tags).toEqual([]);
  });
  it('evaluates against the original transaction, not earlier rules\' effects', () => {
    const rs = [
      rule({ id: 'r1', priority: 1, actions: [{ type: 'add_note', text: 'marker' }] }),
      rule({ id: 'r2', priority: 2, conditions: [{ type: 'description', op: 'contains', value: 'marker' }], actions: [{ type: 'add_tag', tag: 'seen' }] }),
    ];
    expect(evaluateRules(rs, txn()).matchedRuleIds).toEqual(['r1']);
  });
  it('is deterministic and does not mutate its input', () => {
    const rs = [rule({ id: 'r' })];
    const t = txn();
    const snap = JSON.stringify(rs, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(evaluateRules(rs, t)).toEqual(evaluateRules(rs, t));
    expect(JSON.stringify(rs, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snap);
  });
  it('only examines a bounded prefix of the description', () => {
    const t = txn({ description: 'x'.repeat(5000) + 'needle' });
    expect(m({ type: 'description', op: 'contains', value: 'needle' }, t)).toBe(false);
  });
});

describe('validation', () => {
  const good = {
    name: 'Fuel', conditions: [{ type: 'description', op: 'contains', value: 'shell' }],
    actions: [{ type: 'set_category', accountId: CAT_1 }],
  };
  it('applies defaults', () => {
    expect(parseRuleDefinition(good)).toMatchObject({ priority: 100, strict: true, enabled: true });
  });
  it('rejects unknown fields, bad ops, bad amounts, bad dates, empty lists', () => {
    const bad = (o: object) => expect(() => parseRuleDefinition({ ...good, ...o })).toThrow(RuleValidationError);
    bad({ extra: 1 });
    bad({ conditions: [] });
    bad({ actions: [] });
    bad({ conditions: [{ type: 'description', op: 'ends_with', value: 'x' }] });
    bad({ conditions: [{ type: 'amount', op: 'gt', value: '12.50' }] });
    bad({ conditions: [{ type: 'amount', op: 'between', min: '9', max: '1' }] });
    bad({ conditions: [{ type: 'date', op: 'equals', value: '2026-02-30' }] });
    bad({ conditions: [{ type: 'account', accountId: 'nope' }] });
    bad({ priority: -1 });
    bad({ strict: 'yes' });
    bad({ actions: [{ type: 'add_tag', tag: 'x'.repeat(41) }] });
    bad({ actions: [{ type: 'set_category', accountId: CAT_1 }, { type: 'set_category', accountId: CAT_2 }] });
  });
  it('partial mode only validates and returns supplied fields', () => {
    expect(parseRuleDefinition({ enabled: false }, true)).toEqual({ enabled: false });
    expect(() => parseRuleDefinition({ priority: 1.5 }, true)).toThrow(RuleValidationError);
  });
  it('refuses catastrophic or unbounded regexes', () => {
    for (const p of ['(a+)+$', '(.*)*x', '(\\w+\\s?)*', '(a)\\1', 'a'.repeat(201), '', '(']) {
      expect(regexProblem(p), p).toBeTypeOf('string');
    }
    for (const p of ['^shell\\s+\\d{4}', 'amazon|amzn', '(?:uber|lyft)\\b']) expect(regexProblem(p), p).toBeUndefined();
  });
});

describe('regex safe execution', () => {
  it('aborts a catastrophic pattern that passes static checks and keeps working', () => {
    const t = { id: 't', description: `${'a'.repeat(60)}!`, notes: '', date: '2026-01-01', amount: 1n,
      accountIds: [], tags: [], categorizable: true, categoryAccountId: null } as const;
    const start = Date.now();
    expect(matchesCondition({ type: 'description', op: 'regex', value: '(a|a)*$' }, t)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(matchesCondition({ type: 'description', op: 'regex', value: '^a+!$' }, t)).toBe(true);
  });
});
