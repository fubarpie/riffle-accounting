// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { api, blockersFromError } from "../api";
import { isWriter } from "../draft";
import { useLoad, useSession } from "../hooks";
import { allPicked, summarizeAutoMap, summarizeBulkExclude, toggleId } from "../importBulk";
import { autoMapImport, bulkExcludeImport, bulkMapImport, searchImportEntries, type EntryFilter } from "../importBulkApi";
import {
  ACCOUNT_TYPES, BATCH_STATUS_LABEL, canApproveBatch, canRejectBatch, choiceValue, describeBlockers, isMapped, parseChoice,
  suggestedType, summarizeApproval, toDecision,
} from "../importReview";
import { currencyExponent, formatMinor } from "../money";
import { hrefFor } from "../router";
import type { Account, AccountType, ApprovalBlockers, ImportAccount, ImportEntry } from "../types";

const PAGE = 100;
type EntryView = "all" | "invalid" | "skipped" | "excluded";

export function ImportReview({ businessId, batchId }: { businessId: string; batchId: string }) {
  const { describe } = useSession();
  const business = useLoad(() => api.business(businessId), [businessId]);
  const accounts = useLoad(() => api.accounts(businessId), [businessId]);
  const detail = useLoad(() => api.getImport(businessId, batchId), [businessId, batchId]);

  const [refused, setRefused] = useState<ApprovalBlockers>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pickedAccounts, setPickedAccounts] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("");

  const role = business.data?.business.role;
  const writer = isWriter(role);
  const d = detail.data;
  const editable = writer && d?.batch.status === "staged";
  const targets = (accounts.data?.accounts ?? []).filter((a) => !a.archived_at);

  const approve = async () => {
    setError(undefined); setNotice(undefined); setRefused(undefined);
    setBusy(true);
    try {
      const r = await api.approveImport(businessId, batchId);
      setNotice(summarizeApproval(r));
    } catch (err) {
      const blockers = blockersFromError(err);
      if (blockers) setRefused(blockers); else setError(describe(err));
    } finally {
      setBusy(false);
      detail.reload();
    }
  };

  const reject = async () => {
    if (!window.confirm("Reject this import? It stays on record but can no longer be approved.")) return;
    setError(undefined); setNotice(undefined); setRefused(undefined);
    setBusy(true);
    try {
      await api.rejectImport(businessId, batchId);
      setNotice("Import rejected. Nothing was posted.");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      detail.reload();
    }
  };

  /** Runs one bulk action with the shared busy/notice/error handling, then refreshes the batch. */
  const run = async (action: () => Promise<string>) => {
    setError(undefined); setNotice(undefined); setRefused(undefined);
    setBusy(true);
    try {
      setNotice(await action());
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      detail.reload();
    }
  };

  const autoMap = () => run(async () => summarizeAutoMap(await autoMapImport(businessId, batchId)));

  const bulkMap = (clear: boolean) => run(async () => {
    const ids = [...pickedAccounts];
    const choice = parseChoice(bulkTarget);
    if (!clear && choice.kind !== "target") throw new Error("Choose the account to map the selected rows to.");
    const decision = clear || choice.kind !== "target" ? ({ kind: "clear" } as const) : ({ kind: "target", accountId: choice.accountId } as const);
    const r = await bulkMapImport(businessId, batchId, ids, decision);
    setPickedAccounts(new Set());
    return clear ? `Cleared ${r.updated} accounts.` : `Mapped ${r.updated} accounts.`;
  });

  const accountIds = (d?.accounts ?? []).map((a) => a.id);

  return (
    <>
      <p><a href={hrefFor.imports(businessId)}>← Wave imports</a></p>
      <h1>Review import{business.data ? ` — ${business.data.business.name}` : ""}</h1>
      {detail.loading && !d && <p className="muted">Loading…</p>}
      {detail.error && <p className="msg error" role="alert">{detail.error}</p>}
      {error && <p className="msg error" role="alert">{error}</p>}
      {notice && <p className="msg ok" role="status">{notice}</p>}

      {d && (
        <>
          <section className="card">
            <div className="row">
              <span className={`badge ${d.batch.status}`}>{BATCH_STATUS_LABEL[d.batch.status]}</span>
              <span className="muted">Uploaded {d.batch.createdAt.slice(0, 10)}</span>
            </div>
            <p style={{ marginBottom: 0 }}>
              {d.counts.entries} entries: {d.counts.valid} valid, {d.counts.invalid} with problems, {d.counts.skipped} skipped, {d.counts.excluded} excluded.
            </p>
          </section>

          {refused && <BlockerList blockers={refused} />}
          {!refused && d.batch.status === "staged" && !d.blockers.ready && (
            <p className="msg" role="status">
              Not ready yet: {d.blockers.invalidEntries} entries with problems (exclude them), {d.blockers.unmappedAccounts} accounts not mapped.
              Approving will check everything again.
            </p>
          )}

          <h2>1. Map accounts</h2>
          <p className="muted">
            Each account in the export needs a home in your chart of accounts. The export&apos;s class must match the account&apos;s type;
            nothing is changed automatically.
          </p>
          {editable && (
            <>
              <div className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => void autoMap()}>Auto-map accounts</button>
                <span className="muted">
                  Matches an existing account with the same name and type, otherwise queues a new one. Nothing is created until you approve,
                  and rows you have already decided are left alone.
                </span>
              </div>
              <div className="row" style={{ marginTop: ".5rem" }}>
                <span>{pickedAccounts.size} selected</span>
                <select aria-label="Map selected accounts to" value={bulkTarget} disabled={busy || pickedAccounts.size === 0} onChange={(e) => setBulkTarget(e.target.value)}>
                  <option value="">Map selected to…</option>
                  {targets.map((t) => <option key={t.id} value={`target:${t.id}`}>{t.code ? `${t.code} ` : ""}{t.name} ({t.type})</option>)}
                </select>
                <button type="button" disabled={busy || pickedAccounts.size === 0 || !bulkTarget} onClick={() => void bulkMap(false)}>Map selected</button>
                <button type="button" disabled={busy || pickedAccounts.size === 0} onClick={() => void bulkMap(true)}>Clear selected</button>
              </div>
            </>
          )}
          <table>
            <thead>
              <tr>
                {editable && (
                  <th>
                    <input
                      type="checkbox" aria-label="Select all accounts" checked={allPicked(accountIds, pickedAccounts)}
                      onChange={(e) => setPickedAccounts(e.target.checked ? new Set(accountIds) : new Set())}
                    />
                  </th>
                )}
                <th>In the export</th><th>Class</th><th className="num">Lines</th><th>Goes to</th>
              </tr>
            </thead>
            <tbody>
              {d.accounts.map((a) => (
                <MappingRow
                  key={`${a.id}:${choiceValue(a)}:${a.createName ?? ""}:${a.createType ?? ""}`}
                  account={a} targets={targets} disabled={!editable} businessId={businessId} batchId={batchId}
                  onSaved={detail.reload} selectable={editable} picked={pickedAccounts.has(a.id)}
                  onPick={() => setPickedAccounts((s) => toggleId(s, a.id))}
                />
              ))}
            </tbody>
          </table>

          <h2>2. Review entries</h2>
          <Entries
            businessId={businessId} batchId={batchId} accounts={d.accounts} editable={editable}
            currency={business.data?.business.currency ?? ""} onChanged={detail.reload}
            counts={d.counts}
          />

          <h2>3. Approve</h2>
          {writer ? (
            <div className="row">
              <button
                className="primary" type="button" disabled={busy || !canApproveBatch(d.batch, role, true)}
                onClick={() => void approve()}
              >
                {busy ? "Working…" : "Approve and post to books"}
              </button>
              <button type="button" disabled={busy || !canRejectBatch(d.batch, role)} onClick={() => void reject()}>Reject import</button>
            </div>
          ) : (
            <p className="muted">Your role can look at imports but not approve them.</p>
          )}
          <p className="muted">
            Approval posts every non-excluded, valid entry in one step: either all of them are posted or none are. If something blocks it,
            the reasons are listed above.
          </p>
        </>
      )}
    </>
  );
}

