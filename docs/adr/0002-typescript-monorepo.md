# ADR-0002: TypeScript monorepo

- Status: Accepted
- Date: 2026-10-18

## Context
The system has an API, a background worker, and a web UI, with shared types
and domain logic (ledger, rules, SimpleFIN adapter, extraction validation).

## Decision
- Node 22 LTS and TypeScript with `strict` plus `noUncheckedIndexedAccess`.
- pnpm workspaces: `apps/*` for deployables, `packages/*` for shared libraries.
- Backend: Fastify. Frontend: React with Vite. Tests: Vitest.
- One Docker image with two run modes, `MODE=api` and `MODE=worker`.
- PostgreSQL is the only required external service. The job queue will live in
  Postgres, so there is no Redis.
- Money is stored as integer minor units, never floats.

## Consequences
- One language across API, worker, and UI; domain code in `packages/*` is
  shared and unit tested without a database where possible.
- Workspace packages ship as TypeScript source and are bundled into each app
  by tsup, so there is no separate publish step.
- Database access (Drizzle ORM and SQL migrations) is introduced in Phase 1.
