// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Extractor contract (ADR 0011).
 *
 * An extractor turns the untrusted content of a bank/card statement into a
 * structured candidate. Its output is DATA ONLY: it is never trusted, never
 * executed, and never posted to the ledger until the validation gate
 * (validation.ts) passes and a human approves it.
 */

export const MAX_LINES = 2_000;
/** Largest magnitude accepted for a balance or amount (keeps sums far from bigint/overflow trouble). */
export const MAX_MINOR = 10n ** 15n;

export interface ExtractInput {
  filename: string;
  mimeType: string;
  /** Raw file bytes (CSV or PDF). */
  bytes?: Uint8Array | undefined;
  /** Text content: the CSV text, or the text layer of a PDF. Preferred by AI extractors. */
  text?: string | undefined;
}

/**
 * One statement line as the extractor reports it.
 * `amountMinor` is deliberately loose (number | string): whether it is a true
 * integer count of minor units is decided by the validation gate, so a model
 * answering 12.34 gets the extraction flagged instead of silently rounded.
 *
 * Sign: the SAME sign the statement's balances use, i.e. a positive amount
 * raises the closing balance (deposit on a bank account; purchase on a card).
 */
export interface ExtractedLine {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  amountMinor: number | string;
}

export interface ExtractionResult {
  periodStart: string;
  periodEnd: string;
  /** Integer minor units, as printed on the statement. */
  openingBalance: number | string;
  closingBalance: number | string;
  /** ISO 4217 code if the statement states one. Checked against the business currency. */
  currency?: string | undefined;
  lines: ExtractedLine[];
}

export interface Extractor {
  /** Stable identifier stored with every extraction ("mock", "openai-compatible", "csv"). */
  readonly name: string;
  /** Model or parser version, stored for provenance. */
  readonly model: string;
  extract(input: ExtractInput): Promise<ExtractionResult>;
}

export type ExtractorErrorCode =
  | "input" // the file cannot be processed (unsupported, unreadable, no text layer, bad CSV)
  | "output" // the extractor answered with something that fails strict parsing
  | "upstream" // the model service failed (network, HTTP error, timeout)
  | "not_configured";

export class ExtractorError extends Error {
  constructor(readonly code: ExtractorErrorCode, message: string) {
    super(message);
    this.name = "ExtractorError";
  }
}
