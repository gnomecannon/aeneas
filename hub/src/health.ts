import { effectiveAt, nextOccurrence } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { atTime, startOfDay } from "./planner.js";
import { pendingReminders } from "./reminders.js";

/**
 * Module 4, body: the health summary over `log` rows and the weekly injection reminder.
 * Everything is read from logs (weight, bp, caffeine, med, mood, sleep, activity) and facts; nothing here
 * writes except the injection-day reminder.
 */

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const INJECTION_PREFIX = "Injection:";

export interface Point { at: string; value: number }
export interface HealthSummary {
  days: number;
  /** Every value in `unit`: the newest weight log's (kg, else lb). */
  weight: { latest: number | null; unit: "kg" | "lb"; at: string | null; delta_7d: number | null; delta_30d: number | null; series: Point[] };
  bp: { latest: string | null; at: string | null };
  /** Cups (95 mg each). */
  caffeine_today: number;
  meds_today: string[];
  meds_expected: string[];
  mood: { series_7d: Point[] };
  /** Minutes asleep. */
  sleep: { series_7d: Point[]; last: Point | null };
  /** Daily step totals (from Apple Health): today's, the newest day's, and the last 14 days. */
  steps: { today: number | null; latest: Point | null; series_14d: Point[] };
  activity_hours_7d: number;
  next_injection: { name: string; at: string } | null;
}

const atOf = (l: Entity) => String(l.fields.at ?? l.created_at);
const byAt = (a: Entity, b: Entity) => atOf(a).localeCompare(atOf(b));
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The facts about the owner: about nobody else (no `person_id` or `person`), or about the owner's own card (My Card) or
 * their name. Facts about other people used to count, so "Jamie takes Zoloft" became the owner's medications and Jamie's
 * doctor rules switched on doctor mode in the food picker.
 */
export function ownerFacts(hub: Hub): Entity[] {
  let owner: string | undefined;
  return hub.store.list({ kind: "fact", limit: 100000 }).filter((f) => {
    const id = String(f.fields.person_id ?? "");
    if (id) return (hub.store.get(id)?.fields.apple as { me?: boolean } | undefined)?.me === true;
    const who = String(f.fields.person ?? "").trim().toLowerCase();
    return !who || who === (owner ??= String(hub.profile.get().name ?? "").trim().toLowerCase());
  });
}

/** The owner's own fact whose `category:key` (or bare `key`) is `ref`, not deleted. */
export function factValue(hub: Hub, ref: string): string | null {
  const [cat, ...rest] = ref.split(":");
  const key = rest.join(":");
  const facts = ownerFacts(hub);
  const f = facts.find((x) => x.fields.key === ref)
    ?? facts.find((x) => x.fields.category === cat && x.fields.key === key)
    ?? facts.find((x) => String(x.fields.key).toLowerCase() === ref.toLowerCase());
  return f && typeof f.fields.value === "string" ? f.fields.value : null;
}

/**
 * `health:medications` → drug names. Split on commas; each part gives its parenthesised brand when present,
 * otherwise its first word. Deduped, order kept.
 */
export function parseMedications(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const brand = /\(([^)]+)\)/.exec(p);
    const first = p.split(/\s+/)[0].replace(/[.;:!?]+$/, "");
    const name = (brand ? brand[1] : first).trim();
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function logsOfType(logs: Entity[], type: string): Entity[] {
  return logs.filter((l) => l.fields.type === type).sort(byAt);
}

const plain = (l: Entity) => num(l.fields.value);

function series(logs: Entity[], since: Date, value: (l: Entity) => number | null = plain): Point[] {
  const out: Point[] = [];
  for (const l of logs) {
    const v = value(l);
    if (v === null || new Date(atOf(l)) < since) continue;
    out.push({ at: atOf(l), value: v });
  }
  return out;
}

/** The newest numeric log as a point, or null. */
function lastPoint(logs: Entity[], value: (l: Entity) => number | null = plain): Point | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const v = value(logs[i]);
    if (v !== null) return { at: atOf(logs[i]), value: v };
  }
  return null;
}

/** Latest minus the newest value at or before `daysAgo` days before `now`; null without a baseline. */
function delta(logs: Entity[], latest: number | null, now: Date, daysAgo: number, value: (l: Entity) => number | null = plain): number | null {
  if (latest === null) return null;
  const limit = new Date(now.getTime() - daysAgo * DAY_MS);
  const base = [...logs].reverse().find((l) => new Date(atOf(l)) <= limit);
  const bv = base ? value(base) : null;
  return bv === null ? null : round1(latest - bv);
}

// ---------- units: one per measure, whatever each log was written in ----------

export const CUP_MG = 95;
const LB_PER_KG = 2.20462;
const unitOf = (l: Entity) => String(l.fields.unit ?? "").trim().toLowerCase();
const isKg = (l: Entity) => /^(kg|kgs|kilo|kilos|kilograms?)$/.test(unitOf(l));
const inHours = (l: Entity) => /^(h|hr|hrs|hour|hours)$/.test(unitOf(l));

