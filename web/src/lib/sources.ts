import { useEffect, useSyncExternalStore } from "react";
import { readTaskGroups, taskFilter, type Entity, type SourceList, type TaskGroup } from "@everythingapp/shared";
import type { SourcesView } from "../sync/api";
import { HubError } from "../sync/api";
import { engine } from "../sync/engine";

/**
 * Which Apple Reminders lists are on (GET /prefs/sources, chosen on the iPhone, iPad or Mac): the tasks of a list
 * that is off are hidden from every list of tasks here, as on every device. Kept for the next visit, refreshed on open
 * and whenever the hub says it changed (`sources` on /live). Nothing known yet hides nothing.
 */
const KEY = "ea-sources";

/** A Reminders list as this page keeps it: what hides its tasks, and what names it in a chooser. */
export interface KeptList extends SourceList {
  account?: string;
  kind?: string;
  /** The space its tasks are in now. */
  space?: "personal" | "work";
}

function keptList(l: Partial<SourcesView["lists"][number]>): KeptList | null {
  if (typeof l?.key !== "string" || typeof l.title !== "string") return null;
  return {
    key: l.key, title: l.title, on: l.on !== false, ...(l.was?.length ? { was: l.was } : {}),
    ...(typeof l.account === "string" ? { account: l.account } : {}), ...(typeof l.kind === "string" ? { kind: l.kind } : {}),
    ...(l.space === "work" || l.space === "personal" ? { space: l.space } : {}),
  };
}

const kept = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") as { lists?: unknown[]; groups?: unknown } | null;
  } catch {
    return null;
  }
})();
let lists: KeptList[] = Array.isArray(kept?.lists) ? kept.lists.map((l) => keptList(l as KeptList)).filter((l): l is KeptList => !!l) : [];
/** The owner's groups on the Tasks screen (gnomecannon/aeneas#26), in their order. */
let groups: TaskGroup[] = readTaskGroups(kept?.groups) ?? [];
let shows = taskFilter(lists);
let version = 0;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let subscribed = false;
/** Read from the hub once this visit; after that the live stream says when it changes (and when it opens again). */
let fetched = false;

/** Take a setting from the hub (null: a hub from before 1.0.18, which has none). */
export function keepSources(v: Pick<SourcesView, "lists" | "groups"> | null): void {
  lists = (v?.lists ?? []).map(keptList).filter((l): l is KeptList => !!l);
  groups = readTaskGroups(v?.groups ?? []) ?? [];
  shows = taskFilter(lists);
  version++;
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify({ lists, groups }));
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

/** An Apple account's name in a chooser: its own name, or what kind of account it is. */
export function sourceAccount(account: string, kind: string): string {
  if (account) return account;
  return kind === "icloud" ? "iCloud" : kind === "exchange" ? "Exchange" : kind === "local" ? "On the device" : "Other";
}

/** The Reminders lists the hub knows, on and off, by account and name: what the list choosers offer. */
export function useSourceLists(): KeptList[] {
  useSourcesVersion();
  return useSyncExternalStore(subscribe, () => lists, () => lists);
}

/** The owner's groups on the Tasks screen, kept for every device by the hub. */
export function useTaskGroups(): TaskGroup[] {
  useSourcesVersion();
  return useSyncExternalStore(subscribe, () => groups, () => groups);
}

/** A number that changes whenever the lists that are on change; reading it keeps a screen up to date. */
export function useSourcesVersion(): number {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => { if (!fetched) void refreshSources(); }, []);
  return v;
}
