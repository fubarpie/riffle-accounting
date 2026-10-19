// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { currencyExponent, formatMinor, minorToDecimal, parseDecimalToMinor } from "../src/money";

describe("currencyExponent", () => {
  it("knows common currencies and falls back to 2", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("")).toBe(2);
    expect(currencyExponent("not-a-code")).toBe(2);
  });
});

describe("minorToDecimal", () => {
  it.each([
    ["123456", 2, "1234.56"],
    ["-123456", 2, "-1234.56"],
    ["5", 2, "0.05"],
    ["-5", 2, "-0.05"],
    ["0", 2, "0.00"],
    ["-0", 2, "0.00"],
    ["1500", 0, "1500"],
    ["1234", 3, "1.234"],
    ["007", 2, "0.07"],
  ])("%s at %i places is %s", (minor, exp, out) => {
    expect(minorToDecimal(minor, exp)).toBe(out);
  });

  it("is exact beyond 2^53", () => {
    expect(minorToDecimal("900719925474099312", 2)).toBe("9007199254740993.12");
  });

  it("leaves non-numeric input alone", () => {
    expect(minorToDecimal("abc", 2)).toBe("abc");
  });
});

describe("formatMinor", () => {
  it("groups thousands and appends the currency", () => {
    expect(formatMinor("123456789", 2, "USD")).toBe("1,234,567.89 USD");
    expect(formatMinor("-100000", 2)).toBe("-1,000.00");
    expect(formatMinor("0", 2, "USD")).toBe("0.00 USD");
    expect(formatMinor("1500", 0, "JPY")).toBe("1,500 JPY");
  });
});

describe("parseDecimalToMinor", () => {
  it.each([
    ["12.34", 2, "1234"],
    ["-12.34", 2, "-1234"],
    ["12", 2, "1200"],
    ["0.5", 2, "50"],
    [" 1,234.50 ", 2, "123450"],
    ["12.340", 2, "1234"],
    ["1500", 0, "1500"],
    ["1.234", 3, "1234"],
    ["-0", 2, "0"],
    ["-0.00", 2, "0"],
    ["007.10", 2, "710"],
  ])("accepts %s at %i places as %s", (input, exp, out) => {
    expect(parseDecimalToMinor(input, exp)).toBe(out);
  });

  it.each([
    ["", 2], ["abc", 2], ["12.345", 2], ["1.5", 0], ["1,23", 2], ["12,34.5", 2], ["1e3", 2], ["--1", 2], ["+5", 2], ["1.", 2], [".5", 2],
  ])("rejects %j at %i places", (input, exp) => {
    expect(parseDecimalToMinor(input, exp)).toBeNull();
  });

  it("never rounds", () => {
    expect(parseDecimalToMinor("0.001", 2)).toBeNull();
  });

  it("enforces the API's 16 digit limit", () => {
    expect(parseDecimalToMinor("99999999999999.99", 2)).toBe("9999999999999999");
    expect(parseDecimalToMinor("100000000000000.00", 2)).toBeNull();
  });

  it("round-trips with minorToDecimal", () => {
    for (const minor of ["0", "1", "-1", "99", "100", "-123456789012", "9999999999999999"]) {
      expect(parseDecimalToMinor(minorToDecimal(minor, 2), 2)).toBe(minor);
    }
  });
});
