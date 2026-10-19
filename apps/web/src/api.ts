// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account, ApprovalBlockers, ApproveResult, BusinessSummary, ExtractionDetail, ExtractionStatus, Extraction, ImportApprovalResult,
  ImportBatch, ImportBatchDetail, ImportBatchStatus, ImportEntry, ImportCounts, ImportReadiness, MappingDecision, PatchBody,
  UploadParams, User, ImportAccount,
} from "./types";

/** A non-2xx answer. `body` keeps the parsed payload: a refused approval (422) still carries the refreshed extraction. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
}

function messageFor(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `HTTP ${status}`;
}

export function createClient(fetchFn: FetchFn) {
  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    let url = path;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== "") params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method, credentials: "same-origin", headers };
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    } else if (opts.form) {
      init.body = opts.form; // the browser sets the multipart boundary
    }

    const res = await fetchFn(url, init);
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) throw new ApiError(res.status, messageFor(res.status, body), body);
    return body as T;
  }

  const biz = (id: string) => `/api/businesses/${encodeURIComponent(id)}`;
  const imp = (id: string, bid: string) => `${biz(id)}/imports/${encodeURIComponent(bid)}`;
  const ext = (id: string, eid: string) => `${biz(id)}/extractions/${encodeURIComponent(eid)}`;

  return {
    me: () => request<{ user: User }>("GET", "/api/auth/me"),
    login: (email: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { json: { email, password } }),
    register: (email: string, name: string, password: string) =>
      request<{ user: User }>("POST", "/api/auth/register", { json: { email, name, password } }),
    logout: () => request<undefined>("POST", "/api/auth/logout"),

    businesses: () => request<{ businesses: BusinessSummary[] }>("GET", "/api/businesses"),
    business: (id: string) => request<{ business: BusinessSummary }>("GET", biz(id)),
    accounts: (id: string) => request<{ accounts: Account[] }>("GET", `${biz(id)}/accounts`),

    listExtractions: (id: string, filter: { status?: ExtractionStatus; accountId?: string } = {}) =>
      request<{ extractions: Extraction[] }>("GET", `${biz(id)}/extractions`, { query: { ...filter, limit: 200 } }),
    getExtraction: (id: string, eid: string) => request<ExtractionDetail>("GET", ext(id, eid)),
    upload: (id: string, file: File, params: UploadParams) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return request<ExtractionDetail>("POST", `${biz(id)}/extractions`, { query: { ...params }, form });
    },
    patchExtraction: (id: string, eid: string, body: PatchBody) => request<ExtractionDetail>("PATCH", ext(id, eid), { json: body }),
    revalidate: (id: string, eid: string) => request<ExtractionDetail>("POST", `${ext(id, eid)}/revalidate`, { json: {} }),
    approve: (id: string, eid: string) => request<ApproveResult>("POST", `${ext(id, eid)}/approve`, { json: {} }),
    reject: (id: string, eid: string) => request<ExtractionDetail & { alreadyRejected: boolean }>("POST", `${ext(id, eid)}/reject`, { json: {} }),

    listImports: (id: string, filter: { status?: ImportBatchStatus } = {}) =>
      request<{ batches: ImportBatch[] }>("GET", `${biz(id)}/imports`, { query: { ...filter, limit: 200 } }),
    getImport: (id: string, bid: string) => request<ImportBatchDetail>("GET", imp(id, bid)),
    importEntries: (id: string, bid: string, filter: { status?: ImportEntry["status"]; excluded?: boolean; limit?: number; offset?: number } = {}) =>
      request<{ entries: ImportEntry[] }>("GET", `${imp(id, bid)}/entries`, { query: { ...filter, excluded: filter.excluded === undefined ? undefined : String(filter.excluded) } }),
    uploadImport: (id: string, file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return request<ImportBatchDetail>("POST", `${biz(id)}/imports`, { query: { source: "wave_journal" }, form });
    },
    setImportMapping: (id: string, bid: string, aid: string, decision: MappingDecision) =>
      request<{ account: ImportAccount }>("PUT", `${imp(id, bid)}/accounts/${encodeURIComponent(aid)}/mapping`, { json: decision }),
    setImportEntryExcluded: (id: string, bid: string, eid: string, excluded: boolean) =>
      request<{ entryId: string; excluded: boolean; counts: ImportCounts; blockers: ImportReadiness }>(
        "PATCH", `${imp(id, bid)}/entries/${encodeURIComponent(eid)}`, { json: { excluded } }),
    approveImport: (id: string, bid: string) => request<ImportApprovalResult>("POST", `${imp(id, bid)}/approve`, { json: {} }),
    rejectImport: (id: string, bid: string) => request<unknown>("POST", `${imp(id, bid)}/reject`, { json: {} }),
  };
}

export type Client = ReturnType<typeof createClient>;

export const api: Client = createClient((input, init) => fetch(input, init));

/** The refreshed detail the API attaches to a refused approval (422), if present. */
export function detailFromError(err: unknown): ExtractionDetail | undefined {
  if (!(err instanceof ApiError) || !err.body || typeof err.body !== "object") return undefined;
  const b = err.body as Partial<ExtractionDetail>;
  return b.extraction && Array.isArray(b.lines) ? { extraction: b.extraction, lines: b.lines } : undefined;
}

/** A message fit for the person using the app. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Cannot reach the server. Check your connection and try again.";
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** The full blocker report the API attaches to a refused import approval (409), if present. */
export function blockersFromError(err: unknown): ApprovalBlockers | undefined {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.body || typeof err.body !== "object") return undefined;
  const b = (err.body as { blockers?: Partial<ApprovalBlockers> }).blockers;
  if (!b || typeof b.invalidEntries !== "number" || !Array.isArray(b.unmappedAccounts) || !Array.isArray(b.classMismatches)) return undefined;
  return { archivedTargets: [], lockedEntries: null, nothingToPost: false, ...b } as ApprovalBlockers;
}
