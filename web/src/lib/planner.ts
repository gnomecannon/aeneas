/**
 * Pure helpers for Module 1 (days and tasks): local dates, plan rule evaluation (including
 * alternating custody weeks), overlap detection, free slot search, week grid placement, watch
 * grouping and the digest text. No DOM. Shared by the Today and Week views, the offline fallback
 * and scripts/mock-hub.ts, so the mock plans the same way the views expect.
 */
import type { Entity } from "@everythingapp/shared";
import { taskAlertAt } from "@everythingapp/shared";
import { fmtTime, HOUR } from "./time";

export const DAY_START = "09:00";
export const DAY_END = "23:00";
export const DEFAULT_BLOCK_HOURS = 3;
export const WATCH_SOON_DAYS = 30;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const DAY_MS = 24 * HOUR;

export interface Span {
  start: string;
  end: string;
}
export interface Block extends Span {
  task_id: string;
  title: string;
  status: string;
}
export type RuleType = "blackout" | "commitment" | "preference" | "info";
export interface Commitment extends Span {
  rule_id: string;
  title: string;
  type: RuleType;
}
export interface FreeSlot extends Span {
  hours: number;
}
export interface PlannerDay {
  date: string;
  blocks: Block[];
  events: Entity[];
  commitments: Commitment[];
  reminders: Entity[];
  watches_due: Entity[];
  free_slots: FreeSlot[];
}
export interface PlannerWeek {
  start: string;
  days: PlannerDay[];
}
export interface PlannerToday {
  date: string;
  now: Entity | null;
  next: Entity[];
  blocks: Block[];
  commitments: Commitment[];
  reminders_due: Entity[];
  watches_due_soon: Entity[];
  captures_unprocessed: number;
  free_slots: FreeSlot[];
  digest: string;
}
export interface Conflict extends Span {
  kind: "block" | "event" | "commitment" | "blackout";
  title: string;
}

// ---------- dates ----------
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight for a YYYY-MM-DD string (an ISO datetime is accepted too). */
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  d.setHours(0, 0, 0, 0);
  return d;
}

