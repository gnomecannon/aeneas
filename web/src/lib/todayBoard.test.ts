import { describe, expect, it } from "vitest";
import { DEFAULT_TODAY, startedTask, todayCards, type Entity } from "@everythingapp/shared";
import { takesTime, timeline, wholeDay, type RuleType, type TimelineItem } from "./planner";
import { cameDue, daysUntil, durationWords, freeLine, needsYou, nowLine, nowWords, openTasks, soFar, todayColumnCount, todayColumns, todayNumbers, todaySlots, tomorrowLines } from "./todayBoard";

let n = 0;
function e(kind: string, fields: Record<string, unknown>, over: Partial<Entity> = {}): Entity {
  n += 1;
  return { id: `id${n}`, kind, space: "personal", fields, field_ts: {}, created_at: `2026-11-01T00:00:${String(n % 60).padStart(2, "0")}Z`, updated_at: "", deleted_at: null, ...over } as unknown as Entity;
}
/** A local time on 2026-11-22 (a Sunday). */
const at = (h: number, m = 0) => new Date(2026, 10, 22, h, m);
const iso = (h: number, m = 0) => at(h, m).toISOString();
const event = (title: string, from: number, to: number): TimelineItem => ({ kind: "event", key: `e:${title}`, start: iso(from), end: iso(to), title, id: title });
const block = (title: string, from: number, to: number, status = "next"): TimelineItem => ({ kind: "block", key: `b:${title}`, start: iso(from), end: iso(to), title, task_id: title, status });
const free = (from: number, to: number): TimelineItem => ({ kind: "free", key: `f:${from}`, start: iso(from), end: iso(to), hours: to - from });
const reminder = (title: string, h: number, m = 0): TimelineItem => ({ kind: "reminder", key: `r:${title}`, start: iso(h, m), title, id: title });
/** Hours from a plan rule; 24 is the midnight that ends the day. */
const rule = (title: string, type: RuleType, from: number, to: number): TimelineItem => ({ kind: "commitment", key: `c:${title}`, start: iso(from), end: iso(to), title, type, rule_id: title });

describe("durationWords", () => {
  it("says whole minutes, and hours with their minutes", () => {
    expect(durationWords(46 * 60_000)).toBe("46 min");
    expect(durationWords(120 * 60_000)).toBe("2 h");
    expect(durationWords(130 * 60_000)).toBe("2 h 10 min");
    expect(durationWords(-5)).toBe("0 min");
  });
});

describe("nowLine", () => {
  it("names what is under way and how long it has left", () => {
    expect(nowLine([event("Dentist cleaning", 15, 16)], at(15, 14))).toEqual({ kind: "during", title: "Dentist cleaning", until: iso(16), left: "46 min", what: "event" });
  });
  it("puts a block under way ahead of an event at the same time", () => {
    const l = nowLine([event("Standup", 9, 10), block("Write the report", 9, 12, "doing")], at(9, 30));
    expect(l.kind === "during" && l.title).toBe("Write the report");
  });
  it("else names the next thing with a time, a reminder included, and how long until it", () => {
    expect(nowLine([event("Dentist cleaning", 15, 16), reminder("Call the vet", 13, 30)], at(12, 50))).toEqual({ kind: "next", title: "Call the vet", at: iso(13, 30), wait: "40 min", what: "reminder" });
  });
  it("skips all-day plans, free time and what is over, and says when nothing is left", () => {
    const allDay: TimelineItem = { kind: "event", key: "e:parade", start: iso(0), end: iso(0), title: "Parade", id: "p", all_day: true };
    expect(nowLine([allDay, free(16, 23), event("Dentist cleaning", 15, 16)], at(16, 14))).toEqual({ kind: "clear" });
  });
});

