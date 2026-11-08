import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { activitySpans } from "./health.js";
import { errCode } from "./logsafe.js";

/**
 * Activity check-in. An `activity` log opens an activity; a later `activity` log with the same value and
 * `note: "end"` closes it. While one is open, every EA_FOCUS_CHECK_HOURS since its start or the last
 * check-in the hub asks whether it is still on purpose: a `notify` of kind `activity` plus an entry in
 * the log's `checkins`. Clients answer with "Still on it" (nothing to do) or "Stop" (the `end` log). One still open
 * after EA_FOCUS_MAX_HOURS was left running: the hub ends it at the first check-in.
 */

const HOUR_MS = 3600_000;

/** Every activity still open (its start log), newest first. */
export function openActivities(hub: Hub): Entity[] {
  return activitySpans(hub.store.list({ kind: "log", limit: 100000 }))
    .filter((s) => s.to === null)
    .sort((a, b) => b.from - a.from)
    .map((s) => s.start);
}

/**
 * The newest activity still open, or null. Only the newest start used to be looked at, so an activity forgotten
 * before another one that started and ended (a walk synced from the Watch) counted as open nowhere and never ended.
 */
export function openActivity(hub: Hub): Entity | null {
  return openActivities(hub)[0] ?? null;
}

function formatHours(h: number): string {
  const r = Math.round(h * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** One pass of the loop. Returns the log id when a check-in was emitted. */
export function focusTick(hub: Hub, now: Date = new Date(), checkHours: number = hub.cfg.focusCheckHours, maxHours: number = hub.cfg.focusMaxHours): string | null {
  const startOf = (l: Entity) => new Date(String(l.fields.at)).getTime();
  const open = openActivities(hub);
  // Left running: nobody pressed Stop in maxHours. It ends where the first check-in found it, so it stops asking every
  // few hours for days and a forgotten timer does not count as days of soldering. Every open one, not only the newest.
  const ended = new Set<string>();
  if (maxHours > 0) {
    for (const l of open) {
      const start = startOf(l);
      if (Number.isNaN(start) || start > now.getTime() || now.getTime() - start < maxHours * HOUR_MS) continue;
      hub.store.create("log", { type: "activity", value: l.fields.value, at: new Date(start + Math.min(checkHours, maxHours) * HOUR_MS).toISOString(), note: "end", source: "api" });
      ended.add(l.id);
    }
  }
  const log = open.find((l) => !ended.has(l.id));
  if (!log) return null;
  const start = startOf(log);
  if (Number.isNaN(start) || start > now.getTime()) return null;
  const checkins = Array.isArray(log.fields.checkins) ? (log.fields.checkins as string[]) : [];
  const last = checkins.reduce((m, c) => Math.max(m, new Date(c).getTime() || 0), start);
  if (now.getTime() - last < checkHours * HOUR_MS) return null;
  const at = now.toISOString();
  const hours = (now.getTime() - start) / HOUR_MS;
  // A normal patch so clients see checkins; one row per check-in, hours apart, is no spam.
  hub.store.patch(log.id, { checkins: [...checkins, at] });
  hub.bus.emit("notify", { id: log.id, kind: "activity", title: `On ${String(log.fields.value)} for ${formatHours(hours)} h`, at, log_id: log.id });
  return log.id;
}

/** The hub's minute loop: the focus check-in plus any other per-minute ticks (sensor staleness). Each tick catches its own errors. */
export function startFocusLoop(hub: Hub, intervalMs = 60_000, extraTicks: { label: string; tick: () => void }[] = []): () => void {
  const run = () => {
    try { focusTick(hub); } catch (e) { console.error(`[focus] tick failed: ${errCode(e)}`); }
    for (const t of extraTicks) {
      try { t.tick(); } catch (e) { console.error(`[${t.label}] tick failed: ${errCode(e)}`); }
    }
  };
  run();
  const t = setInterval(run, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