export const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** A due value as a Date: date-only strings are local dates, datetimes are instants. */
export function parseDue(due: string): Date {
  return isDateOnly(due) ? parseLocalDate(due) : new Date(due);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Local midnight of the Monday of the week containing d. */
export function mondayOf(d: Date): Date {
  const x = startOfLocalDay(d);
  const back = (x.getDay() + 6) % 7;
  return addDays(x, -back);
}

export function weekdayOf(d: Date): Weekday {
  return WEEKDAYS[(d.getDay() + 6) % 7];
}

/** "HH:MM" to minutes since midnight; "24:00" is 1440. */
export function hhmmToMinutes(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHhmm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Local time on `date` at `minutes` past midnight. Minutes past 1440 roll into the next day. */
export function atMinutes(date: Date, minutes: number): Date {
  const x = startOfLocalDay(date);
  x.setMinutes(minutes);
  return x;
}

export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// ---------- plan rules ----------
export interface RuleLike {
  title?: string;
  type?: string;
  days: string[];
  start: string;
  end: string;
  alternating_anchor?: string;
  active?: boolean;
}

/** Whole weeks between the Monday of the anchor's week and the Monday of date's week (negative before). */
export function weeksFromAnchor(anchor: string, date: Date): number {
  const a = mondayOf(parseLocalDate(anchor)).getTime();
  const b = mondayOf(date).getTime();
  return Math.round((b - a) / (7 * DAY_MS));
}

/** Active, on this weekday, and (with an anchor) on an even number of weeks from the anchor's week. */
export function ruleAppliesOn(rule: RuleLike, date: Date): boolean {
  if (rule.active === false) return false;
  if (!rule.days?.includes(weekdayOf(date))) return false;
  if (rule.alternating_anchor && weeksFromAnchor(rule.alternating_anchor, date) % 2 !== 0) return false;
  return true;
}

export function ruleSpan(rule: Pick<RuleLike, "start" | "end">, date: Date): Span {
  return { start: atMinutes(date, hhmmToMinutes(rule.start)).toISOString(), end: atMinutes(date, hhmmToMinutes(rule.end)).toISOString() };
}

/** The commitments, blackouts and preferences in force on one date, from plan_rule entities. */
export function commitmentsFor(rules: Entity[], date: Date): Commitment[] {
  const out: Commitment[] = [];
  for (const r of rules) {
    if (r.deleted_at || r.kind !== "plan_rule") continue;
    const f = r.fields as unknown as RuleLike;
    if (!ruleAppliesOn(f, date)) continue;
    out.push({ rule_id: r.id, title: String(f.title ?? ""), type: (f.type as RuleType) ?? "commitment", ...ruleSpan(f, date) });
  }
  return out.sort(byStart);
}

// ---------- spans ----------
export const byStart = (a: Span, b: Span) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/** Strict overlap: touching ends do not overlap. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

export function findConflict<T extends Span>(span: Span, busy: T[]): T | null {
  for (const b of busy) if (overlaps(span, b)) return b;
  return null;
}

export function blockOf(task: Entity): Block | null {
  const f = task.fields as { title?: string; status?: string; block?: { start: string; end: string } };
  if (!f.block?.start || !f.block?.end) return null;
  return { task_id: task.id, title: String(f.title ?? ""), status: String(f.status ?? ""), start: f.block.start, end: f.block.end };
}

/** An event's time span. An all-day event is stored at midnight UTC: its days are the date parts (end exclusive), so
 * the span runs from local midnight to local midnight, never the evening before west of UTC. */
export function spanOf(e: Entity): Span {
  if (e.fields.all_day === true) {
    const local = (iso: unknown) => parseLocalDate(String(iso ?? "").slice(0, 10)).toISOString();
    return { start: local(e.fields.start), end: local(e.fields.end ?? e.fields.start) };
  }
  return { start: String(e.fields.start), end: String(e.fields.end) };
}

export function daySpan(date: Date): Span {
  return { start: startOfLocalDay(date).toISOString(), end: addDays(startOfLocalDay(date), 1).toISOString() };
}

/**
 * Gaps of at least minHours between dayStart and dayEnd on `date` once the busy spans are taken out.
 * Busy spans outside the day are ignored; spans that straddle its edges are clipped.
 */
export function freeSlots(date: Date, busy: Span[], minHours = DEFAULT_BLOCK_HOURS, dayStart = DAY_START, dayEnd = DAY_END): FreeSlot[] {
  const s0 = atMinutes(date, hhmmToMinutes(dayStart)).getTime();
  const e0 = atMinutes(date, hhmmToMinutes(dayEnd)).getTime();
  const taken = busy
    .map((b) => ({ s: Math.max(s0, new Date(b.start).getTime()), e: Math.min(e0, new Date(b.end).getTime()) }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  const out: FreeSlot[] = [];
  let cursor = s0;
  const push = (s: number, e: number) => {
    const hours = (e - s) / HOUR;
    if (hours + 1e-9 >= minHours) out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), hours: Math.round(hours * 100) / 100 });
  };
  for (const t of taken) {
    if (t.s > cursor) push(cursor, t.s);
    cursor = Math.max(cursor, t.e);
  }
  if (e0 > cursor) push(cursor, e0);
  return out;
}

/** Percent offsets of a span inside a day column running from dayStart to dayEnd; null when outside. */
export function gridPlacement(span: Span, date: Date, dayStart = DAY_START, dayEnd = DAY_END): { top: number; height: number } | null {
  const s0 = atMinutes(date, hhmmToMinutes(dayStart)).getTime();
  const e0 = atMinutes(date, hhmmToMinutes(dayEnd)).getTime();
  const total = e0 - s0;
  if (total <= 0) return null;
  const s = Math.max(s0, new Date(span.start).getTime());
  const e = Math.min(e0, new Date(span.end).getTime());
  if (e <= s) return null;
  return { top: ((s - s0) / total) * 100, height: ((e - s) / total) * 100 };
}

/** Grid row labels, one per hour from dayStart up to (not including) dayEnd. */
export function hourRows(dayStart = DAY_START, dayEnd = DAY_END): number[] {
  const a = Math.floor(hhmmToMinutes(dayStart) / 60);
  const b = Math.ceil(hhmmToMinutes(dayEnd) / 60);
  const out: number[] = [];
  for (let h = a; h < b; h++) out.push(h);
  return out;
}

/** Minutes past midnight for a pointer at fraction `y` (0..1) of the column, snapped down to `step`. */
export function minutesAtFraction(y: number, step = 30, dayStart = DAY_START, dayEnd = DAY_END): number {
  const a = hhmmToMinutes(dayStart);
  const b = hhmmToMinutes(dayEnd);
  const raw = a + Math.min(1, Math.max(0, y)) * (b - a);
  return Math.min(b - step, Math.floor(raw / step) * step);
}

/** A task with a reminder that has not been done. */
export function pendingReminder(t: Entity): boolean {
  return !t.deleted_at && !!taskAlertAt(t.fields);
}

/** Whether a task's reminder notifies on `date` (local day). */
export function reminderOnDate(t: Entity, date: Date): boolean {
  const at = t.deleted_at ? null : taskAlertAt(t.fields);
  if (!at) return false;
  const d = daySpan(date);
  return at >= d.start && at < d.end;
}

// ---------- watches ----------
/** Whole days from today (local) to the due date; negative when overdue. */
export function daysLeft(due: string, now = new Date()): number {
  const a = startOfLocalDay(now).getTime();
  const b = startOfLocalDay(parseDue(due)).getTime();
  return Math.round((b - a) / DAY_MS);
}

export function groupWatches(watches: Entity[], now = new Date(), soonDays = WATCH_SOON_DAYS): { overdue: Entity[]; soon: Entity[]; later: Entity[] } {
  const live = watches.filter((w) => !w.deleted_at && w.fields.due).sort((a, b) => (parseDue(String(a.fields.due)).getTime() - parseDue(String(b.fields.due)).getTime()));
  const overdue: Entity[] = [];
  const soon: Entity[] = [];
  const later: Entity[] = [];
  for (const w of live) {
    const d = daysLeft(String(w.fields.due), now);
    if (d < 0) overdue.push(w);
    else if (d <= soonDays) soon.push(w);
    else later.push(w);
  }
  return { overdue, soon, later };
}

export function watchesDueSoon(watches: Entity[], now = new Date(), soonDays = WATCH_SOON_DAYS): Entity[] {
  const g = groupWatches(watches, now, soonDays);
  return [...g.overdue, ...g.soon];
}

/** "in 5 d", "today", "3 d overdue". */
export function fmtDaysLeft(days: number): string {
  if (days === 0) return "today";
  if (days < 0) return `${-days} d overdue`;
  return `in ${days} d`;
}

// ---------- timeline ----------
export type TimelineItem =
  | { kind: "block"; key: string; start: string; end: string; title: string; task_id: string; status: string }
  | { kind: "commitment"; key: string; start: string; end: string; title: string; type: RuleType; rule_id: string }
  | { kind: "event"; key: string; start: string; end: string; title: string; id: string; location?: string; all_day?: boolean }
  | { kind: "reminder"; key: string; start: string; title: string; id: string }
  | { kind: "free"; key: string; start: string; end: string; hours: number }
  | { kind: "now"; key: string; start: string };

/** Everything on one day in time order, with the current time marker inserted when `now` falls on that day. */
export function timeline(day: { blocks: Block[]; commitments: Commitment[]; events?: Entity[]; reminders: Entity[]; free_slots: FreeSlot[] }, now: Date | null): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const b of day.blocks) items.push({ kind: "block", key: `b:${b.task_id}:${b.start}`, start: b.start, end: b.end, title: b.title, task_id: b.task_id, status: b.status });
  for (const c of day.commitments) items.push({ kind: "commitment", key: `c:${c.rule_id}:${c.start}`, start: c.start, end: c.end, title: c.title, type: c.type, rule_id: c.rule_id });
  for (const e of day.events ?? []) items.push({ kind: "event", key: `e:${e.id}`, ...spanOf(e), title: String(e.fields.title ?? ""), id: e.id, location: e.fields.location as string | undefined, ...(e.fields.all_day === true ? { all_day: true } : {}) });
  for (const r of day.reminders) items.push({ kind: "reminder", key: `r:${r.id}`, start: taskAlertAt(r.fields) ?? "", title: String(r.fields.title ?? ""), id: r.id });
  for (const f of day.free_slots) items.push({ kind: "free", key: `f:${f.start}`, start: f.start, end: f.end, hours: f.hours });
  if (now) items.push({ kind: "now", key: "now", start: now.toISOString() });
  const rank: Record<TimelineItem["kind"], number> = { now: 0, reminder: 1, commitment: 2, event: 3, block: 4, free: 5 };
  return items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : rank[a.kind] - rank[b.kind]));
}

