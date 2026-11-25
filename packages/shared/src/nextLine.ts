/**
 * The Next line (since 2026-11-25): the one line that says what you are on and what comes next. It is Today's top line,
 * and the same line shows wherever the Now task used to: the widgets, the Watch, the Mac menu bar, the Windows widget,
 * the morning digest and the assistant (CONTRACT.md, Planner, The Next line).
 *
 * It replaced the Now task (the task being done, else the first task in Next). The app cannot know what its owner is
 * doing unless they say so, and saying so all the time is not something anyone keeps up; a gift idea captured as an
 * undated Next task showed up as Now. So a task is on the line only when it was started (Start sets it to `doing`), or
 * when its time comes (its block, its reminder). Everything else is automatic: what is under way and the time left,
 * else the next thing with a time and how long until it, else the free time.
 *
 * The Apple apps carry the same rules in EACore (`TodayBoard.nowLine`, `TodayBoard.lineWords`), and both sides are
 * tested with the same cases (test/next-line-cases.json).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** "46 min", "2 h", "2 h 10 min": a length of time in whole minutes, never "about". */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * One thing on the day as the line needs it: an event, a block of work, a plan rule's hours (`type` is the rule's
 * kind), free time, or a reminder (a time and no end). Times are ISO. Anything else (Today's own marker for the time
 * now, say) is passed over.
 */
export interface DayThing {
  kind: string;
  title?: string;
  start: string;
  end?: string;
  all_day?: boolean;
  /** A plan rule's type: `commitment` and `blackout` hold their time; `preference` and `info` take none. */
  type?: string;
}

/** A task as the line reads it: the entity, or anything shaped like one. */
export interface LineTask {
  id: string;
  fields: Record<string, unknown>;
  updated_at?: string;
  field_ts?: Record<string, string>;
  deleted_at?: string | null;
}

/** When a task was started: when its status last changed (it became `doing` then), else its last change. */
const startedAt = (t: LineTask) => t.field_ts?.status ?? t.updated_at ?? "";
const orderOf = (t: LineTask) => (typeof t.fields.order === "number" ? t.fields.order : Number.MAX_SAFE_INTEGER);

/**
 * The task you started: one with status `doing`, the most recently started first. Null when there is none. Never a
 * task you have not started, however high it is in Next.
 */
export function startedTask<T extends LineTask>(tasks: readonly T[]): T | null {
  let best: T | null = null;
  for (const t of tasks) {
    if (t.deleted_at || t.fields.status !== "doing") continue;
    if (!best) { best = t; continue; }
    const a = startedAt(t), b = startedAt(best);
    if (a > b || (a === b && (orderOf(t) < orderOf(best) || (orderOf(t) === orderOf(best) && t.id < best.id)))) best = t;
  }
  return best;
}

/** A rule that lasts the whole day (a custody week runs midnight to midnight) is no moment. 23 hours counts. */
const wholeDay = (it: DayThing) => it.end !== undefined && Date.parse(it.end) - Date.parse(it.start) >= 23 * HOUR;

type Timed = DayThing & { kind: "event" | "block" | "commitment"; end: string };

/**
 * Something that holds its time: an event with hours, a block, or fixed hours from a commitment or blackout rule. Not
 * a preference or an info rule (they take no time), not an all-day event, and not a rule that lasts the whole day.
 */
function isTimed(it: DayThing): it is Timed {
  if (typeof it.end !== "string") return false;
  if (it.kind === "event") return it.all_day !== true;
  if (it.kind === "block") return true;
  if (it.kind === "commitment") return (it.type === "commitment" || it.type === "blackout") && !wholeDay(it);
  return false;
}

export type NextLine =
  /** The task you started; `until` and `left` while its block is under way. */
  | { kind: "started"; title: string; id: string; until?: string; left?: string }
  | { kind: "during"; title: string; until: string; left: string; what: "event" | "block" | "commitment" }
  | { kind: "next"; title: string; at: string; wait: string; what: "event" | "block" | "commitment" | "reminder" }
  | { kind: "clear" };

