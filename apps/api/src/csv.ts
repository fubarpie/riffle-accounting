// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure CSV generation (RFC 4180) with spreadsheet formula-injection guarding. */

export type Cell = string | number | bigint | boolean | null | undefined;

/** Characters that make Excel/Sheets/LibreOffice treat a text cell as a formula (OWASP CSV injection). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Render one cell. Numbers and bigints are emitted verbatim (they are our own
 * integer minor units, so a leading "-" is a sign, not a formula). Strings
 * that start with = + - @ (or tab/CR) get a leading apostrophe so a
 * spreadsheet shows them as text, then standard quoting is applied.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("CSV numbers must be finite");
    return String(value);
  }
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows joined with CRLF and a trailing CRLF, as RFC 4180 specifies. */
export function toCsv(rows: readonly (readonly Cell[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",") + "\r\n").join("");
}
