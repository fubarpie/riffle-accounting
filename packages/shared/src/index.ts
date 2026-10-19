// SPDX-License-Identifier: AGPL-3.0-or-later
// Riffle - free and open source small business bookkeeping software.

export const APP_NAME = "Riffle";
export const SOURCE_URL = "https://github.com/fubarpie/riffle-accounting";

/** Run modes supported by the single Riffle image. */
export const MODES = ["api", "worker"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Parse the MODE environment variable.
 * Defaults to "api" when unset; throws on unknown values so a typo fails fast
 * instead of silently starting the wrong process.
 */
export function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "") return "api";
  if ((MODES as readonly string[]).includes(value)) return value as Mode;
  throw new Error(`Invalid MODE "${value}". Expected one of: ${MODES.join(", ")}`);
}

/**
 * Parse a TCP port from an environment variable.
 * Throws when the value is not an integer between 1 and 65535.
 */
export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`Port out of range: ${port}`);
  return port;
}

/** Shape of the JSON returned by every service's /healthz endpoint. */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
}

/** Build version, injected at image build time via APP_VERSION. */
export function getVersion(env: Record<string, string | undefined> = process.env): string {
  return env["APP_VERSION"] && env["APP_VERSION"] !== "" ? env["APP_VERSION"] : "dev";
}

export * from "./csv";
export * from "./wave-journal";
