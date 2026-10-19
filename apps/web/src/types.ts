// SPDX-License-Identifier: AGPL-3.0-or-later
/** Response shapes of the extraction API (apps/api/src/routes/extractions.ts). Amounts are decimal strings of minor units. */

export type Role = "owner" | "admin" | "bookkeeper" | "viewer";
export type ExtractionStatus = "pending" | "staged" | "flagged" | "approved" | "rejected";

export interface User { id: string; email: string; name: string }
export interface BusinessSummary { id: string; name: string; currency: string; role: Role }
export interface Account { id: string; code: string | null; name: string; type: string; currency: string; archived_at: string | null }

export interface Extraction {
  id: string;
  businessId: string;
  accountId: string;
  documentId: string | null;
  status: ExtractionStatus;
  extractorName: string;
  extractorModel: string;
  periodStart: string;
  periodEnd: string;
  openingBalanceMinor: string;
  closingBalanceMinor: string;
  currency: string | null;
  validation: unknown;
  validationOk: boolean;
  validatedAt: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionLine {
  id: string;
  extractionId: string;
  lineNo: number;
  date: string;
  description: string;
  amountMinor: string;
  amountInvalid: boolean;
  alreadyRecorded: boolean;
}

export interface ExtractionDetail { extraction: Extraction; lines: ExtractionLine[] }

export interface ApproveResult extends ExtractionDetail {
  alreadyApproved: boolean;
  posted: number;
  skippedAlreadyRecorded?: number;
  transactionIds?: string[];
}

export interface GateReason { code: string; message: string; lineIndex?: number }
export interface GateView { ok: boolean; reasons: GateReason[]; differenceMinor: string | null }

export interface PatchBody {
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: string;
  closingBalance?: string;
  lines?: { date: string; description: string; amountMinor: string; alreadyRecorded: boolean }[];
}

export interface UploadParams {
  accountId: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: string;
  closingBalance?: string;
}

// ------------------------------------------------------------- Wave imports
/** Response shapes of apps/api/src/routes/imports.ts. Dates are ISO strings; amounts are decimal strings of minor units. */
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type ImportBatchStatus = "staged" | "approved" | "rejected";

export interface ImportBatch {
  id: string;
  source: string;
  fileSha256: string;
  status: ImportBatchStatus;
  summary: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
}
export interface ImportCounts { entries: number; valid: number; invalid: number; skipped: number; excluded: number }
export interface ImportReadiness { invalidEntries: number; unmappedAccounts: number; ready: boolean }
export interface ImportAccount {
  id: string;
  sourceName: string;
  sourceGroup: string;
  sourceType: string;
  accountRefLast4: string | null;
  targetAccountId: string | null;
  createName: string | null;
  createType: AccountType | null;
  lineCount: number;
}
export interface ImportBatchDetail { batch: ImportBatch; counts: ImportCounts; blockers: ImportReadiness; accounts: ImportAccount[] }
export interface ImportIssue { severity: "error" | "warning"; code: string; message: string; row?: number }
export interface ImportEntryLine { lineNo: number; importAccountId: string; amountMinor: string; memo: string }
export interface ImportEntry {
  id: string;
  externalId: string;
  date: string | null;
  description: string;
  status: "valid" | "invalid" | "skipped";
  issues: ImportIssue[];
  excluded: boolean;
  transactionId: string | null;
  lines: ImportEntryLine[];
}
export type MappingDecision =
  | { kind: "target"; accountId: string }
  | { kind: "create"; name: string; type: AccountType }
  | { kind: "clear" };

/** Body of a 409 refusal to approve: every reason at once. */
export interface ApprovalBlockers {
  invalidEntries: number;
  unmappedAccounts: { importAccountId: string; sourceName: string }[];
  archivedTargets: { importAccountId: string; sourceName: string }[];
  classMismatches: { importAccountId: string; sourceName: string; sourceGroup: string; expected: AccountType; actual: AccountType }[];
  lockedEntries: { count: number; lockedThrough: string; earliest: string } | null;
  nothingToPost: boolean;
}
export interface ImportApprovalResult {
  batch: ImportBatch;
  counts: ImportCounts;
  posted: number;
  accountsCreated: number;
  alreadyImported: number;
}
