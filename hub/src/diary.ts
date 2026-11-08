import type { Entity } from "@everythingapp/shared";
import type { Store } from "./store.js";

/**
 * The diary: one note per day (`Diary/YYYY-MM-DD.md`, also in the Obsidian vault) with every capture of that day as a
 * timestamped line. It is the raw history the assistant recalls from ("when did I last eat at Luigi's?"), whatever
 * else a capture was filed as.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Local day and time (the hub runs in EA_TZ). */
export function diaryDay(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** The owner's day ends when they sleep, not at midnight: a capture before 4 AM belongs to the day before. */
export const DAY_START_HOUR = 4;
export function captureDay(d: Date): string {
  return diaryDay(d.getHours() < DAY_START_HOUR ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12) : d);
}
/** Sort key for a diary line's time, so 00:18 comes after 23:40 in the same day. */
const lineOrder = (hhmm: string) => (Number(hhmm.slice(0, 2)) < DAY_START_HOUR ? `${Number(hhmm.slice(0, 2)) + 24}${hhmm.slice(2)}` : hhmm);
function clock(d: Date): string { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

export function diaryPath(day: string): string { return `Diary/${day}.md`; }

/** Append one line to the day's diary note, creating the note on the day's first entry. Returns the note. */
export function appendDiary(store: Store, text: string, at: Date = new Date()): Entity {
  const day = captureDay(at);
  const path = diaryPath(day);
  const line = `- ${clock(at)} ${text.trim().replace(/\n+/g, " / ")}`;
  const note = store.list({ kind: "note", limit: 100000 }).find((n) => String(n.fields.path ?? "").toLowerCase() === path.toLowerCase());
  if (!note) {
    return store.create("note", { title: `Diary ${day}`, path, tags: ["diary"], body: `# ${day}\n\n${line}\n` });
  }
  const body = String(note.fields.body ?? "").replace(/\s*$/, "\n");
  return store.patch(note.id, { body: `${body}${line}\n` });
}

export type DiaryDay = {
  day: string;
  lines: { time: string; text: string }[];
  events: { id: string; title: string; start: string; all_day: boolean }[];
  logs: { id: string; type: string; value: unknown; unit?: string; time: string }[];
};

/** Days from `from` to `to` (YYYY-MM-DD, inclusive) with their diary lines, calendar events and logs; empty days are left out.
 * With `query`, only lines, events and logs whose words match (all words, any order). */
export function readDiary(store: Store, from: string, to: string, query?: string): DiaryDay[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const days = new Map<string, DiaryDay>();
  const dayOf = (d: string) => days.get(d) ?? days.set(d, { day: d, lines: [], events: [], logs: [] }).get(d)!;
  const inRange = (d: string) => d >= from && d <= to;

  for (const n of store.list({ kind: "note", limit: 100000 })) {
    const m = /^Diary\/(\d{4}-\d{2}-\d{2})\.md$/i.exec(String(n.fields.path ?? ""));
    if (!m || !inRange(m[1])) continue;
    for (const raw of String(n.fields.body ?? "").split("\n")) {
      const l = /^- (\d{2}:\d{2}) (.*)$/.exec(raw.trim());
      if (l && hit(l[2])) dayOf(m[1]).lines.push({ time: l[1], text: l[2] });
    }
  }
  for (const e of store.list({ kind: "event", limit: 100000 })) {
    const start = new Date(String(e.fields.start ?? ""));
    if (isNaN(+start)) continue;
    // All-day events are stored at midnight UTC; their day is the date part.
    // A timed event before 4 AM is the night before, as the diary's own lines are (a 00:15 show is that evening's).
    const d = e.fields.all_day ? String(e.fields.start).slice(0, 10) : captureDay(start);
    if (inRange(d) && hit(String(e.fields.title ?? "") + " " + String(e.fields.location ?? ""))) {
      dayOf(d).events.push({ id: e.id, title: String(e.fields.title ?? ""), start: e.fields.all_day ? "all day" : clock(start), all_day: !!e.fields.all_day, ...(e.space === "work" ? { work: true } : {}) });
    }
  }
  for (const g of store.list({ kind: "log", limit: 100000 })) {
    const at = new Date(String(g.fields.at ?? ""));
    if (isNaN(+at)) continue;
    // The same day as the capture line it came from ("took my claritin" at 00:30 is on the day before, line and log).
    const d = captureDay(at);
    const label = [g.fields.type, g.fields.name, g.fields.value, g.fields.unit, g.fields.note].filter((x) => x != null && x !== "").join(" ");
    if (inRange(d) && hit(label)) dayOf(d).logs.push({ id: g.id, type: String(g.fields.type), value: g.fields.value, ...(g.fields.unit ? { unit: String(g.fields.unit) } : {}), time: clock(at) });
  }
  const out = [...days.values()].filter((d) => d.lines.length || d.events.length || d.logs.length).sort((a, b) => b.day.localeCompare(a.day));
  for (const d of out) {
    d.lines.sort((a, b) => lineOrder(a.time).localeCompare(lineOrder(b.time)));
    d.events.sort((a, b) => a.start.localeCompare(b.start));
    d.logs.sort((a, b) => a.time.localeCompare(b.time));
  }
  return out;
}
