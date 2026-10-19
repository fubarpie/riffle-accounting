// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Keyring, parseKeyring } from "@riffle/db";
import { type Extractor, ExtractorError, MockExtractor, OpenAICompatibleExtractor } from "@riffle/extractor";

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
  /** Directory for the statement vault (STATEMENT_STORAGE_DIR). Must be a persistent, private volume. */
  statementStorageDir?: string | undefined;
  /** Largest accepted statement upload in bytes (MAX_UPLOAD_BYTES). Default 10 MiB. */
  maxUploadBytes?: number | undefined;
  /**
   * Extractor for PDF statement text (EXTRACTOR=mock|openai). Without one, PDF
   * extraction answers 503; CSV is parsed deterministically and never needs it.
   */
  extractor?: Extractor | undefined;
}

/** Build the PDF extractor from the environment. A bad setting fails startup loudly; an absent one disables PDF extraction. */
export function extractorFromEnv(env: NodeJS.ProcessEnv): Extractor | undefined {
  const kind = (env["EXTRACTOR"] ?? "").trim().toLowerCase();
  if (kind === "") return undefined;
  if (kind === "mock") return new MockExtractor();
  if (kind === "openai") {
    return new OpenAICompatibleExtractor({
      baseUrl: env["EXTRACTOR_BASE_URL"] ?? "", apiKey: env["EXTRACTOR_API_KEY"] ?? "", model: env["EXTRACTOR_MODEL"] ?? "",
    });
  }
  throw new ExtractorError("not_configured", `EXTRACTOR must be "mock" or "openai", got "${kind.slice(0, 20)}"`);
}

const positive = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const bool = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());
  const extractor = extractorFromEnv(env);
  return {
    secureCookies: bool(env["COOKIE_SECURE"], env["NODE_ENV"] === "production"),
    allowRegistration: bool(env["ALLOW_REGISTRATION"], false),
    trustedOrigins: (env["TRUSTED_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // A malformed key ring fails startup loudly; an absent one only disables bank import.
    ...(env["RIFFLE_SECRET_KEY"] && { keyring: parseKeyring(env["RIFFLE_SECRET_KEY"]) }),
    ...(extractor && { extractor }),
    ...(env["STATEMENT_STORAGE_DIR"] && { statementStorageDir: env["STATEMENT_STORAGE_DIR"] }),
    ...(positive(env["MAX_UPLOAD_BYTES"]) && { maxUploadBytes: positive(env["MAX_UPLOAD_BYTES"])! }),
    ...(positive(env["BANK_IMPORT_MIN_INTERVAL_SECONDS"]) && {
      bankImportMinIntervalMs: positive(env["BANK_IMPORT_MIN_INTERVAL_SECONDS"])! * 1000,
    }),
  };
}
