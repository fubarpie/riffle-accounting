// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure logic for the Wave import screens (no React, so it can be unit-tested).
 * The server is the authority on every rule here: this only explains its answers
 * and keeps the buttons honest. Nothing below decides whether books may change.
 */
import { isWriter } from "./draft";
import type {
  AccountType, ApprovalBlockers, ImportAccount, ImportBatch, ImportBatchStatus, MappingDecision, Role,
} from "./types";

export const ACCOUNT_TYPES: readonly AccountType[] = ["asset", "liability", "equity", "income", "expense"];

export const BATCH_STATUS_LABEL: Record<ImportBatchStatus, string> = {
  staged: "Ready to review",
  approved: "Approved",
  rejected: "Rejected",
};

const SHOWN = 5;

function names(items: readonly { sourceName: string }[]): string {
  const shown = items.slice(0, SHOWN).map((i) => `"${i.sourceName}"`).join(", ");
  const more = items.length - SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One plain sentence per thing that stops approval; empty when nothing does. */
export function describeBlockers(b: ApprovalBlockers): string[] {
  const out: string[] = [];
  if (b.invalidEntries > 0) {
    out.push(`${plural(b.invalidEntries, "entry has", "entries have")} problems. Exclude ${b.invalidEntries === 1 ? "it" : "them"} or fix the source file and upload again.`);
  }
  if (b.unmappedAccounts.length > 0) {
    out.push(`${plural(b.unmappedAccounts.length, "account is", "accounts are")} not mapped yet: ${names(b.unmappedAccounts)}. Map each to an existing account or choose to create it.`);
  }
  if (b.archivedTargets.length > 0) {
    out.push(`Mapped to an archived account: ${names(b.archivedTargets)}. Pick a different account.`);
  }
  for (const m of b.classMismatches.slice(0, SHOWN)) {
    out.push(`"${m.sourceName}" is ${m.sourceGroup || "unclassified"} in the export but maps to a ${m.actual} account (expected ${m.expected}). Nothing is changed automatically; pick a ${m.expected} account.`);
  }
  if (b.classMismatches.length > SHOWN) out.push(`${b.classMismatches.length - SHOWN} more accounts have a class mismatch.`);
  if (b.lockedEntries) {
    const l = b.lockedEntries;
    out.push(`${plural(l.count, "entry is", "entries are")} dated on or before the books lock date (${l.lockedThrough}); the earliest is ${l.earliest}. Exclude ${l.count === 1 ? "it" : "them"} or move the lock date, then approve.`);
  }
  if (b.nothingToPost) out.push("Nothing would be posted: every entry is excluded, skipped or already imported.");
  return out;
}

export function hasBlockers(b: ApprovalBlockers): boolean {
  return describeBlockers(b).length > 0;
}

// ---------------------------------------------------------------- mapping

export type MappingChoice = { kind: "none" } | { kind: "target"; accountId: string } | { kind: "create" };

/** The `<select>` value for an account's current mapping. */
export function choiceValue(a: Pick<ImportAccount, "targetAccountId" | "createName">): string {
  if (a.targetAccountId) return `target:${a.targetAccountId}`;
  if (a.createName) return "create";
  return "";
}

export function parseChoice(value: string): MappingChoice {
  if (value === "create") return { kind: "create" };
  if (value.startsWith("target:") && value.length > "target:".length) return { kind: "target", accountId: value.slice("target:".length) };
  return { kind: "none" };
}

/** A class the server recognises, as the type to pre-select when creating. Unknown or blank gives undefined: the person must choose. */
export function suggestedType(sourceGroup: string): AccountType | undefined {
  const g = sourceGroup.trim().toLowerCase();
  return ACCOUNT_TYPES.find((t) => t === g);
}

/** Turns what the form holds into the request body, or an explanation of what is missing. */
export function toDecision(choice: MappingChoice, createName: string, createType: AccountType | ""): MappingDecision | { error: string } {
  if (choice.kind === "none") return { kind: "clear" };
  if (choice.kind === "target") return { kind: "target", accountId: choice.accountId };
  const name = createName.trim();
  if (!name) return { error: "Give the new account a name." };
  if (!createType) return { error: "Choose a type for the new account." };
  return { kind: "create", name, type: createType };
}

export const isMapped = (a: Pick<ImportAccount, "targetAccountId" | "createName">): boolean => a.targetAccountId !== null || a.createName !== null;

// --------------------------------------------------------------- approval

export function canApproveBatch(batch: ImportBatch, role: Role | undefined, ready: boolean): boolean {
  return isWriter(role) && batch.status === "staged" && ready;
}

export const canRejectBatch = (batch: ImportBatch, role: Role | undefined): boolean => isWriter(role) && batch.status === "staged";

/** The sentence shown after an approval succeeds. */
export function summarizeApproval(r: { posted: number; accountsCreated: number; alreadyImported: number }): string {
  const parts = [`Posted ${plural(r.posted, "entry", "entries")}`];
  if (r.accountsCreated > 0) parts.push(`created ${plural(r.accountsCreated, "account", "accounts")}`);
  if (r.alreadyImported > 0) parts.push(`skipped ${plural(r.alreadyImported, "entry", "entries")} an earlier import already posted`);
  return `${parts.join(", ")}.`;
}
