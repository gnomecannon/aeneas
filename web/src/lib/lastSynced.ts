import type { PairingProblem } from "../sync/engine";

const HOUR = 3_600_000;

/**
 * "last synced 3 h ago", said once the last sync is over an hour old: a short gap is normal and the screen already
 * says the hub is unreachable. Hours until two days, then days, so a device that lost its hub long ago says so.
 * Lower case, to follow "local copy, hub unreachable"; the banner capitalizes it.
 */
export function lastSynced(at: number | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const gap = now - at;
  if (gap <= HOUR) return null;
  const hours = Math.floor(gap / HOUR);
  if (hours < 48) return `last synced ${hours} h ago`;
  return `last synced ${Math.floor(hours / 24)} days ago`;
}

/** "local copy, hub unreachable", with the last sync when that says one. */
export function unreachableLine(at: number | undefined, now = Date.now()): string {
  const last = lastSynced(at, now);
  return last ? `local copy, hub unreachable, ${last}` : "local copy, hub unreachable";
}

/** What the Pair again banner says for each problem, or null when it does not show (only pairing again helps then). */
export function pairAgainText(problem: PairingProblem | undefined, status: string): { title: string; detail: string } | null {
  if (!problem || status === "synced" || status === "setup") return null;
  return problem === "other_hub"
    ? { title: "This address leads to another hub", detail: "Nothing was sent to it." }
    : { title: "This device needs to be paired again", detail: "Your hub no longer accepts its key. Changes not sent yet stay here and go once it is paired." };
}
