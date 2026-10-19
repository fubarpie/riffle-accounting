// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { isWriter } from "../draft";
import { useLoad, useSession } from "../hooks";
import { BATCH_STATUS_LABEL } from "../importReview";
import { hrefFor } from "../router";
import type { ImportBatchStatus } from "../types";

const STATUSES: ImportBatchStatus[] = ["staged", "approved", "rejected"];

export function Imports({ businessId }: { businessId: string }) {
  const { describe } = useSession();
  const [status, setStatus] = useState<ImportBatchStatus | "">("");
  const business = useLoad(() => api.business(businessId), [businessId]);
  const list = useLoad(() => api.listImports(businessId, status ? { status } : {}), [businessId, status]);
  const role = business.data?.business.role;

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose the CSV exported from Wave.");
    setBusy(true);
    try {
      const res = await api.uploadImport(businessId, file);
      window.location.hash = hrefFor.importReview(businessId, res.batch.id);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p><a href={hrefFor.extractions(businessId)}>← Statement uploads</a></p>
      <h1>Wave imports{business.data ? ` — ${business.data.business.name}` : ""}</h1>
      {business.error && <p className="msg error" role="alert">{business.error}</p>}

      {isWriter(role) && (
        <form className="card" onSubmit={(e) => void upload(e)}>
          <h2 style={{ marginTop: 0 }}>Import a Wave journal export</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            The file is read and checked here, then discarded; only the parsed rows are kept. Nothing reaches your books until you
            map the accounts, review the entries and approve.
          </p>
          <div className="row">
            <label>Wave journal CSV<input ref={fileRef} type="file" accept=".csv,text/csv" required /></label>
            <button className="primary" type="submit" disabled={busy}>{busy ? "Reading file…" : "Upload and stage"}</button>
          </div>
          {error && <p className="msg error" role="alert">{error}</p>}
        </form>
      )}

      <h2>Imports</h2>
      <label style={{ maxWidth: "14rem" }}>Show
        <select value={status} onChange={(e) => setStatus(e.target.value as ImportBatchStatus | "")}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{BATCH_STATUS_LABEL[s]}</option>)}
        </select>
      </label>
      {list.loading && <p className="muted">Loading…</p>}
      {list.error && <p className="msg error" role="alert">{list.error}</p>}
      {list.data && list.data.batches.length === 0 && <p>No imports yet.</p>}
      {list.data && list.data.batches.length > 0 && (
        <table>
          <thead><tr><th>Uploaded</th><th>Source</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.batches.map((b) => (
              <tr key={b.id}>
                <td>{b.createdAt.slice(0, 10)}</td>
                <td>{b.source}</td>
                <td><span className={`badge ${b.status}`}>{BATCH_STATUS_LABEL[b.status]}</span></td>
                <td><a href={hrefFor.importReview(businessId, b.id)}>{b.status === "staged" ? "Review" : "View"}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
