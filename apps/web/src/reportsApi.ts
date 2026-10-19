// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError } from "./api";
import type { ReportResponse } from "./reportTypes";
import type { ReportKind } from "./router";

export type ReportQuery = Record<string, string>;

/** URL of a report endpoint. `format=csv` makes the browser download it (same-origin cookie auth applies). */
export function reportUrl(businessId: string, kind: ReportKind, query: ReportQuery, format?: "csv"): string {
  const params = new URLSearchParams(query);
  if (format) params.set("format", format);
  return `/api/businesses/${encodeURIComponent(businessId)}/reports/${kind}?${params.toString()}`;
}

export async function fetchReport<T>(
  businessId: string, kind: ReportKind, query: ReportQuery, fetchFn: typeof fetch = fetch,
): Promise<ReportResponse<T>> {
  const res = await fetchFn(reportUrl(businessId, kind, query), {
    credentials: "same-origin", headers: { accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return body as ReportResponse<T>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayIso = (): string => isoDate(new Date());
export const yearStartIso = (): string => `${new Date().getFullYear()}-01-01`;

/** A real calendar date in YYYY-MM-DD form. Round-trips through UTC so 2025-02-30 is rejected whatever the JS engine's lenient parsing does. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
