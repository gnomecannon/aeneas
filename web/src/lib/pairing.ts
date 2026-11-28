import type { DeviceRow } from "../sync/api";

/**
 * The device that paired while a pairing code was showing: the first in the hub's list that was not there when the
 * code was made (`before`, device ids). Null until one appears. This device itself never counts.
 */
export function newlyPaired(before: ReadonlySet<string>, now: readonly DeviceRow[]): DeviceRow | null {
  return now.find((d) => !d.current && !before.has(d.id)) ?? null;
}

/** How often the list is asked for while a code shows. */
export const PAIRED_POLL_MS = 3000;
