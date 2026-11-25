/**
 * What the Today screen shows, worked out from the day's plan and the local copy. No DOM, so the rules are tested
 * here once (todayBoard.test.ts) and the Apple app's Today follows the same ones (EACore TodayBoard).
 *
 * Today is a status report of the day in the order its owner asked every report to take: what needs you (actions
 * only, numbered), what is on now and what is left (the schedule), what is done (today so far), then what is coming
 * and needs nothing from you. An automatic record (a charge on autopay) is never an action, and Today does not list
 * it at all: it pays itself (gnomecannon/aeneas#14); Renewals shows it. What needs a look in Tech is Tech's own card
 * above Needs you (lib/tech.ts `techLight`), never a row of Needs you. That is the default order: Theme, Today changes
 * it and hides parts (`today` in the feel setting), and `todayColumns` fills the columns in the order chosen.
 */
import type { Entity, LineWords, NextLine, TodayCard } from "@everythingapp/shared";
import { durationWords, freeTime, lineWords, nextLine } from "@everythingapp/shared";
import type { TimelineItem } from "./planner";
import { localDate } from "./planner";
import type { DueReminder } from "./reminders";
import { fmtDate, fmtTime } from "./time";

const MIN = 60_000;

/** "46 min", "2 h", "2 h 10 min": a length of time in whole minutes, never "about" (packages/shared). */
export { durationWords };

// ---------- the Next line ----------

/** The line at the top of Today, and wherever the Now task used to show (packages/shared `nextLine.ts`). */
export type NowLine = NextLine;

/**
 * The one sentence at the top: the task you started (`started`, from `startedTask`), else what is under way and how
 * long it has left, else the next thing with a time and how long until it, else that nothing else is on today. A block
 * under way leads an event at the same time; of two under way, the one that ends first. The rule is packages/shared's,
 * so the Windows widget, the hub's digest and the Apple apps say the same.
 */
export function nowLine(items: TimelineItem[], now: Date, started?: Entity | null): NowLine {
  return nextLine(items, now, started);
}

/** The free time now or next today: "Free until 3:00 PM, 2 h 46 min" or "Free 6:00 PM to 11:00 PM, 5 h". Null when none is left. */
export function freeLine(items: TimelineItem[], now: Date): string | null {
  return freeTime(items, now, fmtTime);
}

/**
 * The line in words, in this device's time format. `free` is the free time for a line that stands alone (the Windows
 * widget); Today passes null, since it shows the free time on a line of its own.
 */
export function nowWords(line: NowLine, free: string | null): LineWords {
  return lineWords(line, free, fmtTime);
}

// ---------- needs you ----------

export type Need =
  | { key: string; kind: "reminder"; title: string; detail: string; reminder: DueReminder }
  | { key: string; kind: "renewal"; title: string; detail: string; watch: Entity; overdue: boolean }
  | { key: string; kind: "followup"; title: string; detail: string; app: Entity; late: boolean }
  | { key: string; kind: "med"; title: string; detail: string; med: string }
  | { key: string; kind: "unsorted"; title: string; detail: string; count: number };

/**
 * Everything waiting on the owner right now, in the order to take it: reminders whose time has come (oldest first),
 * renewals the owner has to make (never the ones on autopay), job follow ups due, regular meds not yet logged today,
 * and captures the assistant could not file. A renewal's own reminder says the same as the renewal, so only the
 * renewal is listed. Tech's looks are not here: Tech's card above Needs you holds them.
 */
