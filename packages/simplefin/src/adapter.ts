import { claimAccessUrl } from "./claim.js";
import { fetchAccounts, type SimpleFinAccount, type SimpleFinAccountSet } from "./accounts.js";
import type { FetchLike } from "./http.js";
import { planWindows } from "./window.js";

/** Provider-neutral bank feed adapter; SimpleFIN is a moving draft so callers depend on this. */
export interface BankFeedAdapter {
  claim(setupToken: string): Promise<string>;
  fetchRange(
    accessUrl: string,
    range: { start: Date; end: Date },
    opts?: { pending?: boolean; accountIds?: string[]; signal?: AbortSignal },
  ): Promise<SimpleFinAccountSet>;
}

export function createSimpleFinAdapter(fetchImpl: FetchLike = fetch, timeoutMs?: number): BankFeedAdapter {
  const t = timeoutMs === undefined ? {} : { timeoutMs };
  return {
    claim: (token) => claimAccessUrl(token, fetchImpl, t),
    async fetchRange(accessUrl, range, opts = {}) {
      const merged = new Map<string, SimpleFinAccount>();
      const result: SimpleFinAccountSet = { accounts: [], connections: [], warnings: [] };
      for (const w of planWindows(range.start, range.end)) {
        const set = await fetchAccounts(
          accessUrl,
          { startDate: w.start, endDate: w.end, ...opts, ...t },
          fetchImpl,
        );
        result.warnings.push(...set.warnings);
        result.connections = set.connections;
        for (const a of set.accounts) {
          const prev = merged.get(a.id);
          if (!prev) merged.set(a.id, { ...a, transactions: [...a.transactions] });
          else {
            const seen = new Set(prev.transactions.map((x) => x.id));
            prev.transactions.push(...a.transactions.filter((x) => !seen.has(x.id)));
            if (a.balanceDate > prev.balanceDate) {
              prev.balanceMinor = a.balanceMinor;
              prev.availableBalanceMinor = a.availableBalanceMinor;
              prev.balanceDate = a.balanceDate;
            }
          }
        }
      }
      result.accounts = [...merged.values()];
      return result;
    },
  };
}
