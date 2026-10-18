/**
 * Rule definitions: the shapes stored in rules.conditions / rules.actions, and
 * a strict validator for untrusted input. Pure: no I/O.
 *
 * Money is carried as decimal strings of minor units ("1250" = 12.50 USD)
 * because JSON cannot hold a bigint. One currency per business, so no
 * currency field exists.
 */

export type DescriptionOp = 'contains' | 'starts_with' | 'regex';
export type AmountOp = 'equals' | 'gt' | 'lt' | 'between';
export type DateOp = 'equals' | 'before' | 'after' | 'between';

export type Condition =
  | { type: 'description'; op: DescriptionOp; value: string; caseSensitive?: boolean }
  | { type: 'amount'; op: 'equals' | 'gt' | 'lt'; value: string }
  | { type: 'amount'; op: 'between'; min: string; max: string }
  | { type: 'account'; accountId: string }
  | { type: 'date'; op: 'equals' | 'before' | 'after'; value: string }
  | { type: 'date'; op: 'between'; min: string; max: string };

export type Action =
  | { type: 'set_category'; accountId: string }
  | { type: 'add_note'; text: string }
  | { type: 'add_tag'; tag: string };

export interface RuleDefinition {
  name: string;
  priority: number;
  /** true: every condition must match. false: any one is enough. */
  strict: boolean;
  enabled: boolean;
  conditions: Condition[];
  actions: Action[];
}

export const LIMITS = {
  nameMax: 120,
  conditionsMax: 20,
  actionsMax: 10,
  textMax: 200,
  regexMax: 200,
  noteMax: 500,
  tagMax: 40,
  priorityMax: 100_000,
} as const;

/** Input was structurally invalid. `issues` are safe to show to the caller. */
export class RuleValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINOR = /^\d{1,15}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function isIsoDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Regexes run on the API thread, and JavaScript has no linear-time engine in
 * core, so patterns are bounded and the classic catastrophic shapes refused:
 * a quantified group that itself contains a quantifier, and back-references.
 * This is a defence in depth with the length caps in the evaluator, not a proof.
 */
export function regexProblem(pattern: string): string | undefined {
  if (pattern.length === 0) return 'regex must not be empty';
  if (pattern.length > LIMITS.regexMax) return `regex is longer than ${LIMITS.regexMax} characters`;
  if (/\\[1-9]|\\k</.test(pattern)) return 'regex back-references are not supported';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(pattern)) {
    return 'regex has a nested quantifier, which is not supported';
  }
  try {
    new RegExp(pattern, 'i');
  } catch {
    return 'regex does not compile';
  }
  return undefined;
}

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Collector {
  readonly issues: string[] = [];
  add(path: string, msg: string): void {
    this.issues.push(`${path}: ${msg}`);
  }
}

function exactKeys(o: Obj, allowed: readonly string[], path: string, c: Collector): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) c.add(path, `unknown field "${k}"`);
}

function oneOf<T extends string>(v: unknown, opts: readonly T[], path: string, c: Collector): T | undefined {
  if (typeof v === 'string' && (opts as readonly string[]).includes(v)) return v as T;
  c.add(path, `must be one of ${opts.join(', ')}`);
  return undefined;
}

function minor(v: unknown, path: string, c: Collector): string | undefined {
  if (typeof v === 'string' && MINOR.test(v)) return v;
  c.add(path, 'must be a non-negative integer string of minor units (e.g. "1250")');
  return undefined;
}

function isoDate(v: unknown, path: string, c: Collector): string | undefined {
  if (typeof v === 'string' && isIsoDate(v)) return v;
  c.add(path, 'must be a valid YYYY-MM-DD date');
  return undefined;
}

function text(v: unknown, max: number, path: string, c: Collector): string | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) {
    c.add(path, 'must be a non-empty string');
    return undefined;
  }
  if (v.length > max) {
    c.add(path, `must be at most ${max} characters`);
    return undefined;
  }
  if (CONTROL.test(v)) {
    c.add(path, 'must not contain control characters');
    return undefined;
  }
  return v;
}

