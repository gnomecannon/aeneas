import { useEffect, useSyncExternalStore } from "react";
import { taskFilter, type Entity, type SourceList } from "@everythingapp/shared";
import type { SourcesView } from "../sync/api";
import { HubError } from "../sync/api";
import { engine } from "../sync/engine";

/**
 * Which Apple Reminders lists are on (GET /prefs/sources, chosen on the iPhone, iPad or Mac): the tasks of a list
 * that is off are hidden from every list of tasks here, as on every device. Kept for the next visit, refreshed on open
 * and whenever the hub says it changed (`sources` on /live). Nothing known yet hides nothing.
 */
const KEY = "ea-sources";
let lists: SourceList[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { lists?: SourceList[] } | null;
    return Array.isArray(v?.lists) ? v.lists : [];
  } catch {
    return [];
  }
})();
let shows = taskFilter(lists);
let version = 0;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let subscribed = false;
/** Read from the hub once this visit; after that the live stream says when it changes (and when it opens again). */
let fetched = false;

/** Take a setting from the hub (null: a hub from before 1.0.18, which has none). */
export function keepSources(v: Pick<SourcesView, "lists"> | null): void {
  lists = (v?.lists ?? []).map((l) => ({ key: l.key, title: l.title, on: l.on, ...(l.was?.length ? { was: l.was } : {}) }));
  shows = taskFilter(lists);
  version++;
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify({ lists }));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window */
  }
  listeners.forEach((f) => f());
}

export function refreshSources(): Promise<void> {
  const c = engine.client;
  if (!subscribed) {
    subscribed = true;
    engine.onSources(keepSources);
  }
  if (!c) return Promise.resolve();
  loading ??= c
    .sources()
    .then((v) => { fetched = true; keepSources(v); })
    // A hub from before the setting answers 404: nothing is hidden. Unreachable: the copy kept is used.
    .catch((e) => { if (e instanceof HubError && e.status === 404) { fetched = true; keepSources(null); } })
    .finally(() => { loading = null; });
  return loading;
}

/** Whether an item shows: every item but a task in an Apple Reminders list that is switched off. */
export function isShown(e: Entity): boolean {
  return e.kind !== "task" || shows(e.fields);
}

/** The items that show, for lists read straight from the local copy. */
export function shownOnly<T extends Entity>(rows: T[]): T[] {
  return rows.filter(isShown);
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** A number that changes whenever the lists that are on change; reading it keeps a screen up to date. */
export function useSourcesVersion(): number {
  const v = useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (!fetched) void refreshSources(); }, []);
  return v;
}
