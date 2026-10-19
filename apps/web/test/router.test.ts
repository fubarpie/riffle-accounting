// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "../src/router";

const B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const X = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("parseRoute", () => {
  it("routes the home page", () => {
    expect(parseRoute("")).toEqual({ name: "businesses" });
    expect(parseRoute("#")).toEqual({ name: "businesses" });
    expect(parseRoute("#/")).toEqual({ name: "businesses" });
  });

  it("routes a business and an extraction", () => {
    expect(parseRoute(`#/b/${B}`)).toEqual({ name: "extractions", businessId: B });
    expect(parseRoute(`#/b/${B}/`)).toEqual({ name: "extractions", businessId: B });
    expect(parseRoute(`#/b/${B}/x/${X}`)).toEqual({ name: "review", businessId: B, extractionId: X });
  });

  it("ignores a query string", () => {
    expect(parseRoute(`#/b/${B}?status=flagged`)).toEqual({ name: "extractions", businessId: B });
  });

  it("rejects anything that is not a UUID or a known shape", () => {
    expect(parseRoute("#/b/123")).toEqual({ name: "not-found" });
    expect(parseRoute(`#/b/${B}/x/nope`)).toEqual({ name: "not-found" });
    expect(parseRoute(`#/b/${B}/y/${X}`)).toEqual({ name: "not-found" });
    expect(parseRoute(`#/b/${B}/x/${X}/extra`)).toEqual({ name: "not-found" });
    expect(parseRoute("#/b/../../etc")).toEqual({ name: "not-found" });
    expect(parseRoute("#/other")).toEqual({ name: "not-found" });
  });

  it("round-trips with hrefFor", () => {
    expect(parseRoute(hrefFor.businesses())).toEqual({ name: "businesses" });
    expect(parseRoute(hrefFor.extractions(B))).toEqual({ name: "extractions", businessId: B });
    expect(parseRoute(hrefFor.review(B, X))).toEqual({ name: "review", businessId: B, extractionId: X });
  });
});
