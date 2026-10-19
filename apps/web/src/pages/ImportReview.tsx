// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { api, blockersFromError } from "../api";
import { isWriter } from "../draft";
import { useLoad, useSession } from "../hooks";
import {
  ACCOUNT_TYPES, BATCH_STATUS_LABEL, canApproveBatch, canRejectBatch, choiceValue, describeBlockers, isMapped, parseChoice,
  suggestedType, summarizeApproval, toDecision,
} from "../importReview";
import { currencyExponent, formatMinor } from "../money";
import { hrefFor } from "../router";
import type { Account, AccountType, ApprovalBlockers, ImportAccount, ImportEntry } from "../types";

const PAGE = 100;
type EntryFilter = "all" | "invalid" | "skipped" | "excluded";

export function ImportReview({ businessId, batchId }: { businessId: string; batchId: string }) {
  const { describe } = useSession();
  const business = useLoad(() => api.business(businessId), [businessId]);
  const accounts = useLoad(() => api.accounts(businessId), [businessId]);
  const detail = useLoad(() => api.getImport(businessId, batchId), [businessId, batchId]);

  const [refused, setRefused] = useState<ApprovalBlockers>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

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
          <table>
            <thead><tr><th>In the export</th><th>Class</th><th className="num">Lines</th><th>Goes to</th></tr></thead>
            <tbody>
              {d.accounts.map((a) => (
                <MappingRow
                  key={`${a.id}:${choiceValue(a)}:${a.createName ?? ""}:${a.createType ?? ""}`}
                  account={a} targets={targets} disabled={!editable} businessId={businessId} batchId={batchId}
                  onSaved={detail.reload}
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
}

function MappingRow({ account, targets, disabled, businessId, batchId, onSaved }: MappingRowProps) {
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
  const [filter, setFilter] = useState<EntryFilter>("invalid");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string>();
  const exponent = currencyExponent(currency);
  const nameOf = new Map(accounts.map((a) => [a.id, a.sourceName]));

  const query = (): { status?: ImportEntry["status"]; excluded?: boolean; limit: number; offset: number } => {
    const base = { limit: PAGE, offset };
    if (filter === "invalid") return { ...base, status: "invalid" };
    if (filter === "skipped") return { ...base, status: "skipped" };
    if (filter === "excluded") return { ...base, excluded: true };
    return base;
  };
  const list = useLoad(() => api.importEntries(businessId, batchId, query()), [businessId, batchId, filter, offset]);

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

  const entries = list.data?.entries ?? [];
  return (
    <>
      <label style={{ maxWidth: "18rem" }}>Show
        <select value={filter} onChange={(e) => { setFilter(e.target.value as EntryFilter); setOffset(0); }}>
          <option value="invalid">Entries with problems ({counts.invalid})</option>
          <option value="skipped">Skipped ({counts.skipped})</option>
          <option value="excluded">Excluded ({counts.excluded})</option>
          <option value="all">All entries ({counts.entries})</option>
        </select>
      </label>
      {error && <p className="msg error" role="alert">{error}</p>}
      {list.loading && <p className="muted">Loading…</p>}
      {list.error && <p className="msg error" role="alert">{list.error}</p>}
      {list.data && entries.length === 0 && <p>Nothing to show here.</p>}
      {entries.length > 0 && (
        <table>
          <thead><tr><th>Date</th><th>Description</th><th>Lines</th><th>Status</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
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
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button type="button" disabled={entries.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </>
  );
}
