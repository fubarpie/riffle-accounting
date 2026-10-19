// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { STATUS_LABEL, isWriter } from "../draft";
import { useLoad, useSession } from "../hooks";
import { currencyExponent, formatMinor, parseDecimalToMinor } from "../money";
import { hrefFor } from "../router";
import type { ExtractionStatus, UploadParams } from "../types";

const STATUSES: ExtractionStatus[] = ["flagged", "staged", "pending", "approved", "rejected"];

export function Extractions({ businessId }: { businessId: string }) {
  const { describe } = useSession();
  const [status, setStatus] = useState<ExtractionStatus | "">("");
  const business = useLoad(() => api.business(businessId), [businessId]);
  const accounts = useLoad(() => api.accounts(businessId), [businessId]);
  const list = useLoad(() => api.listExtractions(businessId, status ? { status } : {}), [businessId, status]);

  const role = business.data?.business.role;
  const currency = business.data?.business.currency ?? "";
  const exponent = currencyExponent(currency);
  const accountName = new Map((accounts.data?.accounts ?? []).map((a) => [a.id, a.name]));
  const uploadable = (accounts.data?.accounts ?? []).filter((a) => (a.type === "asset" || a.type === "liability") && !a.archived_at);

  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState("");
  const [csv, setCsv] = useState({ periodStart: "", periodEnd: "", opening: "", closing: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a PDF or CSV statement.");
    if (!accountId) return setError("Choose the account this statement belongs to.");

    const params: UploadParams = { accountId };
    if (file.name.toLowerCase().endsWith(".csv")) {
      if (csv.periodStart) params.periodStart = csv.periodStart;
      if (csv.periodEnd) params.periodEnd = csv.periodEnd;
      for (const [key, raw, field] of [["openingBalance", csv.opening, "opening"], ["closingBalance", csv.closing, "closing"]] as const) {
        if (!raw.trim()) continue;
        const minor = parseDecimalToMinor(raw, exponent);
        if (minor === null) return setError(`The ${field} balance is not an exact amount.`);
        params[key] = minor;
      }
    }
    setBusy(true);
    try {
      const res = await api.upload(businessId, file, params);
      window.location.hash = hrefFor.review(businessId, res.extraction.id);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p><a href={hrefFor.businesses()}>← Businesses</a></p>
      <h1>Statement uploads{business.data ? ` — ${business.data.business.name}` : ""}</h1>
      <p><a href={hrefFor.imports(businessId)}>Import a Wave journal export →</a></p>
      {business.error && <p className="msg error" role="alert">{business.error}</p>}

      {isWriter(role) && (
        <form className="card" onSubmit={(e) => void upload(e)}>
          <h2 style={{ marginTop: 0 }}>Upload a statement</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            PDFs need a text layer (scans are not supported). Nothing is posted to your books until you review and approve it.
          </p>
          <div className="row">
            <label>Account
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">Choose…</option>
                {uploadable.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ` : ""}{a.name}</option>)}
              </select>
            </label>
            <label>File (PDF or CSV)<input ref={fileRef} type="file" accept=".pdf,.csv,application/pdf,text/csv" required /></label>
            <button className="primary" type="submit" disabled={busy}>{busy ? "Extracting… this can take a minute" : "Upload and extract"}</button>
          </div>
          <details style={{ marginTop: ".75rem" }}>
            <summary>CSV options (only if the file has no running balance column)</summary>
            <div className="row" style={{ marginTop: ".5rem" }}>
              <label>Period start<input type="date" value={csv.periodStart} onChange={(e) => setCsv({ ...csv, periodStart: e.target.value })} /></label>
              <label>Period end<input type="date" value={csv.periodEnd} onChange={(e) => setCsv({ ...csv, periodEnd: e.target.value })} /></label>
              <label>Opening balance<input className="num" inputMode="decimal" value={csv.opening} onChange={(e) => setCsv({ ...csv, opening: e.target.value })} /></label>
              <label>Closing balance<input className="num" inputMode="decimal" value={csv.closing} onChange={(e) => setCsv({ ...csv, closing: e.target.value })} /></label>
            </div>
          </details>
          {error && <p className="msg error" role="alert">{error}</p>}
        </form>
      )}

      <h2>Extractions</h2>
      <label style={{ maxWidth: "14rem" }}>Show
        <select value={status} onChange={(e) => setStatus(e.target.value as ExtractionStatus | "")}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </label>
      {list.loading && <p className="muted">Loading…</p>}
      {list.error && <p className="msg error" role="alert">{list.error}</p>}
      {list.data && list.data.extractions.length === 0 && <p>No extractions yet.</p>}
      {list.data && list.data.extractions.length > 0 && (
        <table>
          <thead><tr><th>Uploaded</th><th>Account</th><th>Period</th><th className="num">Closing balance</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.extractions.map((x) => (
              <tr key={x.id}>
                <td>{x.createdAt.slice(0, 10)}</td>
                <td>{accountName.get(x.accountId) ?? "—"}</td>
                <td>{x.periodStart} to {x.periodEnd}</td>
                <td className="num">{formatMinor(x.closingBalanceMinor, exponent, currency)}</td>
                <td><span className={`badge ${x.status}`}>{STATUS_LABEL[x.status]}</span></td>
                <td><a href={hrefFor.review(businessId, x.id)}>Review</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
