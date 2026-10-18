# ADR 0008: Financial reports

- Status: Accepted
- Builds on: ADR 0004 (ledger and tenancy), ADR 0005 (schema notes), ADR 0006 (API access control)

## Context

Phase 2 adds the standard statements: trial balance, profit and loss, balance
sheet, general ledger / account detail, and a tax summary. They must be
correct by construction (the ledger already guarantees balanced entries),
tenant-safe, and exportable to spreadsheets without creating a security hole.

## Decisions

1. **One source: `live_journal_lines`.** Every report is a SQL aggregate over
   this view, which already drops voided transactions and superseded
   (reversed/edited) entries. Reports never re-implement reversal logic and
   never read `journal_lines` directly. Functions live in
   `packages/db/src/reports` and take a `PoolClient` inside a tenant
   transaction.
2. **Accrual basis.** A line belongs to the period of its `entry_date`
   (the transaction date), regardless of whether cash has moved. An unpaid
   invoice is revenue on its date. Cash-basis reporting is out of scope.
3. **Integer minor units.** Amounts are summed in SQL as `bigint`, cast to
   text, and converted with a safe-integer check (`toMinor`), so a value that
   cannot be represented exactly raises instead of rounding. JSON and CSV
   carry integer minor units; the business currency (one per business) is
   returned alongside. No decimal formatting happens server-side.
4. **Sign conventions.** The ledger is debit-positive. Trial balance shows
   gross debits and credits plus a net balance in a single debit or credit
   column. Other reports use each account's *natural* sign (asset/expense =
   debits minus credits; liability/equity/income = credits minus debits), so
   contra accounts appear negative without special cases. `-0` is normalised
   to `0`.
5. **Invariants.** Trial balance: total debits = total credits (gross and
   net). Balance sheet: assets = liabilities + equity. Because Riffle has no
   period-close, cumulative income minus expense through the date is shown as
   a synthetic *current earnings* line inside equity; that is what keeps the
   identity true at any date. These are asserted in tests at several dates,
   including after voids and edits.
6. **General ledger.** For `[from, to]`: per account, an opening balance
   (all live lines before `from`), the lines in `entry_date, entry id, line id`
   order with a running balance, and a closing balance. `accountId` narrows it
   to one account (account transaction detail). Output is unpaginated, which is
   acceptable at small-business volumes; pagination is future work.
7. **Tax summary is generic.** There is no tax-code or jurisdiction model yet.
   The report gives period debits, credits and net per account. The caller
   selects accounts with `accounts=<uuid,uuid,...>`; by default it selects
   accounts whose name contains "tax" (Sales Tax Payable, Taxes in the default
   chart). This is a convenience heuristic, not tax advice; a real tax-code
   model would supersede it.
8. **Access control.** Every route uses `withMembership` with all four roles
   (owner, admin, bookkeeper, viewer): reports are read-only. Non-members get
   404 and unauthenticated callers 401, per ADR 0006. RLS (`app.business_id`)
   confines all queries, and each query also filters on `business_id`
   explicitly as defence in depth. A foreign `accountId` simply matches
   nothing.
9. **API shape.** `GET /api/businesses/:id/reports/{trial-balance,
   profit-loss, balance-sheet, general-ledger, tax-summary}` (prefixed `/api`
   like the existing routes). Query: `asOf` (trial balance, balance sheet) or
   `from`/`to` (others), `format=json|csv` (default json). Dates are validated
   with `z.iso.date()` (real calendar dates only), `from <= to` is enforced,
   and the db layer re-validates before dates reach SQL (always bound
   parameters, never interpolated).
10. **CSV.** RFC 4180 (CRLF, quote on comma/quote/CR/LF, doubled quotes),
    `text/csv; charset=utf-8`, `Content-Disposition: attachment`,
    `Cache-Control: no-store`. **Formula-injection guard:** a *string* cell
    beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so
    spreadsheets treat it as text. Numeric cells (our integer amounts, which
    may be negative) are emitted verbatim and never guarded. Account names and
    transaction descriptions are user-controlled, so this applies to them. The
    guard changes the displayed text of such cells by one character; that is
    the accepted trade-off. CSV generation is pure (`apps/api/src/csv.ts`) and
    unit-tested without a database.

## Consequences

- Reports are always consistent with the ledger and cheap to add to.
- Large ledgers will need pagination and possibly materialised balances.
- Cash-basis reports, period closing, comparative columns and a proper tax-code
  model are deferred.