export function needsYou(input: {
  reminders: DueReminder[];
  watches: Entity[];
  followUps: Entity[];
  meds: { name: string; takenAt: string | null }[];
  unsorted: number;
  now: Date;
}): Need[] {
  const { now } = input;
  const out: Need[] = [];
  const toRenew = input.watches.filter((w) => w.fields.autopay !== true);
  const renewing = new Set(toRenew.map((w) => w.id));
  for (const r of input.reminders) {
    if (renewing.has(String(r.entity.fields.linked_id ?? ""))) continue;
    out.push({ key: `r:${r.key}`, kind: "reminder", title: String(r.entity.fields.title ?? ""), detail: `Reminder, ${cameDue(r.at, now)}`, reminder: r });
  }
  for (const w of toRenew) {
    const days = daysUntil(String(w.fields.due ?? ""), now);
    out.push({
      key: `w:${w.id}`, kind: "renewal", title: `Renew ${String(w.fields.title ?? "")}`, overdue: days < 0, watch: w,
      detail: days === 0 ? "Due today" : days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : `Due in ${days} day${days === 1 ? "" : "s"}`,
    });
  }
  for (const a of input.followUps) {
    const late = localDate(new Date(String(a.fields.next_at))) < localDate(now);
    out.push({
      key: `a:${a.id}`, kind: "followup", app: a, late,
      title: `Follow up with ${String(a.fields.company ?? "")}`,
      detail: [a.fields.next_step ? String(a.fields.next_step) : "", late ? "late" : `today, ${fmtTime(String(a.fields.next_at))}`].filter(Boolean).join(", "),
    });
  }
  for (const m of input.meds) {
    if (m.takenAt) continue;
    out.push({ key: `m:${m.name.toLowerCase()}`, kind: "med", title: m.name, detail: "Not logged today", med: m.name });
  }
  if (input.unsorted > 0) {
    out.push({ key: "unsorted", kind: "unsorted", count: input.unsorted, title: `${input.unsorted} capture${input.unsorted === 1 ? "" : "s"} could not be filed`, detail: "Waiting in Unsorted Info" });
  }
  return out;
}

/**
 * When a reminder came due, in words: "2:20 PM, 40 min ago" today, "Nov 20 at 4:08 PM, 2 days ago" from an earlier
 * day (hours alone, "51 h 49 min ago", made the owner work out which day that was).
 */
export function cameDue(at: string, now: Date): string {
  const days = -daysUntil(at, now);
  if (days >= 1) return `${fmtDate(at)} at ${fmtTime(at)}, ${days === 1 ? "yesterday" : `${days} days ago`}`;
  const late = now.getTime() - Date.parse(at);
  return late >= MIN ? `${fmtTime(at)}, ${durationWords(late)} ago` : fmtTime(at);
}

/** Whole local days from today to a date ("2026-11-25" or a full time); negative when it has passed. */
export function daysUntil(due: string, now: Date): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(due);
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ---------- to do ----------

/**
 * Open tasks in the order to offer them: the one being done, then Next in its order, then the rest (the Inbox, which
 * is where tasks from Reminders and captures arrive) in theirs. Tasks that are only a reminder for later (scheduled)
 * and parked ones are not offered: the first shows at its time, the second was set aside on purpose.
 */
export function openTasks(tasks: Entity[]): Entity[] {
  const rank: Record<string, number> = { doing: 0, next: 1, inbox: 2 };
  const order = (e: Entity) => (typeof e.fields.order === "number" ? e.fields.order : Number.MAX_SAFE_INTEGER);
  return tasks
    .filter((t) => !t.deleted_at && String(t.fields.status) in rank)
    .sort((a, b) => rank[String(a.fields.status)] - rank[String(b.fields.status)] || order(a) - order(b) || a.created_at.localeCompare(b.created_at));
}

// ---------- today so far ----------

export interface SoFarRow {
  key: string;
  /** When it happened, for the order. */
  at: number;
  /**
   * When it happened, in words: "8:10 AM", or "Yesterday 8:10 AM" for a line from before midnight (the day runs until
   * 4 AM, so after midnight a bare 8:10 AM read as later today).
   */
  time: string;
  /** "Yesterday" for a line from before midnight; `clock` is the time alone. */
  day?: "Yesterday";
  clock: string;
  text: string;
  kind: "capture" | "done" | "log";
  /** The task or log it is, for its link. */
  id?: string;
}

/** The start of the day `now` is in when days start at `startHour` (4 for the diary: 1 AM belongs to the day before). */
export function dayStart(now: Date, startHour: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour);
  if (now.getHours() < startHour) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * What was said and done today, oldest first: the diary's lines (every capture, as the assistant filed it), tasks
 * finished, and logs with words in them (a med taken, an activity). Numbers logged today are `todayNumbers`.
 * The day runs 4 AM to 4 AM, as the diary's does; between midnight and 4 AM its lines from before midnight say
 * "Yesterday" before their time.
 */
