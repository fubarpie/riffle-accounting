# Worker: scheduled SimpleFIN import

The worker (`MODE=worker`, `apps/worker`) imports bank transactions from
SimpleFIN into the staging table (`staged_transactions`). It never posts to the
ledger; a person or a rule approves staged rows (ADR 0009). The same image and
code path serve both the scheduler and any future "import now" trigger
(`importConnection`).

## Schedule

- The scheduler wakes every `RIFFLE_IMPORT_INTERVAL_SECONDS` (default 60) and
  runs one pass immediately at start-up, so a restart catches up on missed
  slots.
- Each connection has one **daily slot**: the UTC hour is derived from a hash
  of the connection id (`slotHour`), and the minute is the connection's
  `schedule_minute`. Load spreads over the day with no coordination.
- A connection is due when its `last_synced_at` is older than the most recent
  slot, or it has never synced. Dueness is a pure function of database state
  (`isDue`), so replicas agree without talking to each other.
- A connection in `error` status ignores the slot and is retried once
  `RIFFLE_IMPORT_RETRY_MINUTES` (default 360) have passed since the failed
  attempt (`updated_at`). That caps failures at 4 attempts a day by default,
  well under SimpleFIN's 24-requests-a-day limit.
- `disabled` connections are never imported.
- A connection with no linked accounts is skipped without calling the bank and
  without advancing `last_synced_at` (advancing it would shrink the fetch
  window and lose history for accounts linked later). The scheduler leaves it
  alone for an hour.
- Fetch window: last success minus 5 days, at most 90 days (SimpleFIN's limit),
  with pending items included. If an account was linked after the last sync,
  the full 90 days are fetched. Re-fetching the overlap is harmless because
  staging is idempotent on `(connection_id, external_id)`.

## Discovery and tenancy

`riffle_app` is confined by row-level security to one business per
transaction, so the worker cannot list connections across businesses with plain
SQL. Migration `0005_worker_bank_discovery.sql` adds
`riffle_worker_bank_connections(p_id uuid DEFAULT NULL)`, a `SECURITY DEFINER`
function returning only `id, business_id, created_by, status, last_synced_at,
updated_at, schedule_minute`. It never returns the encrypted URL, key id, label
or last error. Everything else (reading links, decrypting the access URL,
staging, recording results) runs through `withTenant` with RLS enforced, acting
as the connection's `created_by` user. The worker never connects as the owner.
See the ADR 0009 addendum for the trade-off.

## Locking

Each import takes a **session-level Postgres advisory lock**
(`pg_try_advisory_lock(hashtextextended('riffle:bank_import:<id>', 0))`) on a
dedicated pooled connection for the whole run. It is try-acquired: a second
worker (or a manual run) gets outcome `locked` immediately instead of waiting.
A row lock would hold a transaction open across a network call; this does not.
After taking the lock the importer re-reads the connection and, for scheduled
runs, re-checks dueness, so two replicas that both saw it as due import it
once. If releasing the lock fails the pooled connection is discarded, which
releases it.

Network access happens outside any database transaction: read and decrypt in
one short transaction, fetch, then stage and record the result in another.

## Error handling

| Situation | Result |
| --- | --- |
| HTTP 402/403 from SimpleFIN | Connection set to `disabled` with a "re-authorize" `last_error`. Needs a new setup token. |
| HTTP 429 | Recorded as `error`; the scheduler stops calling SimpleFIN for `Retry-After` seconds (default 1 hour) for all connections. |
| Other HTTP, timeout, bad payload, decrypt failure | Recorded as `error` with a short generic message; retried after `RIFFLE_IMPORT_RETRY_MINUTES`. |
| Provider `errlist` entries (non-auth) | Import succeeds and `last_synced_at` advances; the messages are kept in `last_error` for display. A rate-limit message also triggers the back-off. |
| `errlist` auth entry (`*.auth`) | Rows are staged, but the run is `partial`: status `error`, `last_synced_at` not advanced. |
| One linked account fails to stage | Its rows roll back to a savepoint; the other accounts still stage. Run is `partial`, `last_synced_at` not advanced, so the next run re-covers it. |
| Provider account with no link | Skipped and reported (`unlinkedAccounts`); its transactions are not staged. |
| Database error during a tick | Logged; the connection stays due and is retried next tick. |

Messages stored or logged never contain URLs or credentials: any
`scheme://...` text is replaced with `[url]`, messages are length-bounded, and
only typed SimpleFIN client errors are echoed. Unknown errors are reduced to
their class name. Logs are JSON lines with ids and counts only.

Note: SimpleFIN HTTP 401 is treated as an ordinary failure (`error`, retried),
not as revocation; only 402/403 disable a connection.

## Shutdown

On SIGTERM/SIGINT the worker stops scheduling, lets in-flight imports finish for
up to 20 seconds, then aborts their SimpleFIN requests and closes the pool. An
aborted run records nothing as success, so the connection is retried.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIFFLE_SECRET_KEY` | none | Key ring `id:key[,id:key]` used to decrypt stored Access URLs. Must match the api's. |
| `RIFFLE_IMPORT_ENABLED` | auto | Unset: on when `DATABASE_URL` and `RIFFLE_SECRET_KEY` are both set. `true`: required, start-up fails if either is missing. `false`: off. |
| `RIFFLE_IMPORT_INTERVAL_SECONDS` | 60 | Scheduler tick, 5 to 3600. |
| `RIFFLE_IMPORT_CONCURRENCY` | 2 | Connections imported at once per worker, 1 to 8. |
| `RIFFLE_IMPORT_RETRY_MINUTES` | 360 | Wait before retrying a failed connection, 15 to 1440. |

Invalid values stop the worker at start-up. Blank values count as unset. In
`docker-compose.yml` these are passed through from `.env`.

## Tests

`apps/worker/test` runs against real PostgreSQL (embedded locally,
`TEST_DATABASE_URL` in CI) with a mocked `fetch`. The database is shared by
test files, so scheduler tests filter to their own connection ids.
