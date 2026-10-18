import { SimpleFinInputError } from "./errors.js";

const ZERO_EXPONENT = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "PYG", "RWF", "XAF", "XOF", "XPF", "DJF", "GNF", "KMF", "VUV"]);
const THREE_EXPONENT = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Minor-unit exponent for a currency code; defaults to 2 (also for custom/unknown currencies). */
export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_EXPONENT.has(c)) return 0;
  if (THREE_EXPONENT.has(c)) return 3;
  return 2;
}

const DECIMAL = /^([+-])?(\d+)(?:\.(\d*))?$|^([+-])?\.(\d+)$/;

/**
 * Parse a decimal string to integer minor units with no float math.
 * Fractional digits beyond the exponent are only accepted if they are zeros.
 */
export function parseAmountToMinor(value: string, currency: string): number {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new SimpleFinInputError("Invalid decimal amount");
  const sign = (m[1] ?? m[4]) === "-" ? -1n : 1n;
  const whole = m[2] ?? "0";
  const frac = m[3] ?? m[5] ?? "";
  const exp = currencyExponent(currency);
  const kept = frac.slice(0, exp).padEnd(exp, "0");
  if (/[1-9]/.test(frac.slice(exp))) {
    throw new SimpleFinInputError("Amount has more precision than the currency allows");
  }
  const minor = sign * BigInt(whole + kept);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SimpleFinInputError("Amount exceeds safe integer range");
  }
  return Number(minor);
}
