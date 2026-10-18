# @riffle/simplefin

SimpleFIN protocol client (spec 2.0.0-draft). The protocol is a moving draft, so consumers should depend on the `BankFeedAdapter` interface (`createSimpleFinAdapter`) rather than the raw functions.

- `claimAccessUrl(setupToken, fetch)`: Base64-decodes the token, POSTs (empty body, https only, no retries because tokens are single-use) and returns the Access URL. The Access URL holds credentials, so store it as a secret.
- `fetchAccounts(accessUrl, {startDate,endDate,pending,accountIds}, fetch)`: GET `/accounts` with Basic auth taken from the URL userinfo (stripped from the request URL). The response is validated with zod. Amounts become integer minor units via string/BigInt math (currency exponent, default 2). A single request is limited to 90 days.
- `planWindows(from,to)` splits a range into chunks of at most 90 days. `computeFetchRange(lastSyncedAt, now)` returns lastSync minus a 5-day overlap, capped at 90 days.
- `errlist` / `errors` become `SimpleFinWarning[]` on the result. HTTP 402/403 throws `SimpleFinAccessRevokedError`, 429 throws `SimpleFinRateLimitedError`, and timeouts (default 30s, via `AbortSignal`) throw `SimpleFinTimeoutError`.
- `randomMinuteSchedule(seed)` returns a deterministic minute from 1 to 59 so fetches avoid the top of the hour.

`fetch` is always injected, so tests make no network calls. Errors and logs never contain the setup token or URL credentials.

Run the tests with `pnpm --filter @riffle/simplefin test`.
