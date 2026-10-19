// SPDX-License-Identifier: AGPL-3.0-or-later

/** Thrown when CSV text is structurally invalid (for example an unterminated quote). */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * Parse RFC 4180 style CSV into rows of strings.
 *
 * - Handles a leading BOM, CRLF/LF/CR line endings, quoted fields with
 *   embedded commas and newlines, and doubled quotes inside quoted fields.
 * - Every cell is returned as a string. Nothing is coerced to a number, so
 *   19-digit identifiers survive intact.
 * - Rows that are completely empty (a blank line) are dropped.
 * - Cells are NOT trimmed: callers decide what whitespace means.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  // True once the current row has any content, so a blank line can be dropped
  // while a row like `,` (two empty cells) is kept.
  let rowHasContent = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const endRow = (): void => {
    if (rowHasContent) {
      endCell();
      rows.push(row);
    }
    row = [];
    cell = "";
    rowHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      rowHasContent = true;
    } else if (ch === ",") {
      rowHasContent = true;
      endCell();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      rowHasContent = true;
      cell += ch;
    }
  }
  if (inQuotes) throw new CsvError("Unterminated quoted field at end of input");
  endRow();
  return rows;
}
