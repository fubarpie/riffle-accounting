// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_MINOR } from "./types.js";

const ZERO_EXPONENT = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "PYG", "RWF", "XAF", "XOF", "XPF", "DJF", "GNF", "KMF", "VUV"]);
const THREE_EXPONENT = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Minor-unit exponent for a currency code; 2 when unknown. */
export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_EXPONENT.has(c)) return 0;
  if (THREE_EXPONENT.has(c)) return 3;
  return 2;
}

/**
 * Strict integer parse of a minor-unit amount. Accepts a safe JS integer or a
 * plain digit string; returns null for anything else (fractions, exponents,
 * NaN, empty, out of range). Never rounds.
 */
export function parseMinorInteger(v: unknown): bigint | null {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) return null;
    n = BigInt(v);
  } else if (typeof v === "string") {
    if (!/^-?\d{1,18}$/.test(v)) return null;
    n = BigInt(v);
  } else return null;
  return n > MAX_MINOR || n < -MAX_MINOR ? null : n;
}

/**
 * Convert a printed decimal ("1,234.50", "(12.00)", "$-3.1") to integer minor
 * units, without float math. Returns:
 *  - a digit string of minor units when exact,
 *  - the cleaned decimal text when it has more precision than the currency
 *    allows (never integer-parseable, so the gate flags it),
 *  - null when it is not a number at all.
 */
export function decimalToMinorString(raw: string, currency: string): string | null {
  let s = raw.trim().replace(/^\$|^[A-Z]{3}\s*/, "").trim();
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { negative = true; s = paren[1]!.trim(); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) s = s.slice(1).trim();
  s = s.replace(/^\$/, "");
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replaceAll(",", "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  const exp = currencyExponent(currency);
  if (/[1-9]/.test(frac.slice(exp))) return `${negative ? "-" : ""}${whole}.${frac}`;
  const digits = (whole + frac.slice(0, exp).padEnd(exp, "0")).replace(/^0+(?=\d)/, "");
  if (digits.length > 18) return null;
  return `${negative && digits !== "0" ? "-" : ""}${digits}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