describe("the Next line", () => {
  it("leads with the task you started, never the first task in Next", () => {
    const gift = e("task", { title: "Gift idea for Alex", status: "next", order: 1 });
    const report = e("task", { title: "Write the report", status: "doing", order: 2 });
    const items = [event("Dentist cleaning", 15, 16)];
    expect(nowWords(nowLine(items, at(15, 14), startedTask([gift, report])), null).text).toBe("Doing: Write the report");
    // Nothing started: the gift idea is nowhere on it, and the event under way is.
    expect(startedTask([gift])).toBeNull();
    expect(nowWords(nowLine(items, at(15, 14), startedTask([gift])), null).text).toMatch(/^Dentist cleaning until .+, 46 min left$/);
  });
  it("says the free time where the line stands alone, and leaves it to Today's own line there", () => {
    const items = [free(18, 23)];
    expect(nowWords(nowLine(items, at(16)), freeLine(items, at(16))).text).toBe("Free 6:00 PM to 11:00 PM, 5 h");
    expect(nowWords(nowLine(items, at(16)), null).text).toBe("Nothing else today");
  });
});

describe("plan rules", () => {
  it("only a commitment or a blackout takes time; a preference and an info rule do not", () => {
    expect((["commitment", "blackout", "preference", "info"] as RuleType[]).filter((type) => takesTime({ type }))).toEqual(["commitment", "blackout"]);
  });
  it("a rule from midnight to midnight is the whole day, also on the 23 hours of the day the clocks go forward", () => {
    expect(wholeDay({ start: iso(0), end: iso(24) })).toBe(true);
    expect(wholeDay({ start: iso(0), end: iso(23) })).toBe(true);
    expect(wholeDay({ start: iso(9), end: iso(17) })).toBe(false);
  });
  it("a whole-day rule is never what is on now or next, as an all-day event is not", () => {
    expect(nowLine([rule("Away", "blackout", 0, 24), rule("Pepper weeks", "info", 0, 24), rule("Music first", "preference", 10, 13)], at(11))).toEqual({ kind: "clear" });
    const l = nowLine([rule("Work hours", "commitment", 9, 17)], at(11));
    expect(l.kind === "during" && l.title).toBe("Work hours");
  });
});

describe("freeLine", () => {
  it("says free time from now by when it ends, and later free time by both ends", () => {
    expect(freeLine([free(16, 23)], new Date(at(16).getTime() + 30_000))).toBe("Free until 11:00 PM, 7 h");
    expect(freeLine([free(18, 23)], at(16))).toBe("Free 6:00 PM to 11:00 PM, 5 h");
    expect(freeLine([free(9, 12)], at(13))).toBeNull();
  });
});

describe("timeline", () => {
  it("draws the now marker above the free time that holds now (the hub starts that slot a moment before this device's now)", () => {
    const day = { blocks: [], commitments: [], events: [], reminders: [], free_slots: [{ start: new Date(at(16, 14).getTime() - 900).toISOString(), end: iso(23), hours: 6.8 }] };
    expect(timeline(day, at(16, 14)).map((x) => x.kind)).toEqual(["now", "free"]);
  });
});

