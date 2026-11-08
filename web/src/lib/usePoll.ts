import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../sync/engine";
import { HubClient, HubError } from "../sync/api";
import { useSyncState } from "../sync/hooks";

export type Loaded<T> = { data: T | null; error: string | null; unavailable: boolean; at: Date | null; busy: boolean };

export function describeError(e: unknown): { error: string; unavailable: boolean } {
  if (e instanceof HubError && e.status === 404) return { error: "not available on this hub", unavailable: true };
  return { error: e instanceof Error ? e.message : String(e), unavailable: false };
}

/**
 * Loads one hub route, then again on every synced change (the engine's seq moves), every `everyMs`
 * while the tab is visible, and on demand through `reload`.
 */
export function usePoll<T>(load: (c: HubClient) => Promise<T>, everyMs = 60_000): Loaded<T> & { reload: () => Promise<void> } {
  const sync = useSyncState();
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, unavailable: false, at: null, busy: false });
  const fnRef = useRef(load);
  fnRef.current = load;

  const reload = useCallback(async () => {
    const c = engine.client;
    if (!c) {
      setState((s) => ({ ...s, error: "Needs the hub.", busy: false }));
      return;
    }
    setState((s) => ({ ...s, busy: true }));
    try {
      const data = await fnRef.current(c);
      setState({ data, error: null, unavailable: false, at: new Date(), busy: false });
    } catch (e) {
      setState((s) => ({ ...s, ...describeError(e), at: new Date(), busy: false }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, sync.seq, sync.status === "setup"]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void reload(), everyMs);
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
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload, everyMs]);

  return { ...state, reload };
}
