// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { getVersion, parseMode, parsePort } from "./index";

describe("parseMode", () => {
  it("defaults to api", () => {
    expect(parseMode(undefined)).toBe("api");
    expect(parseMode("")).toBe("api");
  });
  it("accepts known modes", () => {
    expect(parseMode("api")).toBe("api");
    expect(parseMode("worker")).toBe("worker");
  });
  it("rejects unknown modes", () => {
    expect(() => parseMode("cron")).toThrow(/Invalid MODE/);
  });
});

describe("parsePort", () => {
  it("uses the fallback when unset", () => {
    expect(parsePort(undefined, 3000)).toBe(3000);
  });
  it("parses valid ports", () => {
    expect(parsePort("8080", 3000)).toBe(8080);
  });
  it("rejects garbage and out-of-range values", () => {
    expect(() => parsePort("abc", 3000)).toThrow();
    expect(() => parsePort("0", 3000)).toThrow();
    expect(() => parsePort("70000", 3000)).toThrow();
    expect(() => parsePort("80.5", 3000)).toThrow();
  });
});

describe("getVersion", () => {
  it("falls back to dev", () => {
    expect(getVersion({})).toBe("dev");
    expect(getVersion({ APP_VERSION: "" })).toBe("dev");
  });
  it("returns APP_VERSION when set", () => {
    expect(getVersion({ APP_VERSION: "1.2.3" })).toBe("1.2.3");
  });
});
