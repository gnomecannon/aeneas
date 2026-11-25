/**
 * The Week screen's views (CONTRACT.md, Planner, Week screen): Day, Week, Month and Year, the period each shows and how
 * the arrows move it, the month and year grids, the events on each day, and search. Pure, local time, no DOM. The Apple
 * apps carry the same rules in EACore `CalendarViews.swift`, tested against the same cases.
 */
import type { Entity } from "@everythingapp/shared";
import { addDays, fmtDayLabel, localDate, mondayOf, parseLocalDate, startOfLocalDay } from "./planner";

export const CALENDAR_VIEWS = ["day", "week", "month", "year"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const VIEW_NAMES: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };

export function isCalendarView(v: unknown): v is CalendarView {
  return typeof v === "string" && (CALENDAR_VIEWS as readonly string[]).includes(v);
}

/** A span of local time, end exclusive. */
export interface DateRange {
  start: Date;
  end: Date;
}

const daysIn = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/**
 * The period a view shows around the day looked at: that day; Monday to the next Monday; the first of the month to the
 * first of the next; January 1 to the next January 1.
 */
export function viewRange(view: CalendarView, anchor: Date): DateRange {
  const d = startOfLocalDay(anchor);
  switch (view) {
    case "day":
      return { start: d, end: addDays(d, 1) };
    case "week": {
      const mon = mondayOf(d);
      return { start: mon, end: addDays(mon, 7) };
    }
    case "month":
      return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
    case "year":
      return { start: new Date(d.getFullYear(), 0, 1), end: new Date(d.getFullYear() + 1, 0, 1) };
  }
}

/**
 * The day looked at after the arrows move `n` periods (negative goes back): by days, weeks, months or years. Moving by
 * months or years keeps the day of the month, or the month's last day when it has fewer (January 31 to February 28).
 */
export function shiftAnchor(view: CalendarView, anchor: Date, n: number): Date {
  const d = startOfLocalDay(anchor);
  if (view === "day") return addDays(d, n);
  if (view === "week") return addDays(d, 7 * n);
  const months = view === "month" ? n : 12 * n;
  const y = d.getFullYear() + Math.floor((d.getMonth() + months) / 12);
  const m = (((d.getMonth() + months) % 12) + 12) % 12;
  return new Date(y, m, Math.min(d.getDate(), daysIn(y, m)));
}

/** Whether the period a view shows around `anchor` holds `day`. */
export function holdsDay(view: CalendarView, anchor: Date, day: Date): boolean {
  const r = viewRange(view, anchor);
  const t = startOfLocalDay(day).getTime();
  return t >= r.start.getTime() && t < r.end.getTime();
}

/** One day of a month grid: its date, and whether it is in the month shown (the others are drawn faded). */
export interface GridDay {
  date: string;
  inMonth: boolean;
}

/**
 * A month as weeks of seven days, Monday first: every week that holds a day of the month (4 to 6), with the days of
 * the months either side that fill those weeks. `month` is 0 for January.
 */
export function monthGrid(year: number, month: number): GridDay[][] {
  const first = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  const weeks: GridDay[][] = [];
  for (let mon = mondayOf(first); mon < end; mon = addDays(mon, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const d = addDays(mon, i);
      return { date: localDate(d), inMonth: d.getMonth() === month && d.getFullYear() === year };
    }));
  }
  return weeks;
}

/** The twelve months of a year, each as its grid. */
export function yearGrid(year: number): { month: number; weeks: GridDay[][] }[] {
  return Array.from({ length: 12 }, (_, month) => ({ month, weeks: monthGrid(year, month) }));
}

/** At most this many days per event: a stray end years away must not fill every cell. */
const MAX_SPAN_DAYS = 62;

/**
 * The local days an event is on. An all-day one: the date parts of its start and end, end exclusive (stored at midnight
 * UTC, it is never the evening before west of UTC). A timed one: from its start's day to the day its last moment is in;
 * one with no length is on its start's day.
 */
export function eventDays(fields: Record<string, unknown>): string[] {
  const start = String(fields.start ?? "");
  const endRaw = String(fields.end ?? "") || start;
  let first: Date;
  let last: Date;
  if (fields.all_day === true) {
    first = parseLocalDate(start.slice(0, 10));
    const after = parseLocalDate(endRaw.slice(0, 10));
    last = after > first ? addDays(after, -1) : first;
  } else {
    const s = Date.parse(start);
    const e = Date.parse(endRaw);
    if (Number.isNaN(s)) return [];
    first = startOfLocalDay(new Date(s));
    last = startOfLocalDay(new Date(Number.isNaN(e) || e <= s ? s : e - 1));
  }
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return [];
  const out: string[] = [];
  for (let d = first; d <= last && out.length < MAX_SPAN_DAYS; d = addDays(d, 1)) out.push(localDate(d));
  return out;
}

/** Events in the order a day lists them: all-day first, then by start, then by title. */
export function byDayOrder(a: Entity, b: Entity): number {
  const ad = a.fields.all_day === true ? 0 : 1;
  const bd = b.fields.all_day === true ? 0 : 1;
  return ad - bd || Date.parse(String(a.fields.start)) - Date.parse(String(b.fields.start)) || String(a.fields.title ?? "").localeCompare(String(b.fields.title ?? ""));
}

