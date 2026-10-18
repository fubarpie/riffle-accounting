/** Typed errors and warnings for the SimpleFIN client. Messages never contain credentials. */

export class SimpleFinError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The setup token is not valid Base64 / not a valid https claim URL. */
export class SimpleFinTokenError extends SimpleFinError {}

/** Claiming failed (token already claimed, compromised, or server refused). Never retry. */
export class SimpleFinClaimError extends SimpleFinError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** HTTP 402/403 on data fetch: the Access URL was disabled or revoked. */
export class SimpleFinAccessRevokedError extends SimpleFinError {
  constructor(readonly status: 402 | 403) {
    super(`SimpleFIN access token disabled or revoked (HTTP ${status})`);
  }
}

/** HTTP 429. */
export class SimpleFinRateLimitedError extends SimpleFinError {
  constructor(readonly retryAfterSeconds?: number) {
    super("SimpleFIN rate limit exceeded (HTTP 429)");
  }
}

export class SimpleFinTimeoutError extends SimpleFinError {
  constructor(readonly timeoutMs: number) {
    super(`SimpleFIN request timed out after ${timeoutMs}ms`);
  }
}

/** Any other non-2xx response. */
export class SimpleFinHttpError extends SimpleFinError {
  constructor(readonly status: number) {
    super(`SimpleFIN request failed (HTTP ${status})`);
  }
}

/** Response was not JSON or did not match the Account Set schema. */
export class SimpleFinProtocolError extends SimpleFinError {}

/** Invalid access URL, amount, or request range supplied by the caller. */
export class SimpleFinInputError extends SimpleFinError {}

export type SimpleFinWarningKind = "auth" | "connection" | "account" | "general";

/** A non-fatal message from the server's errlist / errors fields. */
export interface SimpleFinWarning {
  kind: SimpleFinWarningKind;
  /** Spec error code (e.g. "con.auth"), or "unknown" for legacy string errors. */
  code: string;
  message: string;
  connectionId?: string;
  accountId?: string;
}
