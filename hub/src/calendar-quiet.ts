/**
 * Writes the calendar sync makes itself (calendar-sync.ts), and those Invitations makes to the events the sync keeps in
 * step: they must not start another sync, which the sync's after-write hook would otherwise do 10 seconds later.
 */
let syncing = 0;

/** True while such a write runs. */
export const syncWriting = () => syncing > 0;

/** Run a write that must not start a calendar sync. */
export function quietly<T>(f: () => T): T {
  syncing++;
  try { return f(); } finally { syncing--; }
}
