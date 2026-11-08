import { datePhrase, datesSoon, peopleInPlans, plansToday, taskAlertAt, type PersonDate, type PersonToday } from "@everythingapp/shared";
import { pendingReminders } from "./reminders.js";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { dayKey } from "./metrics.js";
import { scheduleDaily } from "./schedule.js";

/**
 * Module 1: days and tasks. The week model is built in local time (the process TZ is EA_TZ):
 * a day window from EA_DAY_START to EA_DAY_END, minus plan_rule blackouts and commitments,
 * minus task blocks and events, leaves the free slots a 3 to 4 hour block can go into.
 */

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Interval { start: Date; end: Date }
export interface Block { task_id: string; title: string; start: string; end: string; status: string }
export interface Commitment { rule_id: string; title: string; start: string; end: string; type: string }
export interface FreeSlot { start: string; end: string; hours: number; preferred?: boolean }
export interface PlannerDay {
  date: string;
  blocks: Block[];
  events: Entity[];
  commitments: Commitment[];
  /** Preferences overlapping the day. They never remove time; matching free slots carry `preferred: true`. */
  preferences: Commitment[];
  reminders: Entity[];
  watches_due: Entity[];
  free_slots: FreeSlot[];
}
export interface PlannerWeek { start: string; min_hours: number; days: PlannerDay[] }

export type Conflict =
  | { type: "block"; task_id: string; title: string; start: string; end: string }
  | { type: "blackout" | "commitment"; rule_id: string; title: string; start: string; end: string }
  | { type: "event"; event_id: string; title: string; start: string; end: string };

// ---------- local-time helpers ----------

/** Local midnight for a YYYY-MM-DD string. Throws 400 on anything else. */
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new StoreError(400, "date must be YYYY-MM-DD");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime()) || dayKey(d) !== s) throw new StoreError(400, "date must be a real calendar day");
  return d;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A `due` or similar value as a moment: a date-only string is local midnight, anything else parses as ISO. */
export function localDateOf(value: unknown): Date {
  const s = String(value ?? "");
  if (DATE_ONLY.test(s)) { try { return parseLocalDate(s); } catch { return new Date(NaN); } }
  return new Date(s);
}

/** Local midnight of the given moment. */
export function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }

/** `day` (local midnight) plus an HH:MM wall-clock time; `24:00` is the next midnight. */
export function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/** Local midnight of the Monday on or before `d`. */
export function mondayOf(d: Date): Date {
  const day = startOfDay(d);
  const back = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back, 0, 0, 0, 0);
}

function addDays(day: Date, n: number): Date { return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n, 0, 0, 0, 0); }

/** A time as the apps show it ("3:00 PM"): the digest is read on screens and in notifications, and the assistant
 * copied its 24 hour times into replies. */
const clockOf = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
const hoursOf = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / HOUR_MS) * 100) / 100;
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

// ---------- rules ----------

/** Does an alternating rule apply on the week whose Monday is `monday`? Even weeks from the anchor's Monday do. */
export function ruleAppliesOnWeek(rule: Entity, monday: Date): boolean {
  const anchor = rule.fields.alternating_anchor;
  if (typeof anchor !== "string") return true;
  let anchorMonday: Date;
  try { anchorMonday = mondayOf(parseLocalDate(anchor)); } catch { return true; }
  const weeks = Math.round((monday.getTime() - anchorMonday.getTime()) / (7 * DAY_MS));
  return weeks % 2 === 0;
}

function activeRules(hub: Hub): Entity[] {
  return hub.store.list({ kind: "plan_rule", limit: 10000 }).filter((r) => r.fields.active !== false);
}

