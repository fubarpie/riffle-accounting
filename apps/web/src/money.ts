// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Money helpers. Amounts are integer minor units carried as decimal STRINGS and
 * handled with string/BigInt arithmetic only: a float never touches a balance.
 */

/** Largest digit count the API accepts for an amount (`^-?\d{1,16}$`). */
export const MAX_AMOUNT_DIGITS = 16;

/** Number of minor-unit digits for a currency (USD 2, JPY 0, KWD 3). Falls back to 2. */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const MINOR_RE = /^-?\d+$/;

/** "-123456" with exponent 2 becomes "-1234.56". No grouping, so it can be edited and parsed back. */
export function minorToDecimal(minor: string, exponent: number): string {
  if (!MINOR_RE.test(minor)) return minor;
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent);
  const frac = exponent > 0 ? padded.slice(padded.length - exponent) : "";
  const isZero = !/[1-9]/.test(digits);
  return `${negative && !isZero ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Display form with thousands separators and an optional currency code. */
export function formatMinor(minor: string, exponent: number, currency?: string | null): string {
  const plain = minorToDecimal(minor, exponent);
  if (plain === minor && !MINOR_RE.test(minor)) return minor;
  const negative = plain.startsWith("-");
  const [whole = "0", frac] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}${currency ? ` ${currency}` : ""}`;
}

/**
 * Parses what a person types ("1,234.50", "-12", "0.5") into minor units as a
 * decimal string, or null when it is not an exact amount. Extra decimals are
 * accepted only when they are zeros; nothing is ever rounded.
 */
export function parseDecimalToMinor(input: string, exponent: number): string | null {
  const s = input.trim().replace(/\s/g, "");
  const m = /^(-?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] ?? "";
  const whole = (m[2] ?? "").replace(/,/g, "");
  const frac = m[3] ?? "";
  if (frac.length > exponent && /[1-9]/.test(frac.slice(exponent))) return null;
  const digits = (whole + frac.slice(0, exponent).padEnd(exponent, "0")).replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_AMOUNT_DIGITS) return null;
  if (!/[1-9]/.test(digits)) return "0";
  return `${sign}${digits}`;
}