describe("needsYou", () => {
  const now = at(16, 31);
  const due = (t: Entity, when: string) => ({ entity: t, at: when, key: `${t.id}:${when}` });
  it("lists only what waits on the owner, in the order to take it", () => {
    const vet = e("task", { title: "Call the vet", remind_at: iso(16, 8) });
    const car = e("watch", { title: "car registration", due: "2026-11-20" });
    const spotify = e("watch", { title: "Spotify", due: "2026-11-25", autopay: true, cost: 11.99 });
    const out = needsYou({ reminders: [due(vet, iso(16, 8))], watches: [car, spotify], meds: [{ name: "Claritin", takenAt: null }, { name: "Vitamin D", takenAt: iso(8) }], unsorted: 2, now });
    expect(out.map((x) => [x.kind, x.title, x.detail])).toEqual([
      ["reminder", "Call the vet", "Reminder, 4:08 PM, 23 min ago"],
      ["renewal", "Renew car registration", "2 days overdue"],
      ["med", "Claritin", "Not logged today"],
      ["unsorted", "2 captures could not be filed", "Waiting in Unsorted Info"],
    ]);
  });
  it("lists each connection that broke after the reminders and invitations, before renewals", () => {
    const vet = e("task", { title: "Call the vet", remind_at: iso(16, 8) });
    const car = e("watch", { title: "car registration", due: "2026-11-20" });
    const broken = { id: "account:icloud:jamie@icloud.com", service: "iCloud", title: "iCloud stopped signing in for jamie@icloud.com", detail: "Replace its app-specific password.", fix: "account" as const, account: "icloud:jamie@icloud.com", button: "Replace password", affects: ["mail"], since: null };
    const out = needsYou({ reminders: [due(vet, iso(16, 8))], watches: [car], meds: [], unsorted: 0, now, invitations: { title: "1 invitation", detail: "Dinner", count: 1 }, connections: [broken] });
    expect(out.map((x) => [x.kind, x.title, x.detail])).toEqual([
      ["reminder", "Call the vet", "Reminder, 4:08 PM, 23 min ago"],
      ["invitations", "1 invitation", "Dinner"],
      ["connection", "iCloud stopped signing in for jamie@icloud.com", "Replace its app-specific password."],
      ["renewal", "Renew car registration", "2 days overdue"],
    ]);
    expect(out[2].key).toBe("c:account:icloud:jamie@icloud.com");
  });
  it("names a renewal once: its own reminder is left out, a charge on autopay is never an action", () => {
    const passport = e("watch", { title: "passport", due: "2026-11-22" });
    const renew = e("task", { title: "Renew: passport", remind_at: iso(9), linked_id: passport.id });
    const netflix = e("watch", { title: "Netflix", due: "2026-11-22", autopay: true });
    const out = needsYou({ reminders: [due(renew, iso(9))], watches: [passport, netflix], meds: [], unsorted: 0, now });
    expect(out.map((x) => [x.kind, x.title, x.detail])).toEqual([["renewal", "Renew passport", "Due today"]]);
  });
  it("says the day a reminder came due when that was not today", () => {
    expect(cameDue(iso(16, 8), now)).toBe("4:08 PM, 23 min ago");
    expect(cameDue(new Date(2026, 10, 22, 16, 30, 40).toISOString(), now)).toBe("4:30 PM");
    expect(cameDue(new Date(2026, 10, 21, 9, 55).toISOString(), now)).toBe("Nov 21 at 9:55 AM, yesterday");
    expect(cameDue(new Date(2026, 10, 20, 16, 8).toISOString(), now)).toBe("Nov 20 at 4:08 PM, 2 days ago");
    // Late last night is yesterday, however few hours ago.
    expect(cameDue(new Date(2026, 10, 21, 23, 30).toISOString(), new Date(2026, 10, 22, 0, 30))).toBe("Nov 21 at 11:30 PM, yesterday");
  });
  it("is empty when nothing waits", () => {
    expect(needsYou({ reminders: [], watches: [], meds: [], unsorted: 0, now })).toEqual([]);
  });
  it("has nothing of Tech: what needs a look there is Tech's own card above Needs you", () => {
    const look = { key: "mon-1", thing: "nas01", title: "nas01 SMB down", detail: "connect timeout", severity: "major", monitorId: "m1" };
    // @ts-expect-error Needs you takes no looks any more.
    const out = needsYou({ reminders: [], looks: [look], watches: [], meds: [], unsorted: 0, now });
    expect(out).toEqual([]);
  });
  it("counts days by the local calendar", () => {
    expect(daysUntil("2026-11-25", now)).toBe(3);
    expect(daysUntil("2026-11-22", new Date(2026, 10, 22, 23, 59))).toBe(0);
    expect(daysUntil("2026-11-21", now)).toBe(-1);
  });
});

