// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseExtractionResult } from "./schema.js";
import { ExtractorError, type ExtractInput, type ExtractionResult, type Extractor } from "./types.js";

/**
 * Deterministic extractor for tests and local trials (EXTRACTOR=mock). It
 * "reads" the statement by parsing its text as a JSON document of the exact
 * ExtractionResult shape, so a test controls the outcome precisely, including
 * wrong balances and fractional amounts. No network, no randomness, no model.
 * It goes through the same strict schema as the real extractor.
 */
export class MockExtractor implements Extractor {
  readonly name = "mock";
  readonly model = "mock-1";

  async extract(input: ExtractInput): Promise<ExtractionResult> {
    const text = input.text ?? (input.bytes ? new TextDecoder().decode(input.bytes) : undefined);
    if (text === undefined) throw new ExtractorError("input", "No content to extract");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new ExtractorError("output", "Mock extractor expects a JSON document in the statement text");
    let json: unknown;
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new ExtractorError("output", "Mock extractor could not parse the statement text as JSON");
    }
    return parseExtractionResult(json);
  }
}
