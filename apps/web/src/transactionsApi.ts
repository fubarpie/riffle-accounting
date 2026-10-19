// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError } from "./api";
import { isIsoDate } from "./reportsApi";
import type { TransactionKind, TransactionList } from "./types";

export const TRANSACTION_KINDS: readonly TransactionKind[] = ["deposit", "withdrawal", "transfer", "journal"];
export const TRANSACTION_STATUSES = ["live", "voided", "all"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const TRANSACTION_SORTS = ["date", "amount", "description"] as const;
export type TransactionSort = (typeof TRANSACTION_SORTS)[number];
export type SortDir = "asc" | "desc";

/** Rows per page; the API accepts 1-100. */
export const PAGE_SIZE = 50;

export interface TransactionFilters {
  q: string;
  from: string;
  to: string;
  kind: TransactionKind | "";
  accountId: string;
  status: TransactionStatus;
  sort: TransactionSort;
  dir: SortDir;
  /** 1-based page number. */
  page: number;
}

export const DEFAULTS: Readonly<TransactionFilters> = {
  q: "", from: "", to: "", kind: "", accountId: "", status: "live", sort: "date", dir: "desc", page: 1,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_Q = 200;
const MAX_PAGE = 1_000_000;

export const pageToOffset = (page: number, limit: number = PAGE_SIZE): number => Math.max(0, Math.floor(page) - 1) * limit;
export const offsetToPage = (offset: number, limit: number = PAGE_SIZE): number => Math.floor(Math.max(0, offset) / limit) + 1;
export const pageCount = (total: number, limit: number = PAGE_SIZE): number => Math.max(1, Math.ceil(total / limit));

/** Query params for the API: defaults and empty values are omitted. */
export function buildQuery(f: TransactionFilters): Record<string, string> {
  const out: Record<string, string> = {};
  const q = f.q.trim();
  if (q) out.q = q;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.kind) out.kind = f.kind;
  if (f.accountId) out.accountId = f.accountId;
  if (f.status !== DEFAULTS.status) out.status = f.status;
  if (f.sort !== DEFAULTS.sort) out.sort = f.sort;
  if (f.dir !== DEFAULTS.dir) out.dir = f.dir;
  const offset = pageToOffset(f.page);
  if (offset > 0) out.offset = String(offset);
  return out;
}

/** Query part of the page hash: same as the API query but with `page` instead of `offset`/`limit`. */
export function filtersToParams(f: TransactionFilters): Record<string, string> {
  const rest = buildQuery(f);
  delete rest.offset;
  if (f.page > 1) rest.page = String(f.page);
  return rest;
}

export function filtersToHash(businessId: string, f: TransactionFilters): string {
  const qs = new URLSearchParams(filtersToParams(f)).toString();
  return `#/b/${businessId}/transactions${qs ? `?${qs}` : ""}`;
}

/** Reads filters from a location hash. Anything invalid falls back to its default; never throws. */
export function filtersFromHash(hash: string): TransactionFilters {
  const i = hash.indexOf("?");
  const p = new URLSearchParams(i === -1 ? "" : hash.slice(i + 1));
  const f: TransactionFilters = { ...DEFAULTS };
  f.q = (p.get("q") ?? "").trim().slice(0, MAX_Q);
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  if (isIsoDate(from)) f.from = from;
  if (isIsoDate(to)) f.to = to;
  const kind = p.get("kind") ?? "";
  if ((TRANSACTION_KINDS as readonly string[]).includes(kind)) f.kind = kind as TransactionKind;
  const accountId = p.get("accountId") ?? "";
  if (UUID.test(accountId)) f.accountId = accountId;
  const status = p.get("status") ?? "";
  if ((TRANSACTION_STATUSES as readonly string[]).includes(status)) f.status = status as TransactionStatus;
  const sort = p.get("sort") ?? "";
  if ((TRANSACTION_SORTS as readonly string[]).includes(sort)) f.sort = sort as TransactionSort;
  const dir = p.get("dir") ?? "";
  if (dir === "asc" || dir === "desc") f.dir = dir;
  const pageRaw = p.get("page") ?? "";
  if (/^\d{1,7}$/.test(pageRaw)) {
    const n = Number(pageRaw);
    if (n >= 1 && n <= MAX_PAGE) f.page = n;
  }
  return f;
}

/** Click on a column header: same column flips direction, a new column starts at its natural direction (text asc, date/amount desc). Resets to page 1. */
export function toggleSort(f: TransactionFilters, column: TransactionSort): TransactionFilters {
  if (f.sort === column) return { ...f, dir: f.dir === "asc" ? "desc" : "asc", page: 1 };
  return { ...f, sort: column, dir: column === "description" ? "asc" : "desc", page: 1 };
}

export function transactionsUrl(businessId: string, filters: TransactionFilters): string {
  const qs = new URLSearchParams(buildQuery(filters)).toString();
  return `/api/businesses/${encodeURIComponent(businessId)}/transactions${qs ? `?${qs}` : ""}`;
}

export async function fetchTransactions(
  businessId: string, filters: TransactionFilters, fetchFn: typeof fetch = fetch,
): Promise<TransactionList> {
  const res = await fetchFn(transactionsUrl(businessId, filters), {
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
  return body as TransactionList;
}
