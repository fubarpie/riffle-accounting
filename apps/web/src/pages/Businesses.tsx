// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useLoad, useSession } from "../hooks";
import { hrefFor } from "../router";

export function Businesses() {
  const { describe } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.businesses(), []);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(undefined);
    try {
      await api.createBusiness(name.trim(), currency.trim().toUpperCase());
      setName("");
      reload();
    } catch (err) {
      setFormError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Your businesses</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="msg error" role="alert">{error}</p>}
      {data && data.businesses.length === 0 && <p>You are not a member of any business yet. Create one below.</p>}
      {data && data.businesses.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Currency</th><th>Your role</th><th /></tr></thead>
          <tbody>
            {data.businesses.map((b) => (
              <tr key={b.id}>
                <td><a href={hrefFor.dashboard(b.id)}>{b.name}</a></td><td>{b.currency}</td><td>{b.role}</td>
                <td>
                  <a href={hrefFor.dashboard(b.id)}>Dashboard</a>{" · "}
                  <a href={hrefFor.reports(b.id, "profit-loss")}>Reports</a>{" · "}
                  <a href={hrefFor.imports(b.id)}>Wave import</a>{" · "}
                  <a href={hrefFor.extractions(b.id)}>Statement uploads</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Create a business</h2>
      <form onSubmit={onCreate}>
        <label>Name{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>{" "}
        <label>Currency{" "}
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} required
            pattern="[A-Za-z]{3}" maxLength={3} size={4} title="ISO 4217 code, e.g. USD" />
        </label>{" "}
        <button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
        {formError && <p className="msg error" role="alert">{formError}</p>}
      </form>
    </>
  );
}