export function soFar(input: { diary: { lines: { time: string; text: string }[] } | null; tasks: Entity[]; logs: Entity[]; now: Date; startHour?: number }): SoFarRow[] {
  const start = dayStart(input.now, input.startHour ?? 4);
  const from = start.getTime(), to = from + 86_400_000;
  const today = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate()).getTime();
  const when = (at: number, iso: string): Pick<SoFarRow, "time" | "day" | "clock"> => {
    const clock = fmtTime(iso);
    return at < today ? { time: `Yesterday ${clock}`, day: "Yesterday", clock } : { time: clock, clock };
  };
  const rows: SoFarRow[] = [];
  (input.diary?.lines ?? []).forEach((l, i) => {
    const [h, m] = l.time.split(":").map(Number);
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate(), h, m);
    // A line before the day's first hour was said after midnight: it is on the next calendar day.
    if (h < start.getHours()) d.setDate(d.getDate() + 1);
    rows.push({ key: `c:${i}`, at: d.getTime() + i / 1000, ...when(d.getTime(), d.toISOString()), text: l.text, kind: "capture" });
  });
  for (const t of input.tasks) {
    const done = typeof t.fields.done_at === "string" ? Date.parse(t.fields.done_at) : NaN;
    if (t.deleted_at || !(done >= from && done < to)) continue;
    rows.push({ key: `d:${t.id}`, at: done, ...when(done, String(t.fields.done_at)), text: `Done: ${String(t.fields.title ?? "")}`, kind: "done", id: t.id });
  }
  for (const l of input.logs) {
    const at = Date.parse(String(l.fields.at ?? ""));
    if (l.deleted_at || !(at >= from && at < to)) continue;
    const type = String(l.fields.type ?? ""), value = String(l.fields.value ?? "").trim();
    if (!value || (type !== "med" && type !== "activity" && type !== "workout")) continue;
    rows.push({ key: `l:${l.id}`, at, ...when(at, String(l.fields.at)), text: type === "med" ? `Took ${value}` : `${cap(type)}: ${value}`, kind: "log", id: l.id });
  }
  return rows.sort((a, b) => a.at - b.at);
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The numbers logged today, one per kind, in a fixed order: "Weight 158.4 lb", "Sleep 6 h 30 min", "Steps 4,210",
 * "Caffeine 2 cups", "Mood +1". Units are read as the hub reads logs (hub/src/health.ts): a weight is lb unless its
 * unit is kg, sleep is minutes unless its unit says hours (a night of 390 with no unit used to read "390 h").
 */
export function todayNumbers(logs: Entity[], now: Date, startHour = 4): { type: string; label: string; value: string }[] {
  const from = dayStart(now, startHour).getTime(), to = from + 86_400_000;
  const ORDER = ["weight", "sleep", "steps", "caffeine", "mood", "bp"];
  const LABEL: Record<string, string> = { weight: "Weight", sleep: "Sleep", steps: "Steps", caffeine: "Caffeine", mood: "Mood", bp: "Blood pressure" };
  const by = new Map<string, Entity[]>();
  for (const l of logs) {
    const at = Date.parse(String(l.fields.at ?? ""));
    const type = String(l.fields.type ?? "");
    if (l.deleted_at || !ORDER.includes(type) || !(at >= from && at < to)) continue;
    by.set(type, [...(by.get(type) ?? []), l]);
  }
  return ORDER.filter((t) => by.has(t)).map((type) => {
    const list = by.get(type)!.slice().sort((a, b) => String(a.fields.at).localeCompare(String(b.fields.at)));
    const last = list[list.length - 1];
    const unit = typeof last.fields.unit === "string" && last.fields.unit ? ` ${last.fields.unit}` : "";
    const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v)));
    let value: string;
    if (type === "caffeine") {
      // Every cup is a log of its own: the day's total is what matters.
      const sum = list.reduce((s, l) => s + (Number.isFinite(num(l.fields.value)) ? num(l.fields.value) : 1), 0);
      // The log's unit is "cups" whatever the count: one of them is a cup.
      value = `${fmtNumber(sum)}${sum === 1 ? (unit || " cup").replace(/s$/, "") : unit || " cups"}`;
    } else if (type === "mood") {
      const v = num(last.fields.value);
      value = Number.isFinite(v) ? (v > 0 ? `+${v}` : String(v)) : String(last.fields.value);
    } else if (type === "sleep" && Number.isFinite(num(last.fields.value))) {
      const hours = ["h", "hr", "hrs", "hour", "hours"].includes(unit.trim().toLowerCase());
      value = durationWords(num(last.fields.value) * (hours ? 60 : 1) * MIN);
    } else if (type === "weight" && Number.isFinite(num(last.fields.value))) {
      const kg = ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"].includes(unit.trim().toLowerCase());
      value = `${fmtNumber(num(last.fields.value))} ${kg ? "kg" : "lb"}`;
    } else if (Number.isFinite(num(last.fields.value))) {
      value = `${fmtNumber(num(last.fields.value))}${unit}`;
    } else {
      value = `${String(last.fields.value)}${unit}`;
    }
    return { type, label: LABEL[type], value };
  });
}

