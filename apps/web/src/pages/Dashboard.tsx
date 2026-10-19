// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "../api";
import { REPORT_LABELS } from "../components/BusinessLayout";
import { useLoad } from "../hooks";
import { currencyExponent, formatMinor } from "../money";
import type { BalanceSheetReport, ProfitLossReport } from "../reportTypes";
import { fetchReport, todayIso, yearStartIso } from "../reportsApi";
import { REPORT_KINDS, hrefFor } from "../router";

const DESCRIPTIONS = {
  "profit-loss": "Income and expenses over a period",
  "balance-sheet": "Assets, liabilities and equity at a date",
  "trial-balance": "Debits and credits per account",
  "general-ledger": "Every posting, account by account",
  "tax-summary": "Totals per account for tax time",
} as const;

export function Dashboard({ businessId }: { businessId: string }) {
  const { data, error, loading } = useLoad(async () => {
    const from = yearStartIso();
    const to = todayIso();
    const [business, pl, bs] = await Promise.all([
      api.business(businessId),
      fetchReport<ProfitLossReport>(businessId, "profit-loss", { from, to }),
      fetchReport<BalanceSheetReport>(businessId, "balance-sheet", { asOf: to }),
    ]);
    return { business: business.business, pl, bs, from };
  }, [businessId]);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <p className="msg error" role="alert">{error}</p>;
  if (!data) return null;

  const { business, pl, bs, from } = data;
  const exp = currencyExponent(business.currency);
  const money = (v: string) => formatMinor(String(v), exp);
  const empty = [pl.report.totals.income, pl.report.totals.expenses, bs.report.totals.assets, bs.report.totals.liabilities]
    .every((v) => /^-?0+$/.test(String(v)));

  return (
    <>
      <h1>{business.name}</h1>
      <p className="muted">Currency {business.currency} · your role: {business.role}</p>
      {empty && (
        <p className="msg warn">
          Nothing has been posted yet, so every figure is zero. Bring in your books with{" "}
          <a href={hrefFor.imports(businessId)}>Wave import</a> or <a href={hrefFor.extractions(businessId)}>Statement uploads</a>.
        </p>
      )}
      <h2>Year to date ({from} to today)</h2>
      <div className="stats">
        <div className="stat"><div className="label">Income</div><div className="value">{money(pl.report.totals.income)}</div></div>
        <div className="stat"><div className="label">Expenses</div><div className="value">{money(pl.report.totals.expenses)}</div></div>
        <div className="stat"><div className="label">Net income</div><div className="value">{money(pl.report.totals.netIncome)}</div></div>
      </div>
      <h2>Balance sheet (today)</h2>
      <div className="stats">
        <div className="stat"><div className="label">Assets</div><div className="value">{money(bs.report.totals.assets)}</div></div>
        <div className="stat"><div className="label">Liabilities</div><div className="value">{money(bs.report.totals.liabilities)}</div></div>
        <div className="stat"><div className="label">Equity</div><div className="value">{money(bs.report.totals.equity)}</div></div>
      </div>
      <h2>Reports</h2>
      <div className="grid-links">
        {REPORT_KINDS.map((k) => (
          <a key={k} href={hrefFor.reports(businessId, k)}>{REPORT_LABELS[k]}<small>{DESCRIPTIONS[k]}</small></a>
        ))}
      </div>
      <h2>Bring in data</h2>
      <div className="grid-links">
        <a href={hrefFor.imports(businessId)}>Wave import<small>Upload a Wave journal export and review it before posting</small></a>
        <a href={hrefFor.extractions(businessId)}>Statement uploads<small>Upload a bank statement and check the extracted lines</small></a>
      </div>
    </>
  );
}