describe("openTasks", () => {
  it("offers the one being done, then Next in its order, then the Inbox in its order; never done, parked or reminder-only tasks", () => {
    const tasks = [
      e("task", { title: "inbox b", status: "inbox", order: 2 }),
      e("task", { title: "next b", status: "next", order: 5 }),
      e("task", { title: "done", status: "done", order: 0 }),
      e("task", { title: "doing", status: "doing", order: 9 }),
      e("task", { title: "inbox a", status: "inbox", order: 1 }),
      e("task", { title: "parked", status: "parked", order: 0 }),
      e("task", { title: "reminder", status: "scheduled", order: 0 }),
      e("task", { title: "next a", status: "next", order: 3 }),
      e("task", { title: "gone", status: "inbox", order: 0 }, { deleted_at: "2026-11-01T00:00:00Z" }),
    ];
    expect(openTasks(tasks).map((t) => t.fields.title)).toEqual(["doing", "next a", "next b", "inbox a", "inbox b"]);
  });
});

describe("soFar", () => {
  const now = at(16, 31);
  it("puts the diary's lines, finished tasks and logs with words in the order they happened", () => {
    const rows = soFar({
      diary: { lines: [{ time: "09:12", text: "Coffee with Devon" }, { time: "14:05", text: "Ordered the HDMI cable" }] },
      tasks: [e("task", { title: "Dish soap", status: "done", done_at: iso(11, 30) }), e("task", { title: "Yesterday's", status: "done", done_at: new Date(2026, 10, 21, 20).toISOString() })],
      logs: [e("log", { type: "med", value: "Claritin", at: iso(8, 5) }), e("log", { type: "weight", value: 158.4, at: iso(7, 30) }), e("log", { type: "activity", value: "Soldering", at: iso(15) })],
      now,
    });
    expect(rows.map((r) => `${r.time} ${r.text}`)).toEqual(["8:05 AM Took Claritin", "9:12 AM Coffee with Devon", "11:30 AM Done: Dish soap", "2:05 PM Ordered the HDMI cable", "3:00 PM Activity: Soldering"]);
    expect(rows.map((r) => r.kind)).toEqual(["log", "capture", "done", "capture", "log"]);
  });
  it("runs the day 4 AM to 4 AM, as the diary does: 1 AM belongs to the day before and reads after its evening", () => {
    const rows = soFar({ diary: { lines: [{ time: "23:10", text: "Movie" }, { time: "01:15", text: "Bed" }] }, tasks: [e("task", { title: "Late one", done_at: new Date(2026, 10, 23, 0, 30).toISOString() })], logs: [], now: new Date(2026, 10, 23, 1, 30) });
    expect(rows.map((r) => r.text)).toEqual(["Movie", "Done: Late one", "Bed"]);
    // After midnight a line from before it says so: a bare 11:10 PM read as later today.
    expect(rows.map((r) => r.time)).toEqual(["Yesterday 11:10 PM", "12:30 AM", "1:15 AM"]);
    expect(rows.map((r) => r.day)).toEqual(["Yesterday", undefined, undefined]);
    expect(rows.map((r) => r.clock)).toEqual(["11:10 PM", "12:30 AM", "1:15 AM"]);
  });
});

