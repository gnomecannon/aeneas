import { BAR_LIBRARY } from "@everythingapp/shared";

/**
 * The web's side of the bottom bar (the rules are in @everythingapp/shared, `bar.ts`): which hash path a screen id
 * opens, which screens a device can show now, and which tab is lit for a route.
 */

/** The hash path of a screen id: its own name, but for the Image Gallery (`images`, at /gallery). */
export function screenPath(id: string): string {
  return id === "images" ? "/gallery" : `/${id}`;
}

/** The screen id of a path from the sidebar's lists. */
export function screenId(path: string): string {
  return path === "/gallery" ? "images" : path.replace(/^\//, "");
}

/** The main screens: the ones the Library does not list. One left out of the bar is listed at the top of the Library. */
export const MAIN_SCREENS = ["today", "assistant", "capture", "search"] as const;

/**
 * Paths that are a screen's own pages though they do not start with its path: a machine's page, the change journal and
 * snippets are the Overview's, Create image is the Image Gallery's. (An old link to Now opens Today: lib/router.ts.)
 */
export const SCREEN_ALSO: Record<string, string[]> = {
  ops: ["/hosts", "/journal", "/snippets"],
  images: ["/images"],
  library: ["/more"],
};

const under = (path: string, p: string) => path === p || path.startsWith(p + "/");

/**
 * The tab that is lit for a route: the screen the route shows when that screen has a place in the bar (the longest
 * path wins, so a list at /lists/<id> is Lists), else Library, the home of everything without a place.
 */
export function barShowing(path: string, tabs: string[]): string {
  let best: { id: string; len: number } | null = null;
  for (const id of tabs) {
    for (const p of [screenPath(id), ...(SCREEN_ALSO[id] ?? [])]) {
      if (under(path, p) && (!best || p.length > best.len)) best = { id, len: p.length };
    }
  }
  return best?.id ?? BAR_LIBRARY;
}

/**
 * The screens this device can show now, for `barLayout` and the editor's list: the main ones, Library, and what the
 * Library lists (`listed`: the paths of its areas with screens of modules that are off left out, and Status).
 */
export function barAvailable(listed: string[]): Set<string> {
  return new Set([...MAIN_SCREENS, BAR_LIBRARY, ...listed.map(screenId)]);
}

/** Where a drag on the bar leaves the second row: `reveal` of `full` pixels showing, moving at `speed` pixels a millisecond (up is positive). */
export function settlesOpen(reveal: number, full: number, speed: number): boolean {
  // A flick decides by its direction; a slow drag by whether more than half shows.
  if (Math.abs(speed) > 0.4) return speed > 0;
  return reveal > full / 2;
}
