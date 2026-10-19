# 0011. AI statement upload

Status: accepted

## Context
Users want to turn a bank statement (CSV or text-layer PDF) into staged transactions without retyping. Language models can read statements but make mistakes, so output can never be trusted blindly.

## Decision
- `packages/extractor` defines an `Extractor` interface with a deterministic mock and an OpenAI-compatible implementation (configurable base URL, so OpenAI, Ollama and LM Studio all work). The provider is optional; CSV parsing needs no model.
- Inputs are CSV and PDF with a text layer. OCR and images are out of scope.
- A **validation gate** checks every extraction: line amounts parse, dates are valid, and opening balance plus the sum of lines equals closing balance. A failure sets the extraction to `flagged`. Flagged extractions are never auto-staged and can only be approved after a human edits the lines and they revalidate cleanly.
- Extractions and lines live in `statement_extractions` and `extraction_lines` (migration 0007), scoped by business with row-level security.
- Approval posts through the existing `postStaged` path, so ledger invariants and the audit log apply unchanged. Reject keeps the record for audit.
- Owners, admins and bookkeepers may upload and approve; viewers get 403.

## Consequences
- No data leaves the server unless an operator configures an extractor endpoint.
- The web approval UI is a follow-up; the API is complete.
