// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { type Route, parseRoute } from "./router";
import type { User } from "./types";

export interface Session {
  user: User;
  /** Turns any thrown value into a message for the person. A 401 also ends the session. */
  describe(err: unknown): string;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside of a signed-in view");
  return s;
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return parseRoute(hash);
}

export interface Loaded<T> { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void }

/** Runs `load` whenever `deps` change (or `reload()` is called) and ignores answers that arrive after a newer request. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const { describe } = useSession();
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined; loading: boolean }>({
    data: undefined, error: undefined, loading: true,
  });
  const [tick, setTick] = useState(0);

  // `load` is re-created every render on purpose; `deps` decide when to run.
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (data) => { if (live) setState({ data, error: undefined, loading: false }); },
      (err: unknown) => { if (live) setState({ data: undefined, error: describe(err), loading: false }); },
    );
    return () => { live = false; };
  }, [...deps, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
