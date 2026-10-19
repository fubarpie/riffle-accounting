# 0012. Wave migration

Status: accepted

## Context
Users are leaving Wave. A real Wave "Accounts transactions" export shows what we have to import:

- It is a **journal export**, not a bank-transaction export. Each row is one line of a double-entry transaction. Rows sharing a `Transaction ID` form one entry, and the entry must balance.
- There is **no separate chart of accounts file** in the export set. Accounts must be derived from the journal rows (`Account Name`, `Account Group`, `Account Type`).
- Customers, vendors and bill-item exports are separate CSVs and are often empty.
- Wave's CSV import is known to mishandle signs, so we must not copy its approach.

Observed format traps the importer must handle:

1. Transaction IDs are 19-digit integers. They exceed 2^53 and **must be read as strings**, never numbers.
2. One header cell is blank (between `Amount (One column)` and the debit column). Columns are matched by name where possible and by position for the blank one.
3. `Amount (One column)` is signed relative to the account, not to debit/credit. **The two-column debit/credit fields are authoritative**; the one-column amount is ignored (and used only as a cross-check warning).
4. Memo fields contain quoted newlines and commas.
5. Account names contain trailing spaces, doubled spaces and en-dashes. Names are normalised for matching but the original is kept for display and for the mapping report.
6. Wave generates a `Transfer Clearing` account. Each transfer between two bank accounts appears as two separate transactions that both touch it.
7. Zero-amount lines and entries exist, as do reversal entries and placeholder accounts such as `misc`.
8. The `Account ID` column holds an account number (for example a loan number or card suffix), not a Wave identifier. Treat it as optional metadata and treat it as sensitive.

## Decision
- **One importer, three stages.** Upload a Wave journal CSV, then stage accounts, then stage entries. Nothing touches the ledger until a human approves.
- **Accounts first.** Distinct `(name, group, type)` rows become staged accounts. Wave group maps to our account class (Asset, Liability, Equity, Income, Expense). The user can rename, merge or map each one to an existing account before entries are staged. An account name seen with two different groups is an error the user must resolve.
- **Entries.** Rows group by `Transaction ID` string. An entry is valid only if debits equal credits to the cent, every account is mapped, and the date parses. Invalid entries are flagged and cannot be approved until fixed or excluded, reusing the Phase 5 gate and `postStaged` path, so ledger invariants and the audit log apply unchanged.
- **Money is parsed as integer cents** from the decimal strings. No floats. Negative debit/credit values are rejected and flagged.
- **Zero-amount entries** are skipped with a warning in the report, not silently dropped.
- **Idempotency.** The Wave `Transaction ID` is stored as an external reference on the posted entry, and re-importing the same file skips entries already imported.
- **Trial balance as proof.** After staging, the importer compares computed balances per account to an optional Wave trial balance CSV. If none is supplied it shows computed balances for the user to check against Wave by hand.
- **Contacts.** Customers and vendors CSVs import into contacts with the same staging flow. Header-only files are valid and produce an empty batch.
- **Manual journals** are API-only in Wave. The journal export already contains them as ordinary entries, so no API integration is needed for the export-based path.
- **Privacy.** Uploaded files are processed in memory and the staged rows are scoped by business with row-level security. Fixtures in the repo are synthetic only.

## Resolved decisions
1. **Transfer Clearing: import as-is.** The `Transfer Clearing` account and both legs are imported faithfully. Pairing legs into a single transfer is an optional step after import and is a later phase.
2. **Opening balances: import as given.** No synthetic entries are added. The trial balance check exposes any gap against Wave's balance sheet. An optional opening-balance entry may be added later.
3. **Date range: import the whole file.** A from/to filter is a later option.

## Consequences
- The importer is deterministic and needs no model.
- Large files (thousands of lines) must be parsed in a streaming way and staged in batches.
- Backup/restore docs and the security review follow this work and cover the new staging tables.

## Approval (decided with the owner; defaults, open to change)

Approval posts every valid, non-excluded entry of a staged batch through the
normal ledger path in one transaction (`POST /api/businesses/:id/imports/:bid/approve`,
owner/admin/bookkeeper). All checks run before the first write, so a batch posts
completely or not at all.

1. **Source class is kept.** The source account class ("Account Group" in a Wave
   journal) is stored on each staged account (`import_accounts.source_group`).
   No schema change was needed.
2. **Class must match.** An account may only be mapped to, or created as, the
   ledger type its source class implies (Asset→asset, Liability→liability,
   Equity→equity, Income→income, Expense→expense). A mismatch is refused when
   mapping (422) and blocks approval (409); it is never coerced. A blank or
   unrecognised class is not judged.
3. **Locked periods block the whole batch.** If any entry to be posted is dated
   on or before `books_locked_through`, approval is refused and the response
   names the count and the earliest date. Nothing is posted silently and nothing
   is excluded automatically: the reviewer excludes those entries or moves the
   lock date, then approves.

Other behaviour: accounts chosen as "create" are created at approval time in the
business currency and the staged account is re-pointed at them; every posted
entry is a `journal` transaction whose notes carry the source and its entry id;
entries another import has already posted are skipped (staging pre-excludes
them; approval re-checks in case two files were staged before either was
approved); a second approval is a 409.
