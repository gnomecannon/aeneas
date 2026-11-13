import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../sync/engine";
import { HubClient, HubError } from "../sync/api";
import { useSyncState } from "../sync/hooks";

/**
 * `at`: when the data last loaded. A failed refresh keeps it (it said "checked now" while the hub was unreachable) and
 * sets `error`, so a screen can say its data is from then.
 */
export type Loaded<T> = { data: T | null; error: string | null; unavailable: boolean; at: Date | null; busy: boolean };

export function describeError(e: unknown): { error: string; unavailable: boolean } {
  if (e instanceof HubError && e.status === 404) return { error: "not available on this hub", unavailable: true };
  return { error: e instanceof Error ? e.message : String(e), unavailable: false };
}

/** Synced changes come in bursts (a sensor reading moves the position too): at most one reload for them this often. */
export const SYNC_RELOAD_MS = 5_000;

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Loads one hub route, then again after synced changes (at most every SYNC_RELOAD_MS), every `everyMs`, and on demand
 * through `reload`; never while the window is hidden (a minimized app left on Ops kept fetching), and one request at a
 * time (a reload asked for during one runs once it ends).
 */
export function usePoll<T>(load: (c: HubClient) => Promise<T>, everyMs = 60_000): Loaded<T> & { reload: () => Promise<void> } {
  const sync = useSyncState();
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, unavailable: false, at: null, busy: false });
  const fnRef = useRef(load);
  fnRef.current = load;
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const c = engine.client;
    if (!c) {
      setState((s) => ({ ...s, error: "Needs the hub.", busy: false }));
      return;
    }
    const run = (async () => {
      setState((s) => ({ ...s, busy: true }));
      try {
        const data = await fnRef.current(c);
        if (alive.current) setState({ data, error: null, unavailable: false, at: new Date(), busy: false });
      } catch (e) {
        if (alive.current) setState((s) => ({ ...s, ...describeError(e), busy: false }));
      }
    })();
    running.current = run;
    try {
      await run;
    } finally {
      running.current = null;
    }
    if (again.current && alive.current) {
      again.current = false;
      await reload();
    }
  }, []);

  // Synced changes: the first at once, a burst after it at most every SYNC_RELOAD_MS; held while hidden.
  const lastSyncReload = useRef(0);
  const pendingSync = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!visible()) return;
    const wait = lastSyncReload.current + SYNC_RELOAD_MS - Date.now();
    if (wait <= 0) {
      lastSyncReload.current = Date.now();
      void reload();
      return;
    }
    if (pendingSync.current) return;
    pendingSync.current = setTimeout(() => {
      pendingSync.current = null;
      lastSyncReload.current = Date.now();
      if (visible()) void reload();
    }, wait);
  }, [reload, sync.seq, sync.status === "setup"]);
  useEffect(() => () => {
    if (pendingSync.current) clearTimeout(pendingSync.current);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (visible()) void reload();
      }, everyMs);
    };
    const onVis = () => {
      if (visible()) {
        void reload();
        start();
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload, everyMs]);

  return { ...state, reload };
}
