// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { api } from "../api";
import { useLoad } from "../hooks";
import { REPORT_KINDS, hrefFor, type ReportKind, type Route } from "../router";
import "../layout.css";

export const REPORT_LABELS: Record<ReportKind, string> = {
  "profit-loss": "Profit & Loss",
  "balance-sheet": "Balance Sheet",
  "trial-balance": "Trial Balance",
  "general-ledger": "General Ledger",
  "tax-summary": "Tax Summary",
};

const current = (on: boolean) => (on ? { "aria-current": "page" as const } : {});

/** Simple stroke icons drawn for this app (24x24 grid). */
const ICONS = {
  dashboard: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  transactions: "M4 7h16M4 12h16M4 17h10",
  reports: "M5 20V10M12 20V4M19 20v-7",
  upload: "M12 16V4m0 0L8 8m4-4l4 4M4 20h16",
  download: "M12 4v12m0 0l-4-4m4 4l4-4M4 20h16",
  home: "M4 20V9l8-5 8 5v11M9 20v-6h6v6",
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Sidebar shown on every page that belongs to one business. */
export function BusinessLayout({ businessId, route, children }: { businessId: string; route: Route; children: ReactNode }) {
  const { data } = useLoad(() => api.business(businessId), [businessId]);
  const name = data?.business.name ?? "…";
  return (
    <div className="biz">
      <nav className="side" aria-label="Business">
        <div className="biz-head">
          <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
          <p className="biz-name">{name}</p>
        </div>
        <a href={hrefFor.dashboard(businessId)} {...current(route.name === "dashboard")}><Icon name="dashboard" />Dashboard</a>
        <a href={hrefFor.transactions(businessId)} {...current(route.name === "transactions")}><Icon name="transactions" />Transactions</a>
        <h3>Reports</h3>
        {REPORT_KINDS.map((k) => (
          <a key={k} className="sub" href={hrefFor.reports(businessId, k)} {...current(route.name === "reports" && route.kind === k)}>{REPORT_LABELS[k]}</a>
        ))}
        <h3>Add your records</h3>
        <a href={hrefFor.extractions(businessId)} {...current(route.name === "extractions" || route.name === "review")}><Icon name="upload" />Upload a bank statement</a>
        <a href={hrefFor.imports(businessId)} {...current(route.name === "imports" || route.name === "import-review")}><Icon name="download" />Import from Wave</a>
        <h3>Switch</h3>
        <a href={hrefFor.businesses()}><Icon name="home" />All businesses</a>
      </nav>
      <div>{children}</div>
    </div>
  );
}
