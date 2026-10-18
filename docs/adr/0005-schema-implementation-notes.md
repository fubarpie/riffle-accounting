# ADR 0005: Schema implementation notes

- Status: Accepted
- Amends: ADR 0004

## Context

Implementing ADR 0004 surfaced three small departures. None changes the tenancy or ledger model.

## Decisions

1. **Hand-written SQL migrations are the source of truth.** Drizzle's schema in `packages/db` mirrors them for typed queries. A drift test compares the Drizzle schema to a freshly migrated database and fails CI on any difference. RLS, triggers and roles cannot be expressed in Drizzle, which is why generated migrations were not used.
2. **`accounts.contra` flag.** Contra accounts (for example Accumulated Depreciation) carry a normal balance opposite to their type. The flag lets reports sign them correctly.
3. **`businesses` and `memberships` use RLS without FORCE.** The owner role must read them to run migrations and one helper function that resolves membership before a tenant context exists. The app role (`riffle_app`, non-bypass) is still fully subject to RLS. All other tenant tables use FORCE RLS.

## Consequences

- Schema changes need a new SQL migration plus a matching Drizzle edit; the drift test enforces both.
- Tests run against real Postgres 16 (CI service container; locally via `embedded-postgres` pinned to 16.x).
- Still open for the API phase: audit-log read access per role. Viewers get 403 (decided); bookkeeper access is assumed allowed and needs confirmation.
