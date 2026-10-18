# ADR-0004: Ledger and tenancy schema

- Status: Accepted
- Date: 2026-10-18

## Context
Phase 1 delivers the core of Riffle: users, businesses, gated access, a chart
of accounts, and a double-entry ledger. Everything later (rules, reports,
SimpleFIN import, reconciliation, AI upload) writes into or reads from this
schema, so mistakes here are expensive to undo.

Requirements that shape the design:
- Many businesses per installation. A user may belong to several businesses
  with a different role in each, and must never see data from a business they
  do not belong to.
- Double-entry: every posted entry balances, always.
- Users can edit and add transactions, but the books need an audit trail and
  history must not silently change.
- Self-hosted on PostgreSQL 16 with Drizzle ORM (see ADR-0002). No external
  services and no license or phone-home checks.

## Decision

### 1. Tenancy
- **`business` is the tenant.** `users` are global. `memberships`
  (`user_id`, `business_id`, `role`) grant access. A user has at most one
  membership per business.
- Roles are fixed in v1: `owner`, `admin`, `bookkeeper`, `viewer`. Roles carry
  permissions; there are no per-user grants. Every business must always have at
  least one `owner`. Custom roles are out of scope.
- **Every tenant-owned table has a `business_id NOT NULL` column.**
- **Cross-tenant references are impossible by construction.** Each tenant table
  has a `UNIQUE (business_id, id)` key, and foreign keys between tenant tables
  are composite, e.g. `FOREIGN KEY (business_id, account_id) REFERENCES
  accounts (business_id, id)`. A row can therefore only point at rows in its own
  business.
- **PostgreSQL row-level security is the enforcement layer**, with application
  checks on top rather than instead:
  - RLS is enabled and `FORCE`d on every tenant table.
  - Policy: `business_id = current_setting('app.business_id')::uuid`.
  - Each request runs in a transaction that first does
    `SET LOCAL app.business_id = ...` after the app has verified the user's
    membership. With no setting, the policy matches no rows.
  - The app connects as a dedicated role that is not a superuser, does not own
    the tables and does not have `BYPASSRLS`. Migrations run as a separate
    owner role.
  - Tables that are not tenant-scoped (`users`, `sessions`, `memberships`,
    `businesses`) are protected by queries that filter on the authenticated user.
    `memberships` and `businesses` get their own RLS policies keyed on
    `app.user_id`.
- Authorization (who may do what) is checked in the API layer from the
  membership role. Authentication mechanics (password hashing, sessions) get
  their own ADR.

### 2. Chart of accounts
- One chart per business, so there is no separate `chart_of_accounts` table.
  `accounts` hold `business_id`, `code` (optional, unique per business), `name`,
  `type` (`asset`, `liability`, `equity`, `income`, `expense`), optional
  `parent_id` for hierarchy, `currency`, and `archived_at`.
- Accounts are archived, never deleted, once they have lines. The normal
  balance side is derived from `type`, not stored.
- Account type cannot change after the account has lines.
- New businesses are seeded from the default template below, which the user can
  edit. Wave import (Phase 6) maps into the same structure.

#### Default chart (standard small business)
Codes follow the usual convention: 1xxx assets, 2xxx liabilities, 3xxx equity,
4xxx income, 5xxx cost of goods sold, 6xxx operating expenses. Cost of goods
sold uses type `expense`; there is no separate type. Accounts marked (system)
are created for every business and cannot be archived, because imports and
opening balances post to them.

| Code | Name | Type |
| --- | --- | --- |
| 1000 | Cash on Hand | asset |
| 1010 | Checking | asset |
| 1020 | Savings | asset |
| 1100 | Accounts Receivable | asset |
| 1200 | Inventory | asset |
| 1300 | Prepaid Expenses | asset |
| 1500 | Equipment | asset |
| 1510 | Accumulated Depreciation | asset (contra) |
| 2000 | Accounts Payable | liability |
| 2100 | Credit Card | liability |
| 2200 | Sales Tax Payable | liability |
| 2300 | Payroll Liabilities | liability |
| 2500 | Loans Payable | liability |
| 3000 | Owner's Equity | equity |
| 3100 | Owner's Contributions | equity |
| 3200 | Owner's Draws | equity |
| 3800 | Opening Balance Equity (system) | equity |
| 3900 | Retained Earnings (system) | equity |
| 4000 | Sales | income |
| 4100 | Service Revenue | income |
| 4200 | Interest Income | income |
| 4300 | Other Income | income |
| 4900 | Uncategorized Income (system) | income |
| 5000 | Cost of Goods Sold | expense |
| 5100 | Shipping and Freight | expense |
| 6000 | Advertising and Marketing | expense |
| 6010 | Bank Fees | expense |
| 6020 | Contractors | expense |
| 6030 | Depreciation | expense |
| 6040 | Insurance | expense |
| 6050 | Interest Expense | expense |
| 6060 | Licenses and Permits | expense |
| 6070 | Meals | expense |
| 6080 | Office Supplies | expense |
| 6090 | Professional Fees | expense |
| 6100 | Rent | expense |
| 6110 | Repairs and Maintenance | expense |
| 6120 | Software and Subscriptions | expense |
| 6130 | Taxes | expense |
| 6140 | Travel | expense |
| 6150 | Utilities | expense |
| 6160 | Wages and Salaries | expense |
| 6900 | Uncategorized Expense (system) | expense |

Uncategorized income and expense are where imported and rule-less transactions
land until the user categorizes them. Other templates (by industry) can be added
later without schema changes.

