import { useSyncExternalStore } from "react";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { isWindowsApp } from "../tauri/bridge";
import { DEFAULT_FEEL, mergeFeel, viewFrom, type Feel, type FeelView } from "./prefs";

/**
 * The feel setting on this device: the hub's copy, cached in localStorage for offline use. A change applies here at
 * once and is sent to the hub; one the hub has not taken yet (offline) is kept and sent on the next refresh.
 */

const CACHE = "ea.feel";
const PENDING = "ea.feel.pending";

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage full: the in-memory copy still works */
  }
}

let view: FeelView = read(CACHE) ? viewFrom(read(CACHE)) : DEFAULT_FEEL;
let pending: Partial<Feel> = (read(PENDING) as Partial<Feel> | null) ?? {};
let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function set(next: FeelView) {
  view = next;
  write(CACHE, next);
  for (const l of listeners) l();
}

function savePending() {
  write(PENDING, Object.keys(pending).length ? pending : null);
}

/** A computer (the Windows app, or a browser with a mouse) plays notes only once its own switch is on. */
const SOUND_HERE = "ea.feel.soundHere";
export const onComputer =
  isWindowsApp || (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
let soundOnComputer = read(SOUND_HERE) === true;

export function soundOnThisComputer(): boolean {
  return soundOnComputer;
}

export function setSoundOnThisComputer(on: boolean): void {
  soundOnComputer = on;
  write(SOUND_HERE, on);
}

/** Whether taps play notes on this device: the shared switch, and on a computer its own switch too. */
export function soundHere(f: FeelView): boolean {
  return f.sound && (!onComputer || soundOnComputer);
}

export function getFeel(): FeelView {
  return view;
}

export function subscribeFeel(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFeel(): FeelView {
  return useSyncExternalStore(subscribeFeel, getFeel);
}

/** Send what has not reached the hub yet. Runs one at a time so answers cannot land out of order. */
function flush(): Promise<void> {
  timer = undefined;
  chain = chain.then(async () => {
    const c = engine.client;
    if (!c || !Object.keys(pending).length) return;
    const body = pending;
    pending = {};
    savePending();
    try {
      const out = await c.setFeel(body);
      set(mergeFeel(viewFrom(out), pending));
    } catch (e) {
      // The hub refused it or has no such route: keep it on this device only. Unreachable: try again later.
      if (!(e instanceof HubError)) {
        pending = { ...body, ...pending };
        savePending();
      }
    }
  });
  return chain;
}

/** Change the setting. `debounceMs` holds the hub write while a slider is still moving. */
export function updateFeel(patch: Partial<Feel>, debounceMs = 0): void {
  set(mergeFeel(view, patch));
  pending = { ...pending, ...patch };
  savePending();
  if (timer) clearTimeout(timer);
  if (debounceMs) timer = setTimeout(() => void flush(), debounceMs);
  else void flush();
}

/** Fetch the hub's copy, sending any change made while it was unreachable first. */
export async function refreshFeel(): Promise<void> {
  const c = engine.client;
  if (!c) return;
  if (Object.keys(pending).length) return flush();
  try {
    const out = await c.feel();
    if (!Object.keys(pending).length) set(viewFrom(out));
  } catch {
    /* keep the cached copy */
  }
}

/** Upload an image shape (PNG or WebP bytes, already shrunk). Needs the hub; throws when it cannot be reached or refuses. */
export async function addFeelImage(blob: Blob, name: string): Promise<void> {
  const c = engine.client;
  if (!c) throw new Error("Connect to the hub first.");
  await flush();
  const out = await c.uploadFeelImage(blob, name);
  set(mergeFeel(viewFrom(out), pending));
}

/** Delete an image shape on the hub. */
export async function removeFeelImage(id: string): Promise<void> {
  const c = engine.client;
  if (!c) throw new Error("Connect to the hub first.");
  await flush();
  const out = await c.deleteFeelImage(id);
  set(mergeFeel(viewFrom(out), pending));
}
