/**
 * Service worker registration, update flow and the install prompt.
 * Registered only in production builds and never under Tauri (the shell loads from its own origin).
 */
import { isTauri } from "./tauri/bridge";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaState {
  supported: boolean;
  registered: boolean;
  updateReady: boolean;
  canInstall: boolean;
  standalone: boolean;
  error?: string;
}

type Listener = (s: PwaState) => void;

const listeners = new Set<Listener>();
let registration: ServiceWorkerRegistration | null = null;
let waiting: ServiceWorker | null = null;
let installEvent: BeforeInstallPromptEvent | null = null;
let askedForReload = false;
let state: PwaState = {
  supported: typeof navigator !== "undefined" && "serviceWorker" in navigator && !isTauri,
  registered: false,
  updateReady: false,
  canInstall: false,
  standalone: isStandalone(),
};

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function set(partial: Partial<PwaState>) {
  state = { ...state, ...partial };
  for (const l of listeners) l(state);
}

export function pwaState(): PwaState {
  return state;
}

export function subscribePwa(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/** Call once, before render, so an early beforeinstallprompt is not missed. */
export function initPwa(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    set({ canInstall: false, standalone: isStandalone() });
  });
  if (!state.supported || !import.meta.env.PROD) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!askedForReload) return;
    askedForReload = false;
    window.location.reload();
  });
  void register();
}

async function register(): Promise<void> {
  try {
    // Relative to the document, so under https://hub/app/ this is /app/sw.js with scope /app/.
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    registration = reg;
    set({ registered: true });
    if (reg.waiting && navigator.serviceWorker.controller) {
      waiting = reg.waiting;
      set({ updateReady: true });
    }
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          waiting = reg.waiting ?? sw;
          set({ updateReady: true });
        }
      });
    });
    // Look for a newer shell when the tab comes back and once an hour while it stays open.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void reg.update().catch(() => {});
    });
    setInterval(() => void reg.update().catch(() => {}), 60 * 60_000);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

export async function checkForUpdate(): Promise<void> {
  await registration?.update();
}

/** Tell the waiting worker to take over; the page reloads on controllerchange. */
export function applyUpdate(): void {
  if (!waiting) return;
  askedForReload = true;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

export function dismissUpdate(): void {
  set({ updateReady: false });
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!installEvent) return "unavailable";
  const ev = installEvent;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  if (outcome === "accepted") {
    installEvent = null;
    set({ canInstall: false });
  }
  return outcome;
}

/** Asks the active worker for its shell version; null when none controls the page. */
export async function shellVersion(): Promise<{ version: string; precache: number } | null> {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data as { version: string; precache: number });
    };
    ctl.postMessage({ type: "VERSION" }, [ch.port2]);
  });
}

/** Fetches the manifest the page links to and summarises it, for the Settings check. */
export async function manifestCheck(): Promise<{ ok: boolean; detail: string }> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return { ok: false, detail: "no manifest link" };
  try {
    const res = await fetch(link.href, { cache: "no-store" });
    if (!res.ok) return { ok: false, detail: `${res.status} for ${link.href}` };
    const m = (await res.json()) as { name?: string; start_url?: string; display?: string; icons?: unknown[] };
    return { ok: true, detail: `${m.name ?? "unnamed"}, ${m.display ?? "browser"}, start ${m.start_url ?? "?"}, ${m.icons?.length ?? 0} icons` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