describe("todayNumbers", () => {
  it("gives one number per kind logged today, in a fixed order: the latest, and for caffeine the day's total", () => {
    const logs = [
      e("log", { type: "caffeine", value: 1, unit: "cups", at: iso(8, 30) }),
      e("log", { type: "weight", value: 159.0, unit: "lb", at: iso(7) }),
      e("log", { type: "weight", value: 158.4, unit: "lb", at: iso(7, 30) }),
      e("log", { type: "sleep", value: 6.5, unit: "h", at: iso(7) }),
      e("log", { type: "steps", value: 4210, at: iso(12) }),
      e("log", { type: "mood", value: 1, at: iso(10) }),
      e("log", { type: "weight", value: 160, unit: "lb", at: new Date(2026, 10, 21, 7).toISOString() }),
      e("log", { type: "med", value: "Claritin", at: iso(8) }),
    ];
    expect(todayNumbers(logs, at(16)).map((x) => `${x.label} ${x.value}`)).toEqual(["Weight 158.4 lb", "Sleep 6 h 30 min", "Steps 4,210", "Caffeine 1 cup", "Mood +1"]);
    // Sleep is minutes unless the log says hours, and a weight keeps its own unit, as the hub reads them.
    const others = [e("log", { type: "sleep", value: 390, at: iso(7) }), e("log", { type: "weight", value: 72.5, unit: "kg", at: iso(7) }), e("log", { type: "weight", value: 150, at: iso(6) })];
    expect(todayNumbers(others, at(16)).map((x) => `${x.label} ${x.value}`)).toEqual(["Weight 72.5 kg", "Sleep 6 h 30 min"]);
    expect(todayNumbers([...logs, e("log", { type: "caffeine", value: 1, unit: "cups", at: iso(13) })], at(16)).find((x) => x.type === "caffeine")!.value).toBe("2 cups");
  });
});

describe("coming up", () => {
  const now = at(16, 31);
  it("lists tomorrow's plans, all-day ones first, and how many more there are", () => {
    const events = [
      e("event", { title: "Standup", start: new Date(2026, 10, 23, 9).toISOString(), end: new Date(2026, 10, 23, 9, 30).toISOString() }),
      e("event", { title: "Pepper handoff", start: "2026-11-23", end: "2026-11-23", all_day: true }),
      e("event", { title: "Lunch", start: new Date(2026, 10, 23, 12).toISOString(), end: new Date(2026, 10, 23, 13).toISOString() }),
      e("event", { title: "Review", start: new Date(2026, 10, 23, 15).toISOString(), end: new Date(2026, 10, 23, 16).toISOString() }),
      e("event", { title: "Today's", start: iso(18), end: iso(19) }),
      e("event", { title: "Later", start: new Date(2026, 10, 24, 9).toISOString(), end: new Date(2026, 10, 24, 10).toISOString() }),
    ];
    const out = tomorrowLines(events, now);
    expect(out.lines.map((l) => `${l.time} ${l.title}`)).toEqual(["All day Pepper handoff", "9:00 AM Standup", "12:00 PM Lunch"]);
    expect(out.more).toBe(1);
  });
});

