# ADR 0006: Authentication, sessions and API access control

- Status: Accepted
- Builds on: ADR 0004 (tenancy and roles), ADR 0005 (schema notes)

## Context

Phase 1 needs sign-in and a tenant-scoped HTTP API. Riffle is self-hosted by
small businesses, so the design favours few moving parts, no external identity
provider, and defaults that are safe when the operator changes nothing.

## Decisions

1. **Passwords** are hashed with scrypt from `node:crypto` (N=2^15, r=8, p=1,
   16-byte salt, NFKC-normalised input, 10 to 256 characters). Parameters are
   stored in each hash so they can be raised later. No native dependency.
   Login always performs one verification, against a dummy hash for unknown
   emails, so timing does not reveal which accounts exist.
2. **Sessions** are opaque 256-bit random tokens in an `HttpOnly`,
   `SameSite=Lax` cookie (`Secure` by default in production). Only the SHA-256
   of the token is stored (`sessions`, migration 0002), so a database leak does
   not yield live sessions. Expiry is sliding (30 days, refreshed at most once
   an hour). The app role may create, touch and delete sessions but cannot
   change which user one belongs to. Sessions sit outside RLS because they are
   looked up before a user is known.
3. **CSRF**: `SameSite=Lax` plus an `Origin` check on every state-changing
   request (must match `Host` or `TRUSTED_ORIGINS`; `Origin: null` is refused).
   No token round-trip is needed for a same-origin SPA.
4. **Brute force**: in-memory failure counters per client IP (20 / 15 min) and
   per account (8 / 15 min), returning 429. This is a per-process brake, not a
   guarantee across replicas.
5. **Registration** is closed after the first account unless
   `ALLOW_REGISTRATION=true`. A fresh install is therefore not an open sign-up
   form by default. Members are added to a business by an owner/admin using the
   email of an existing user; email invitations are future work.
6. **Authorisation** lives in one place, `withMembership(userId, businessId,
   allowedRoles, fn)`. It reads the caller's role and sets `app.business_id`
   in the same transaction, then RLS confines every query to that business.
   Non-members get **404**, identical to a missing business, so ids cannot be
   probed; members with too low a role get **403**.
7. **Role rules**:
   - Audit log: owner, admin and bookkeeper. Viewers get 403 (user decision).
   - Member list and changes: owner and admin. Admins may only add, change or
     remove bookkeepers and viewers; only owners touch owners and admins.
   - Any member may leave. The database refuses to remove the last owner.
   - All member changes are written to the audit log.
8. **Database roles at runtime**: the API process connects as the restricted
   `riffle_app` role. Only the API receives owner credentials
   (`MIGRATE_DATABASE_URL`) to apply migrations and set the `riffle_app`
   password at start-up. The worker gets only the restricted URL.

## Consequences

- Anyone able to run SQL as `riffle_app` can read all users' email and password
  hashes (the `users` table has no RLS, since login must look users up by
  email). Compromise of the app process already implies this.
- Rate limits reset on restart and are not shared between replicas.
- Single sign-on, MFA and password reset are not included; each needs its own
  ADR (reset needs outbound email, which is not yet configured).
