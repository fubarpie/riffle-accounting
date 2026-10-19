// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text-layer PDF reading via unpdf (a serverless build of Mozilla's pdf.js:
 * no native code, no network, no scripts executed). No OCR: a scanned PDF
 * without a text layer is rejected with a clear message.
 */
import { extractText, getDocumentProxy } from "unpdf";
import { ExtractorError } from "./types.js";

export const MAX_PDF_PAGES = 40;
export const MAX_TEXT_CHARS = 200_000;

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let text: string;
  try {
    // pdf.js transfers the buffer; hand it a copy so the caller's bytes stay intact.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractorError("input", `PDF has more than ${MAX_PDF_PAGES} pages`);
    const out = await extractText(pdf, { mergePages: true });
    text = out.text;
  } catch (err) {
    if (err instanceof ExtractorError) throw err;
    throw new ExtractorError("input", "The PDF could not be read (damaged, encrypted or not a PDF)");
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  if (text.replace(/\s+/g, "").length < 20) {
    throw new ExtractorError("input", "The PDF has no text layer. Scanned statements need OCR, which is not supported; upload a CSV or a text PDF");
  }
  if (text.length > MAX_TEXT_CHARS) throw new ExtractorError("input", "The PDF text is too large to process");
  return text;
}
