/** Module 4 helpers: meal by time of day, meds chip merge, sensor state and tone, custody wording. */

import { localDate } from "./planner";

export type Meal = "lunch" | "dinner" | "snack";
export type SensorState = "ok" | "low" | "high" | "stale";

/** Lunch before 15:00 local, dinner after; snack only when toggled. */
export function mealForTime(d: Date, snack = false): Meal {
  if (snack) return "snack";
  return d.getHours() < 15 ? "lunch" : "dinner";
}

export interface MedChip {
  name: string;
  taken: boolean;
  /** True when the med was logged today but is not in the expected list. */
  extra: boolean;
}

/** The drug name from a logged value: "Claritin 30mg" and "claritin" both match the expected "Claritin". */
function drug(s: string): string {
  return s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * One chip per expected med, filled when a log today matches it by drug name; meds logged today that
 * are not expected are appended as extras. Order: expected first, as given.
 */
export function mergeMeds(expected: string[], today: string[]): MedChip[] {
  const exp = expected.map((e) => e.trim()).filter(Boolean);
  const takenKeys = new Set(today.map(drug).filter(Boolean));
  const out: MedChip[] = exp.map((name) => ({ name, taken: takenKeys.has(drug(name)), extra: false }));
  const known = new Set(exp.map(drug));
  const seen = new Set<string>();
  for (const t of today) {
    const k = drug(t);
    if (!k || known.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: t.trim(), taken: true, extra: true });
  }
  return out;
}

export interface SensorLike {
  last_value?: number | null;
  last_at?: string | null;
  min?: number | null;
  max?: number | null;
  stale_minutes?: number | null;
  state?: SensorState | null;
}

/** The hub's state when present, else derived: stale past stale_minutes (default 180), low under min, high over max. */
export function sensorState(s: SensorLike, now = new Date()): SensorState {
  if (s.state) return s.state;
  if (s.last_value == null || !s.last_at) return "stale";
  const ageMin = (now.getTime() - new Date(s.last_at).getTime()) / 60_000;
  if (ageMin > (s.stale_minutes ?? 180)) return "stale";
  if (s.min != null && s.last_value < s.min) return "low";
  if (s.max != null && s.last_value > s.max) return "high";
  return "ok";
}

/** CSS tone for a state chip: ok green, low and high warn, stale muted. */
export function sensorTone(state: SensorState): "ok" | "warn" | "muted" {
  if (state === "ok") return "ok";
  if (state === "stale") return "muted";
  return "warn";
}

/** "+1.2" or "-0.8" or "0.0", one decimal. */
export function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  const s = n.toFixed(1);
  return n > 0 ? `+${s}` : s;
}

/** Custody wording for the pet card. */
export function custodyLabel(withMe: boolean | null | undefined): string {
  if (withMe == null) return "Custody not set";
  return withMe ? "With you this week" : "At the other home this week";
}

/** The handoff cycle when nothing on record says otherwise (the hub's DEFAULT_CYCLE_DAYS). */
export const DEFAULT_CYCLE_DAYS = 7;

export interface Handoff { id: string; fields: Record<string, unknown> }
export interface CustodyNow { withMe: boolean; since: string; next: string; cycleDays: number; handoff: Handoff }

const addDays = (at: string, days: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), 0, 0);
};
const ownCycle = (h: Handoff): number | null => (typeof h.fields.cycle_days === "number" && h.fields.cycle_days >= 1 ? Math.round(h.fields.cycle_days) : null);
const atMs = (h: Handoff) => new Date(String(h.fields.at)).getTime();

/** The hub's `cycleIn`: its own cycle, else the nearest older handoff's, else the days since the one before (1 to 60), else the default. `all` is newest first. */
export function cycleIn(h: Handoff, all: Handoff[]): number {
  const own = ownCycle(h);
  if (own) return own;
  const t = atMs(h);
  const older = all.filter((o) => o.id !== h.id && atMs(o) < t);
  for (const o of older) { const c = ownCycle(o); if (c) return c; }
  if (older[0]) {
    const gap = Math.round((t - atMs(older[0])) / 86400000);
    if (gap >= 1 && gap <= 60) return gap;
  }
  return DEFAULT_CYCLE_DAYS;
}

/** Custody events that say where the pet went, newest first. */
export function handoffsOf(events: Handoff[]): Handoff[] {
  return events
    .filter((e) => e.fields.type === "custody" && (e.fields.with === "me" || e.fields.with === "other") && Number.isFinite(new Date(String(e.fields.at)).getTime()))
    .sort((a, b) => new Date(String(b.fields.at)).getTime() - new Date(String(a.fields.at)).getTime());
}

/**
 * The hub's `custodyOf` from handoffs, worked here so a logged handoff shows at once and offline. Past the
 * predicted handoff with nothing logged, it assumes the swap happened on schedule. Null with no handoff logged.
 */
export function custodyNow(events: Handoff[], now = new Date()): CustodyNow | null {
  const all = handoffsOf(events);
  const last = all.find((e) => new Date(String(e.fields.at)).getTime() <= now.getTime());
  if (!last) return null;
  const cycleDays = cycleIn(last, all);
  let since = String(last.fields.at);
  let withMe = last.fields.with === "me";
  let next = last.fields.next_due ? new Date(String(last.fields.next_due)) : addDays(since, cycleDays);
  while (next.getTime() <= now.getTime()) {
    since = next.toISOString();
    withMe = !withMe;
    next = addDays(since, cycleDays);
  }
  return { withMe, since, next: next.toISOString(), cycleDays, handoff: last };
}

/** The predicted handoff for a stretch that started at `at`. */
export const nextHandoffFrom = (at: string, cycleDays: number) => addDays(at, cycleDays).toISOString();

/** File name for a sensor CSV download. */
export function csvFilename(name: string, days: number, now = new Date()): string {
  return `${name}-${days}d-${localDate(now)}.csv`;
}
