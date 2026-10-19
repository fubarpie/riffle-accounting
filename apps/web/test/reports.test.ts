// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { fetchReport, isIsoDate, isoDate, reportUrl } from "../src/reportsApi";
import { hrefFor, parseRoute } from "../src/router";

const ID = "0190a0a0-0000-7000-8000-000000000001";

describe("report routes", () => {
  it("parses the dashboard and each report", () => {
    expect(parseRoute(`#/b/${ID}/dashboard`)).toEqual({ name: "dashboard", businessId: ID });
    expect(parseRoute(`#/b/${ID}/reports/balance-sheet`)).toEqual({ name: "reports", businessId: ID, kind: "balance-sheet" });
    expect(parseRoute(`#/b/${ID}/reports`)).toEqual({ name: "reports", businessId: ID, kind: "profit-loss" });
  });
  it("rejects unknown report kinds", () => {
    expect(parseRoute(`#/b/${ID}/reports/nope`)).toEqual({ name: "not-found" });
  });
  it("keeps the existing routes", () => {
    expect(parseRoute(`#/b/${ID}`)).toEqual({ name: "extractions", businessId: ID });
    expect(parseRoute(`#/b/${ID}/imports`)).toEqual({ name: "imports", businessId: ID });
  });
  it("round-trips hrefs", () => {
    expect(parseRoute(hrefFor.reports(ID, "tax-summary"))).toEqual({ name: "reports", businessId: ID, kind: "tax-summary" });
    expect(parseRoute(hrefFor.dashboard(ID))).toEqual({ name: "dashboard", businessId: ID });
  });
});

describe("reports client", () => {
  it("builds JSON and CSV urls", () => {
    expect(reportUrl(ID, "profit-loss", { from: "2025-01-01", to: "2025-12-31" }))
      .toBe(`/api/businesses/${ID}/reports/profit-loss?from=2025-01-01&to=2025-12-31`);
    expect(reportUrl(ID, "balance-sheet", { asOf: "2025-06-30" }, "csv")).toBe(`/api/businesses/${ID}/reports/balance-sheet?asOf=2025-06-30&format=csv`);
  });
  it("returns the parsed body", async () => {
    const fake = (async () => new Response(JSON.stringify({ currency: "USD", report: { x: 1 } }), { status: 200 })) as typeof fetch;
    expect(await fetchReport(ID, "trial-balance", { asOf: "2025-01-01" }, fake)).toEqual({ currency: "USD", report: { x: 1 } });
  });
  it("throws ApiError carrying the server message", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })) as typeof fetch;
    await expect(fetchReport(ID, "profit-loss", {}, fake)).rejects.toMatchObject({ status: 403, message: "Forbidden" });
    await expect(fetchReport(ID, "profit-loss", {}, fake)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("dates", () => {
  it("formats local dates and validates input", () => {
    expect(isoDate(new Date(2025, 0, 5))).toBe("2025-01-05");
    expect(isIsoDate("2025-02-30")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate("2025-03-01")).toBe(true);
  });
});
