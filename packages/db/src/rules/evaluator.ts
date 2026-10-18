/**
 * Pure rule evaluator. No I/O, no clock, no randomness: the same rules and
 * facts always give the same result, which is what makes dry-run previews
 * trustworthy.
 *
 * Semantics (clean-room; Firefly III's trigger/action behaviour was used only
 * as a behavioural reference):
 *  - Only enabled rules run, in ascending `priority`; ties keep input order.
 *  - Conditions are always tested against the transaction as it was before
 *    any rule ran, so results never depend on what an earlier rule did.
 *  - `strict` true: every condition must match. false: at least one.
 *  - A transaction has one category. The first matching rule that sets one
 *    wins; later setters are reported as `overridden`, not applied.
 *  - Notes and tags accumulate across matching rules, de-duplicated, and are
 *    no-ops when the transaction already has them (so re-running is idempotent).
 */
import vm from 'node:vm';
import {
  type Action, type Condition, LIMITS, normalizeTag,
} from './definition.js';

export interface EvaluableRule {
  /** Opaque id; drafts under preview may use any unique string. */
  id: string;
  name: string;
  priority: number;
  strict: boolean;
  enabled: boolean;
  conditions: readonly Condition[];
  actions: readonly Action[];
}

/** What the evaluator knows about a transaction. */
export interface TransactionFacts {
  id: string;
  description: string;
  notes: string;
  /** YYYY-MM-DD */
  date: string;
  /** Total moved, in minor units, always positive (sum of debit lines). */
  amount: bigint;
  /** Every account touched by the current entry's lines. */
  accountIds: readonly string[];
  tags: readonly string[];
  /**
   * Whether a category can be set at all: a two-line deposit or withdrawal
   * with one income/expense line. Splits, transfers and journals are not.
   */
  categorizable: boolean;
  /** Current category account, if one is identifiable. */
  categoryAccountId: string | null;
}

export interface AppliedNote { text: string; ruleId: string }
export interface AppliedTag { tag: string; ruleId: string }
export interface CategoryChange { accountId: string; ruleId: string }

export interface Evaluation {
  /** Enabled rules that matched, in the order they ran. */
  matchedRuleIds: string[];
  /** The category to set, or null when nothing would change. */
  category: CategoryChange | null;
  /** Setters that lost to a higher-priority rule. */
  overridden: CategoryChange[];
  /** A winning category the transaction cannot take. */
  uncategorizable: CategoryChange | null;
  notes: AppliedNote[];
  tags: AppliedTag[];
}

/** Only this much of a description is examined, bounding regex work. */
export const MAX_DESCRIPTION_CHARS = 1000;

/**
 * Regexes run inside a throwaway vm context with a hard execution timeout, so a
 * pattern that slips past the static checks in definition.ts (e.g. `(a|a)*$`)
 * is aborted instead of freezing the event loop. A pattern that times out is
 * remembered and treated as never matching. Input length is capped separately.
 */
export const REGEX_TIMEOUT_MS = 25;

const sandbox = vm.createContext(Object.create(null) as Record<string, unknown>);
const runner = new vm.Script('new RegExp(__p, __f).test(__d)');
const brokenPatterns = new Set<string>();