describe("todayColumns", () => {
  const usual = todayCards(DEFAULT_TODAY);
  const noTech = usual.filter((c) => c !== "tech");

  it("is one column on a phone and up to five across a wide window, every card in exactly one place", () => {
    expect(todayColumns(358, noTech)).toEqual([["needs", "schedule", "todo", "sofar", "coming"]]);
    expect(todayColumns(792, noTech)).toEqual([["needs", "todo", "coming"], ["schedule", "sofar"]]);
    expect(todayColumns(1048, noTech)).toEqual([["needs", "todo"], ["schedule"], ["sofar", "coming"]]);
    expect(todayColumns(1688, noTech)).toEqual([["needs"], ["schedule"], ["todo"], ["sofar", "coming"]]);
    expect(todayColumns(2328, noTech)).toEqual([["needs"], ["schedule"], ["todo"], ["sofar"], ["coming"]]);
    for (const w of [0, 358, 700, 1048, 1688, 2328, 3600]) {
      expect(todayColumns(w, noTech).flat().sort()).toEqual(["coming", "needs", "schedule", "sofar", "todo"]);
      expect(todayColumns(w, usual).flat().sort()).toEqual(["coming", "needs", "schedule", "sofar", "tech", "todo"]);
    }
  });

  it("draws the default as Today always was, Tech at the top of the Needs you slot", () => {
    expect(todayColumnCount(679)).toBe(1);
    expect(todayColumnCount(680)).toBe(2);
    expect(todayColumnCount(1040)).toBe(3);
    expect(todayColumnCount(1500)).toBe(4);
    expect(todayColumnCount(2100)).toBe(5);
    expect(todayColumns(358, usual)).toEqual([["tech", "needs", "schedule", "todo", "sofar", "coming"]]);
    expect(todayColumns(792, usual)).toEqual([["tech", "needs", "todo", "coming"], ["schedule", "sofar"]]);
    expect(todayColumns(1048, usual)).toEqual([["tech", "needs", "todo"], ["schedule"], ["sofar", "coming"]]);
    expect(todayColumns(1688, usual)).toEqual([["tech", "needs"], ["schedule"], ["todo"], ["sofar", "coming"]]);
    expect(todayColumns(2328, usual)).toEqual([["tech", "needs"], ["schedule"], ["todo"], ["sofar"], ["coming"]]);
  });

  it("fills the columns in a custom order", () => {
    const cards = todayCards({ order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: [] });
    expect(cards).toEqual(["coming", "todo", "schedule", "needs", "tech", "sofar"]);
    expect(todayColumns(358, cards)).toEqual([["coming", "todo", "schedule", "needs", "tech", "sofar"]]);
    expect(todayColumns(792, cards)).toEqual([["coming", "schedule", "tech", "sofar"], ["todo", "needs"]]);
    expect(todayColumns(1048, cards)).toEqual([["coming", "schedule"], ["todo"], ["needs", "tech", "sofar"]]);
    expect(todayColumns(1688, cards)).toEqual([["coming"], ["todo"], ["schedule"], ["needs", "tech", "sofar"]]);
    expect(todayColumns(2328, cards)).toEqual([["coming"], ["todo"], ["schedule"], ["needs"], ["tech", "sofar"]]);
  });

  it("leaves hidden cards out and gives each slot a column of its own while there are no more slots than columns", () => {
    // Two hidden, and Tech last: it sits under the Schedule, so three slots.
    const cards = todayCards({ order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: ["sofar", "needs"] });
    expect(cards).toEqual(["coming", "todo", "schedule", "tech"]);
    expect(todayColumns(358, cards)).toEqual([["coming", "todo", "schedule", "tech"]]);
    expect(todayColumns(792, cards)).toEqual([["coming", "schedule", "tech"], ["todo"]]);
    expect(todayColumns(1048, cards)).toEqual([["coming"], ["todo"], ["schedule", "tech"]]);
    expect(todayColumns(1688, cards)).toEqual([["coming"], ["todo"], ["schedule", "tech"]]);
    expect(todayColumns(2328, cards)).toEqual([["coming"], ["todo"], ["schedule", "tech"]]);
    // Two cards: never more than two columns, however wide.
    expect(todayColumns(2328, ["schedule", "todo"])).toEqual([["schedule"], ["todo"]]);
    expect(todayColumns(358, [])).toEqual([]);
  });

  it("sits Tech with the card after it, else with the card before it, else alone", () => {
    expect(todaySlots(["tech", "needs", "schedule"])).toEqual([["tech", "needs"], ["schedule"]]);
    // Needs you hidden: Tech sits at the top of the next card.
    expect(todaySlots(["tech", "schedule", "todo"])).toEqual([["tech", "schedule"], ["todo"]]);
    expect(todaySlots(["schedule", "todo", "tech"])).toEqual([["schedule"], ["todo", "tech"]]);
    expect(todaySlots(["tech"])).toEqual([["tech"]]);
    expect(todayColumns(2328, ["tech"])).toEqual([["tech"]]);
    // Tech never takes a column: hidden or shown, the other cards keep theirs.
    const without = todayColumns(1048, noTech);
    const withTech = todayColumns(1048, usual);
    expect(withTech.map((c) => c.filter((x) => x !== "tech"))).toEqual(without);
  });
});
