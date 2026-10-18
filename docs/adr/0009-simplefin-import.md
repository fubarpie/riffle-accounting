# ADR 0009: SimpleFIN bank import (storage layer)

- Status: Accepted
- Builds on: ADR 0004 (ledger and tenancy), ADR 0006 (access control), ADR 0007 (rules engine)

## Context

Riffle imports bank transactions from SimpleFIN Bridge. The access URL embeds
credentials, bank data is untrusted and arrives repeatedly (overlapping
windows, pending items that later change), and the ledger is append-only
(ADR 0004). Money is integer minor units (`bigint`), one currency per business.

This ADR covers the database layer only (`packages/db/src/bank/`, migration
`0004_bank_connections.sql`). The SimpleFIN HTTP client, scheduler and API
routes are separate work and consume these functions.

## Decisions

### Staging before ledger

Imports never write journal entries. Each fetched item becomes a row in
`staged_transactions` with status `new`, `approved`, `ignored` or `posted`.
`new`, `approved` and `ignored` move freely between each other through
`updateStaged`; `posted` is reached only through `postStaged` and is terminal.
A bad or duplicate import therefore costs a staged row to ignore, not a
reversing entry in the books. `raw` keeps the provider payload (size-capped);
list results omit it and `getStaged` returns it.

`source` is open-ended (`simplefin` now, `statement` for Phase 5 uploads).
SimpleFIN rows must have a `connection_id` (CHECK); other sources may not.

### `importBatch`: idempotent staging

`importBatch(client, businessId, actor, connectionId, ParsedTransaction[])`
is the single entry point. `ParsedTransaction` is provider-neutral:
`externalAccountId`, `externalId`, `postedDate` (`YYYY-MM-DD`), signed
`amountMinor` (positive = into the account), `description`, `pending`, `raw`.

- **Idempotency key.** `UNIQUE (connection_id, external_id)`; a partial unique
  index on `(business_id, source, external_id) WHERE connection_id IS NULL`
  gives connection-less sources the same guarantee. Rows are inserted with
  `ON CONFLICT DO NOTHING`, so replaying a batch, or the 5-day overlap window a
  sync deliberately re-requests, inserts nothing and counts as `duplicate`.
  Repeats within one batch collapse to one row; if a later copy is settled and
  the earlier one pending, the settled copy wins.
- **Account links.** The provider account is resolved through
  `bank_account_links` to a ledger asset or liability account. Items for an
  unlinked provider account are skipped and reported
  (`skippedUnlinked`, `unlinkedAccounts`) rather than failing the batch.
- **Pending to settled.** If a key already exists and the stored row is still
  `pending`, and the bank now reports different data (settled, new date, new
  amount, new description), the row is updated in place (`updated`) and a
  `staged.pending_update` audit entry records before/after. It is never
  duplicated. Once a row is settled, later echoes of the pending version are
  ignored. A person's `status` and chosen category survive the update. Rows
  already `posted` are never touched; a database trigger also freezes them
  (see below).
- **Pending rows cannot enter the ledger.** `updateStaged` refuses to approve
  a pending row and `postStaged` refuses to post one. A pending item that
  disappears without a settled match is left for a human to ignore; it is
  never deleted, since the ledger never saw it.
- **Untrusted input.** Dates must be real calendar dates, amounts `bigint` within
  +/-9e15, ids 1-200 characters, `raw` at most 32 KiB, batches at most 5,000.
  These raise `BankInputError` before anything is written. Descriptions are
  truncated to 1,000 characters and NUL characters (which Postgres cannot
  store) are stripped, so one odd row cannot fail a whole sync; the same
  normalised value is used for duplicate detection.
- Disabled connections refuse imports (`ConnectionDisabledError`). Each batch
  writes one `bank_import.batch` audit row with the counts.

### `postStaged`: staging to ledger

`postStaged(client, businessId, actor, stagedId, { categoryAccountId? })`
posts one staged row through the normal ledger path (`postTransaction`), so
balance validation, the append-only triggers and the lock-date trigger all
apply unchanged. Nothing in `bank/` inserts journal rows itself.

- The entry has two lines: the linked bank or card account takes the signed
  amount as reported, the category takes the negation. For an asset account a
  positive amount is a debit (money in); for a liability account a charge is
  negative, a credit that raises the balance owed.
- **Category precedence:** (1) a category a person chose, either the option or
  the one stored on the staged row; (2) the Phase 2 rules engine (ADR 0007),
  which also contributes notes and tags and is evaluated with the absolute
  amount, as it is for posted transactions; (3) the system accounts
  Uncategorized Income (4900) for money in and Uncategorized Expense (6900)
  for money out. A rule category that is archived or not income/expense is
  ignored in favour of the fallback. The result reports `categorySource`
  (`chosen`, `rule`, `uncategorized`) and the matched `ruleIds`.
- Transactions are `deposit`/`withdrawal` when the category is income or
  expense, so later rule runs can still re-categorise them by reversal;
  `transfer` for asset/liability categories.
- Refused: already posted, ignored, pending, zero amount, archived bank or
  category account, or a category equal to the bank account.
- **Lock date.** The application checks `books_locked_through` first and throws
  `BooksLockedError` (the date is inclusive); the database trigger remains the
  authority and a trigger rejection is mapped to the same error. Staging
  itself is allowed inside locked periods, since it is not the ledger.