// ---------- digest ----------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDayLabel(d: Date): string {
  return `${DAY_NAMES[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Two to four plain lines summarising the day. Shared by the mock hub and the offline fallback. */
export function buildDigest(t: Omit<PlannerToday, "digest" | "next" | "date">, at = new Date()): string {
  const lines: string[] = [];
  const nowTitle = t.now ? String(t.now.fields.title ?? "") : "";
  const nowBlock = t.now ? (t.now.fields.block as { end: string } | undefined) : undefined;
  const nowNote = nowBlock && new Date(nowBlock.end) > at ? ` until ${fmtTime(nowBlock.end)}` : "";
  lines.push(`${fmtDayLabel(at)}. ${nowTitle ? `Now: ${nowTitle}${nowNote}.` : "Nothing queued."}`);
  const fixed = t.commitments.filter((c) => c.type !== "preference" && c.type !== "info").length;
  const parts = [`${t.blocks.length} ${t.blocks.length === 1 ? "block" : "blocks"}`, `${fixed} fixed`, `${t.reminders_due.length} ${t.reminders_due.length === 1 ? "reminder" : "reminders"}`];
  const nextFree = t.free_slots.find((s) => new Date(s.end) > at);
  lines.push(`${parts.join(", ")}.${nextFree ? ` Free: ${Math.floor(nextFree.hours)} h at ${fmtTime(nextFree.start > at.toISOString() ? nextFree.start : at.toISOString())}.` : ""}`);
  if (t.watches_due_soon.length) {
    const w = t.watches_due_soon.slice(0, 3).map((x) => `${String(x.fields.title)} ${fmtDaysLeft(daysLeft(String(x.fields.due), at))}`);
    lines.push(`Renewals: ${w.join(", ")}${t.watches_due_soon.length > 3 ? `, ${t.watches_due_soon.length - 3} more` : ""}.`);
  }
  if (t.captures_unprocessed > 0) lines.push(`${t.captures_unprocessed} waiting in Unsorted Info.`);
  return lines.slice(0, 4).join("\n");
}
