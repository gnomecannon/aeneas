import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "./engine";
import { HubClient, HubError } from "./api";
import { useSyncState } from "./hooks";

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** The hub answered 404: the route is not on this hub. */
  unavailable: boolean;
  /** Where `data` came from. */
  source: "hub" | "local" | null;
  at: Date | null;
  busy: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads something from the hub, refreshing every `intervalMs` while the tab is visible and whenever
 * the sync cursor moves (a `change` event makes the engine pull and bump `seq`). When the hub cannot
 * be reached and a `fallback` is given, the fallback supplies the data from the local store instead.
 * The pattern of the Status view, generalised for the planner views.
 */
export function useHubPoll<T>(load: (c: HubClient) => Promise<T>, fallback: (() => Promise<T>) | null, deps: unknown[], intervalMs = 60_000): Polled<T> {
  const sync = useSyncState();
  const [state, setState] = useState<Omit<Polled<T>, "reload">>({ data: null, error: null, unavailable: false, source: null, at: null, busy: false });
  const seqRef = useRef(sync.seq);
  const gen = useRef(0);

  const reload = useCallback(async () => {
    const my = ++gen.current;
    setState((s) => ({ ...s, busy: true }));
    const c = engine.client;
    let next: Omit<Polled<T>, "reload">;
    try {
      if (!c) throw new Error("Needs the hub.");
      const data = await load(c);
      next = { data, error: null, unavailable: false, source: "hub", at: new Date(), busy: false };
    } catch (e) {
      const unavailable = e instanceof HubError && e.status === 404;
      const message = unavailable ? "not available on this hub" : e instanceof Error ? e.message : String(e);
      if (fallback) {
        try {
          const data = await fallback();
          next = { data, error: message, unavailable, source: "local", at: new Date(), busy: false };
        } catch (e2) {
          next = { data: null, error: e2 instanceof Error ? e2.message : String(e2), unavailable, source: null, at: new Date(), busy: false };
        }
      } else {
        next = { data: null, error: message, unavailable, source: null, at: new Date(), busy: false };
      }
    }
    if (my === gen.current) setState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void reload(), intervalMs);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void reload();
        start();
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    void reload();
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload, intervalMs, sync.status === "setup"]);

  useEffect(() => {
    if (sync.seq === seqRef.current) return;
    seqRef.current = sync.seq;
    void reload();
  }, [sync.seq, reload]);

  return { ...state, reload };
}