function BlockerList({ blockers }: { blockers: ApprovalBlockers }) {
  const items = describeBlockers(blockers);
  return (
    <div className="msg error" role="alert">
      <strong>This import cannot be approved yet:</strong>
      <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

interface MappingRowProps {
  account: ImportAccount;
  targets: Account[];
  disabled: boolean;
  businessId: string;
  batchId: string;
  onSaved: () => void;
  selectable: boolean;
  picked: boolean;
  onPick: () => void;
}

function MappingRow({ account, targets, disabled, businessId, batchId, onSaved, selectable, picked, onPick }: MappingRowProps) {
  const { describe } = useSession();
  const [value, setValue] = useState(choiceValue(account));
  const [name, setName] = useState(account.createName ?? account.sourceName);
  const [type, setType] = useState<AccountType | "">(account.createType ?? suggestedType(account.sourceGroup) ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (nextValue: string) => {
    setError(undefined);
    const decision = toDecision(parseChoice(nextValue), name, type);
    if ("error" in decision) return setError(decision.error);
    setSaving(true);
    try {
      await api.setImportMapping(businessId, batchId, account.id, decision);
      onSaved();
    } catch (err) {
      setError(describe(err));
    } finally {
      setSaving(false);
    }
  };

  const choice = parseChoice(value);
  return (
    <tr>
      {selectable && (
        <td><input type="checkbox" aria-label={`Select ${account.sourceName}`} checked={picked} onChange={onPick} /></td>
      )}
      <td>{account.sourceName}{account.accountRefLast4 ? ` (…${account.accountRefLast4})` : ""}</td>
      <td>{account.sourceGroup || "—"}</td>
      <td className="num">{account.lineCount}</td>
      <td>
        <select
          aria-label={`Map ${account.sourceName}`} value={value} disabled={disabled || saving}
          onChange={(e) => {
            setValue(e.target.value);
            // An existing account saves at once; "create" waits for a name and type; "not mapped" clears.
            if (e.target.value !== "create") void save(e.target.value);
          }}
        >
          <option value="">Not mapped</option>
          <option value="create">Create a new account…</option>
          {targets.map((t) => <option key={t.id} value={`target:${t.id}`}>{t.code ? `${t.code} ` : ""}{t.name} ({t.type})</option>)}
        </select>
        {choice.kind === "create" && (
          <div className="row" style={{ marginTop: ".4rem" }}>
            <label>New account name<input value={name} disabled={disabled || saving} onChange={(e) => setName(e.target.value)} /></label>
            <label>Type
              <select value={type} disabled={disabled || saving} onChange={(e) => setType(e.target.value as AccountType | "")}>
                <option value="">Choose…</option>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <button type="button" disabled={disabled || saving} onClick={() => void save("create")}>{saving ? "Saving…" : "Save"}</button>
          </div>
        )}
        {!isMapped(account) && !disabled && value === "" && <span className="muted"> Needs a decision</span>}
        {error && <p className="msg error" role="alert">{error}</p>}
      </td>
    </tr>
  );
}

interface EntriesProps {
  businessId: string;
  batchId: string;
  accounts: ImportAccount[];
  editable: boolean;
  currency: string;
  counts: { entries: number; invalid: number; skipped: number; excluded: number };
  onChanged: () => void;
}

function Entries({ businessId, batchId, accounts, editable, currency, counts, onChanged }: EntriesProps) {
  const { describe } = useSession();
  const [view, setView] = useState<EntryView>("invalid");
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const exponent = currencyExponent(currency);
  const nameOf = new Map(accounts.map((a) => [a.id, a.sourceName]));

  /** What "this view" means, used both to list entries and to act on every match. */
  const filter = (): EntryFilter => ({
    ...(view === "invalid" ? { status: "invalid" as const } : {}),
    ...(view === "skipped" ? { status: "skipped" as const } : {}),
    ...(view === "excluded" ? { excluded: true } : {}),
    ...(search ? { search } : {}),
  });
  const list = useLoad(
    () => searchImportEntries(businessId, batchId, { ...filter(), limit: PAGE, offset }),
    [businessId, batchId, view, offset, search],
  );

  const clearPicks = () => { setPicked(new Set()); setAllMatching(false); };
  const entries: ImportEntry[] = list.data?.entries ?? [];
  const total = list.data?.total ?? 0;
  // Skipped entries are never posted, so they have nothing to exclude.
  const selectable = entries.filter((e) => e.status !== "skipped").map((e) => e.id);
  const bulk = editable && view !== "skipped";
  const pageAll = allPicked(selectable, picked);
  const selectedCount = allMatching ? total : picked.size;

  const toggle = async (e: ImportEntry) => {
    setError(undefined);
    try {
      await api.setImportEntryExcluded(businessId, batchId, e.id, !e.excluded);
      list.reload();
      onChanged();
    } catch (err) {
      setError(describe(err));
    }
  };

  const act = async (excluded: boolean) => {
    const verb = excluded ? "Exclude" : "Include";
    if (allMatching && !window.confirm(`${verb} every entry that matches this view (${total})? Skipped entries are left alone.`)) return;
    setError(undefined); setNotice(undefined);
    setBusy(true);
    try {
      const r = await bulkExcludeImport(businessId, batchId, allMatching ? { excluded, filter: filter() } : { excluded, ids: [...picked] });
      setNotice(summarizeBulkExclude(r.changed, excluded));
      clearPicks();
      list.reload();
      onChanged();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row">
        <label style={{ maxWidth: "18rem" }}>Show
          <select value={view} onChange={(e) => { setView(e.target.value as EntryView); setOffset(0); clearPicks(); }}>
            <option value="invalid">Entries with problems ({counts.invalid})</option>
            <option value="skipped">Skipped ({counts.skipped})</option>
            <option value="excluded">Excluded ({counts.excluded})</option>
            <option value="all">All entries ({counts.entries})</option>
          </select>
        </label>
        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); setSearch(typed.trim()); setOffset(0); clearPicks(); }}
        >
          <label>Search description or account
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. Stripe" />
          </label>
          <button type="submit">Search</button>
          {search && <button type="button" onClick={() => { setTyped(""); setSearch(""); setOffset(0); clearPicks(); }}>Clear search</button>}
        </form>
      </div>
      {error && <p className="msg error" role="alert">{error}</p>}
      {notice && <p className="msg ok" role="status">{notice}</p>}
      {list.loading && <p className="muted">Loading…</p>}
      {list.error && <p className="msg error" role="alert">{list.error}</p>}
      {list.data && <p className="muted">{total} {total === 1 ? "entry matches" : "entries match"} this view.</p>}
      {list.data && entries.length === 0 && <p>Nothing to show here.</p>}

      {bulk && entries.length > 0 && (
        <div className="row">
          <span>{selectedCount} selected</span>
          <button type="button" disabled={busy || selectedCount === 0} onClick={() => void act(true)}>Exclude selected</button>
          <button type="button" disabled={busy || selectedCount === 0} onClick={() => void act(false)}>Include selected</button>
          {pageAll && !allMatching && total > selectable.length && (
            <button type="button" onClick={() => setAllMatching(true)}>Select all {total} matching this view</button>
          )}
          {allMatching && <button type="button" onClick={clearPicks}>Clear selection</button>}
        </div>
      )}

      {entries.length > 0 && (
        <table>
          <thead>
            <tr>
              {bulk && (
                <th>
                  <input
                    type="checkbox" aria-label="Select all entries on this page" checked={pageAll || allMatching}
                    onChange={(e) => { setAllMatching(false); setPicked(e.target.checked ? new Set(selectable) : new Set()); }}
                  />
                </th>
              )}
              <th>Date</th><th>Description</th><th>Lines</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                {bulk && (
                  <td>
                    {e.status !== "skipped" && (
                      <input
                        type="checkbox" aria-label={`Select entry ${e.description || e.externalId}`}
                        checked={allMatching || picked.has(e.id)} disabled={allMatching}
                        onChange={() => setPicked((s) => toggleId(s, e.id))}
                      />
                    )}
                  </td>
                )}
                <td>{e.date ?? "—"}</td>
                <td>
                  {e.description || <span className="muted">(no description)</span>}
                  {e.issues.length > 0 && <ul className="muted">{e.issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>}
                </td>
                <td>
                  {e.lines.map((l) => (
                    <div key={l.lineNo}>{nameOf.get(l.importAccountId) ?? "?"}: <span className="num">{formatMinor(l.amountMinor, exponent, currency)}</span></div>
                  ))}
                </td>
                <td>
                  <span className={`badge ${e.status}`}>{e.status}</span>
                  {e.excluded && <> <span className="badge rejected">excluded</span></>}
                  {e.transactionId && <> <span className="badge approved">posted</span></>}
                </td>
                <td>
                  {editable && e.status !== "skipped" && (
                    <button type="button" onClick={() => void toggle(e)}>{e.excluded ? "Include" : "Exclude"}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE)); clearPicks(); }}>Previous</button>
        <button type="button" disabled={entries.length < PAGE} onClick={() => { setOffset(offset + PAGE); clearPicks(); }}>Next</button>
      </div>
    </>
  );
}