/**
 * The line at `now`: the task you started (it is what you chose to do), else what is under way and how long it has
 * left (a block leads an event at the same time; of two under way, the one that ends first), else the next thing with
 * a time today and how long until it, else clear (the free time, or "Nothing else today", is `lineWords`').
 */
export function nextLine(things: readonly DayThing[], now: Date, started?: LineTask | null): NextLine {
  const t = now.getTime();
  if (started) {
    const title = String(started.fields.title ?? "");
    const block = started.fields.block as { start?: unknown; end?: unknown } | undefined;
    const s = Date.parse(String(block?.start ?? "")), e = Date.parse(String(block?.end ?? ""));
    if (s <= t && t < e) return { kind: "started", title, id: started.id, until: String(block!.end), left: durationWords(e - t) };
    return { kind: "started", title, id: started.id };
  }
  const rank = { block: 0, event: 1, commitment: 2 } as const;
  const during = things.filter(isTimed)
    .filter((it) => Date.parse(it.start) <= t && t < Date.parse(it.end))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || Date.parse(a.end) - Date.parse(b.end))[0];
  if (during) return { kind: "during", title: during.title ?? "", until: during.end, left: durationWords(Date.parse(during.end) - t), what: during.kind };
  const ahead = things
    .filter((it) => isTimed(it) || it.kind === "reminder")
    .filter((it) => Date.parse(it.start) > t)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (ahead) return { kind: "next", title: ahead.title ?? "", at: ahead.start, wait: durationWords(Date.parse(ahead.start) - t), what: ahead.kind as "event" | "block" | "commitment" | "reminder" };
  return { kind: "clear" };
}

/**
 * The free time now or next today: "Free until 3:00 PM, 2 h 46 min" or "Free 6:00 PM to 11:00 PM, 5 h", each time
 * written by `clock` (the device's own format). Null when none is left.
 */
export function freeTime(things: readonly DayThing[], now: Date, clock: (iso: string) => string): string | null {
  const t = now.getTime();
  const free = things.filter((it) => it.kind === "free" && typeof it.end === "string" && Date.parse(it.end) > t)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (!free?.end) return null;
  const from = Math.max(Date.parse(free.start), t);
  const length = durationWords(Date.parse(free.end) - from);
  // A slot that has begun (the hub starts today's first one at the moment it answered) is free from now.
  return from - t < 2 * MIN ? `Free until ${clock(free.end)}, ${length}` : `Free ${clock(free.start)} to ${clock(free.end)}, ${length}`;
}

/**
 * The line in words. `text` is the whole line ("Doing: Write the report", "Dentist until 4:00 PM, 46 min left",
 * "Next: Call the vet at 1:30 PM, in 40 min", "Free until 11:00 PM, 7 h", "Nothing else today"); the parts are for
 * drawing it (the title bold, the aside quieter). `label` goes above it where there is room for one (a widget).
 * `free` is the free time, or null where it is shown apart (Today has a line of its own for it).
 */
export interface LineWords {
  label: "Doing" | "Now" | "Next" | "Today";
  lead: string;
  title: string;
  when: string;
  aside: string;
  text: string;
}

export function lineWords(line: NextLine, free: string | null, clock: (iso: string) => string): LineWords {
  const make = (label: LineWords["label"], lead: string, title: string, when = "", aside = ""): LineWords =>
    ({ label, lead, title, when, aside, text: `${lead}${title}${when ? ` ${when}` : ""}${aside ? `, ${aside}` : ""}` });
  switch (line.kind) {
    case "started":
      return line.until ? make("Doing", "Doing: ", line.title, `until ${clock(line.until)}`, `${line.left} left`) : make("Doing", "Doing: ", line.title);
    case "during":
      return make("Now", "", line.title, `until ${clock(line.until)}`, `${line.left} left`);
    case "next":
      return make("Next", "Next: ", line.title, `at ${clock(line.at)}`, `in ${line.wait}`);
    case "clear":
      return make("Today", "", free ?? NOTHING_ELSE);
  }
}

/** What the line says when nothing is started, nothing has a time left today and no free time is left. */
export const NOTHING_ELSE = "Nothing else today";
