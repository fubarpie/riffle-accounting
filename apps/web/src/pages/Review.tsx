// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { api, detailFromError } from "../api";
import {
  STATUS_LABEL, canApprove, canReject, draftToPatch, emptyLine, generalReasons, isDirty, isEditable, isWriter,
  previewDifference, readGate, reasonsForLine, toDraft, type Draft, type DraftError,
} from "../draft";
import { useLoad, useSession } from "../hooks";
import { currencyExponent, formatMinor } from "../money";
import { hrefFor } from "../router";
import type { ExtractionDetail } from "../types";

type Notice = { kind: "ok" | "error" | "warn"; text: string };

export function Review({ businessId, extractionId }: { businessId: string; extractionId: string }) {
  const { describe } = useSession();
  const business = useLoad(() => api.business(businessId), [businessId]);
  const accounts = useLoad(() => api.accounts(businessId), [businessId]);
  const loaded = useLoad(() => api.getExtraction(businessId, extractionId), [businessId, extractionId]);

  const [detail, setDetail] = useState<ExtractionDetail>();
  const [draft, setDraft] = useState<Draft>();
  const [baseline, setBaseline] = useState<Draft>();
  const [formErrors, setFormErrors] = useState<DraftError[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);

  const currency = business.data?.business.currency ?? "";
  const role = business.data?.business.role;
  const exponent = currencyExponent(currency);

  const apply = (d: ExtractionDetail) => {
    const fresh = toDraft(d, exponent);
    setDetail(d);
    setDraft(fresh);
    setBaseline(fresh);
    setFormErrors([]);
  };

  // Seed once both the extraction and the business currency (which fixes the decimal places) are known.
  useEffect(() => {
    if (loaded.data && business.data) apply(loaded.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data, business.data]);

  const error = loaded.error ?? business.error;
  if (error) return <p className="msg error" role="alert">{error}</p>;
  if (!detail || !draft || !baseline) return <p className="muted">Loading…</p>;

  const { extraction } = detail;
  const gate = readGate(extraction);
  const dirty = isDirty(draft, baseline);
  const editable = isWriter(role) && isEditable(extraction.status);
  const accountName = accounts.data?.accounts.find((a) => a.id === extraction.accountId)?.name ?? "—";
  const preview = previewDifference(draft, exponent);
  const money = (minor: string) => formatMinor(minor, exponent, currency);
  const lineProblems = (i: number) => formErrors.filter((e) => e.lineIndex === i).map((e) => e.message);

  /** Runs one server action, keeping the page consistent whatever happens. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
    } catch (err) {
      // A refused approval still returns the refreshed extraction and its reasons.
      const refreshed = detailFromError(err);
      if (refreshed) apply(refreshed);
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const result = draftToPatch(draft, exponent);
    if (!result.ok) {
      setFormErrors(result.errors);
      setNotice({ kind: "error", text: "Fix the highlighted fields, then save again." });
      return;
    }
    const d = await api.patchExtraction(businessId, extractionId, result.body);
    apply(d);
    setNotice({ kind: "ok", text: d.extraction.status === "staged" ? "Saved. The statement passes the balance check." : "Saved. It still needs attention before it can be approved." });
  });

  const revalidate = () => run(async () => {
    apply(await api.revalidate(businessId, extractionId));
    setNotice({ kind: "ok", text: "Checked again against the current books." });
  });

  const approve = () => {
    const toPost = draft.lines.filter((l) => !l.alreadyRecorded).length;
    const ok = window.confirm(
      `Post ${toPost} transaction${toPost === 1 ? "" : "s"} to your books? ` +
      `${draft.lines.length - toPost} line(s) marked already recorded will be skipped.`);
    if (!ok) return Promise.resolve();
    return run(async () => {
      const res = await api.approve(businessId, extractionId);
      apply(res);
      setNotice(res.alreadyApproved
        ? { kind: "warn", text: "This extraction was already approved. Nothing new was posted." }
        : { kind: "ok", text: `Approved. ${res.posted} transaction${res.posted === 1 ? "" : "s"} posted to your books${res.skippedAlreadyRecorded ? `, ${res.skippedAlreadyRecorded} skipped as already recorded` : ""}.` });
    });
  };

  const reject = () => {
    if (!window.confirm("Reject this extraction? Nothing will be posted.")) return Promise.resolve();
    return run(async () => {
      apply(await api.reject(businessId, extractionId));
      setNotice({ kind: "ok", text: "Rejected. Nothing was posted." });
    });
  };

  const setLine = (i: number, patch: Partial<Draft["lines"][number]>) =>
    setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const fieldError = (f: DraftError["field"]) => formErrors.find((e) => e.field === f && e.lineIndex === undefined)?.message;

  return (
    <>
      <p><a href={hrefFor.extractions(businessId)}>← Statement uploads</a></p>
      <h1>
        Review statement <span className={`badge ${extraction.status}`}>{STATUS_LABEL[extraction.status]}</span>
      </h1>
      <p className="muted">
        {accountName} · extracted by {extraction.extractorName} ({extraction.extractorModel}) on {extraction.createdAt.slice(0, 10)}
      </p>

      {notice && <p className={`msg ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}

      <section aria-label="Balance check" className={`msg ${gate.ok ? "ok" : "error"}`}>
        {gate.ok
          ? <strong>The lines add up to the statement balances.</strong>
          : <strong>This statement cannot be approved yet.</strong>}
        {!dirty && generalReasons(gate).length > 0 && (
          <ul className="reasons">{generalReasons(gate).map((r, i) => <li key={`${r.code}${i}`}>{r.message}</li>)}</ul>
        )}
        {dirty && <div className="muted">You have unsaved changes. Save to re-run the check.</div>}
        {preview !== null && (
          <div className="muted">
            Preview: lines minus balance movement = {money(preview)} {preview === "0" ? "(balanced)" : "(should be 0)"}
          </div>
        )}
      </section>

      <div className="card">
        <div className="row">
          <label>Period start
            <input type="date" disabled={!editable} value={draft.periodStart} onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })} />
            {fieldError("periodStart") && <span className="reasons">{fieldError("periodStart")}</span>}
          </label>
          <label>Period end
            <input type="date" disabled={!editable} value={draft.periodEnd} onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })} />
            {fieldError("periodEnd") && <span className="reasons">{fieldError("periodEnd")}</span>}
          </label>
          <label>Opening balance ({currency})
            <input className="num" inputMode="decimal" disabled={!editable} value={draft.opening} onChange={(e) => setDraft({ ...draft, opening: e.target.value })} />
            {fieldError("opening") && <span className="reasons">{fieldError("opening")}</span>}
          </label>
          <label>Closing balance ({currency})
            <input className="num" inputMode="decimal" disabled={!editable} value={draft.closing} onChange={(e) => setDraft({ ...draft, closing: e.target.value })} />
            {fieldError("closing") && <span className="reasons">{fieldError("closing")}</span>}
          </label>
        </div>
        {extraction.currency && extraction.currency !== currency && (
          <p className="msg warn">The statement says {extraction.currency}, but this business uses {currency}.</p>
        )}
      </div>

      <h2>Lines ({draft.lines.length})</h2>
      {fieldError("lines") && <p className="msg error">{fieldError("lines")}</p>}
      <table>
        <thead>
          <tr><th>#</th><th>Date</th><th>Description</th><th className="num">Amount ({currency})</th><th>Already in books</th>{editable && <th />}</tr>
        </thead>
        <tbody>
          {draft.lines.map((l, i) => {
            const problems = [...lineProblems(i), ...(dirty ? [] : reasonsForLine(gate, i).map((r) => r.message))];
            return (
              <tr key={l.key} className={problems.length ? "problem" : undefined}>
                <td>{i + 1}</td>
                <td><input type="date" aria-label={`Line ${i + 1} date`} disabled={!editable} value={l.date} onChange={(e) => setLine(i, { date: e.target.value })} /></td>
                <td>
                  <input aria-label={`Line ${i + 1} description`} disabled={!editable} value={l.description} maxLength={1000} onChange={(e) => setLine(i, { description: e.target.value })} />
                  {problems.length > 0 && <ul className="reasons">{problems.map((p, k) => <li key={k}>{p}</li>)}</ul>}
                </td>
                <td><input className="num" inputMode="decimal" aria-label={`Line ${i + 1} amount`} disabled={!editable} value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                <td className="narrow"><input type="checkbox" aria-label={`Line ${i + 1} already recorded`} disabled={!editable} checked={l.alreadyRecorded} onChange={(e) => setLine(i, { alreadyRecorded: e.target.checked })} /></td>
                {editable && (
                  <td><button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>Remove</button></td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <p><button type="button" onClick={() => setDraft({ ...draft, lines: [...draft.lines, emptyLine(draft.periodEnd)] })}>Add line</button></p>
      )}
      <p className="muted">
        Amounts use the statement's sign: a positive amount raises the closing balance (a deposit on a bank account, a purchase on a card).
      </p>

      {isWriter(role) ? (
        <div className="actions">
          {editable && <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>Save changes</button>}
          {editable && <button type="button" disabled={busy || dirty} onClick={() => void revalidate()}>Check again</button>}
          <button type="button" className="primary" disabled={busy || !canApprove(extraction, role, dirty)} onClick={() => void approve()}>Approve and post</button>
          <button type="button" className="danger" disabled={busy || !canReject(extraction, role)} onClick={() => void reject()}>Reject</button>
          {dirty && editable && <button type="button" disabled={busy} onClick={() => { setDraft(baseline); setFormErrors([]); }}>Discard changes</button>}
        </div>
      ) : (
        <p className="muted">You have view-only access to this business.</p>
      )}
      {extraction.status === "approved" && <p className="muted">Approved {extraction.approvedAt?.slice(0, 10)}. The transactions were posted to your books.</p>}
      {extraction.status === "rejected" && <p className="muted">Rejected {extraction.rejectedAt?.slice(0, 10)}.</p>}
    </>
  );
}