/**
 * Caffeine in cups, the app's unit (its +1 is a cup, and the iPhone turns Health's milligrams into cups of 95 mg and
 * back). A log in mg is turned into cups; no value is one cup. Milligrams and cups used to be added as one number.
 */
export function caffeineCups(l: Entity): number {
  const v = num(l.fields.value);
  if (v === null) return 1;
  return isMg(l.fields.unit) ? v / CUP_MG : v;
}

const isMg = (unit: unknown) => /^(mg|milligrams?)$/.test(String(unit ?? "").trim().toLowerCase());

/**
 * A new log in the app's units: caffeine in mg becomes cups (two decimals), since the iPhone writes each caffeine log
 * to Health as cups times 95 mg (a 200 mg log reached Health as 19,000 mg). Everything else is kept as given.
 */
export function inAppUnits(fields: Record<string, unknown>): Record<string, unknown> {
  const v = num(fields.value);
  if (fields.type !== "caffeine" || v === null || !isMg(fields.unit)) return fields;
  return { ...fields, value: Math.round((v / CUP_MG) * 100) / 100, unit: "cups" };
}

/** Once at start: caffeine logs kept in mg become cups, so every device and Health read one unit. Returns how many. */
export function migrateCaffeineToCups(store: Hub["store"]): number {
  let n = 0;
  for (const l of store.list({ kind: "log", where: { type: "caffeine" }, limit: 1_000_000 })) {
    const next = inAppUnits(l.fields);
    if (next === l.fields) continue;
    store.patch(l.id, { value: next.value, unit: next.unit });
    n++;
  }
  return n;
}

/** Sleep in minutes, as Apple Health sends it; a log whose unit says hours is turned into minutes. */
export function sleepMinutes(l: Entity): number | null {
  const v = num(l.fields.value);
  return v === null ? null : inHours(l) ? v * 60 : v;
}

/** The unit weights are shown in: the newest weight log's (kg, else lb). */
export function weightUnit(weights: Entity[]): "kg" | "lb" {
  const newest = [...weights].sort(byAt).pop();
  return newest && isKg(newest) ? "kg" : "lb";
}

/** A weight log in `unit` (a log without a unit is in lb). Logs in kg and lb used to be compared and averaged as is. */
export function weightIn(l: Entity, unit: "kg" | "lb"): number | null {
  const v = num(l.fields.value);
  if (v === null) return null;
  const kg = isKg(l);
  if (kg === (unit === "kg")) return v;
  return round1(kg ? v * LB_PER_KG : v / LB_PER_KG);
}

// ---------- activity ----------

export interface ActivitySpan { start: Entity; value: string; from: number; to: number | null }
const isEnd = (l: Entity) => String(l.fields.note ?? "").trim().toLowerCase() === "end";

/**
 * Activity sessions, oldest first: an activity log opens one for its value and the next `end` log with that value
 * closes it (`to` null while open). Another start of the same activity while it is open is the same session (Start
 * pressed twice, or the owner saying it again); each start used to run to the first end after it, so two starts and one
 * end counted the overlap twice. An end with nothing open is ignored.
 */
export function activitySpans(logs: Entity[]): ActivitySpan[] {
  const time = (l: Entity) => new Date(atOf(l)).getTime();
  const acts = logs.filter((l) => l.fields.type === "activity" && Number.isFinite(time(l)))
    // At the same moment a start comes first, so an end at the start's own time still closes it.
    .sort((a, b) => time(a) - time(b) || Number(isEnd(a)) - Number(isEnd(b)));
  const open = new Map<string, ActivitySpan>();
  const out: ActivitySpan[] = [];
  for (const l of acts) {
    const value = String(l.fields.value);
    if (isEnd(l)) {
      const s = open.get(value);
      if (s) { s.to = time(l); open.delete(value); }
      continue;
    }
    if (open.has(value)) continue;
    const s: ActivitySpan = { start: l, value, from: time(l), to: null };
    open.set(value, s);
    out.push(s);
  }
  return out;
}

/** Hours of activity in the window: each session until its end, an open one until now. */
export function activityHours(logs: Entity[], since: Date, now: Date): number {
  let ms = 0;
  for (const a of activitySpans(logs)) {
    if (a.from > now.getTime()) continue;
    const s = Math.max(a.from, since.getTime());
    const e = Math.min(a.to ?? now.getTime(), now.getTime());
    if (e > s) ms += e - s;
  }
  return round1(ms / HOUR_MS);
}

/** The earliest pending reminder titled `Injection: <name>`. */
export function nextInjection(hub: Hub): { name: string; at: string } | null {
  const rows = pendingReminders(hub.store)
    .filter(({ t }) => String(t.fields.title ?? "").startsWith(INJECTION_PREFIX))
    .map(({ t, eff }) => ({ name: String(t.fields.title).slice(INJECTION_PREFIX.length).trim(), at: eff }));
  return rows[0] ?? null;
}

