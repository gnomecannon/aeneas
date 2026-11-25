import { useEffect, useState } from "react";

/** The screen the app opens on. */
export const START = "/today";

export interface Route {
  path: string;
  parts: string[];
  params: URLSearchParams;
}

/** The route a location hash names ("#/notes/abc?x=1"). */
export function routeOf(hash: string): Route {
  const raw = hash.replace(/^#/, "") || START;
  const [p, q = ""] = raw.split("?");
  const typed = p.startsWith("/") ? p : "/" + p;
  // The Now screen went on 2026-11-25 (Today's top line, the Next line, says it): an old link or bookmark opens Today.
  const path = typed === "/now" || typed.startsWith("/now/") ? START : typed;
  return { path, parts: path.split("/").filter(Boolean), params: new URLSearchParams(q) };
}

function parse(): Route {
  return routeOf(window.location.hash);
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parse());
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export function go(path: string): void {
  window.location.hash = path;
}

/**
 * Go to a screen in place of the current one, for a redirect: with `go` the page that redirects stays in the history,
 * and Back lands on it and is sent forward again (Android's Back could not leave the Assistant).
 */
export function replace(path: string): void {
  window.location.replace(`#${path}`);
}

/** A pairing link's route (`/setup?hub=&code=`), or the setup screen itself. */
const isSetup = (path: string) => path === "/setup" || path.startsWith("/setup?");
/** A new device's join code (`/join?node=&s=...`), opened on a paired phone. */
const isJoin = (path: string) => path === "/join" || path.startsWith("/join?");

/**
 * The screen to show once this device is paired, or once the person keeps the hub it has: where they were. Setup shows
 * in place of any screen on a device with no hub, so that screen stays; a pairing link that opened in the middle of
 * something (a QR code scanned while the app was open, a link pasted into the address bar) goes back to the screen
 * before it; a link that started the app goes to the start screen. Never the link itself, which holds the code.
 */
export function afterPairing(current: string, before: string | null): string {
  // A join code that opened an app with no hub showed Setup in its place; it was meant for a paired device.
  if (!isSetup(current) && !isJoin(current)) return current || START;
  return before && !isSetup(before) && !isJoin(before) ? before : START;
}

/** The screen before the latest pairing link or join code, from the hash change that brought it in. */
let beforeLink: string | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", (e) => {
    const hash = (url: string) => { try { return new URL(url).hash.replace(/^#/, ""); } catch { return ""; } };
    const to = hash(e.newURL);
    const from = hash(e.oldURL);
    if ((isSetup(to) || isJoin(to)) && !isSetup(from) && !isJoin(from)) beforeLink = from || null;
  });
}

/**
 * Leave the setup screen, or a join code's screen, for `afterPairing`'s screen, replacing the link in the history: a
 * join code holds the new device's secret.
 */
export function leaveSetup(): void {
  replace(afterPairing(window.location.hash.replace(/^#/, ""), beforeLink));
}
