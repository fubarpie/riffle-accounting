// SPDX-License-Identifier: AGPL-3.0-or-later
/** Client calls for the Wave import bulk tools. Kept apart from api.ts so that file stays untouched. */
import { ApiError } from "./api";
import type { AutoMapResult } from "./importBulk";
import type { ImportCounts, ImportEntry, ImportReadiness } from "./types";

export interface EntryFilter {
  status?: ImportEntry["status"] | undefined;
  excluded?: boolean | undefined;
  search?: string | undefined;
}

async function send<T>(method: string, path: string, json?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path, init);
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
  return body as T;
}

const imp = (id: string, bid: string): string => `/api/businesses/${encodeURIComponent(id)}/imports/${encodeURIComponent(bid)}`;

export function searchImportEntries(
  id: string, bid: string, q: EntryFilter & { limit?: number; offset?: number },
): Promise<{ entries: ImportEntry[]; total: number }> {
  const params = new URLSearchParams();
  if (q.status) params.set("status", q.status);
  if (q.excluded !== undefined) params.set("excluded", String(q.excluded));
  if (q.search && q.search.trim()) params.set("search", q.search.trim());
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));
  const qs = params.toString();
  return send("GET", `${imp(id, bid)}/entries${qs ? `?${qs}` : ""}`);
}

export const autoMapImport = (id: string, bid: string): Promise<AutoMapResult & { counts: ImportCounts; blockers: ImportReadiness }> =>
  send("POST", `${imp(id, bid)}/accounts/auto-map`, {});

export const bulkMapImport = (
  id: string, bid: string, accountIds: string[], decision: { kind: "target"; accountId: string } | { kind: "clear" },
): Promise<{ updated: number }> => send("POST", `${imp(id, bid)}/accounts/mapping`, { accountIds, decision });

export const bulkExcludeImport = (
  id: string, bid: string, body: { excluded: boolean; ids: string[] } | { excluded: boolean; filter: EntryFilter },
): Promise<{ changed: number; counts: ImportCounts; blockers: ImportReadiness }> =>
  send("POST", `${imp(id, bid)}/entries/exclude`, body);