### 3. Ledger
- **Amounts are integers in minor units** (`bigint`, e.g. cents), never floats
  or `numeric` with rounding. Currency is an ISO 4217 code per business.
  **Exactly one currency per business in v1** (decided); multi-currency is
  deferred, and `currency` columns are kept so it can be added without a
  rewrite. A business's currency is set at creation and cannot change once it
  has lines.
- Tables:
  - `transactions`: the user-facing record (`kind`: `deposit`, `withdrawal`,
    `transfer`, `journal`; `date`, `description`, `notes`, category and tags
    live on lines or link tables). Rules, the register UI, imports and AI
    staging all work at this level.
  - `journal_entries`: one per posted version of a transaction, with
    `transaction_id`, `entry_date`, `reverses_entry_id` (nullable) and
    `created_by`.
  - `journal_lines`: `entry_id`, `account_id`, `amount_minor` and an optional
    line memo. **Signed amounts: debit positive, credit negative, never zero.**
- **Balance invariant:** for every entry, `SUM(amount_minor) = 0`. It is
  enforced in the database by a deferred constraint trigger checked at commit,
  not just in application code. An entry also needs at least two lines.
- **Account balances are derived** by summing lines. There is no stored mutable
  balance column. Materialized or cached balances may be added later for
  performance, and must be rebuildable from lines.
- **Posted entries are immutable.** Triggers reject `UPDATE` and `DELETE` on
  `journal_entries` and `journal_lines`. Editing a transaction inserts a
  reversing entry plus a new entry, and `transactions.current_entry_id` points
  at the live one. Deleting a transaction reverses it and marks it voided.
  History is therefore always reconstructible.
- A **transfer** is one transaction whose entry has a debit line on one asset
  or liability account and a credit line on another. Linking two existing
  transactions as a transfer (e.g. two imported bank rows) merges them into one
  transaction and is handled in Phase 3.
- `entry_date` is a `date` (the business's accounting date, no time zone).
  Audit timestamps are `timestamptz`.
- A per-business lock date (`books_locked_through`) is reserved for
  reconciliation in Phase 4. Posting on or before it will be rejected.

### 4. Audit log
- Append-only `audit_log` (`business_id`, `actor_user_id`, `action`,
  `entity`, `entity_id`, `at`, `before`/`after` JSON where useful). Written in the
  same transaction as the change. Immutable by trigger, like the ledger.
- **Viewers cannot read the audit log** (decided). Owners, admins and
  bookkeepers can. This is enforced in the API layer by role. Because RLS keys
  on business and not role, the audit log read is also tested per role so a
  viewer request returns 403 and never rows.

### 5. Conventions
- Primary keys are UUIDv7 generated in the application, which gives
  time-ordered index locality and no enumerable IDs. PostgreSQL 16 has no
  native `uuidv7()`.
- `created_at`, `updated_at` on mutable tables. Ledger tables get `created_at`
  only.
- Schema is defined in Drizzle. Triggers, RLS policies and roles are in
  hand-written SQL migrations alongside the generated ones, since Drizzle does
  not model them.

### 6. Testing (the Phase 1 exit criteria)
- CI runs a PostgreSQL service container. Tests run against real Postgres, not
  a mock.
- **Property tests** (fast-check) generate random sequences of postings, edits,
  voids and transfers and assert: every entry sums to zero, the trial balance
  sums to zero, and balances equal the sum of lines.
- **Tenancy tests:** for every tenant table, as a user of business A, SELECT,
  INSERT, UPDATE and DELETE against business B's rows fail or return nothing,
  including with a forged `business_id` and with no `app.business_id` set. A
  test fails if a table with a `business_id` column lacks RLS, so new tables
  can't be added unprotected.
- **Seed test:** the default chart balances in structure (every account has a
  valid type, codes are unique, system accounts exist) for each new business.

## Alternatives considered
- **Separate schema or database per tenant.** Strong isolation, but migrations,
  backups and connection pooling become heavy for a self-hosted small-business
  app. Shared schema with RLS is simpler to run and still enforced by the
  database.
- **Application-level filtering only.** One forgotten `WHERE business_id` is a
  data leak. RLS and composite keys remove that class of bug.
- **Stored balances updated on write.** Faster reads, but they can drift from
  the lines. Derived balances are always correct. Caching can come later.
- **Debit and credit as separate columns.** Familiar to accountants, but allows
  rows with both or neither set. A signed amount makes the balance rule a plain
  sum, and the UI can still present debit and credit columns.
- **Mutable entries with an audit log only.** Simpler edits, but history
  depends on the log being perfect. Immutable entries with reversals give a
  ledger that cannot quietly change, as in other double-entry systems (the Square
  Books approach is the reference).

## Consequences
- Cross-tenant leaks need a bug in the database layer, not only in a handler.
- Every request pays for a transaction with `SET LOCAL`, and the connection
  pool must never reuse a connection with a stale setting (hence `SET LOCAL`
  inside a transaction only).
- Edits create more rows than an in-place update, and reports must read only
  live entries (not reversed ones). A view over live lines will be provided so
  reports do not re-implement this.
- Migrations are more involved (roles, RLS, triggers) and need review.
- Multi-currency, fiscal periods and custom roles are explicitly deferred and
  will need a follow-up ADR.
- A business that earns or holds a second currency has to run a second
  business for it until multi-currency lands.

## Resolved questions
- Viewer access to the audit log: no.
- Single currency per business for v1: yes.
- Default chart: the standard small-business chart above.
