import { SimpleFinClaimError, SimpleFinTokenError } from "./errors.js";
import { DEFAULT_TIMEOUT_MS, timedFetch, type FetchLike } from "./http.js";

export interface ClaimOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const B64 = /^[A-Za-z0-9+/_-]+=*$/;

/** Decode a setup token into a validated https claim URL (no credentials). */
export function decodeSetupToken(setupToken: string): URL {
  const t = setupToken.trim();
  if (t.length === 0 || !B64.test(t)) throw new SimpleFinTokenError("Malformed setup token");
  let decoded: string;
  try {
    decoded = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    throw new SimpleFinTokenError("Malformed setup token");
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new SimpleFinTokenError("Setup token does not contain a valid URL");
  }
  if (url.protocol !== "https:") throw new SimpleFinTokenError("Claim URL must use https");
  if (url.username || url.password) throw new SimpleFinTokenError("Claim URL must not contain credentials");
  return url;
}

/**
 * Exchange a one-time setup token for an Access URL. NOT retried: the token is single-use.
 * The returned Access URL contains credentials; callers must store it as a secret.
 */
export async function claimAccessUrl(
  setupToken: string,
  fetchImpl: FetchLike = fetch,
  opts: ClaimOptions = {},
): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const res = await timedFetch(
    fetchImpl,
    claimUrl.toString(),
    { method: "POST", body: "" },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.signal,
  );
  if (!res.ok) {
    throw new SimpleFinClaimError(`Claim failed (HTTP ${res.status}); token may be used or invalid`, res.status);
  }
  const body = (await res.text()).trim();
  let access: URL;
  try {
    access = new URL(body);
  } catch {
    throw new SimpleFinClaimError("Claim response was not a valid URL");
  }
  if (access.protocol !== "https:" || !access.username || !access.password) {
    throw new SimpleFinClaimError("Claim response was not an https Access URL with credentials");
  }
  return body;
}
