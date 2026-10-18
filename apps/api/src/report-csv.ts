// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BalanceSheet, GeneralLedger, ProfitLoss, TaxSummary, TrialBalance,
} from "@riffle/db";
import { type Cell, toCsv } from "./csv";

/** CSV layouts for each report. Money columns are integer minor units; the currency is a column, not a unit conversion. */

export function trialBalanceCsv(r: TrialBalance, currency: string): string {
  const rows: Cell[][] = [["Code", "Account", "Type", "Currency", "Debits", "Credits", "Debit balance", "Credit balance"]];
  for (const x of r.rows) rows.push([x.code, x.name, x.type, currency, x.debits, x.credits, x.debitBalance, x.creditBalance]);
  rows.push(["", "Total", "", currency, r.totals.debits, r.totals.credits, r.totals.debitBalance, r.totals.creditBalance]);
  return toCsv(rows);
}

export function profitLossCsv(r: ProfitLoss, currency: string): string {
  const rows: Cell[][] = [["Section", "Code", "Account", "Currency", "Amount"]];
  for (const x of r.income) rows.push(["Income", x.code, x.name, currency, x.amount]);
  rows.push(["Total income", "", "", currency, r.totals.income]);
  for (const x of r.expenses) rows.push(["Expenses", x.code, x.name, currency, x.amount]);
  rows.push(["Total expenses", "", "", currency, r.totals.expenses]);
  rows.push(["Net income", "", "", currency, r.totals.netIncome]);
  return toCsv(rows);
}

export function balanceSheetCsv(r: BalanceSheet, currency: string): string {
  const rows: Cell[][] = [["Section", "Code", "Account", "Currency", "Amount"]];
  for (const x of r.assets) rows.push(["Assets", x.code, x.name, currency, x.amount]);
  rows.push(["Total assets", "", "", currency, r.totals.assets]);
  for (const x of r.liabilities) rows.push(["Liabilities", x.code, x.name, currency, x.amount]);
  rows.push(["Total liabilities", "", "", currency, r.totals.liabilities]);
  for (const x of r.equity) rows.push(["Equity", x.code, x.name, currency, x.amount]);
  rows.push(["Equity", "", "Current earnings", currency, r.currentEarnings]);
  rows.push(["Total equity", "", "", currency, r.totals.equity]);
  rows.push(["Total liabilities and equity", "", "", currency, r.totals.liabilitiesAndEquity]);
  return toCsv(rows);
}

export function generalLedgerCsv(r: GeneralLedger, currency: string): string {
  const rows: Cell[][] = [["Code", "Account", "Date", "Description", "Memo", "Currency", "Debit", "Credit", "Balance"]];
  for (const a of r.accounts) {
    rows.push([a.code, a.name, r.from, "Opening balance", "", currency, "", "", a.openingBalance]);
    for (const l of a.lines) rows.push([a.code, a.name, l.date, l.description, l.memo, currency, l.debit, l.credit, l.balance]);
    rows.push([a.code, a.name, r.to, "Closing balance", "", currency, a.totalDebits, a.totalCredits, a.closingBalance]);
  }
  return toCsv(rows);
}

export function taxSummaryCsv(r: TaxSummary, currency: string): string {
  const rows: Cell[][] = [["Code", "Account", "Type", "Currency", "Debits", "Credits", "Net"]];
  for (const x of r.rows) rows.push([x.code, x.name, x.type, currency, x.debits, x.credits, x.net]);
  rows.push(["", "Total", "", currency, r.totals.debits, r.totals.credits, ""]);
  return toCsv(rows);
}
