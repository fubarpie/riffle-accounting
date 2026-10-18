# ADR 0007: Rules engine

- Status: Accepted
- Builds on: ADR 0004 (ledger and tenancy), ADR 0006 (API access control)

## Context

Phase 2 adds per-business rules that categorise, annotate and tag
transactions automatically. They must not weaken the ledger's guarantees
(append-only, auditable), must be safe to run on user-supplied patterns, and
must respect the role model.

## Decisions

1. **Rules are data, the evaluator is pure.** A rule has a name, priority,
   `strict` flag (all vs. any condition), `enabled`, 1-20 conditions and 1-10
   actions, stored as validated JSON in `rules` (migration 0003).
   `evaluateRules` does no I/O and reads no clock, so a dry run and a real
   apply give identical answers. The behaviour was specified clean-room;
   Firefly III was only a behavioural reference (no code copied).
2. **Conditions:** description (contains / starts_with / regex), amount
   (equals / gt / lt / between, integer minor units as strings), account, date.
   **Actions:** `set_category`, `add_note`, `add_tag`. Unknown fields are rejected.
3. **Semantics.** Enabled rules run by ascending priority, ties in creation
   order. Conditions see the transaction as it was before any rule ran. The
   first matching `set_category` wins; later ones are reported as overridden.
   Notes and tags accumulate, de-duplicated, and are no-ops if already present,
   so applying twice changes nothing.
4. **Rules never touch posted lines.** The only ledger change is
   `editTransaction` (reversal entry plus replacement), the existing
   edit-by-reversal operation. Only deposits/withdrawals with exactly two lines
   and one income/expense line are categorisable; splits and transfers are
   reported as skipped. The target must be an active income/expense account in
   the same business. Books-locked periods skip that transaction alone
   (per-transaction savepoint).
5. **Audit.** `rule.create/update/delete` store before/after snapshots, and each
   changed transaction gets a `transaction.rule_apply` row (plus the
   `transaction.edit` row from the ledger), all in the same DB transaction as
   the change. Dry runs write nothing.
6. **ReDoS defence, in layers.** (a) Pattern length cap 200 and description
   input cap 1000 chars; (b) static rejection of back-references and quantified
   groups containing quantifiers; (c) **safe execution**: every regex test runs
   in a `node:vm` context with a 25 ms timeout, and a pattern that times out is
   treated as non-matching and not retried. Not a linear-time engine (RE2 would
   be, but adds a native dependency); the timeout bounds the worst case.
7. **Access.** Owner, admin and bookkeeper may create, update, delete and apply.
   Viewers may list, read and dry-run (it exposes only what they can already
   read) and get 403 on writes. Role is checked before the body is parsed.
   Non-members get 404; no session gets 401.
8. **Tenancy.** `rules` and `transaction_tags` have forced RLS on
   `app.business_id`, plus composite FKs on `(business_id, id)`. Every query
   also filters by business explicitly.
9. **Limits.** 500 rules per business; scans cap at 500 transactions per call.

## Consequences

- Rule changes are not retroactive until `apply` is called.
- Tags are mutable metadata outside the ledger.
- A timed-out regex costs up to 25 ms once per process, then is skipped.

## API

`GET/POST /api/businesses/:id/rules`, `GET/PATCH/DELETE .../rules/:ruleId`,
`POST .../rules/dry-run` (stored rules or `rules: [drafts]`), `POST .../rules/apply`.