/** The intervals the active rules of one type produce on `day` (local midnight). */
function ruleIntervals(rules: Entity[], day: Date, types: Set<string>): (Commitment & Interval)[] {
  const name = WEEKDAYS[day.getDay()];
  const monday = mondayOf(day);
  const out: (Commitment & Interval)[] = [];
  for (const r of rules) {
    const f = r.fields as { type: string; days?: string[]; start?: string; end?: string; title?: string };
    if (!types.has(f.type) || !Array.isArray(f.days) || !f.days.includes(name)) continue;
    if (typeof f.start !== "string" || typeof f.end !== "string") continue;
    if (!ruleAppliesOnWeek(r, monday)) continue;
    const start = atTime(day, f.start);
    const end = atTime(day, f.end);
    if (end <= start) continue;
    out.push({ rule_id: r.id, title: String(f.title ?? ""), type: f.type, start, end } as Commitment & Interval);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const toCommitment = (c: Commitment & Interval): Commitment => ({ rule_id: c.rule_id, title: c.title, start: c.start.toISOString(), end: c.end.toISOString(), type: c.type });

// ---------- blocks, events, free slots ----------

/** Tasks that still hold a block: not deleted, not done. */
export function blockedTasks(hub: Hub): (Entity & { block: Interval })[] {
  const out: (Entity & { block: Interval })[] = [];
  for (const t of hub.store.list({ kind: "task", limit: 100000 })) {
    const b = t.fields.block as { start?: string; end?: string } | undefined;
    if (!b || typeof b.start !== "string" || typeof b.end !== "string" || t.fields.status === "done") continue;
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    out.push(Object.assign({}, t, { block: { start, end } }));
  }
  return out;
}

/**
 * When an event happens. An all-day event's days are the date parts of start and end (end exclusive), whatever
 * offset they were written with, so its span runs local midnight to local midnight: read as UTC instants, a
 * Saturday plan also showed on Friday evening west of UTC.
 */
export function eventSpan(e: Entity): Interval | null {
  if (e.fields.all_day === true) {
    const day = (v: unknown) => /^\d{4}-\d{2}-\d{2}/.test(String(v ?? "")) ? String(v).slice(0, 10) : null;
    const a = day(e.fields.start);
    if (!a) return null;
    const b = day(e.fields.end);
    const start = new Date(`${a}T00:00:00`);
    let end = b ? new Date(`${b}T00:00:00`) : start;
    if (end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { start, end };
  }
  const s = new Date(String(e.fields.start ?? ""));
  const en = new Date(String(e.fields.end ?? ""));
  if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime()) || en <= s) return null;
  return { start: s, end: en };
}

function eventsOn(hub: Hub, day: Interval): (Entity & { span: Interval })[] {
  const out: (Entity & { span: Interval })[] = [];
  for (const e of hub.store.list({ kind: "event", limit: 100000 })) {
    const span = eventSpan(e);
    if (span && overlaps(span, day)) out.push(Object.assign({}, e, { span }));
  }
  return out.sort((a, b) => a.span.start.getTime() - b.span.start.getTime());
}

/** Subtract busy intervals from a window. Returns the gaps, in order. */
export function subtract(window: Interval, busy: Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const b of [...busy].sort((a, c) => a.start.getTime() - c.start.getTime())) {
    if (b.end <= cursor || b.start >= window.end) continue;
    if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

/**
 * Turn the gaps into slots of at least `minHours`. Preferences cut a gap at their edges so a preferred stretch
 * is its own slot; pieces too short to hold a block are merged back into a neighbour (so a slot that overlaps
 * a preference at all is `preferred`). Anything still under `minHours` is dropped.
 */
export function freeSlots(gaps: Interval[], preferences: Interval[], minHours: number): FreeSlot[] {
  const out: FreeSlot[] = [];
  const minMs = minHours * HOUR_MS;
  for (const gap of gaps) {
    const cuts = new Set<number>([gap.start.getTime(), gap.end.getTime()]);
    for (const p of preferences) {
      if (p.start > gap.start && p.start < gap.end) cuts.add(p.start.getTime());
      if (p.end > gap.start && p.end < gap.end) cuts.add(p.end.getTime());
    }
    const edges = [...cuts].sort((a, b) => a - b);
    const pieces: { start: number; end: number; preferred: boolean }[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const piece = { start: new Date(edges[i]), end: new Date(edges[i + 1]) };
      pieces.push({ start: edges[i], end: edges[i + 1], preferred: preferences.some((p) => overlaps(p, piece)) });
    }
    for (;;) {
      const i = pieces.findIndex((p) => p.end - p.start < minMs);
      if (i < 0 || pieces.length < 2) break;
      const j = i > 0 ? i - 1 : i + 1;
      const merged = { start: Math.min(pieces[i].start, pieces[j].start), end: Math.max(pieces[i].end, pieces[j].end), preferred: pieces[i].preferred || pieces[j].preferred };
      pieces.splice(Math.min(i, j), 2, merged);
    }
    for (const p of pieces) {
      if (p.end - p.start < minMs) continue;
      const s = new Date(p.start);
      const e = new Date(p.end);
      out.push({ start: s.toISOString(), end: e.toISOString(), hours: hoursOf(s, e), ...(p.preferred ? { preferred: true } : {}) });
    }
  }
  return out;
}

// ---------- the week ----------

export interface DayInputs {
  rules: Entity[];
  tasks: (Entity & { block: Interval })[];
  reminders: Entity[];
  watches: Entity[];
}

function collect(hub: Hub): DayInputs {
  return {
    rules: activeRules(hub),
    tasks: blockedTasks(hub),
    reminders: pendingReminders(hub.store).map((p) => p.t),
    watches: hub.modules.on("renewals") ? hub.store.list({ kind: "watch", limit: 100000 }).filter((w) => typeof w.fields.due === "string") : [],
  };
}

/** One local day of the planner view. `day` is local midnight. */
export function dayModel(hub: Hub, day: Date, minHours: number, inputs: DayInputs = collect(hub)): PlannerDay {
  const whole: Interval = { start: day, end: addDays(day, 1) };
  const window: Interval = { start: atTime(day, hub.cfg.dayStart), end: atTime(day, hub.cfg.dayEnd) };
  const fixed = ruleIntervals(inputs.rules, day, new Set(["blackout", "commitment"]));
  const prefs = ruleIntervals(inputs.rules, day, new Set(["preference"]));
  // Info rules (a custody week) take no time and weigh no slot; they are sent for the clients to show.
  const infos = ruleIntervals(inputs.rules, day, new Set(["info"]));
  const blocks = inputs.tasks.filter((t) => overlaps(t.block, whole)).sort((a, b) => a.block.start.getTime() - b.block.start.getTime());
  const events = eventsOn(hub, whole);
  // All-day events (holidays, birthdays, trips marked on a calendar) are markers, as calendars treat them: they do
  // not take the day's free time. A day off work is a plan rule.
  const busy: Interval[] = [...fixed, ...blocks.map((t) => t.block), ...events.filter((e) => e.fields.all_day !== true).map((e) => e.span)];
  const slots = window.end > window.start ? freeSlots(subtract(window, busy), prefs, minHours) : [];
  const dayIso = { start: whole.start.toISOString(), end: whole.end.toISOString() };
  const reminders = inputs.reminders
    .map((r) => ({ r, eff: taskAlertAt(r.fields) ?? "" }))
    .filter(({ eff }) => eff >= dayIso.start && eff < dayIso.end)
    .sort((a, b) => a.eff.localeCompare(b.eff))
    .map(({ r }) => r);
  const watches_due = inputs.watches
    .filter((w) => { const d = localDateOf(w.fields.due); return !Number.isNaN(d.getTime()) && dayKey(d) === dayKey(day); })
    .sort((a, b) => String(a.fields.due).localeCompare(String(b.fields.due)));
  return {
    date: dayKey(day),
    blocks: blocks.map((t) => ({ task_id: t.id, title: String(t.fields.title ?? ""), start: t.block.start.toISOString(), end: t.block.end.toISOString(), status: String(t.fields.status ?? ""), ...(t.space === "work" ? { work: true } : {}) })),
    events: events.map(({ span: _span, ...e }) => e as Entity),
    commitments: fixed.map(toCommitment),
    preferences: [...prefs, ...infos].map(toCommitment),
    reminders,
    watches_due,
    free_slots: slots,
  };
}

/** Seven days from `start` (local midnight; default the current week's Monday). */
export function weekModel(hub: Hub, start?: Date, minHours = 3, now: Date = new Date()): PlannerWeek {
  const first = start ?? mondayOf(now);
  const inputs = collect(hub);
  const days: PlannerDay[] = [];
  for (let i = 0; i < 7; i++) days.push(dayModel(hub, addDays(first, i), minHours, inputs));
  return { start: dayKey(first), min_hours: minHours, days };
}

export function parseMinHours(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24) throw new StoreError(400, "min_hours must be a number from 0 to 24");
  return n;
}

// ---------- schedule and unschedule ----------

/** The first fixed thing a block from `start` to `end` would land on, or null. */
export function findConflict(hub: Hub, taskId: string, span: Interval): Conflict | null {
  for (const t of blockedTasks(hub)) {
    if (t.id === taskId || !overlaps(t.block, span)) continue;
    return { type: "block", task_id: t.id, title: String(t.fields.title ?? ""), start: t.block.start.toISOString(), end: t.block.end.toISOString() };
  }
  const rules = activeRules(hub);
  for (let day = startOfDay(span.start); day < span.end; day = addDays(day, 1)) {
    for (const c of ruleIntervals(rules, day, new Set(["blackout", "commitment"]))) {
      if (!overlaps(c, span)) continue;
      return { type: c.type as "blackout" | "commitment", rule_id: c.rule_id, title: c.title, start: c.start.toISOString(), end: c.end.toISOString() };
    }
  }
  // All-day markers do not clash, matching free time.
  for (const e of eventsOn(hub, span).filter((x) => x.fields.all_day !== true)) {
    return { type: "event", event_id: e.id, title: String(e.fields.title ?? ""), start: e.span.start.toISOString(), end: e.span.end.toISOString() };
  }
  return null;
}

export interface ScheduleRequest { task_id?: unknown; start?: unknown; hours?: unknown; force?: unknown }

/** Place a task block. 409 `{ error: "conflict", conflict }` unless `force`. */
export function scheduleTask(hub: Hub, body: ScheduleRequest): Entity {
  const taskId = typeof body.task_id === "string" ? body.task_id : "";
  if (!taskId) throw new StoreError(422, "task_id required");
  const task = hub.store.get(taskId);
  if (!task || task.kind !== "task" || task.deleted_at) throw new StoreError(404, "task not found");
  if (typeof body.start !== "string" || Number.isNaN(new Date(body.start).getTime())) throw new StoreError(422, "start must be an ISO datetime");
  const hours = body.hours === undefined ? 3 : Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new StoreError(422, "hours must be a number from 0 to 24");
  const start = new Date(body.start);
  const end = new Date(start.getTime() + hours * HOUR_MS);
  if (!body.force) {
    const conflict = findConflict(hub, taskId, { start, end });
    if (conflict) throw new StoreError(409, "conflict", undefined, { conflict });
  }
  const status = task.fields.status === "doing" ? "doing" : "scheduled";
  return hub.store.patch(taskId, { block: { start: start.toISOString(), end: end.toISOString() }, status });
}

/** Clear a task's block. Status goes back to `next` unless the task is done or doing. */
export function unscheduleTask(hub: Hub, body: { task_id?: unknown }): Entity {
  const taskId = typeof body.task_id === "string" ? body.task_id : "";
  if (!taskId) throw new StoreError(422, "task_id required");
  const task = hub.store.get(taskId);
  if (!task || task.kind !== "task" || task.deleted_at) throw new StoreError(404, "task not found");
  const keep = task.fields.status === "done" || task.fields.status === "doing";
  return hub.store.patch(taskId, { block: null, ...(keep ? {} : { status: "next" }) });
}

// ---------- today and the digest ----------

export interface TodayView {
  date: string;
  now: Entity | null;
  next: Entity[];
  blocks: Block[];
  events: Entity[];
  commitments: Commitment[];
  /** Preference and info rules for today: shown on the timeline, never blocking time. */
  preferences: Commitment[];
  reminders_due: Entity[];
  watches_due_soon: Entity[];
  dates_soon: PersonDate[];
  people_today: PersonToday[];
  captures_unprocessed: number;
  free_slots: FreeSlot[];
  digest: string;
}

/** Watches whose due is inside their own lead window (or already past). */
export function watchesDueSoon(hub: Hub, now: Date): Entity[] {
  if (!hub.modules.on("renewals")) return [];
  return hub.store.list({ kind: "watch", limit: 100000 })
    .filter((w) => {
      const due = localDateOf(w.fields.due);
      if (Number.isNaN(due.getTime())) return false;
      const lead = Number.isFinite(Number(w.fields.lead_days)) ? Number(w.fields.lead_days) : 7;
      // A one-time renewal marked renewed while this due date was coming up is done (a passport renewed in time).
      const renewed = typeof w.fields.renewed_at === "string" ? Date.parse(w.fields.renewed_at) : NaN;
      if (!w.fields.repeat && Number.isFinite(renewed) && renewed >= due.getTime() - (lead + 30) * DAY_MS) return false;
      return due.getTime() - lead * DAY_MS <= now.getTime();
    })
    .sort((a, b) => String(a.fields.due).localeCompare(String(b.fields.due)));
}

export function todayView(hub: Hub, now: Date = new Date(), minHours = 3): TodayView {
  const day = startOfDay(now);
  const model = dayModel(hub, day, minHours);
  const tasks = hub.store.list({ kind: "task", limit: 100000 });
  const byOrder = (a: Entity, b: Entity) => Number(a.fields.order ?? 0) - Number(b.fields.order ?? 0) || a.created_at.localeCompare(b.created_at);
  const doing = tasks.filter((t) => t.fields.status === "doing").sort(byOrder);
  const nextTasks = tasks.filter((t) => t.fields.status === "next").sort(byOrder);
  const current = doing[0] ?? nextTasks[0] ?? null;
  const next = nextTasks.filter((t) => t.id !== current?.id).slice(0, 10);

  const endOfDay = addDays(day, 1).toISOString();
  const reminders_due = pendingReminders(hub.store).filter(({ eff }) => eff < endOfDay).map(({ t }) => t);
  const watches_due_soon = watchesDueSoon(hub, now);
  const captures_unprocessed = hub.store.list({ kind: "capture", limit: 100000 }).filter((c) => c.fields.processed !== true).length;

  // Only the part of today that is still ahead can take a block.
  const minMs = minHours * HOUR_MS;
  const free_slots = model.free_slots
    .map((s) => (new Date(s.start) < now ? { ...s, start: now.toISOString(), hours: hoursOf(now, new Date(s.end)) } : s))
    .filter((s) => new Date(s.end).getTime() - new Date(s.start).getTime() >= minMs);

  const lines: string[] = [];
  lines.push(current ? `Now: ${String(current.fields.title ?? "")}` : "Nothing queued");
  // All-day plans are how most plans are saved ("Tonight: dinner at Luigi's with Jamie"), so they lead.
  const plans = model.events.filter((e) => e.fields.all_day === true);
  if (plans.length) lines.push(`Plans: ${plans.slice(0, 3).map((e) => String(e.fields.title ?? "")).join("; ")}${plans.length > 3 ? ", ..." : ""}`);
  const timed = model.events.filter((e) => e.fields.all_day !== true && new Date(String(e.fields.end ?? "")) > now);
  if (timed.length) lines.push(`Calendar: ${timed.slice(0, 4).map((e) => `${clockOf(new Date(String(e.fields.start)))} ${String(e.fields.title ?? "")}`).join("; ")}${timed.length > 4 ? ", ..." : ""}`);
  if (model.blocks.length) lines.push(`Blocks: ${model.blocks.map((b) => `${clockOf(new Date(b.start))} to ${clockOf(new Date(b.end))} ${b.title}`).join("; ")}`);
  const due: string[] = [];
  // Only what the owner has to renew is due; autopay renewals are charges coming, said apart with their amounts.
  const toRenew = watches_due_soon.filter((w) => w.fields.autopay !== true);
  // A renewal's own reminder says the same as "renew X by": each renewal is named once.
  const renewing = new Set(toRenew.map((w) => w.id));
  const reminders = reminders_due.filter((r) => !renewing.has(String(r.fields.linked_id ?? "")));
  if (reminders.length) due.push(`${reminders.length} reminder${reminders.length === 1 ? "" : "s"}: ${reminders.slice(0, 3).map((r) => String(r.fields.title ?? "")).join(", ")}${reminders.length > 3 ? ", ..." : ""}`);
  const charges = watches_due_soon.filter((w) => w.fields.autopay === true);
  if (toRenew.length) due.push(`renew ${toRenew.slice(0, 3).map((w) => `${String(w.fields.title ?? "")} by ${dayKey(localDateOf(w.fields.due))}`).join(", ")}${toRenew.length > 3 ? ", ..." : ""}`);
  if (due.length) lines.push(`Due: ${due.join("; ")}`);
  // What went wrong while no app was open to hear it: a down monitor or an out of range sensor notifies once, over
  // the live stream only, so the morning digest says it again.
  const ops = opsLine(hub);
  if (ops) lines.push(ops);
  if (charges.length) lines.push(`Charges: ${charges.slice(0, 4).map((w) => `${String(w.fields.title ?? "")}${typeof w.fields.cost === "number" ? ` $${w.fields.cost.toFixed(2)}` : ""} on ${dayKey(localDateOf(w.fields.due))}`).join(", ")}${charges.length > 4 ? ", ..." : ""}`);
  const everyone = hub.store.list({ kind: "person", limit: 100000 });
  const dates_soon = datesSoon(everyone, now, 14);
  const people_today = everyone.length ? peopleInPlans(everyone, hub.store.list({ kind: "fact", limit: 100000 }), plansToday(model.events, reminders_due, tasks, now)) : [];
  const people = [
    ...people_today.slice(0, 2).map((p) => {
      const at = p.plans.find((x) => x.at)?.at;
      return `${p.name}${at ? ` at ${clockOf(new Date(at))}` : ""}${p.notes[0] ? ` (${p.notes[0]})` : ""}`;
    }),
    ...dates_soon.filter((d) => d.days <= 7).slice(0, 3).map(datePhrase),
  ];
  if (people.length) lines.push(`People: ${people.join("; ")}`);
  if (captures_unprocessed) lines.push(`${captures_unprocessed} capture${captures_unprocessed === 1 ? "" : "s"} to sort`);

  return {
    date: model.date, now: current, next, blocks: model.blocks, events: model.events, commitments: model.commitments, preferences: model.preferences,
    reminders_due, watches_due_soon, dates_soon, people_today, captures_unprocessed, free_slots,
    digest: lines.slice(0, 6).join("\n"),
  };
}

/** "Homelab: down Storage backup, oldbox ping; sensors storage.zfs.tank.healthy low", or null when all is well. */
export function opsLine(hub: Hub): string | null {
  const parts: string[] = [];
  if (hub.modules.on("homelab")) {
    const down = hub.store.list({ kind: "monitor", limit: 100000 }).filter((m) => m.fields.enabled !== false && m.fields.state === "down").map((m) => String(m.fields.name));
    if (down.length) parts.push(`down ${down.slice(0, 3).join(", ")}${down.length > 3 ? `, ${down.length - 3} more` : ""}`);
  }
  if (hub.modules.on("sensors")) {
    const off = hub.store.list({ kind: "sensor", limit: 10000 }).filter((x) => x.fields.alert !== false && ["low", "high", "stale"].includes(String(x.fields.state))).map((x) => `${String(x.fields.name)} ${String(x.fields.state)}`);
    if (off.length) parts.push(`sensors ${off.slice(0, 3).join(", ")}${off.length > 3 ? `, ${off.length - 3} more` : ""}`);
  }
  return parts.length ? `Homelab: ${parts.join("; ")}` : null;
}

/**
 * Emit the daily digest notify: the whole digest, today's plans and calendar first (the morning notification showed
 * only "Now: <task>"). Clients that show one line show the first.
 */
export function emitDigest(hub: Hub, now: Date = new Date()): string {
  const view = todayView(hub, now);
  // "Nothing queued" is no way to open a morning notification when there is anything else to say.
  const all = view.digest.split("\n");
  const lines = all.length > 1 ? all.filter((l) => l !== "Nothing queued") : all;
  const lead = (l: string) => l.startsWith("Plans:") || l.startsWith("Calendar:");
  const title = [...lines.filter(lead), ...lines.filter((l) => !lead(l))].join("\n");
  hub.bus.emit("notify", { id: `digest:${view.date}`, kind: "digest", title, at: now.toISOString() });
  return view.digest;
}

/** Once a day at EA_DIGEST_TIME local. */
export function startDigestJob(hub: Hub): () => void {
  const [h, m] = hub.cfg.digestTime.split(":").map((x) => parseInt(x, 10));
  return scheduleDaily("digest", h, m, () => { emitDigest(hub); });
}

/** The planner line of /status: blocks and free hours in the current week, watches due within 30 days. */
export function plannerStatus(hub: Hub, now: Date = new Date()): { blocks_this_week: number; free_hours_this_week: number; watches_due_30d: number } {
  const week = weekModel(hub, undefined, 3, now);
  const blocks = week.days.reduce((n, d) => n + d.blocks.length, 0);
  const hours = week.days.reduce((n, d) => n + d.free_slots.reduce((m, s) => m + s.hours, 0), 0);
  const limit = now.getTime() + 30 * DAY_MS;
  const watches = (hub.modules.on("renewals") ? hub.store.list({ kind: "watch", limit: 100000 }) : []).filter((w) => {
    const due = localDateOf(w.fields.due).getTime();
    return Number.isFinite(due) && due <= limit;
  }).length;
  return { blocks_this_week: blocks, free_hours_this_week: Math.round(hours * 10) / 10, watches_due_30d: watches };
}
