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
