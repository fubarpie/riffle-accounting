// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { hrefFor, parseRoute } from "../src/router";
import {
  DEFAULTS, PAGE_SIZE, buildQuery, fetchTransactions, filtersFromHash, filtersToHash, offsetToPage, pageCount, pageToOffset, toggleSort,
  type TransactionFilters,
} from "../src/transactionsApi";

const B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const f = (patch: Partial<TransactionFilters> = {}): TransactionFilters => ({ ...DEFAULTS, ...patch });

describe("transactions route", () => {
  it("parses the route with and without a query", () => {
    expect(parseRoute(`#/b/${B}/transactions`)).toEqual({ name: "transactions", businessId: B });
    expect(parseRoute(`#/b/${B}/transactions/`)).toEqual({ name: "transactions", businessId: B });
    expect(parseRoute(`#/b/${B}/transactions?q=rent&kind=deposit&page=2`)).toEqual({ name: "transactions", businessId: B });
  });
  it("rejects extra segments and bad ids", () => {
    expect(parseRoute(`#/b/${B}/transactions/x`)).toEqual({ name: "not-found" });
    expect(parseRoute("#/b/nope/transactions")).toEqual({ name: "not-found" });
  });
  it("builds the href and keeps other routes", () => {
    expect(hrefFor.transactions(B)).toBe(`#/b/${B}/transactions`);
    expect(parseRoute(`#/b/${B}/dashboard`)).toEqual({ name: "dashboard", businessId: B });
    expect(parseRoute(`#/b/${B}/imports`)).toEqual({ name: "imports", businessId: B });
  });
});

describe("buildQuery", () => {
  it("omits defaults and empty values", () => {
    expect(buildQuery(f())).toEqual({});
    expect(buildQuery(f({ q: "   " }))).toEqual({});
  });
  it("includes non-default values and the offset", () => {
    expect(buildQuery(f({ q: " rent ", kind: "deposit", accountId: A, status: "all", sort: "amount", dir: "asc", from: "2025-01-01", to: "2025-01-31", page: 3 })))
      .toEqual({ q: "rent", kind: "deposit", accountId: A, status: "all", sort: "amount", dir: "asc", from: "2025-01-01", to: "2025-01-31", offset: "100" });
  });
});

describe("hash filters", () => {
  it("round-trips", () => {
    const x = f({ q: "rent & fees", kind: "transfer", accountId: A, status: "voided", sort: "description", dir: "asc", from: "2024-02-29", to: "2025-01-01", page: 2 });
    expect(filtersFromHash(filtersToHash(B, x))).toEqual(x);
  });
  it("has no query for default filters and reads the documented example", () => {
    expect(filtersToHash(B, f())).toBe(`#/b/${B}/transactions`);
    expect(filtersFromHash(`#/b/${B}/transactions?q=rent&kind=deposit&page=2`)).toEqual(f({ q: "rent", kind: "deposit", page: 2 }));
    expect(filtersFromHash("")).toEqual(DEFAULTS);
  });
  it("ignores bad values instead of throwing", () => {
    const bad = `#/b/${B}/transactions?from=2025-02-30&to=nope&kind=refund&sort=hax&dir=up&status=x&accountId=1&page=0`;
    expect(filtersFromHash(bad)).toEqual(DEFAULTS);
    expect(filtersFromHash("#/x?page=-3")).toEqual(DEFAULTS);
    expect(filtersFromHash("#/x?page=abc&%E0%A4%A=1")).toEqual(DEFAULTS);
    expect(filtersFromHash("#/x?page=99999999999")).toEqual(DEFAULTS);
  });
  it("keeps valid values next to bad ones", () => {
    expect(filtersFromHash("#/x?kind=bogus&q=hi&from=2025-03-01")).toEqual(f({ q: "hi", from: "2025-03-01" }));
  });
});

describe("toggleSort", () => {
  it("flips direction on the active column and resets the page", () => {
    expect(toggleSort(f({ page: 4 }), "date")).toEqual(f({ dir: "asc", page: 1 }));
    expect(toggleSort(f({ dir: "asc" }), "date")).toEqual(f({ dir: "desc" }));
  });
  it("starts a new column at its natural direction", () => {
    expect(toggleSort(f(), "description")).toEqual(f({ sort: "description", dir: "asc" }));
    expect(toggleSort(f(), "amount")).toEqual(f({ sort: "amount", dir: "desc" }));
  });
});

describe("page maths", () => {
  it("converts between page and offset", () => {
    expect(pageToOffset(1)).toBe(0);
    expect(pageToOffset(3)).toBe(2 * PAGE_SIZE);
    expect(pageToOffset(0)).toBe(0);
    expect(offsetToPage(0)).toBe(1);
    expect(offsetToPage(100)).toBe(3);
    expect(offsetToPage(99)).toBe(2);
    expect(offsetToPage(-5)).toBe(1);
  });
  it("counts pages", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
    expect(pageCount(123)).toBe(3);
  });
});

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe("fetchTransactions", () => {
  it("requests the API url with the query and returns the body", async () => {
    const payload = { currency: "USD", total: 0, limit: 50, offset: 0, transactions: [] };
    let seen = "";
    const fn = (async (url: string) => { seen = url; return new Response(JSON.stringify(payload), { status: 200 }); }) as unknown as typeof fetch;
    expect(await fetchTransactions(B, f({ q: "a b", page: 2 }), fn)).toEqual(payload);
    expect(seen).toBe(`/api/businesses/${B}/transactions?q=a+b&offset=50`);
  });
  it("uses no query string for default filters", async () => {
    let seen = "";
    const fn = (async (url: string) => { seen = url; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await fetchTransactions(B, f(), fn);
    expect(seen).toBe(`/api/businesses/${B}/transactions`);
  });
  it("throws ApiError on 4xx with the server message", async () => {
    const err = await fetchTransactions(B, f(), reply(400, { error: "bad date" }) as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("bad date");
  });
  it("falls back to the HTTP status for non-JSON errors", async () => {
    const fn = (async () => new Response("oops", { status: 502 })) as unknown as typeof fetch;
    const err = await fetchTransactions(B, f(), fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("HTTP 502");
  });
});
