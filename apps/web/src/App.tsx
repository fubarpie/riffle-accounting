// SPDX-License-Identifier: AGPL-3.0-or-later
import { APP_NAME, type HealthResponse, SOURCE_URL } from "@riffle/shared";
import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: HealthResponse }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/healthz", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then((health) => setState({ kind: "ok", health }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>{APP_NAME}</h1>
      <p>Free and open source small business bookkeeping.</p>
      <p data-testid="api-status">
        API status:{" "}
        {state.kind === "loading" && "checking..."}
        {state.kind === "ok" && `${state.health.status} (version ${state.health.version})`}
        {state.kind === "error" && `unreachable (${state.message})`}
      </p>
      <footer style={{ marginTop: "3rem", fontSize: "0.85rem", color: "#555" }}>
        {APP_NAME} is licensed under the AGPL-3.0-or-later. No warranty.{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          Source code
        </a>
      </footer>
    </main>
  );
}
