// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure helpers for the bulk tools on the Wave import screen (no React, so they can be unit-tested). */

export type AutoMapReason = "unknown_class" | "name_conflict" | "duplicate_in_file" | "ambiguous";

export interface AutoMapUnresolved {
  importAccountId: string;
  sourceName: string;
  sourceGroup: string;
  reason: AutoMapReason;
}

export interface AutoMapResult {
  mappedExisting: number;
  queuedCreate: number;
  unresolved: AutoMapUnresolved[];
}

export const AUTOMAP_REASON: Record<AutoMapReason, string> = {
  unknown_class: "the export's class is not one we recognise",
  name_conflict: "an account with that name already exists with a different type",
  duplicate_in_file: "another account in the export has the same name",
  ambiguous: "more than one existing account matches",
};

const SHOWN = 5;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One short paragraph saying what auto-map did, and which accounts still need a person. */
export function summarizeAutoMap(r: AutoMapResult): string {
  const parts: string[] = [];
  if (r.mappedExisting > 0) parts.push(`${count(r.mappedExisting, "account", "accounts")} matched to existing accounts`);
  if (r.queuedCreate > 0) parts.push(`${count(r.queuedCreate, "new account", "new accounts")} queued, created only when you approve`);
  let text = parts.length > 0 ? `${parts.join("; ")}.` : r.unresolved.length > 0 ? "Nothing could be mapped automatically." : "Every account already has a decision.";
  if (r.unresolved.length > 0) {
    const shown = r.unresolved.slice(0, SHOWN).map((u) => `"${u.sourceName}" (${AUTOMAP_REASON[u.reason]})`).join(", ");
    const more = r.unresolved.length - SHOWN;
    text += ` ${count(r.unresolved.length, "account still needs", "accounts still need")} your decision: ${shown}${more > 0 ? ` and ${more} more` : ""}.`;
  }
  return text;
}

/** A new selection with `id` flipped. Never mutates the old one (React state). */
export function toggleId(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export const allPicked = (ids: readonly string[], selection: ReadonlySet<string>): boolean =>
  ids.length > 0 && ids.every((id) => selection.has(id));

export function summarizeBulkExclude(changed: number, excluded: boolean): string {
  if (changed === 0) return `Nothing to change: those entries were already ${excluded ? "excluded" : "included"}.`;
  return `${count(changed, "entry", "entries")} ${excluded ? "excluded" : "included"}.`;
}
