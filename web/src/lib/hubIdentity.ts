import { useEffect, useState } from "react";
import { engine } from "../sync/engine";

/**
 * Which hub this device is paired with, by the name and color the hub gives itself (EA_HUB_NAME, EA_HUB_COLOR). Several
 * people can each have a hub on one machine; the color is what tells them apart at a glance, so the label shows only
 * on a hub that has one. Kept so it shows at once on the next start, before the hub answers.
 */
export interface HubIdentity { name: string | null; color: string | null }

const KEY = "ea.hubIdentity";
const listeners = new Set<(h: HubIdentity | null) => void>();

function load(): HubIdentity | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as HubIdentity | null; } catch { return null; }
}
let current: HubIdentity | null = load();

function set(next: HubIdentity | null): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try { if (next) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY); } catch { /* private window */ }
  for (const fn of listeners) fn(next);
}

/**
 * Ask the hub again (when the engine connects and when the window comes back). Kept as it was when the hub cannot be
 * reached or the engine has not started yet; cleared by `forgetHubIdentity` when the device leaves the hub.
 */
export async function refreshHubIdentity(): Promise<void> {
  const c = engine.client;
  if (!c) return;
  try {
    const h = await c.health();
    if (h.version === undefined) return; // not accepted with this key: say nothing new
    set(h.hub && (h.hub.name || h.hub.color) ? { name: h.hub.name ?? null, color: h.hub.color ?? null } : null);
  } catch { /* offline: keep what we had */ }
}

export function forgetHubIdentity(): void { set(null); }

/** Asks once each time the engine gets a hub client (start, pairing, switching hubs). */
let askedFor: unknown = null;
engine.subscribe(() => {
  if (engine.client && engine.client !== askedFor) { askedFor = engine.client; void refreshHubIdentity(); }
});

/** "Jamie's hub", or null on a hub that is not one of several (no color). */
export function hubLabel(h: HubIdentity | null): string | null {
  if (!h?.color) return null;
  return h.name ? `${h.name}’s hub` : "This hub";
}

export function useHubIdentity(): HubIdentity | null {
  const [h, setH] = useState(current);
  useEffect(() => {
    listeners.add(setH);
    return () => { listeners.delete(setH); };
  }, []);
  return h;
}

/** The hub's name and color as a small chip; nothing on a single person's hub. */
export function useHubTitle(): void {
  const h = useHubIdentity();
  const label = hubLabel(h);
  useEffect(() => {
    document.title = label && h?.name ? `Aeneas · ${h.name}` : "Aeneas";
  }, [label, h?.name]);
}
