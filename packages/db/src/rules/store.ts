/**
 * Persistence and application of rules. Every function takes a PoolClient that
 * is already inside withTenant/withMembership, so RLS confines it to one
 * business and the role check has already happened.
 *
 * Rules never write journal lines directly. A category change is an
 * `editTransaction` call, i.e. a reversing entry plus a replacement; the
 * immutability triggers from migration 0001 make anything else impossible.
 */
import type { PoolClient } from 'pg';
import { LedgerInputError, audit, editTransaction, type LineInput } from '../ledger.js';
import type { MembershipRole } from '../types.js';
import { uuidv7 } from '../uuid.js';
import {
  type Action, type Condition, type RuleDefinition, RuleValidationError,
  parseActions, parseConditions,
} from './definition.js';
import {
  type Evaluation, type EvaluableRule, type TransactionFacts,
  appendNotes, evaluateRules, hasChanges,
} from './evaluator.js';

/** Roles that may create, change, delete and apply rules. Viewers may read. */
export const RULE_WRITER_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'bookkeeper'];
export const MAX_RULES_PER_BUSINESS = 500;
export const DEFAULT_SCAN_LIMIT = 100;
export const MAX_SCAN_LIMIT = 500;

export interface StoredRule extends RuleDefinition {
  id: string;
  businessId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RuleRow {
  id: string; business_id: string; name: string; priority: number; strict: boolean; enabled: boolean;
  conditions: unknown; actions: unknown; created_by: string; created_at: Date; updated_at: Date;
}

const RULE_COLUMNS = 'id, business_id, name, priority, strict, enabled, conditions, actions, created_by, created_at, updated_at';

function toRule(r: RuleRow): StoredRule {
  return {
    id: r.id, businessId: r.business_id, name: r.name, priority: r.priority, strict: r.strict,
    enabled: r.enabled,
    // Re-validated on read so a hand-edited row cannot reach the evaluator malformed.
    conditions: parseConditions(r.conditions), actions: parseActions(r.actions),
    createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const snapshot = (r: RuleDefinition) => ({
  name: r.name, priority: r.priority, strict: r.strict, enabled: r.enabled,
  conditions: r.conditions, actions: r.actions,
});

// ------------------------------------------------------------------ CRUD

export async function listRules(c: PoolClient, businessId: string): Promise<StoredRule[]> {
  const { rows } = await c.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM rules WHERE business_id = $1 ORDER BY priority, id`, [businessId]);
  return rows.map(toRule);
}

export async function getRule(c: PoolClient, businessId: string, id: string): Promise<StoredRule | undefined> {
  const { rows } = await c.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM rules WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ? toRule(rows[0]) : undefined;
}

/**
 * Accounts named by a rule must exist in this business (RLS hides others), and
 * a category target must be an active income or expense account.
 */
export async function validateRuleAccounts(
  c: PoolClient, businessId: string, conditions: readonly Condition[], actions: readonly Action[],
): Promise<void> {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const x of conditions) if (x.type === 'account') ids.add(x.accountId);
  for (const x of actions) if (x.type === 'set_category') ids.add(x.accountId);
  if (ids.size === 0) return;
  const { rows } = await c.query<{ id: string; type: string; archived_at: Date | null }>(
    'SELECT id, type, archived_at FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])',
    [businessId, [...ids]]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  conditions.forEach((x, i) => {
    if (x.type === 'account' && !byId.has(x.accountId)) issues.push(`conditions[${i}].accountId: no such account`);
  });
  actions.forEach((x, i) => {
    if (x.type !== 'set_category') return;
    const a = byId.get(x.accountId);
    if (!a) issues.push(`actions[${i}].accountId: no such account`);
    else if (a.archived_at) issues.push(`actions[${i}].accountId: account is archived`);
    else if (a.type !== 'income' && a.type !== 'expense') {
      issues.push(`actions[${i}].accountId: a category must be an income or expense account`);
    }
  });
  if (issues.length) throw new RuleValidationError(issues);
}

export async function createRule(
  c: PoolClient, businessId: string, actor: string, def: RuleDefinition,
): Promise<StoredRule> {
  const { rows: cnt } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM rules WHERE business_id = $1', [businessId]);
  if (Number(cnt[0]?.n ?? 0) >= MAX_RULES_PER_BUSINESS) {
    throw new RuleValidationError([`a business may have at most ${MAX_RULES_PER_BUSINESS} rules`]);
  }
  await validateRuleAccounts(c, businessId, def.conditions, def.actions);
  const id = uuidv7();
  const { rows } = await c.query<RuleRow>(
    `INSERT INTO rules (id, business_id, name, priority, strict, enabled, conditions, actions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${RULE_COLUMNS}`,
    [id, businessId, def.name, def.priority, def.strict, def.enabled,
      JSON.stringify(def.conditions), JSON.stringify(def.actions), actor]);
  const rule = toRule(rows[0]!);
  await audit(c, businessId, actor, 'rule.create', 'rule', id, undefined, snapshot(rule));
  return rule;
}

export async function updateRule(
  c: PoolClient, businessId: string, actor: string, id: string, patch: Partial<RuleDefinition>,
): Promise<StoredRule | undefined> {
  const { rows: cur } = await c.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM rules WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
  if (!cur[0]) return undefined;
  const before = toRule(cur[0]);
  const next: RuleDefinition = { ...snapshot(before), ...patch };
  if (patch.conditions || patch.actions) await validateRuleAccounts(c, businessId, next.conditions, next.actions);
  const { rows } = await c.query<RuleRow>(
    `UPDATE rules SET name=$3, priority=$4, strict=$5, enabled=$6, conditions=$7, actions=$8, updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING ${RULE_COLUMNS}`,
    [businessId, id, next.name, next.priority, next.strict, next.enabled,
      JSON.stringify(next.conditions), JSON.stringify(next.actions)]);
  const after = toRule(rows[0]!);
  await audit(c, businessId, actor, 'rule.update', 'rule', id, snapshot(before), snapshot(after));
  return after;
}

export async function deleteRule(c: PoolClient, businessId: string, actor: string, id: string): Promise<boolean> {
  const { rows } = await c.query<RuleRow>(
    `DELETE FROM rules WHERE business_id = $1 AND id = $2 RETURNING ${RULE_COLUMNS}`, [businessId, id]);
  if (!rows[0]) return false;
  await audit(c, businessId, actor, 'rule.delete', 'rule', id, snapshot(toRule(rows[0])), undefined);
  return true;
}

// ------------------------------------------------------- loading facts

export interface ScanOptions {
  transactionIds?: readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

interface LoadedLine extends LineInput { accountType: string }
export interface LoadedTransaction {
  facts: TransactionFacts;
  lines: LoadedLine[];
  /** Index into `lines` of the category line, when categorizable. */
  categoryLine: number;
}

/** Load live (current, non-voided) transactions as evaluator facts. `lock` takes row locks for applying. */
export async function loadTransactions(
  c: PoolClient, businessId: string, opts: ScanOptions, lock = false,
): Promise<LoadedTransaction[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SCAN_LIMIT, 1), MAX_SCAN_LIMIT);
  const { rows: txns } = await c.query<{
    id: string; kind: string; date: string; description: string; notes: string; current_entry_id: string;
  }>(
    `SELECT t.id, t.kind, to_char(t.date,'YYYY-MM-DD') AS date, t.description, t.notes, t.current_entry_id
       FROM transactions t
      WHERE t.business_id = $1 AND t.voided_at IS NULL AND t.current_entry_id IS NOT NULL
        AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
        AND ($3::date IS NULL OR t.date >= $3::date)
        AND ($4::date IS NULL OR t.date <= $4::date)
      ORDER BY t.date DESC, t.id DESC
      LIMIT $5 ${lock ? 'FOR UPDATE OF t' : ''}`,
    [businessId, opts.transactionIds ? [...opts.transactionIds] : null, opts.from ?? null, opts.to ?? null, limit]);
  if (txns.length === 0) return [];

  const { rows: lineRows } = await c.query<{
    entry_id: string; account_id: string; amount_minor: string; memo: string; type: string;
  }>(
    `SELECT l.entry_id, l.account_id, l.amount_minor::text, l.memo, a.type
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND l.entry_id = ANY($2::uuid[]) ORDER BY l.id`,
    [businessId, txns.map((t) => t.current_entry_id)]);
  const { rows: tagRows } = await c.query<{ transaction_id: string; tag: string }>(
    'SELECT transaction_id, tag FROM transaction_tags WHERE business_id = $1 AND transaction_id = ANY($2::uuid[])',
    [businessId, txns.map((t) => t.id)]);

  return txns.map((t) => {
    const lines: LoadedLine[] = lineRows.filter((l) => l.entry_id === t.current_entry_id).map((l) => ({
      accountId: l.account_id, amount: BigInt(l.amount_minor), memo: l.memo, accountType: l.type,
    }));
    const isCategory = (l: LoadedLine) => l.accountType === 'income' || l.accountType === 'expense';
    const candidates = lines.flatMap((l, i) => (isCategory(l) ? [i] : []));
    const categorizable = (t.kind === 'deposit' || t.kind === 'withdrawal')
      && lines.length === 2 && candidates.length === 1;
    const categoryLine = categorizable ? candidates[0]! : -1;
    return {
      lines, categoryLine,
      facts: {
        id: t.id, description: t.description, notes: t.notes, date: t.date,
        amount: lines.reduce((s, l) => (l.amount > 0n ? s + l.amount : s), 0n),
        accountIds: [...new Set(lines.map((l) => l.accountId))],
        tags: tagRows.filter((g) => g.transaction_id === t.id).map((g) => g.tag),
        categorizable,
        categoryAccountId: categorizable ? lines[categoryLine]!.accountId : null,
      },
    };
  });
}

// ------------------------------------------------------------- planning

export type SkipReason = 'not_categorizable' | 'category_account_unavailable' | 'books_locked' | 'invalid';

export interface PlanItem {
  transactionId: string;
  description: string;
  date: string;
  evaluation: Evaluation;
  skipped: { action: 'set_category'; reason: SkipReason; ruleId: string }[];
}

/** A rule as the dry-run sees it: stored, or a draft supplied by the caller. */
export type PreviewRule = EvaluableRule;

export function toEvaluable(r: StoredRule): EvaluableRule {
  return {
    id: r.id, name: r.name, priority: r.priority, strict: r.strict, enabled: r.enabled,
    conditions: r.conditions, actions: r.actions,
  };
}

async function usableCategoryTargets(c: PoolClient, businessId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])
        AND archived_at IS NULL AND type IN ('income','expense')`, [businessId, ids]);
  return new Set(rows.map((r) => r.id));
}

/** Evaluate rules over loaded transactions. Reads only the accounts table. */
export async function planRules(
  c: PoolClient, businessId: string, rules: readonly EvaluableRule[], loaded: readonly LoadedTransaction[],
): Promise<{ item: PlanItem; txn: LoadedTransaction }[]> {
  const evals = loaded.map((txn) => ({ txn, evaluation: evaluateRules(rules, txn.facts) }));
  const targets = [...new Set(evals.flatMap((e) => (e.evaluation.category ? [e.evaluation.category.accountId] : [])))];
  const usable = await usableCategoryTargets(c, businessId, targets);

  const out: { item: PlanItem; txn: LoadedTransaction }[] = [];
  for (const { txn, evaluation } of evals) {
    const skipped: PlanItem['skipped'] = [];
    if (evaluation.uncategorizable) {
      skipped.push({ action: 'set_category', reason: 'not_categorizable', ruleId: evaluation.uncategorizable.ruleId });
    }
    if (evaluation.category && !usable.has(evaluation.category.accountId)) {
      skipped.push({ action: 'set_category', reason: 'category_account_unavailable', ruleId: evaluation.category.ruleId });
      evaluation.category = null;
    }
    if (evaluation.matchedRuleIds.length === 0) continue;
    out.push({
      txn,
      item: { transactionId: txn.facts.id, description: txn.facts.description, date: txn.facts.date, evaluation, skipped },
    });
  }
  return out;
}

/** Dry run: what would change. Writes nothing. */
export async function previewRules(
  c: PoolClient, businessId: string, rules: readonly EvaluableRule[], opts: ScanOptions,
): Promise<{ scanned: number; items: PlanItem[] }> {
  const loaded = await loadTransactions(c, businessId, opts, false);
  const plan = await planRules(c, businessId, rules, loaded);
  return { scanned: loaded.length, items: plan.map((p) => p.item) };
}

// --------------------------------------------------------------- applying

export interface ApplyResult {
  scanned: number;
  applied: { transactionId: string; ruleIds: string[]; category: boolean; notes: number; tags: number }[];
  skipped: { transactionId: string; reason: SkipReason }[];
}

/**
 * Apply the business's enabled stored rules. For each changed transaction, in
 * its own savepoint: recategorise via editTransaction (reversal + repost),
 * append notes, add tags, and write one `transaction.rule_apply` audit row
 * (editTransaction writes its own `transaction.edit` row as well). A
 * transaction that cannot be changed (e.g. books locked) is skipped and rolled
 * back alone.
 */
export async function applyRules(
  c: PoolClient, businessId: string, actor: string, opts: ScanOptions,
): Promise<ApplyResult> {
  const rules = (await listRules(c, businessId)).map(toEvaluable);
  const loaded = await loadTransactions(c, businessId, opts, true);
  const plan = await planRules(c, businessId, rules, loaded);
  const result: ApplyResult = { scanned: loaded.length, applied: [], skipped: [] };

  for (const { item, txn } of plan) {
    const ev = item.evaluation;
    for (const s of item.skipped) result.skipped.push({ transactionId: item.transactionId, reason: s.reason });
    if (!hasChanges(ev)) continue;

    await c.query('SAVEPOINT rule_apply');
    try {
      const edit: { lines?: LineInput[]; notes?: string } = {};
      if (ev.category) {
        edit.lines = txn.lines.map((l, i) => ({
          accountId: i === txn.categoryLine ? ev.category!.accountId : l.accountId, amount: l.amount, memo: l.memo ?? '',
        }));
      }
      if (ev.notes.length) edit.notes = appendNotes(txn.facts.notes, ev.notes);
      if (edit.lines || edit.notes !== undefined) {
        await editTransaction(c, businessId, actor, item.transactionId, edit);
      }
      for (const t of ev.tags) {
        await c.query(
          `INSERT INTO transaction_tags (business_id, transaction_id, tag) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`, [businessId, item.transactionId, t.tag]);
      }
      const ruleIds = [...new Set([
        ...(ev.category ? [ev.category.ruleId] : []), ...ev.notes.map((n) => n.ruleId), ...ev.tags.map((t) => t.ruleId),
      ])];
      await audit(c, businessId, actor, 'transaction.rule_apply', 'transaction', item.transactionId,
        { categoryAccountId: txn.facts.categoryAccountId, notes: txn.facts.notes, tags: txn.facts.tags },
        {
          categoryAccountId: ev.category?.accountId ?? txn.facts.categoryAccountId,
          notes: edit.notes ?? txn.facts.notes,
          tags: [...txn.facts.tags, ...ev.tags.map((t) => t.tag)],
          ruleIds, matchedRuleIds: ev.matchedRuleIds,
        });
      await c.query('RELEASE SAVEPOINT rule_apply');
      result.applied.push({
        transactionId: item.transactionId, ruleIds, category: ev.category !== null,
        notes: ev.notes.length, tags: ev.tags.length,
      });
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT rule_apply');
      await c.query('RELEASE SAVEPOINT rule_apply');
      const code = (err as { code?: string }).code;
      if (code === '55000') result.skipped.push({ transactionId: item.transactionId, reason: 'books_locked' });
      else if (err instanceof LedgerInputError) result.skipped.push({ transactionId: item.transactionId, reason: 'invalid' });
      else throw err;
    }
  }
  return result;
}