/** The events on each local day inside the range (YYYY-MM-DD to events), each day in `byDayOrder`. */
export function eventsByDay(events: readonly Entity[], range: DateRange): Map<string, Entity[]> {
  const from = localDate(range.start);
  const to = localDate(range.end);
  const out = new Map<string, Entity[]>();
  for (const e of events) {
    if (e.deleted_at) continue;
    for (const day of eventDays(e.fields)) {
      if (day < from || day >= to) continue;
      const list = out.get(day);
      if (list) list.push(e);
      else out.set(day, [e]);
    }
  }
  for (const list of out.values()) list.sort(byDayOrder);
  return out;
}

/** Text as search compares it: lower case, accents taken off. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a search, folded. */
export function searchWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

/** Whether an event has every word of a search somewhere in its title or place. No words matches nothing. */
export function eventMatches(fields: Record<string, unknown>, words: readonly string[]): boolean {
  if (!words.length) return false;
  const text = foldText(`${String(fields.title ?? "")} ${typeof fields.location === "string" ? fields.location : ""}`);
  return words.every((w) => text.includes(w));
}

export interface DayGroup {
  date: string;
  events: Entity[];
}

export interface SearchResult {
  /** From today forward, soonest first. */
  upcoming: DayGroup[];
  /** The days before today, newest first. */
  earlier: DayGroup[];
  /** How many events matched, before the limit. */
  total: number;
}

/** The most results a search shows. */
export const SEARCH_LIMIT = 200;

/**
 * Events found by a search, grouped by the local day they start on: today and the days after first, soonest first,
 * then the days before, newest first. At most `limit` events, taken in that order.
 */
export function searchEvents(events: readonly Entity[], query: string, today: Date, limit = SEARCH_LIMIT): SearchResult {
  const words = searchWords(query);
  const todayStr = localDate(today);
  const found = events.filter((e) => !e.deleted_at && eventMatches(e.fields, words)).map((e) => ({ e, day: eventDays(e.fields)[0] ?? "" })).filter((x) => x.day);
  const ahead = found.filter((x) => x.day >= todayStr).sort((a, b) => a.day.localeCompare(b.day) || byDayOrder(a.e, b.e));
  const before = found.filter((x) => x.day < todayStr).sort((a, b) => b.day.localeCompare(a.day) || byDayOrder(a.e, b.e));
  const kept = [...ahead, ...before].slice(0, Math.max(0, limit));
  const group = (xs: { e: Entity; day: string }[]) => {
    const out: DayGroup[] = [];
    for (const x of xs) {
      const last = out[out.length - 1];
      if (last && last.date === x.day) last.events.push(x.e);
      else out.push({ date: x.day, events: [x.e] });
    }
    return out;
  };
  return { upcoming: group(kept.filter((x) => x.day >= todayStr)), earlier: group(kept.filter((x) => x.day < todayStr)), total: found.length };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function monthName(month: number): string {
  return MONTH_NAMES[((month % 12) + 12) % 12];
}

/**
 * The title over a view: "Tue Nov 24" for a day (with the year when it is not this one), "Nov 23 to 29" for a week,
 * "November 2026" for a month, "2026" for a year.
 */
export function periodTitle(view: CalendarView, anchor: Date, today: Date = new Date()): string {
  const d = startOfLocalDay(anchor);
  switch (view) {
    case "day":
      return d.getFullYear() === today.getFullYear() ? fmtDayLabel(d) : `${fmtDayLabel(d)}, ${d.getFullYear()}`;
    case "week": {
      const mon = mondayOf(d);
      const sun = addDays(mon, 6);
      const same = mon.getMonth() === sun.getMonth();
      return `${MONTH_SHORT[mon.getMonth()]} ${mon.getDate()} to ${same ? sun.getDate() : `${MONTH_SHORT[sun.getMonth()]} ${sun.getDate()}`}`;
    }
    case "month":
      return `${monthName(d.getMonth())} ${d.getFullYear()}`;
    case "year":
      return String(d.getFullYear());
  }
}

/** How the arrows name what they move by, for screen readers. */
export function periodWord(view: CalendarView): string {
  return view === "day" ? "day" : view === "week" ? "week" : view === "month" ? "month" : "year";
}

/** An event's place across its day column: lane `lane` of `lanes` side by side. */
export interface EventLane {
  lane: number;
  lanes: number;
}

/**
 * Lanes for timed events that overlap, as calendars draw them side by side; drawn full width, a later event covered the
 * one under it. Sorted by start (the longer first at the same start), each event takes the first lane free at its
 * start. A run of events that overlap through any chain shares one lane count, so their widths line up. An event that
 * ends as the next starts does not overlap it. Times are any one unit (minutes from midnight on the Week screen). The
 * Apple apps carry the same rule in EACore `CalendarViews.lanes`, tested against the same cases.
 */
export function eventLanes(spans: readonly { id: string; start: number; end: number }[]): Map<string, EventLane> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<string, EventLane>();
  let run: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let runEnd = -Infinity;
  const close = () => {
    for (const r of run) out.set(r.id, { lane: r.lane, lanes: laneEnds.length });
    run = [];
    laneEnds = [];
  };
  for (const s of sorted) {
    if (s.start >= runEnd) close();
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(s.end);
    } else laneEnds[lane] = s.end;
    run.push({ id: s.id, lane });
    runEnd = Math.max(runEnd, s.end);
  }
  close();
  return out;
}
