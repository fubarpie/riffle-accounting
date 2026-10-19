// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shapes of the report endpoints (mirrors the CSV layouts in apps/api/src/report-csv.ts). Amounts are minor-unit strings. */

export interface AccountAmount { code: string; name: string; amount: string }

export interface ProfitLossReport {
  income: AccountAmount[];
  expenses: AccountAmount[];
  totals: { income: string; expenses: string; netIncome: string };
}

export interface BalanceSheetReport {
  assets: AccountAmount[];
  liabilities: AccountAmount[];
  equity: AccountAmount[];
  currentEarnings: string;
  totals: { assets: string; liabilities: string; equity: string; liabilitiesAndEquity: string };
}

export interface TrialBalanceReport {
  rows: Array<{ code: string; name: string; type: string; debits: string; credits: string; debitBalance: string; creditBalance: string }>;
  totals: { debits: string; credits: string; debitBalance: string; creditBalance: string };
}

export interface GeneralLedgerReport {
  from: string;
  to: string;
  accounts: Array<{
    code: string; name: string; openingBalance: string; totalDebits: string; totalCredits: string; closingBalance: string;
    lines: Array<{ date: string; description: string; memo: string; debit: string; credit: string; balance: string }>;
  }>;
}

export interface TaxSummaryReport {
  rows: Array<{ code: string; name: string; type: string; debits: string; credits: string; net: string }>;
  totals: { debits: string; credits: string };
}

export interface ReportResponse<T> { currency: string; report: T }