function parseCondition(raw: unknown, path: string, c: Collector): Condition | undefined {
  if (!isObj(raw)) {
    c.add(path, 'must be an object');
    return undefined;
  }
  const type = oneOf(raw.type, ['description', 'amount', 'account', 'date'] as const, `${path}.type`, c);
  switch (type) {
    case 'description': {
      exactKeys(raw, ['type', 'op', 'value', 'caseSensitive'], path, c);
      const op = oneOf(raw.op, ['contains', 'starts_with', 'regex'] as const, `${path}.op`, c);
      const value = text(raw.value, op === 'regex' ? LIMITS.regexMax : LIMITS.textMax, `${path}.value`, c);
      let cs: boolean | undefined;
      if (raw.caseSensitive !== undefined) {
        if (typeof raw.caseSensitive === 'boolean') cs = raw.caseSensitive;
        else c.add(`${path}.caseSensitive`, 'must be a boolean');
      }
      if (op === 'regex' && value !== undefined) {
        const problem = regexProblem(value);
        if (problem) c.add(`${path}.value`, problem);
      }
      return op && value !== undefined
        ? { type, op, value, ...(cs !== undefined ? { caseSensitive: cs } : {}) }
        : undefined;
    }
    case 'amount': {
      exactKeys(raw, ['type', 'op', 'value', 'min', 'max'], path, c);
      const op = oneOf(raw.op, ['equals', 'gt', 'lt', 'between'] as const, `${path}.op`, c);
      if (op === 'between') {
        const min = minor(raw.min, `${path}.min`, c);
        const max = minor(raw.max, `${path}.max`, c);
        if (min !== undefined && max !== undefined && BigInt(min) > BigInt(max)) c.add(path, 'min must not exceed max');
        return min !== undefined && max !== undefined ? { type, op, min, max } : undefined;
      }
      const value = minor(raw.value, `${path}.value`, c);
      return op && value !== undefined ? { type, op, value } : undefined;
    }
    case 'account': {
      exactKeys(raw, ['type', 'accountId'], path, c);
      if (typeof raw.accountId === 'string' && UUID.test(raw.accountId)) return { type, accountId: raw.accountId.toLowerCase() };
      c.add(`${path}.accountId`, 'must be a UUID');
      return undefined;
    }
    case 'date': {
      exactKeys(raw, ['type', 'op', 'value', 'min', 'max'], path, c);
      const op = oneOf(raw.op, ['equals', 'before', 'after', 'between'] as const, `${path}.op`, c);
      if (op === 'between') {
        const min = isoDate(raw.min, `${path}.min`, c);
        const max = isoDate(raw.max, `${path}.max`, c);
        if (min !== undefined && max !== undefined && min > max) c.add(path, 'min must not be after max');
        return min !== undefined && max !== undefined ? { type, op, min, max } : undefined;
      }
      const value = isoDate(raw.value, `${path}.value`, c);
      return op && value !== undefined ? { type, op, value } : undefined;
    }
    default:
      return undefined;
  }
}

