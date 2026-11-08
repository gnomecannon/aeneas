import { errCode } from "./logsafe.js";
/** Run `fn` once a day at hour:minute local time. Errors are logged, never thrown; the next run is always scheduled. */
export function scheduleDaily(label: string, hour: number, minute: number, fn: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    // A timer can fire a millisecond early (08:59:59.999 for 09:00): today's run is then the one just made, so the
    // next is tomorrow's, not another in 1 ms.
    if (next.getTime() - now.getTime() < 1000) next.setDate(next.getDate() + 1);
    timer = setTimeout(() => {
      try { fn(); } catch (e) { console.error(`[${label}] failed: ${errCode(e)}`); }
      schedule();
    }, next.getTime() - now.getTime());
    timer.unref();
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
