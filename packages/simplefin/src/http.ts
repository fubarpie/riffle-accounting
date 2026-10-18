import { SimpleFinTimeoutError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Run fetch with a timeout (and optional caller signal). Maps timeout aborts to a typed error. */
export async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    // redirect:"error" so credentials/tokens are never forwarded to another host.
    return await fetchImpl(url, { ...init, redirect: "error", signal: combined });
  } catch (err) {
    if (timeout.aborted) throw new SimpleFinTimeoutError(timeoutMs);
    throw err;
  }
}
