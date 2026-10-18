// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Keyring, parseKeyring } from "@riffle/db";

export interface ApiConfig {
  /** Mark the session cookie Secure. Defaults to true in production. */
  secureCookies: boolean;
  /** Allow sign-ups after the first account exists. The first user can always register. */
  allowRegistration: boolean;
  /** Extra origins (besides the request's own host) allowed to make state-changing requests. */
  trustedOrigins: string[];
  /** Key ring (RIFFLE_SECRET_KEY) for encrypting bank access URLs. Without it, bank routes answer 503. */
  keyring?: Keyring | undefined;
  /** Minimum gap between manual imports of one connection. Default 1 hour (SimpleFIN allows ~24 requests/day). */
  bankImportMinIntervalMs?: number | undefined;
}

const positive = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const bool = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return {
    secureCookies: bool(env["COOKIE_SECURE"], env["NODE_ENV"] === "production"),
    allowRegistration: bool(env["ALLOW_REGISTRATION"], false),
    trustedOrigins: (env["TRUSTED_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // A malformed key ring fails startup loudly; an absent one only disables bank import.
    ...(env["RIFFLE_SECRET_KEY"] && { keyring: parseKeyring(env["RIFFLE_SECRET_KEY"]) }),
    ...(positive(env["BANK_IMPORT_MIN_INTERVAL_SECONDS"]) && {
      bankImportMinIntervalMs: positive(env["BANK_IMPORT_MIN_INTERVAL_SECONDS"])! * 1000,
    }),
  };
}