export function healthSummary(hub: Hub, days = 30, now: Date = new Date()): HealthSummary {
  const logs = hub.store.list({ kind: "log", limit: 100000 }).filter((l) => !Number.isNaN(new Date(atOf(l)).getTime()));
  const since = new Date(now.getTime() - days * DAY_MS);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const isToday = (l: Entity) => { const d = new Date(atOf(l)); return d >= today && d < tomorrow; };

  const weights = logsOfType(logs, "weight").filter((l) => num(l.fields.value) !== null);
  const unit = weightUnit(weights);
  const kgOrLb = (l: Entity) => weightIn(l, unit);
  const lastW = weights[weights.length - 1];
  const latestW = lastW ? kgOrLb(lastW) : null;
  const bps = logsOfType(logs, "bp");
  const lastBp = bps[bps.length - 1];
  const caffeine = logsOfType(logs, "caffeine").filter(isToday).reduce((n, l) => n + caffeineCups(l), 0);
  const meds = logsOfType(logs, "med").filter(isToday).map((l) => String(l.fields.value ?? "")).filter(Boolean);
  const sleeps = logsOfType(logs, "sleep");

  return {
    days,
    weight: {
      latest: latestW,
      unit,
      at: lastW ? atOf(lastW) : null,
      delta_7d: delta(weights, latestW, now, 7, kgOrLb),
      delta_30d: delta(weights, latestW, now, 30, kgOrLb),
      series: series(weights, since, kgOrLb),
    },
    bp: { latest: lastBp ? String(lastBp.fields.value) : null, at: lastBp ? atOf(lastBp) : null },
    caffeine_today: round1(caffeine),
    meds_today: meds,
    meds_expected: parseMedications(factValue(hub, "health:medications")),
    mood: { series_7d: series(logsOfType(logs, "mood"), week) },
    sleep: { series_7d: series(sleeps, week, sleepMinutes), last: lastPoint(sleeps, sleepMinutes) },
    steps: {
      today: num(logsOfType(logs, "steps").filter(isToday).pop()?.fields.value),
      latest: lastPoint(logsOfType(logs, "steps")),
      series_14d: series(logsOfType(logs, "steps"), new Date(now.getTime() - 14 * DAY_MS)),
    },
    activity_hours_7d: activityHours(logs, week, now),
    next_injection: nextInjection(hub),
  };
}

export function parseDays(raw: string | undefined, dflt: number, max = 365): number {
  if (raw === undefined || raw === "") return dflt;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) throw new StoreError(400, `days must be an integer from 1 to ${max}`);
  return n;
}

/** The next `weekday` at `hhmm` local, strictly after `now`. */
export function nextWeekdayAt(weekday: string, hhmm: string, now: Date): Date {
  const want = WEEKDAYS.indexOf(weekday);
  const day = startOfDay(now);
  for (let i = 0; i < 8; i++) {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    if (d.getDay() !== want) continue;
    const at = atTime(d, hhmm);
    if (at > now) return at;
  }
  return atTime(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7), hhmm);
}

/**
 * Create or update the weekly reminder `Injection: <name>` (matched by title, ignoring case and spacing, so repeated
 * calls move the one reminder instead of adding another; "B12" then "b12" used to make two weekly
 * reminders). Friction `reason`: skipping a dose needs a typed reason.
 */
export function setInjectionDay(hub: Hub, body: { name?: unknown; weekday?: unknown; time?: unknown }, now: Date = new Date()): { reminder: Entity; created: boolean } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new StoreError(422, "name required");
  const weekday = typeof body.weekday === "string" ? body.weekday.trim().toLowerCase().slice(0, 3) : "";
  if (!WEEKDAYS.includes(weekday)) throw new StoreError(422, "weekday must be mon..sun");
  const time = typeof body.time === "string" ? body.time.trim() : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new StoreError(422, "time must be HH:MM");
  const title = `${INJECTION_PREFIX} ${name}`;
  const repeat = `every 1 weeks on ${weekday}`;
  let at = nextWeekdayAt(weekday, time, now).toISOString();
  // nextOccurrence is the authority on repeats; keep `at` on the rule's own grid.
  const check = nextOccurrence(at, repeat, new Date(new Date(at).getTime() - 1000));
  if (check) at = check;
  const want: Record<string, unknown> = { title, remind_at: at, repeat, friction: "reason" };
  const same = (t: unknown) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const existing = hub.store.list({ kind: "task", limit: 100000 })
    .filter((r) => same(r.fields.title) === same(title))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!existing) return { reminder: hub.store.create("task", { ...want, status: "scheduled", order: Date.now() }), created: true };
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want)) if (existing.fields[k] !== v) diff[k] = v;
  if (diff.remind_at !== undefined) { diff.snoozed_until = null; if (existing.fields.status === "done") diff.status = "scheduled"; }
  const reminder = Object.keys(diff).length ? hub.store.patch(existing.id, diff) : existing;
  return { reminder, created: false };
}