function parseAction(raw: unknown, path: string, c: Collector): Action | undefined {
  if (!isObj(raw)) {
    c.add(path, 'must be an object');
    return undefined;
  }
  const type = oneOf(raw.type, ['set_category', 'add_note', 'add_tag'] as const, `${path}.type`, c);
  switch (type) {
    case 'set_category':
      exactKeys(raw, ['type', 'accountId'], path, c);
      if (typeof raw.accountId === 'string' && UUID.test(raw.accountId)) return { type, accountId: raw.accountId.toLowerCase() };
      c.add(`${path}.accountId`, 'must be a UUID');
      return undefined;
    case 'add_note': {
      exactKeys(raw, ['type', 'text'], path, c);
      const t = text(raw.text, LIMITS.noteMax, `${path}.text`, c);
      return t !== undefined ? { type, text: t.trim() } : undefined;
    }
    case 'add_tag': {
      exactKeys(raw, ['type', 'tag'], path, c);
      const t = text(raw.tag, LIMITS.tagMax * 2, `${path}.tag`, c);
      if (t === undefined) return undefined;
      const tag = normalizeTag(t);
      if (tag.length === 0 || tag.length > LIMITS.tagMax) {
        c.add(`${path}.tag`, `must be 1 to ${LIMITS.tagMax} characters`);
        return undefined;
      }
      return { type, tag };
    }
    default:
      return undefined;
  }
}

function parseList<T>(
  raw: unknown, max: number, path: string, c: Collector,
  one: (r: unknown, p: string, c: Collector) => T | undefined,
): T[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    c.add(path, 'must be a non-empty array');
    return [];
  }
  if (raw.length > max) {
    c.add(path, `must have at most ${max} items`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((r, i) => {
    const v = one(r, `${path}[${i}]`, c);
    if (v !== undefined) out.push(v);
  });
  return out;
}

/** Validate conditions on their own (used when loading stored rules). */
export function parseConditions(raw: unknown): Condition[] {
  const c = new Collector();
  const out = parseList(raw, LIMITS.conditionsMax, 'conditions', c, parseCondition);
  if (c.issues.length) throw new RuleValidationError(c.issues);
  return out;
}

export function parseActions(raw: unknown): Action[] {
  const c = new Collector();
  const out = parseList(raw, LIMITS.actionsMax, 'actions', c, parseAction);
  validateActionSet(out, c);
  if (c.issues.length) throw new RuleValidationError(c.issues);
  return out;
}

function validateActionSet(actions: Action[], c: Collector): void {
  // A transaction has one category, so a rule may carry at most one setter.
  if (actions.filter((a) => a.type === 'set_category').length > 1) {
    c.add('actions', 'a rule may contain at most one set_category action');
  }
}

/**
 * Validate a complete rule. With `partial`, absent top-level fields are left
 * out of the result (PATCH semantics); otherwise defaults are applied.
 */
export function parseRuleDefinition(raw: unknown): RuleDefinition;
export function parseRuleDefinition(raw: unknown, partial: true): Partial<RuleDefinition>;
export function parseRuleDefinition(raw: unknown, partial = false): Partial<RuleDefinition> {
  const c = new Collector();
  if (!isObj(raw)) throw new RuleValidationError(['body: must be an object']);
  exactKeys(raw, ['name', 'priority', 'strict', 'enabled', 'conditions', 'actions'], 'body', c);
  const out: Partial<RuleDefinition> = {};

  if (raw.name !== undefined || !partial) {
    const n = text(raw.name, LIMITS.nameMax, 'name', c);
    if (n !== undefined) out.name = n.trim();
  }
  if (raw.priority !== undefined || !partial) {
    const p = raw.priority ?? 100;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= LIMITS.priorityMax) out.priority = p;
    else c.add('priority', `must be an integer from 0 to ${LIMITS.priorityMax}`);
  }
  for (const k of ['strict', 'enabled'] as const) {
    if (raw[k] !== undefined || !partial) {
      const v = raw[k] ?? true;
      if (typeof v === 'boolean') out[k] = v;
      else c.add(k, 'must be a boolean');
    }
  }
  if (raw.conditions !== undefined || !partial) {
    out.conditions = parseList(raw.conditions, LIMITS.conditionsMax, 'conditions', c, parseCondition);
  }
  if (raw.actions !== undefined || !partial) {
    out.actions = parseList(raw.actions, LIMITS.actionsMax, 'actions', c, parseAction);
    validateActionSet(out.actions, c);
  }
  if (c.issues.length) throw new RuleValidationError(c.issues);
  return out;
}
