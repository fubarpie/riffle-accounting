// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hash routing: the API serves the built app as static files, so a hash needs
 * no server-side fallback rules.
 *   #/                      business list
 *   #/b/:id                 extractions of a business (upload + list)
 *   #/b/:id/dashboard       business dashboard
 *   #/b/:id/reports/:kind   one financial report
 *   #/b/:id/x/:eid          review one extraction
 *   #/b/:id/imports         Wave imports of a business (upload + list)
 *   #/b/:id/imports/:bid    review and approve one staged import
 */

export const REPORT_KINDS = ["profit-loss", "balance-sheet", "trial-balance", "general-ledger", "tax-summary"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(s: string | undefined): s is ReportKind {
  return s !== undefined && (REPORT_KINDS as readonly string[]).includes(s);
}

export type Route =
  | { name: "businesses" }
  | { name: "dashboard"; businessId: string }
  | { name: "reports"; businessId: string; kind: ReportKind }
  | { name: "extractions"; businessId: string }
  | { name: "review"; businessId: string; extractionId: string }
  | { name: "imports"; businessId: string }
  | { name: "import-review"; businessId: string; batchId: string }
  | { name: "not-found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length === 0) return { name: "businesses" };
  if (parts[0] === "b" && parts[1] !== undefined && UUID.test(parts[1])) {
    if (parts.length === 2) return { name: "extractions", businessId: parts[1] };
    if (parts[2] === "dashboard" && parts.length === 3) return { name: "dashboard", businessId: parts[1] };
    if (parts[2] === "reports") {
      if (parts.length === 3) return { name: "reports", businessId: parts[1], kind: "profit-loss" };
      if (parts.length === 4 && isReportKind(parts[3])) return { name: "reports", businessId: parts[1], kind: parts[3] };
      return { name: "not-found" };
    }
    if (parts[2] === "imports") {
      if (parts.length === 3) return { name: "imports", businessId: parts[1] };
      if (parts.length === 4 && parts[3] !== undefined && UUID.test(parts[3])) return { name: "import-review", businessId: parts[1], batchId: parts[3] };
    }
    if (parts.length === 4 && parts[2] === "x" && parts[3] !== undefined && UUID.test(parts[3])) {
      return { name: "review", businessId: parts[1], extractionId: parts[3] };
    }
  }
  return { name: "not-found" };
}

export const hrefFor = {
  businesses: () => "#/",
  dashboard: (businessId: string) => `#/b/${businessId}/dashboard`,
  reports: (businessId: string, kind: ReportKind) => `#/b/${businessId}/reports/${kind}`,
  extractions: (businessId: string) => `#/b/${businessId}`,
  review: (businessId: string, extractionId: string) => `#/b/${businessId}/x/${extractionId}`,
  imports: (businessId: string) => `#/b/${businessId}/imports`,
  importReview: (businessId: string, batchId: string) => `#/b/${businessId}/imports/${batchId}`,
};