function safeRegexTest(pattern: string, caseSensitive: boolean, input: string): boolean {
  const key = `${caseSensitive ? 's' : 'i'}:${pattern}`;
  if (brokenPatterns.has(key)) return false;
  // Flags never include g/y, so test() is stateless.
  Object.assign(sandbox, { __p: pattern, __f: caseSensitive ? '' : 'i', __d: input });
  try {
    return runner.runInContext(sandbox, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    // Timeout or a pattern that no longer compiles: never match, don't retry.
    if (brokenPatterns.size > 500) brokenPatterns.clear();
    brokenPatterns.add(key);
    return false;
  } finally {
    Object.assign(sandbox, { __p: '', __d: '' });
  }
}

export function matchesCondition(cond: Condition, t: TransactionFacts): boolean {
  switch (cond.type) {
    case 'description': {
      const d = t.description.slice(0, MAX_DESCRIPTION_CHARS);
      const cs = cond.caseSensitive === true;
      switch (cond.op) {
        case 'contains':
          return cs ? d.includes(cond.value) : d.toLowerCase().includes(cond.value.toLowerCase());
        case 'starts_with':
          return cs ? d.startsWith(cond.value) : d.toLowerCase().startsWith(cond.value.toLowerCase());
        case 'regex':
          // A stored pattern that no longer compiles simply never matches.
          return safeRegexTest(cond.value, cs, d);
      }
      return false;
    }
    case 'amount': {
      if (cond.op === 'between') return t.amount >= BigInt(cond.min) && t.amount <= BigInt(cond.max);
      const v = BigInt(cond.value);
      return cond.op === 'equals' ? t.amount === v : cond.op === 'gt' ? t.amount > v : t.amount < v;
    }
    case 'account':
      return t.accountIds.includes(cond.accountId);
    case 'date': {
      // ISO dates compare correctly as strings.
      if (cond.op === 'between') return t.date >= cond.min && t.date <= cond.max;
      return cond.op === 'equals' ? t.date === cond.value : cond.op === 'before' ? t.date < cond.value : t.date > cond.value;
    }
  }
}

export function ruleMatches(rule: Pick<EvaluableRule, 'strict' | 'conditions'>, t: TransactionFacts): boolean {
  if (rule.conditions.length === 0) return false; // an empty rule must never match everything
  return rule.strict
    ? rule.conditions.every((c) => matchesCondition(c, t))
    : rule.conditions.some((c) => matchesCondition(c, t));
}

/** Rules in the order they run: enabled only, by priority, stable. */
export function runOrder<R extends Pick<EvaluableRule, 'priority' | 'enabled'>>(rules: readonly R[]): R[] {
  return rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.enabled)
    .sort((a, b) => a.r.priority - b.r.priority || a.i - b.i)
    .map(({ r }) => r);
}

export function evaluateRules(rules: readonly EvaluableRule[], t: TransactionFacts): Evaluation {
  const result: Evaluation = {
    matchedRuleIds: [], category: null, overridden: [], uncategorizable: null, notes: [], tags: [],
  };
  let winner: CategoryChange | null = null;
  const haveNotes = new Set(t.notes.split('\n').map((l) => l.trim()).filter(Boolean));
  const haveTags = new Set(t.tags.map(normalizeTag));

  for (const rule of runOrder(rules)) {
    if (!ruleMatches(rule, t)) continue;
    result.matchedRuleIds.push(rule.id);
    for (const a of rule.actions) {
      if (a.type === 'set_category') {
        const change = { accountId: a.accountId, ruleId: rule.id };
        if (winner === null) winner = change;
        else result.overridden.push(change);
      } else if (a.type === 'add_note') {
        const text = a.text.trim().slice(0, LIMITS.noteMax);
        if (text && !haveNotes.has(text)) {
          haveNotes.add(text);
          result.notes.push({ text, ruleId: rule.id });
        }
      } else {
        const tag = normalizeTag(a.tag);
        if (tag && !haveTags.has(tag)) {
          haveTags.add(tag);
          result.tags.push({ tag, ruleId: rule.id });
        }
      }
    }
  }

  if (winner !== null) {
    if (!t.categorizable) result.uncategorizable = winner;
    else if (winner.accountId !== t.categoryAccountId) result.category = winner;
  }
  return result;
}

/** Notes text after appending, one note per line. */
export function appendNotes(existing: string, add: readonly AppliedNote[]): string {
  return [existing.trim(), ...add.map((n) => n.text)].filter(Boolean).join('\n');
}

export function hasChanges(e: Evaluation): boolean {
  return e.category !== null || e.notes.length > 0 || e.tags.length > 0;
}
