/**
 * Celebration events: "create" when something is made here, "complete" when a task is done, a reminder acknowledged
 * or a procedure step finished. Fired from the local edit paths only, never for changes arriving from sync.
 * One action can pass through two paths (an ack that also writes the field), so a repeat within a moment is dropped.
 */

export type Celebration = "create" | "complete";
type Listener = (c: Celebration) => void;

const listeners = new Set<Listener>();
const last: Record<Celebration, number> = { create: 0, complete: 0 };
const QUIET_MS = 300;

export function celebrate(c: Celebration): void {
  const t = Date.now();
  if (t - last[c] < QUIET_MS) return;
  last[c] = t;
  for (const l of listeners) l(c);
}

export function onCelebrate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