- On success the staged row becomes `posted` with `transaction_id` set. Two
  CHECKs tie them together: `status = 'posted'` iff `transaction_id IS NOT
  NULL`, and a pending row can never be `posted`. A `BEFORE UPDATE` trigger
  rejects any change to a posted row (SQLSTATE 55000), and the unique index on
  `(business_id, transaction_id)` allows one staged row per ledger
  transaction. `riffle_app` has no DELETE on `staged_transactions`.
- Audit entries: `staged.update`, `staged.pending_update`, `staged.post` (with
  category source, rule ids and tags) in addition to the ledger's own
  `transaction.post`. A failure rolls everything back, audit included.

### Encryption at rest with a key ring

`bank_connections.access_url_enc` holds the access URL encrypted with
AES-256-GCM (`src/bank/secrets.ts`): a fresh random 12-byte IV per message, a
16-byte tag, and the blob layout `format byte | IV | tag | ciphertext`. The
associated data is `riffle:bank_connection:<businessId>:<connectionId>`, so a
ciphertext copied to another connection or tenant fails authentication.
Tampering, a wrong key and a wrong context all raise the same opaque
`SecretError`, whose message never contains plaintext or key material.

Keys come from `RIFFLE_SECRET_KEY`: comma-separated `id:key` entries (a bare
key has id `1`), each key 32 bytes as base64 or 64 hex characters. The first
entry encrypts new data. `access_url_key_id` records which key encrypted a row.
Rotation: put a new key first (`2:<new>,1:<old>`), run `rotateConnectionKeys`
(re-encrypts every row not on the current key, one `bank_connection.rotate_key`
audit row each), and drop the old key once it returns 0. A missing, malformed
or duplicated key fails closed; so does a row whose key id is no longer in the
ring.

The URL is never logged, audited or returned. Every query on `bank_connections`
other than `getAccessUrl` names its columns explicitly and omits
`access_url_enc`; the `BankConnection` type has no URL field. `getAccessUrl` is
for the sync worker only. `updateConnection` loads the key ring from the
environment only when it has to re-encrypt a replaced URL.

The key ring lives in the environment, not the database, so a database leak
alone does not expose bank credentials.

## Tenancy and access

All three tables (`bank_connections`, `bank_account_links`,
`staged_transactions`) carry `business_id` with ENABLE and FORCE RLS and the
`tenant_isolation` policy used by 0001 and 0003. Composite foreign keys keep a
link or staged row from referencing another business's connection, account or
transaction. A connection id from another tenant is simply "not found".

Roles follow ADR 0006: owner, admin and bookkeeper may write
(`BANK_WRITER_ROLES`); viewer is read-only. As with the ledger and rules, the
functions take a client already inside `withTenant`, and **the caller enforces
the role** by wrapping them in `withMembership(pool, userId, businessId,
BANK_WRITER_ROLES, ...)`; read paths may allow `viewer`. The database does not
distinguish roles, so any new route must use that wrapper; tests cover the
`ForbiddenError` path for each write function. Connection create/update,
sync results, key rotation, link changes, imports, staged updates and posts
all write `audit_log` rows, none of which contain the URL or ciphertext.

## Consequences

- One more review step before data hits the books; deliberate.
- Staging is mutable working state; the ledger is not. Corrections after
  posting go through the existing edit-by-reversal path, not the staged row.
- Losing every key in the ring makes stored URLs unrecoverable; connections
  must be re-created. Back keys up separately from the database.
- Matching a pending item that reappears under a *different* external id is
  not attempted here: it appears as a new row and the old pending row waits to
  be ignored. If SimpleFIN proves to do this in practice, a matching step can
  be added in front of `importBatch` without schema changes.
- Transfers between two linked accounts are not auto-detected; each side
  stages and posts separately (one will typically need a chosen category).

## Addendum: worker connection discovery (migration 0005)

The scheduled import (docs/worker-import.md) must find connections in every
business, but RLS lets `riffle_app` see one business per transaction. Migration
`0005_worker_bank_discovery.sql` adds
`riffle_worker_bank_connections(p_id uuid DEFAULT NULL)`:

- `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `STABLE`, owned by
  the migrating (owner) role.
- Returns `id, business_id, created_by, status, last_synced_at, updated_at,
  schedule_minute` only. No ciphertext, key id, label or error text.
- `REVOKE ALL ... FROM PUBLIC`, then `GRANT EXECUTE ... TO riffle_app`.
- Because `bank_connections` is FORCE RLS and its only policy targets
  `riffle_app`, the migration also adds a `SELECT`-only `worker_discovery`
  policy for the owner role so the function sees rows even when the owner is
  not a superuser.

**Trade-off.** No dedicated role: the existing migrations use a single
application role (`riffle_app`) and already expose `business_has_members()` the
same way, so a second login role would add deployment surface (another
password, another pool) for this one function. The consequence is that the API
process, which shares `riffle_app`, can also call the function, and so can any
SQL injection in it. What leaks is bounded: connection and business ids, the
creating user id, status and timestamps, never secrets, and no write access.
The function does not widen table access: direct `SELECT` on `bank_connections`
without a tenant context still returns nothing. If the worker is later split
onto its own role, grant `EXECUTE` to that role and revoke it from
`riffle_app` in a new migration.