/** 4210 as "4,210"; 158.4 stays "158.4". */
export function fmtNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// ---------- coming up ----------

/** Tomorrow's plans from the local copy: all-day ones first, then by time; at most `limit`, with how many more. */
export function tomorrowLines(events: Entity[], now: Date, limit = 3): { lines: { key: string; time: string; title: string }[]; more: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(), end = start + 86_400_000;
  const day = events
    .filter((e) => !e.deleted_at)
    .map((e) => {
      const allDay = e.fields.all_day === true;
      const s = allDay ? localMidnight(String(e.fields.start ?? "")) : Date.parse(String(e.fields.start ?? ""));
      const en = allDay ? localMidnight(String(e.fields.end ?? e.fields.start ?? "")) + 1 : Date.parse(String(e.fields.end ?? ""));
      return { e, allDay, s, en };
    })
    .filter((x) => Number.isFinite(x.s) && x.s < end && (Number.isFinite(x.en) ? x.en : x.s) > start && (x.allDay || x.s >= start))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.s - b.s);
  return {
    lines: day.slice(0, limit).map((x) => ({ key: x.e.id, time: x.allDay ? "All day" : fmtTime(String(x.e.fields.start)), title: String(x.e.fields.title ?? "") })),
    more: Math.max(0, day.length - limit),
  };
}

function localMidnight(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

// ---------- columns ----------

/** A card of Today, by its id in the setting (`today` in the feel setting, packages/shared `today.ts`). */
export type TodaySection = TodayCard;

/**
 * The cards grouped into the slots the columns are filled with, in their order: each card has a slot of its own, but
 * Tech, one short line, sits at the top of the card after it (Needs you, by default), or at the bottom of the card
 * before it when no card follows; alone, it has its own.
 */
export function todaySlots(cards: readonly TodaySection[]): TodaySection[][] {
  const slots: TodaySection[][] = [];
  let tech = false;
  for (const c of cards) {
    if (c === "tech") tech = true;
    else {
      slots.push(tech ? ["tech", c] : [c]);
      tech = false;
    }
  }
  if (tech) {
    if (slots.length) slots[slots.length - 1].push("tech");
    else slots.push(["tech"]);
  }
  return slots;
}

/** How many columns a width has room for (of the screen's own area, in CSS pixels): one on a phone, up to five. */
export function todayColumnCount(width: number): number {
  if (width >= 2100) return 5;
  if (width >= 1500) return 4;
  if (width >= 1040) return 3;
  if (width >= 680) return 2;
  return 1;
}

/**
 * The column of each slot, by how many columns there are, when there are more slots than columns: the first slot goes
 * in the first place's column, and so on. In the default order these are the columns Today has always had: on three,
 * Needs you and To do share the first and Today so far and Coming up the last; on two, the cards take turns.
 */
const PLACES: Record<number, number[]> = {
  1: [0, 0, 0, 0, 0],
  2: [0, 1, 0, 1, 0],
  3: [0, 1, 0, 2, 2],
  4: [0, 1, 2, 3, 3],
  5: [0, 1, 2, 3, 4],
};

/**
 * Which cards go in which column at a width: the cards drawn (in the setting's order, without the hidden ones and
 * without Tech while it has nothing to show) fill the columns in their order. With no more slots than columns, each has
 * a column of its own. Each card keeps its column at a given width whatever it holds, so nothing moves when a list
 * grows: a status board is read by position.
 */
export function todayColumns(width: number, cards: readonly TodaySection[]): TodaySection[][] {
  const slots = todaySlots(cards);
  const count = Math.min(todayColumnCount(width), slots.length);
  const columns: TodaySection[][] = Array.from({ length: count }, () => []);
  slots.forEach((slot, i) => {
    const col = slots.length <= count ? i : (PLACES[count][i] ?? count - 1);
    columns[col].push(...slot);
  });
  return columns;
}
