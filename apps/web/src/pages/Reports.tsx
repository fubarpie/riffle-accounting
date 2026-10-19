// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment, useState } from "react";
import { REPORT_LABELS } from "../components/BusinessLayout";
import { useLoad } from "../hooks";
import { currencyExponent, formatMinor } from "../money";
import type {
  AccountAmount, BalanceSheetReport, GeneralLedgerReport, ProfitLossReport, TaxSummaryReport, TrialBalanceReport,
} from "../reportTypes";
import { fetchReport, isIsoDate, reportUrl, todayIso, yearStartIso } from "../reportsApi";
import { REPORT_KINDS, hrefFor, type ReportKind } from "../router";

type Fmt = (v: string) => string;

function Num({ v, fmt }: { v: string; fmt: Fmt }) {
  return <td className="num">{fmt(String(v))}</td>;
}

function Lines({ title, rows, fmt }: { title: string; rows: AccountAmount[]; fmt: Fmt }) {
  return (
    <>
      <tr className="section"><th colSpan={3}>{title}</th></tr>
      {rows.length === 0 && <tr><td colSpan={3} className="muted">None</td></tr>}
      {rows.map((r) => <tr key={r.code}><td>{r.code}</td><td>{r.name}</td><Num v={r.amount} fmt={fmt} /></tr>)}
    </>
  );
}

function Total({ label, v, fmt }: { label: string; v: string; fmt: Fmt }) {
  return <tr className="total"><td /><td>{label}</td><Num v={v} fmt={fmt} /></tr>;
}

const Head = () => <thead><tr><th>Code</th><th>Account</th><th className="num">Amount</th></tr></thead>;

function ProfitLoss({ r, fmt }: { r: ProfitLossReport; fmt: Fmt }) {
  return (
    <table><Head /><tbody>
      <Lines title="Income" rows={r.income} fmt={fmt} />
      <Total label="Total income" v={r.totals.income} fmt={fmt} />
      <Lines title="Expenses" rows={r.expenses} fmt={fmt} />
      <Total label="Total expenses" v={r.totals.expenses} fmt={fmt} />
      <Total label="Net income" v={r.totals.netIncome} fmt={fmt} />
    </tbody></table>
  );
}

function BalanceSheet({ r, fmt }: { r: BalanceSheetReport; fmt: Fmt }) {
  return (
    <table><Head /><tbody>
      <Lines title="Assets" rows={r.assets} fmt={fmt} />
      <Total label="Total assets" v={r.totals.assets} fmt={fmt} />
      <Lines title="Liabilities" rows={r.liabilities} fmt={fmt} />
      <Total label="Total liabilities" v={r.totals.liabilities} fmt={fmt} />
      <Lines title="Equity" rows={r.equity} fmt={fmt} />
      <tr><td /><td>Current earnings</td><Num v={r.currentEarnings} fmt={fmt} /></tr>
      <Total label="Total equity" v={r.totals.equity} fmt={fmt} />
      <Total label="Total liabilities and equity" v={r.totals.liabilitiesAndEquity} fmt={fmt} />
    </tbody></table>
  );
}

function TrialBalance({ r, fmt }: { r: TrialBalanceReport; fmt: Fmt }) {
  return (
    <table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Debit balance</th><th className="num">Credit balance</th></tr></thead>
      <tbody>
        {r.rows.map((x) => (
          <tr key={x.code}><td>{x.code}</td><td>{x.name}</td><td>{x.type}</td>
            <Num v={x.debits} fmt={fmt} /><Num v={x.credits} fmt={fmt} /><Num v={x.debitBalance} fmt={fmt} /><Num v={x.creditBalance} fmt={fmt} /></tr>
        ))}
        <tr className="total"><td /><td>Total</td><td />
          <Num v={r.totals.debits} fmt={fmt} /><Num v={r.totals.credits} fmt={fmt} /><Num v={r.totals.debitBalance} fmt={fmt} /><Num v={r.totals.creditBalance} fmt={fmt} /></tr>
      </tbody>
    </table>
  );
}

