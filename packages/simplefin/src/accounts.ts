import { parseAmountToMinor } from "./amount.js";
import {
  SimpleFinAccessRevokedError,
  SimpleFinHttpError,
  SimpleFinInputError,
  SimpleFinProtocolError,
  SimpleFinRateLimitedError,
  type SimpleFinWarning,
  type SimpleFinWarningKind,
} from "./errors.js";
import { DEFAULT_TIMEOUT_MS, timedFetch, type FetchLike } from "./http.js";
import { accountSetSchema, type RawAccountSet } from "./schema.js";
import { DAY_MS, MAX_WINDOW_DAYS } from "./window.js";

export interface FetchAccountsOptions {
  startDate?: Date;
  endDate?: Date;
  pending?: boolean;
  accountIds?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SimpleFinTransaction {
  id: string;
  /** null when the bank reports posted=0 (not yet posted). */
  postedAt: Date | null;
  /** Integer minor units. */
  amountMinor: number;
  description: string;
  pending: boolean;
}

export interface SimpleFinAccount {
  id: string;
  connectionId?: string;
  name: string;
  currency: string;
  balanceMinor: number;
  availableBalanceMinor: number | null;
  balanceDate: Date;
  transactions: SimpleFinTransaction[];
}

export interface SimpleFinAccountSet {
  accounts: SimpleFinAccount[];
  connections: RawAccountSet["connections"];
  warnings: SimpleFinWarning[];
}

/** Split an Access URL into a credential-free base URL and a Basic auth header. */
export function splitAccessUrl(accessUrl: string): { baseUrl: string; authorization: string } {
  let u: URL;
  try {
    u = new URL(accessUrl);
  } catch {
    throw new SimpleFinInputError("Invalid Access URL");
  }
  if (u.protocol !== "https:") throw new SimpleFinInputError("Access URL must use https");
  if (!u.username || !u.password) throw new SimpleFinInputError("Access URL is missing credentials");
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const authorization = "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  return { baseUrl: u.toString().replace(/\/+$/, ""), authorization };
}

const epochSeconds = (d: Date): string => String(Math.floor(d.getTime() / 1000));

export function buildAccountsUrl(baseUrl: string, o: FetchAccountsOptions): string {
  const params = new URLSearchParams();
  if (o.startDate) params.set("start-date", epochSeconds(o.startDate));
  if (o.endDate) params.set("end-date", epochSeconds(o.endDate));
  if (o.pending) params.set("pending", "1");
  for (const id of o.accountIds ?? []) params.append("account", id);
  const qs = params.toString();
  return `${baseUrl}/accounts${qs ? `?${qs}` : ""}`;
}

function warningKind(code: string): SimpleFinWarningKind {
  if (code.endsWith(".auth")) return "auth";
  if (code.startsWith("con.")) return "connection";
  if (code.startsWith("act.")) return "account";
  return "general";
}

export function extractWarnings(raw: RawAccountSet): SimpleFinWarning[] {
  const out: SimpleFinWarning[] = [];
  for (const e of raw.errlist ?? []) {
    out.push({
      kind: warningKind(e.code),
      code: e.code,
      message: e.msg,
      ...(e.conn_id !== undefined && { connectionId: e.conn_id }),
      ...(e.account_id !== undefined && { accountId: e.account_id }),
    });
  }
  for (const msg of raw.errors ?? []) out.push({ kind: "general", code: "unknown", message: msg });
  return out;
}

function normalize(raw: RawAccountSet): SimpleFinAccountSet {
  try {
    const accounts = raw.accounts.map((a): SimpleFinAccount => ({
      id: a.id,
      ...(a.conn_id !== undefined && { connectionId: a.conn_id }),
      name: a.name,
      currency: a.currency,
      balanceMinor: parseAmountToMinor(a.balance, a.currency),
      availableBalanceMinor:
        a["available-balance"] == null ? null : parseAmountToMinor(a["available-balance"], a.currency),
      balanceDate: new Date(a["balance-date"] * 1000),
      transactions: a.transactions.map((t) => ({
        id: t.id,
        postedAt: t.posted === 0 ? null : new Date(t.posted * 1000),
        amountMinor: parseAmountToMinor(t.amount, a.currency),
        description: t.description,
        pending: t.pending ?? t.posted === 0,
      })),
    }));
    return { accounts, connections: raw.connections, warnings: extractWarnings(raw) };
  } catch (err) {
    if (err instanceof SimpleFinInputError) throw new SimpleFinProtocolError(`Invalid amount in response: ${err.message}`);
    throw err;
  }
}

/** GET {accessUrl}/accounts with Basic auth; validates and normalizes the Account Set. */
export async function fetchAccounts(
  accessUrl: string,
  options: FetchAccountsOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<SimpleFinAccountSet> {
  const { startDate, endDate } = options;
  if (startDate && endDate) {
    const span = endDate.getTime() - startDate.getTime();
    if (span < 0) throw new SimpleFinInputError("startDate is after endDate");
    if (span > MAX_WINDOW_DAYS * DAY_MS) {
      throw new SimpleFinInputError("Date range exceeds 90 days; use planWindows()");
    }
  }
  const { baseUrl, authorization } = splitAccessUrl(accessUrl);
  const res = await timedFetch(
    fetchImpl,
    buildAccountsUrl(baseUrl, options),
    { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (res.status === 402 || res.status === 403) throw new SimpleFinAccessRevokedError(res.status);
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new SimpleFinRateLimitedError(Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  if (!res.ok) throw new SimpleFinHttpError(res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SimpleFinProtocolError("Response was not valid JSON");
  }
  const parsed = accountSetSchema.safeParse(json);
  if (!parsed.success) {
    throw new SimpleFinProtocolError(`Response failed validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return normalize(parsed.data);
}
