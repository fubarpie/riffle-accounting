// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Keyring, parseKeyring } from "@riffle/db";

export interface ImportConfig {
  enabled: boolean;
  /** Scheduler wake-up period. */
  tickMs: number;
  /** Max connections imported at the same time by this replica. */
  concurrency: number;
  /** Minimum wait before retrying a connection whose last attempt failed. */
  retryMs: number;
  /** How long shutdown waits for in-flight imports before aborting their fetches. */
  shutdownGraceMs: number;
}

type Env = Record<string, string | undefined>;

function intInRange(raw: string | undefined, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function parseBool(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Read the import settings.
 *
 * RIFFLE_IMPORT_ENABLED unset: the import runs only when both DATABASE_URL and
 * RIFFLE_SECRET_KEY are present, so a Phase 0 style deployment keeps working.
 * Explicitly true with either missing is a configuration error (fail closed).
 */
export function loadImportConfig(env: Env = process.env): ImportConfig {
  const explicit = parseBool(env["RIFFLE_IMPORT_ENABLED"], "RIFFLE_IMPORT_ENABLED");
  const hasPrereqs = Boolean(env["DATABASE_URL"]?.trim()) && Boolean(env["RIFFLE_SECRET_KEY"]?.trim());
  if (explicit === true && !hasPrereqs) {
    throw new Error("RIFFLE_IMPORT_ENABLED=true requires DATABASE_URL and RIFFLE_SECRET_KEY");
  }
  return {
    enabled: explicit ?? hasPrereqs,
    tickMs: intInRange(env["RIFFLE_IMPORT_INTERVAL_SECONDS"], "RIFFLE_IMPORT_INTERVAL_SECONDS", 60, 5, 3600) * 1000,
    concurrency: intInRange(env["RIFFLE_IMPORT_CONCURRENCY"], "RIFFLE_IMPORT_CONCURRENCY", 2, 1, 8),
    retryMs: intInRange(env["RIFFLE_IMPORT_RETRY_MINUTES"], "RIFFLE_IMPORT_RETRY_MINUTES", 360, 15, 1440) * 60_000,
    shutdownGraceMs: 20_000,
  };
}

/** Parse the key ring (RIFFLE_SECRET_KEY, `id:key,id:key`; the first entry is current). */
export function loadWorkerKeyring(env: Env = process.env): Keyring {
  return parseKeyring(env["RIFFLE_SECRET_KEY"]);
}
