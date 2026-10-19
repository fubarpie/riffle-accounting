// SPDX-License-Identifier: AGPL-3.0-or-later
import { APP_NAME, SOURCE_URL } from "@riffle/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, describeError } from "./api";
import { BusinessLayout } from "./components/BusinessLayout";
import { SessionContext, useRoute, type Session } from "./hooks";
import { Businesses } from "./pages/Businesses";
import { Dashboard } from "./pages/Dashboard";
import { Extractions } from "./pages/Extractions";
import { ImportReview } from "./pages/ImportReview";
import { Imports } from "./pages/Imports";
import { Login } from "./pages/Login";
import { Reports } from "./pages/Reports";
import { Review } from "./pages/Review";
import { hrefFor } from "./router";
import type { User } from "./types";

type Auth =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "error"; message: string }
  | { kind: "user"; user: User };

export function App() {
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const route = useRoute();

  useEffect(() => {
    api.me().then(
      ({ user }) => setAuth({ kind: "user", user }),
      (err: unknown) => setAuth(err instanceof ApiError && err.status === 401 ? { kind: "anon" } : { kind: "error", message: describeError(err) }),
    );
  }, []);

  const describe = useCallback((err: unknown): string => {
    if (err instanceof ApiError && err.status === 401) {
      setAuth({ kind: "anon" });
      return "Your session expired. Sign in again.";
    }
    return describeError(err);
  }, []);

  const session = useMemo<Session | null>(() => (auth.kind === "user" ? { user: auth.user, describe } : null), [auth, describe]);

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      setAuth({ kind: "anon" });
    }
  };

  let body;
  if (auth.kind === "loading") body = <p className="muted">Loading…</p>;
  else if (auth.kind === "error") body = <p className="msg error" role="alert">{auth.message}</p>;
  else if (auth.kind === "anon") body = <Login onSignedIn={(user) => setAuth({ kind: "user", user })} />;
  else if (route.name === "businesses") body = <Businesses />;
  else if (route.name === "dashboard") body = <Dashboard key={route.businessId} businessId={route.businessId} />;
  else if (route.name === "reports") body = <Reports key={`${route.businessId}:${route.kind}`} businessId={route.businessId} kind={route.kind} />;
  else if (route.name === "extractions") body = <Extractions key={route.businessId} businessId={route.businessId} />;
  else if (route.name === "imports") body = <Imports key={route.businessId} businessId={route.businessId} />;
  else if (route.name === "import-review") body = <ImportReview key={route.batchId} businessId={route.businessId} batchId={route.batchId} />;
  else if (route.name === "review") body = <Review key={route.extractionId} businessId={route.businessId} extractionId={route.extractionId} />;
  else body = <p>Page not found. <a href={hrefFor.businesses()}>Back to businesses</a></p>;

  // Pages that belong to one business get the sidebar.
  const framed = auth.kind === "user" && "businessId" in route
    ? <BusinessLayout key={route.businessId} businessId={route.businessId} route={route}>{body}</BusinessLayout>
    : body;

  return (
    <>
      <header className="top">
        <a className="brand" href={hrefFor.businesses()}>{APP_NAME}</a>
        <span className="spacer" />
        {session && (
          <>
            <span className="muted">{session.user.name}</span>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </>
        )}
      </header>
      <main>{session ? <SessionContext.Provider value={session}>{framed}</SessionContext.Provider> : body}</main>
      <footer>
        {APP_NAME} is licensed under the AGPL-3.0-or-later. No warranty.{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">Source code</a>
      </footer>
    </>
  );
}