function GeneralLedger({ r, fmt }: { r: GeneralLedgerReport; fmt: Fmt }) {
  if (r.accounts.length === 0) return <p className="muted">No postings in this period.</p>;
  return (
    <>
      {r.accounts.map((a) => (
        <Fragment key={a.code}>
          <h2>{a.code} · {a.name}</h2>
          <table>
            <thead><tr><th>Date</th><th>Description</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr><td>{r.from}</td><td className="muted">Opening balance</td><td /><td /><td /><Num v={a.openingBalance} fmt={fmt} /></tr>
              {a.lines.map((l, i) => (
                <tr key={i}><td>{l.date}</td><td>{l.description}</td><td>{l.memo}</td>
                  <Num v={l.debit} fmt={fmt} /><Num v={l.credit} fmt={fmt} /><Num v={l.balance} fmt={fmt} /></tr>
              ))}
              <tr className="total"><td>{r.to}</td><td>Closing balance</td><td />
                <Num v={a.totalDebits} fmt={fmt} /><Num v={a.totalCredits} fmt={fmt} /><Num v={a.closingBalance} fmt={fmt} /></tr>
            </tbody>
          </table>
        </Fragment>
      ))}
    </>
  );
}

function TaxSummary({ r, fmt }: { r: TaxSummaryReport; fmt: Fmt }) {
  return (
    <table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Net</th></tr></thead>
      <tbody>
        {r.rows.map((x) => (
          <tr key={x.code}><td>{x.code}</td><td>{x.name}</td><td>{x.type}</td>
            <Num v={x.debits} fmt={fmt} /><Num v={x.credits} fmt={fmt} /><Num v={x.net} fmt={fmt} /></tr>
        ))}
        <tr className="total"><td /><td>Total</td><td /><Num v={r.totals.debits} fmt={fmt} /><Num v={r.totals.credits} fmt={fmt} /><td /></tr>
      </tbody>
    </table>
  );
}

/** One financial report with a date picker and CSV download. Remounted per report kind (see App.tsx). */
export function Reports({ businessId, kind }: { businessId: string; kind: ReportKind }) {
  const usesAsOf = kind === "balance-sheet" || kind === "trial-balance";
  const [asOf, setAsOf] = useState(todayIso);
  const [from, setFrom] = useState(yearStartIso);
  const [to, setTo] = useState(todayIso);
  const query: Record<string, string> = usesAsOf ? { asOf } : { from, to };
  const valid = usesAsOf ? isIsoDate(asOf) : isIsoDate(from) && isIsoDate(to) && from <= to;

  const { data, error, loading } = useLoad(
    () => (valid ? fetchReport<unknown>(businessId, kind, query) : Promise.resolve(undefined)),
    [businessId, kind, asOf, from, to, valid],
  );

  const fmt: Fmt | undefined = data ? ((v) => formatMinor(v, currencyExponent(data.currency))) : undefined;

  return (
    <>
      <h1>{REPORT_LABELS[kind]}</h1>
      <div className="report-tabs">
        {REPORT_KINDS.map((k) => (
          <a key={k} href={hrefFor.reports(businessId, k)} {...(k === kind ? { "aria-current": "page" as const } : {})}>{REPORT_LABELS[k]}</a>
        ))}
      </div>
      <div className="row">
        {usesAsOf ? (
          <label>As of<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        ) : (
          <>
            <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        {valid && <a href={reportUrl(businessId, kind, query, "csv")} download>Download CSV</a>}
      </div>
      {!valid && <p className="msg warn">Pick a valid date{usesAsOf ? "" : " range (From must not be after To)"}.</p>}
      {error && <p className="msg error" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {valid && data && fmt && (
        <div style={{ opacity: loading ? 0.5 : 1, marginTop: "1rem" }}>
          {kind === "profit-loss" && <ProfitLoss r={data.report as ProfitLossReport} fmt={fmt} />}
          {kind === "balance-sheet" && <BalanceSheet r={data.report as BalanceSheetReport} fmt={fmt} />}
          {kind === "trial-balance" && <TrialBalance r={data.report as TrialBalanceReport} fmt={fmt} />}
          {kind === "general-ledger" && <GeneralLedger r={data.report as GeneralLedgerReport} fmt={fmt} />}
          {kind === "tax-summary" && <TaxSummary r={data.report as TaxSummaryReport} fmt={fmt} />}
          <p className="muted">Amounts in {data.currency}.</p>
        </div>
      )}
    </>
  );
}
