import { useSyncExternalStore } from "react";

/**
 * Which Library areas (Plan, Notes, Homelab...) are open on this device. Every area starts closed so all of them fit
 * on one screen; one you open stays open until you close it. The sidebar and the phone's Library tab share the list,
 * so opening Plan in one opens it in the other.
 */

const KEY = "ea.library.open";
/** The sidebar used to remember closed areas instead (everything started open). */
const OLD_KEY = "ea.rail.collapsed";

/** The stored list, or nothing open when it is missing or damaged. */
export function parseOpen(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function read(): string[] {
  try {
    localStorage.removeItem(OLD_KEY);
    return parseOpen(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

let current: string[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): string[] {
  return (current ??= read());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The list with `title` opened or closed. */
export function toggled(list: string[], title: string): string[] {
  return list.includes(title) ? list.filter((t) => t !== title) : [...list, title];
}

export function setOpen(next: string[]): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window: open areas last until the page reloads */
  }
  listeners.forEach((fn) => fn());
}

/** The areas open on this device, and a toggle that remembers the change. */
export function useOpenAreas(): [string[], (title: string) => void] {
  const open = useSyncExternalStore(subscribe, snapshot);
  return [open, (title) => setOpen(toggled(snapshot(), title))];
}
