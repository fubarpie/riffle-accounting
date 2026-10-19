// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useLoad } from "../hooks";
import { currencyExponent, formatMinor } from "../money";
import {
  DEFAULTS, PAGE_SIZE, TRANSACTION_KINDS, fetchTransactions, filtersFromHash, filtersToHash, pageCount,
  toggleSort, type TransactionFilters, type TransactionSort, type TransactionStatus,
} from "../transactionsApi";
import type { TransactionKind, TransactionRow } from "../types";

const KIND_LABEL: Record<TransactionKind, string> = { deposit: "Deposit", withdrawal: "Withdrawal", transfer: "Transfer", journal: "Journal" };
const STATUS_LABEL: Record<TransactionStatus, string> = { live: "Active", voided: "Voided", all: "All" };
const SEARCH_DEBOUNCE_MS = 300;

/** Filters live in the URL hash, so refresh, back and shared links all restore the same view. */
function useHashFilters(businessId: string): [TransactionFilters, (next: TransactionFilters) => void] {
  const [filters, setFilters] = useState(() => filtersFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setFilters(filtersFromHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const update = (next: TransactionFilters) => {
    const hash = filtersToHash(businessId, next);
    if (hash === window.location.hash) return;
    window.location.hash = hash;
  };
  return [filters, update];
}

function accountsSummary(t: TransactionRow): string {
  if (t.accounts.length === 0) return "—";
  const names = t.accounts.map((a) => (a.code ? `${a.code} ${a.name}` : a.name));
  return names.length <= 2 ? names.join(" · ") : `${names.slice(0, 2).join(" · ")} +${names.length - 2} more`;
}

export function Transactions({ businessId }: { businessId: string }) {
  const [filters, setFilters] = useHashFilters(businessId);
  const [qInput, setQInput] = useState(filters.q);
  const lastWritten = useRef(filters.q);

  // Pick up q changes made by back/forward, but not the echo of what the box itself just wrote.
  useEffect(() => {
    if (filters.q !== lastWritten.current) {
      lastWritten.current = filters.q;
      setQInput(filters.q);
    }
  }, [filters.q]);

  // Debounce typing into the URL; a changed search goes back to page 1.
  useEffect(() => {
    const next = qInput.trim();
    if (next === filters.q) return;
    const timer = window.setTimeout(() => {
      lastWritten.current = next;
      setFilters({ ...filters, q: next, page: 1 });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [qInput, filters]);

  const accounts = useLoad(() => api.accounts(businessId), [businessId]);
  const list = useLoad(
    () => fetchTransactions(businessId, filters),
    [businessId, filters.q, filters.from, filters.to, filters.kind, filters.accountId, filters.status, filters.sort, filters.dir, filters.page],
  );

  // Changing any filter other than the page goes back to page 1.
  const change = (patch: Partial<TransactionFilters>) => setFilters({ ...filters, ...patch, page: 1 });
  const goToPage = (page: number) => setFilters({ ...filters, page });
  const reset = () => { setQInput(""); lastWritten.current = ""; setFilters({ ...DEFAULTS }); };

  const data = list.data;
  const exponent = currencyExponent(data?.currency);
  const total = data?.total ?? 0;
  const pages = pageCount(total, data?.limit || PAGE_SIZE);
  const first = data && data.transactions.length > 0 ? data.offset + 1 : 0;
  const last = data ? data.offset + data.transactions.length : 0;
  const filtered = JSON.stringify({ ...filters, page: 1 }) !== JSON.stringify(DEFAULTS);

  const header = (column: TransactionSort, label: string, className?: string) => {
    const active = filters.sort === column;
    const ariaSort = active ? (filters.dir === "asc" ? "ascending" : "descending") : "none";
    return (
      <th className={className} aria-sort={ariaSort}>
        <button type="button" onClick={() => setFilters(toggleSort(filters, column))} style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "inherit" }}>
          {label}{active ? (filters.dir === "asc" ? " ▲" : " ▼") : ""}
        </button>
      </th>
    );
  };

  return (
    <>
      <h1>Transactions</h1>
      <form className="card" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="row">
          <label>Search<input type="search" value={qInput} placeholder="Description, notes or memo" onChange={(e) => setQInput(e.target.value)} /></label>
          <label>From<input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => change({ from: e.target.value })} /></label>
          <label>To<input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => change({ to: e.target.value })} /></label>
          <label>Type
            <select value={filters.kind} onChange={(e) => change({ kind: e.target.value as TransactionKind | "" })}>
              <option value="">All types</option>
              {TRANSACTION_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label>Account
            <select value={filters.accountId} onChange={(e) => change({ accountId: e.target.value })}>
              <option value="">All accounts</option>
              {accounts.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ${a.name}` : a.name}</option>)}
            </select>
          </label>
          <label>Show
            <select value={filters.status} onChange={(e) => change({ status: e.target.value as TransactionStatus })}>
              {(Object.keys(STATUS_LABEL) as TransactionStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          {filtered && <button type="button" onClick={reset}>Clear filters</button>}
        </div>
      </form>

      {accounts.error && <p className="msg error" role="alert">{accounts.error}</p>}
      {list.error && <p className="msg error" role="alert">{list.error} <button type="button" onClick={list.reload}>Try again</button></p>}
      {list.loading && <p className="muted">Loading…</p>}

      {data && data.total === 0 && <p>{filtered ? "No transactions match these filters." : "No transactions yet."}</p>}
      {data && data.total > 0 && data.transactions.length === 0 && <p>There are no transactions on this page.</p>}
      {data && data.transactions.length > 0 && (
        <table>
          <thead>
            <tr>
              {header("date", "Date")}
              {header("description", "Description")}
              <th>Type</th>
              <th>Accounts</th>
              {header("amount", "Amount", "num")}
            </tr>
          </thead>
          <tbody>
            {data.transactions.map((t) => (
              <tr key={t.id} style={t.voided ? { opacity: 0.55 } : undefined}>
                <td>{t.date}</td>
                <td>
                  <span style={t.voided ? { textDecoration: "line-through" } : undefined}>{t.description || "(no description)"}</span>
                  {t.voided && <> <span className="badge rejected">Voided</span></>}
                  {t.notes && <div className="muted">{t.notes}</div>}
                </td>
                <td>{KIND_LABEL[t.kind]}</td>
                <td>{accountsSummary(t)}</td>
                <td className="num">{t.amountMinor === null ? "—" : formatMinor(t.amountMinor, exponent, data.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.total > 0 && (
        <div className="actions" role="navigation" aria-label="Pages">
          <button type="button" disabled={filters.page <= 1 || list.loading} onClick={() => goToPage(filters.page - 1)}>Previous</button>
          <span className="muted" aria-live="polite">
            {data.transactions.length > 0 ? `Showing ${first}-${last} of ${total}` : `Showing 0 of ${total}`}
          </span>
          <button type="button" disabled={filters.page >= pages || list.loading} onClick={() => goToPage(filters.page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
