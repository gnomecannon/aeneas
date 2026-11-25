import { useEffect, useState } from "react";
import type { ModuleInfo } from "../sync/api";
import { engine } from "../sync/engine";

/**
 * Which modules are on (GET /modules), one setting for every device. Kept for the next visit so menus show at once,
 * refreshed on open and whenever another device switches one (`modules` on /live). A module not known yet counts as
 * on, so nothing disappears for someone who used it while the hub is out of reach.
 */
const KEY = "ea-modules";
let cached: ModuleInfo[] | null = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as ModuleInfo[] | null; } catch { return null; }
})();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let subscribed = false;

function keep(list: ModuleInfo[]): void {
  cached = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private window */ }
  listeners.forEach((f) => f());
}

export function refreshModules(): Promise<void> {
  const c = engine.client;
  if (!subscribed) { subscribed = true; engine.onModules(keep); }
  if (!c) return Promise.resolve();
  loading ??= c.modules().then((r) => keep(r.modules)).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}

/** Switch modules on or off for every device; the answer becomes the list. */
export async function setModules(changes: Record<string, boolean>): Promise<ModuleInfo[]> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const was = new Set((cached ?? []).filter((m) => m.on).map((m) => m.id));
  const r = await c.setModules(changes);
  for (const [id, on] of Object.entries(changes)) {
    if (on && !was.has(id)) fresh.add(id);
    else if (!on) fresh.delete(id);
  }
  keep(r.modules);
  return r.modules;
}

/**
 * Modules switched on from this app since it opened, whose first steps it offers until the person says Done (Machines:
 * Add machine and this computer's choices, under its switch and at the top of Tech).
 */
const fresh = new Set<string>();
export const justSwitchedOn = (id: string): boolean => fresh.has(id);
export function doneWithFirstSteps(id: string): void {
  fresh.delete(id);
  listeners.forEach((f) => f());
}

/**
 * Modules that count as on only once the hub lists them as on: Music (since 2026-11-25) is off for a new hub, and a hub
 * from before it has no such module to switch on and keeps no Apple Music taste, so its screen would only say to turn
 * on something that is not there.
 */
const LISTED_ONLY = new Set(["apple_music"]);

/** Whether a module is on in a list (an id the list does not have is on, but for LISTED_ONLY). */
export function isOn(list: ModuleInfo[] | null, id: string | undefined): boolean {
  if (!id) return true;
  const m = list?.find((x) => x.id === id);
  return m ? m.on : !LISTED_ONLY.has(id);
}

/** The module list (null until known) and a checker; rerenders when any switch changes. */
export function useModules(): { list: ModuleInfo[] | null; on: (id: string | undefined) => boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    void refreshModules();
    return () => { listeners.delete(f); };
  }, []);
  const list = cached;
  return { list, on: (id) => isOn(list, id) };
}

/** Which module each screen belongs to (by its path); a path not listed is part of the core. */
export const SCREEN_MODULE: Record<string, string> = {
  "/renewals": "renewals",
  "/dashboard": "dashboard",
  "/ops": "homelab", "/hosts": "homelab", "/journal": "homelab", "/snippets": "homelab",
  "/projects": "projects", "/procedures": "projects",
  "/music": "music",
  "/wiki": "wiki",
  "/gallery": "images", "/images": "images",
  "/quiz": "quiz",
  "/health": "health", "/logs": "health",
  "/pet": "pet",
  "/food": "food",
  "/sensors": "sensors",
  "/games": "games",
  "/films": "films",
  "/listening": "apple_music",
  "/calc": "calc",
  "/lists/jobs": "jobs",
  "/layouts": "layouts",
  "/reference": "reference",
  "/mail": "mail_inbox",
};

/** The module a hash path belongs to: the longest screen path it is, or is under. */
export function moduleOfScreen(path: string): string | undefined {
  let best: string | undefined;
  for (const p of Object.keys(SCREEN_MODULE)) {
    if ((path === p || path.startsWith(p + "/")) && (!best || p.length > best.length)) best = p;
  }
  return best ? SCREEN_MODULE[best] : undefined;
}
