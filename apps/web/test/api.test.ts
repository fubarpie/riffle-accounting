// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ApiError, createClient, describeError, detailFromError, type FetchFn } from "../src/api";

interface Call { url: string; init: RequestInit }

function stub(status: number, body?: unknown, contentType = "application/json") {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers: { "content-type": contentType } });
  };
  return { client: createClient(fetchFn), calls };
}

describe("request building", () => {
  it("sends JSON with the right method and headers, same-origin", async () => {
    const { client, calls } = stub(200, { user: { id: "u", email: "a@b.c", name: "A" } });
    await client.login("a@b.c", "pw");
    const c = calls[0]!;
    expect(c.url).toBe("/api/auth/login");
    expect(c.init.method).toBe("POST");
    expect(c.init.credentials).toBe("same-origin");
    expect((c.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(c.init.body as string)).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("drops empty and undefined query values", async () => {
    const { client, calls } = stub(200, { extractions: [] });
    await client.listExtractions("b1", { status: "flagged" });
    expect(calls[0]!.url).toBe("/api/businesses/b1/extractions?status=flagged&limit=200");
    await client.listExtractions("b1");
    expect(calls[1]!.url).toBe("/api/businesses/b1/extractions?limit=200");
  });

  it("encodes ids in paths", async () => {
    const { client, calls } = stub(200, { business: {} });
    await client.business("a/b?c");
    expect(calls[0]!.url).toBe("/api/businesses/a%2Fb%3Fc");
  });

  it("uploads multipart without setting a content type", async () => {
    const { client, calls } = stub(201, { extraction: {}, lines: [] });
    const file = new File(["a,b\n1,2\n"], "jan.csv", { type: "text/csv" });
    await client.upload("b1", file, { accountId: "acc", openingBalance: "100000" });
    const c = calls[0]!;
    expect(c.url).toBe("/api/businesses/b1/extractions?accountId=acc&openingBalance=100000");
    expect(c.init.body).toBeInstanceOf(FormData);
    expect((c.init.body as FormData).get("file")).toBeInstanceOf(File);
    expect((c.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("sends edits as PATCH and actions as POST", async () => {
    const { client, calls } = stub(200, { extraction: {}, lines: [] });
    await client.patchExtraction("b", "e", { closingBalance: "5" });
    await client.revalidate("b", "e");
    await client.approve("b", "e");
    await client.reject("b", "e");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "PATCH /api/businesses/b/extractions/e",
      "POST /api/businesses/b/extractions/e/revalidate",
      "POST /api/businesses/b/extractions/e/approve",
      "POST /api/businesses/b/extractions/e/reject",
    ]);
  });
});

describe("responses", () => {
  it("returns parsed JSON", async () => {
    const { client } = stub(200, { businesses: [{ id: "1", name: "N", currency: "USD", role: "owner" }] });
    expect((await client.businesses()).businesses[0]?.name).toBe("N");
  });

  it("handles 204 with no body", async () => {
    const { client } = stub(204);
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it("throws ApiError carrying status, server message and body", async () => {
    const { client } = stub(409, { error: "Books are locked through 2026-01-31" });
    const err = await client.approve("b", "e").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("Books are locked through 2026-01-31");
    expect(describeError(err)).toBe("Books are locked through 2026-01-31");
  });

  it("falls back to the status when the body is not an error object", async () => {
    const { client } = stub(502, "<html>bad gateway</html>", "text/html");
    const err = (await client.me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.message).toBe("HTTP 502");
  });

  it("keeps the refreshed extraction from a refused approval", async () => {
    const payload = { error: "The extraction does not pass validation and cannot be approved", extraction: { id: "e", status: "flagged" }, lines: [] };
    const { client } = stub(422, payload);
    const err = await client.approve("b", "e").catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(422);
    expect(detailFromError(err)?.extraction.status).toBe("flagged");
  });

  it("returns no detail for other errors", () => {
    expect(detailFromError(new ApiError(500, "x", { error: "x" }))).toBeUndefined();
    expect(detailFromError(new Error("x"))).toBeUndefined();
    expect(detailFromError(new ApiError(422, "x", undefined))).toBeUndefined();
  });
});

describe("describeError", () => {
  it("explains a network failure", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toMatch(/Cannot reach the server/);
  });
  it("handles unknown throwables", () => {
    expect(describeError("boom")).toBe("Something went wrong.");
    expect(describeError(new Error("plain"))).toBe("plain");
  });
});
