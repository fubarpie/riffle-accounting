// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ApiError, blockersFromError, createClient } from "../src/api";
import { hrefFor, parseRoute } from "../src/router";

const BIZ = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const BID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

interface Call { url: string; init: RequestInit }
function client(status = 200, body: unknown = {}) {
  const calls: Call[] = [];
  const c = createClient(async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  });
  return { c, calls };
}

describe("import routes", () => {
  it("parses and builds the import URLs", () => {
    expect(parseRoute(`#/b/${BIZ}/imports`)).toEqual({ name: "imports", businessId: BIZ });
    expect(parseRoute(`#/b/${BIZ}/imports/${BID}`)).toEqual({ name: "import-review", businessId: BIZ, batchId: BID });
    expect(parseRoute(`#/b/${BIZ}/imports/not-a-uuid`)).toEqual({ name: "not-found" });
    expect(parseRoute(`#/b/${BIZ}/imports/${BID}/extra`)).toEqual({ name: "not-found" });
    expect(parseRoute(hrefFor.imports(BIZ))).toEqual({ name: "imports", businessId: BIZ });
    expect(parseRoute(hrefFor.importReview(BIZ, BID))).toEqual({ name: "import-review", businessId: BIZ, batchId: BID });
  });

  it("still parses the older routes", () => {
    expect(parseRoute(`#/b/${BIZ}`)).toEqual({ name: "extractions", businessId: BIZ });
    expect(parseRoute(`#/b/${BIZ}/x/${BID}`)).toEqual({ name: "review", businessId: BIZ, extractionId: BID });
  });
});

describe("import API client", () => {
  it("approves with POST to the approve path", async () => {
    const { c, calls } = client(200, { posted: 2 });
    await c.approveImport(BIZ, BID);
    expect(calls[0]?.url).toBe(`/api/businesses/${BIZ}/imports/${BID}/approve`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("sends a mapping decision as JSON with PUT", async () => {
    const { c, calls } = client(200, { account: {} });
    await c.setImportMapping(BIZ, BID, "acct-1", { kind: "create", name: "Supplies", type: "expense" });
    expect(calls[0]?.url).toBe(`/api/businesses/${BIZ}/imports/${BID}/accounts/acct-1/mapping`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: "create", name: "Supplies", type: "expense" });
  });

  it("sends the exclude flag, and the boolean filter as the string the API expects", async () => {
    const { c, calls } = client(200, { entries: [] });
    await c.setImportEntryExcluded(BIZ, BID, "e1", true);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ excluded: true });
    await c.importEntries(BIZ, BID, { excluded: false, limit: 100, offset: 0 });
    expect(calls[1]?.url).toContain("excluded=false");
    expect(calls[1]?.url).toContain("limit=100");
  });

  it("uploads multipart with the wave_journal source and no JSON content-type", async () => {
    const { c, calls } = client(201, {});
    await c.uploadImport(BIZ, new File(["a,b\n1,2\n"], "sample.csv", { type: "text/csv" }));
    expect(calls[0]?.url).toBe(`/api/businesses/${BIZ}/imports?source=wave_journal`);
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });
});

describe("blockersFromError", () => {
  const report = {
    invalidEntries: 2, unmappedAccounts: [{ importAccountId: "1", sourceName: "Sample Bank" }], archivedTargets: [],
    classMismatches: [], lockedEntries: null, nothingToPost: false,
  };

  it("returns the report from a 409 refusal", async () => {
    const { c } = client(409, { error: "this import cannot be approved yet; see blockers", blockers: report });
    const err = await c.approveImport(BIZ, BID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(blockersFromError(err)).toEqual(report);
  });

  it("fills in optional fields an older server might omit", () => {
    const { archivedTargets: _a, lockedEntries: _l, nothingToPost: _n, ...partial } = report;
    const out = blockersFromError(new ApiError(409, "x", { blockers: partial }));
    expect(out?.archivedTargets).toEqual([]);
    expect(out?.lockedEntries).toBeNull();
    expect(out?.nothingToPost).toBe(false);
  });

  it("ignores other errors", () => {
    expect(blockersFromError(new ApiError(409, "state", { error: "already approved" }))).toBeUndefined();
    expect(blockersFromError(new ApiError(403, "no", { blockers: report }))).toBeUndefined();
    expect(blockersFromError(new Error("boom"))).toBeUndefined();
    expect(blockersFromError(new ApiError(409, "x", { blockers: { invalidEntries: "2" } }))).toBeUndefined();
  });
});
