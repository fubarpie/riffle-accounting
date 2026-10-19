// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import type { User } from "../types";

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { user } = mode === "login" ? await api.login(email, password) : await api.register(email, name, password);
      onSignedIn(user);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)} style={{ maxWidth: "24rem", margin: "3rem auto" }}>
      <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
      <div style={{ display: "grid", gap: ".75rem" }}>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {mode === "register" && (
          <label>Name<input autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        )}
        <label>Password
          <input type="password" required autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="msg error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(undefined); }}>
          {mode === "login" ? "Create an account instead" : "I already have an account"}
        </button>
      </div>
    </form>
  );
}
