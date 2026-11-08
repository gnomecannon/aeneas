import { useEffect, useState } from "react";
import { engine } from "../sync/engine";

/** Who the hub belongs to, and their pet: fetched once, kept for the next visit so labels show at once. */
export interface ProfileInfo { name: string; pet: string; named: boolean }

const KEY = "ea-profile";
let cached: ProfileInfo | null = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as ProfileInfo | null; } catch { return null; }
})();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function refreshProfile(): Promise<void> {
  const c = engine.client;
  if (!c) return Promise.resolve();
  loading ??= c.profile().then((p) => {
    cached = p;
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ }
    listeners.forEach((f) => f());
  }).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}

export function useProfile(): ProfileInfo | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    void refreshProfile();
    return () => { listeners.delete(f); };
  }, []);
  return cached;
}

/** How the owner shows among other people (a game's owners, the players): their name, or "Me" until it is set. */
export function ownerLabel(p: ProfileInfo | null): string {
  return p?.named && p.name.trim() ? p.name.trim() : "Me";
}

export function useOwnerName(): string {
  return ownerLabel(useProfile());
}

/** The pet's name, or "Pet" until one is set. */
export function usePetName(): string {
  return useProfile()?.pet || "Pet";
}
