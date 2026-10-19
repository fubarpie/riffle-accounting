// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "../api";
import { useLoad } from "../hooks";
import { hrefFor } from "../router";

export function Businesses() {
  const { data, error, loading } = useLoad(() => api.businesses(), []);
  return (
    <>
      <h1>Your businesses</h1>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="msg error" role="alert">{error}</p>}
      {data && data.businesses.length === 0 && <p>You are not a member of any business yet.</p>}
      {data && data.businesses.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Currency</th><th>Your role</th><th /></tr></thead>
          <tbody>
            {data.businesses.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td><td>{b.currency}</td><td>{b.role}</td>
                <td><a href={hrefFor.extractions(b.id)}>Statement uploads</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
