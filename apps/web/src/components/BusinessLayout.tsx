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

/** Sidebar shown on every page that belongs to one business. */
export function BusinessLayout({ businessId, route, children }: { businessId: string; route: Route; children: ReactNode }) {
  const { data } = useLoad(() => api.business(businessId), [businessId]);
  return (
    <div className="biz">
      <nav className="side" aria-label="Business">
        <p className="biz-name">{data?.business.name ?? "…"}</p>
        <a href={hrefFor.dashboard(businessId)} {...current(route.name === "dashboard")}>Dashboard</a>
        <h3>Reports</h3>
        {REPORT_KINDS.map((k) => (
          <a key={k} href={hrefFor.reports(businessId, k)} {...current(route.name === "reports" && route.kind === k)}>{REPORT_LABELS[k]}</a>
        ))}
        <h3>Import</h3>
        <a href={hrefFor.extractions(businessId)} {...current(route.name === "extractions" || route.name === "review")}>Statement uploads</a>
        <a href={hrefFor.imports(businessId)} {...current(route.name === "imports" || route.name === "import-review")}>Wave import</a>
        <h3>Switch</h3>
        <a href={hrefFor.businesses()}>All businesses</a>
      </nav>
      <div>{children}</div>
    </div>
  );
}
