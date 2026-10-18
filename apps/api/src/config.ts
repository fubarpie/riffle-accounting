// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApiConfig {
  /** Mark the session cookie Secure. Defaults to true in production. */
  secureCookies: boolean;
  /** Allow sign-ups after the first account exists. The first user can always register. */
  allowRegistration: boolean;
  /** Extra origins (besides the request's own host) allowed to make state-changing requests. */
  trustedOrigins: string[];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const bool = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return {
    secureCookies: bool(env["COOKIE_SECURE"], env["NODE_ENV"] === "production"),
    allowRegistration: bool(env["ALLOW_REGISTRATION"], false),
    trustedOrigins: (env["TRUSTED_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
