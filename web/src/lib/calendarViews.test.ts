import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { calendarShown } from "@everythingapp/shared";
import {
  eventLanes,
  eventDays,
  eventMatches,
  eventsByDay,
  foldText,
  holdsDay,
  isCalendarView,
  monthGrid,
  periodTitle,
  searchEvents,
  searchWords,
  shiftAnchor,
  viewRange,
  yearGrid,
} from "./calendarViews";
import { localDate } from "./planner";

const day = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (y: number, m: number, d: number, h = 0, min = 0) => day(y, m, d, h, min).toISOString();
let n = 0;
const ev = (fields: Record<string, unknown>): Entity => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  kind: "event",
  space: "personal",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  fields,
  field_ts: {},
});
const range = (r: { start: Date; end: Date }) => [localDate(r.start), localDate(r.end)];

describe("calendar views: periods", () => {
  it("each view's period, end exclusive", () => {
    const tue = day(2026, 11, 24, 15);
    expect(range(viewRange("day", tue))).toEqual(["2026-11-24", "2026-11-25"]);
    expect(range(viewRange("week", tue))).toEqual(["2026-11-23", "2026-11-30"]);
    expect(range(viewRange("week", day(2026, 11, 29))), "Sunday is the week's last day").toEqual(["2026-11-23", "2026-11-30"]);
    expect(range(viewRange("month", tue))).toEqual(["2026-11-01", "2026-12-01"]);
    expect(range(viewRange("year", tue))).toEqual(["2026-01-01", "2027-01-01"]);
    expect(range(viewRange("month", day(2026, 12, 31)))).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("the arrows move by the view's period, keeping the day of the month where it can", () => {
    const d = day(2026, 1, 31);
    expect(localDate(shiftAnchor("day", d, 1))).toBe("2026-02-01");
    expect(localDate(shiftAnchor("day", d, -1))).toBe("2026-01-30");
    expect(localDate(shiftAnchor("week", d, 1))).toBe("2026-02-07");
    expect(localDate(shiftAnchor("week", d, -2))).toBe("2026-01-17");
    expect(localDate(shiftAnchor("month", d, 1))).toBe("2026-02-28");
    expect(localDate(shiftAnchor("month", d, -1))).toBe("2025-12-31");
    expect(localDate(shiftAnchor("month", day(2026, 3, 31), -1))).toBe("2026-02-28");
    expect(localDate(shiftAnchor("month", day(2026, 11, 15), 14))).toBe("2028-01-15");
    expect(localDate(shiftAnchor("year", day(2028, 2, 29), 1))).toBe("2029-02-28");
    expect(localDate(shiftAnchor("year", day(2026, 11, 24), -1))).toBe("2025-11-24");
  });

  it("whether a period holds today, for the Today button", () => {
    const today = day(2026, 11, 24);
    expect(holdsDay("week", day(2026, 11, 29), today)).toBe(true);
    expect(holdsDay("week", day(2026, 11, 30), today)).toBe(false);
    expect(holdsDay("day", day(2026, 11, 25), today)).toBe(false);
    expect(holdsDay("month", day(2026, 11, 1), today)).toBe(true);
    expect(holdsDay("year", day(2025, 11, 24), today)).toBe(false);
    expect(isCalendarView("month")).toBe(true);
    expect(isCalendarView("agenda")).toBe(false);
  });

  it("titles", () => {
    const today = day(2026, 11, 24);
    expect(periodTitle("day", today, today)).toBe("Tue Nov 24");
    expect(periodTitle("day", day(2027, 1, 5), today)).toBe("Tue Jan 5, 2027");
    expect(periodTitle("week", today, today)).toBe("Nov 23 to 29");
    expect(periodTitle("week", day(2026, 12, 1), today)).toBe("Nov 30 to Dec 6");
    expect(periodTitle("month", today, today)).toBe("November 2026");
    expect(periodTitle("year", today, today)).toBe("2026");
  });
});

describe("calendar views: grids", () => {
  it("a month is the weeks that hold its days, Monday first, 4 to 6 rows", () => {
    const nov = monthGrid(2026, 10);
    expect(nov.length).toBe(6);
    expect(nov[0][0]).toEqual({ date: "2026-10-26", inMonth: false });
    expect(nov[0][6]).toEqual({ date: "2026-11-01", inMonth: true });
    expect(nov[5][0]).toEqual({ date: "2026-11-30", inMonth: true });
    expect(nov[5][6]).toEqual({ date: "2026-12-06", inMonth: false });
    expect(nov.every((w) => w.length === 7)).toBe(true);
    // February 2027 starts on a Monday and has 28 days: four rows exactly.
    const feb = monthGrid(2027, 1);
    expect(feb.length).toBe(4);
    expect(feb[0][0]).toEqual({ date: "2027-02-01", inMonth: true });
    expect(feb[3][6]).toEqual({ date: "2027-02-28", inMonth: true });
    expect(monthGrid(2026, 1).length).toBe(5);
    // Every day of the month once, in order.
    const inMonth = nov.flat().filter((d) => d.inMonth).map((d) => d.date);
    expect(inMonth.length).toBe(30);
    expect(inMonth[0]).toBe("2026-11-01");
    expect(inMonth[29]).toBe("2026-11-30");
  });

  it("a year is its twelve months", () => {
    const y = yearGrid(2026);
    expect(y.map((m) => m.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(y[0].weeks[0][3]).toEqual({ date: "2026-01-01", inMonth: true });
    expect(y.reduce((s, m) => s + m.weeks.flat().filter((d) => d.inMonth).length, 0)).toBe(365);
  });
});

describe("calendar views: events on days", () => {
  it("the days an event is on", () => {
    expect(eventDays({ start: iso(2026, 11, 24, 9), end: iso(2026, 11, 24, 10) })).toEqual(["2026-11-24"]);
    expect(eventDays({ start: iso(2026, 11, 24, 22), end: iso(2026, 11, 25, 1) })).toEqual(["2026-11-24", "2026-11-25"]);
    expect(eventDays({ start: iso(2026, 11, 24, 22), end: iso(2026, 11, 25, 0) }), "ending at midnight is not on the next day").toEqual(["2026-11-24"]);
    expect(eventDays({ start: iso(2026, 11, 24, 9), end: iso(2026, 11, 24, 9) })).toEqual(["2026-11-24"]);
    expect(eventDays({ start: iso(2026, 11, 24, 9) })).toEqual(["2026-11-24"]);
    // All day, stored at UTC midnights with the end exclusive: its own dates wherever the device is.
    expect(eventDays({ start: "2026-11-20T00:00:00.000Z", end: "2026-11-22T00:00:00.000Z", all_day: true })).toEqual(["2026-11-20", "2026-11-21"]);
    expect(eventDays({ start: "2026-11-20", end: "2026-11-20", all_day: true })).toEqual(["2026-11-20"]);
    expect(eventDays({ start: "nonsense" })).toEqual([]);
    expect(eventDays({ start: iso(2026, 1, 1), end: iso(2030, 1, 1) }).length).toBe(62);
  });

  it("each day's events: all-day first, then by start", () => {
    const lunch = ev({ title: "Lunch", start: iso(2026, 11, 24, 12), end: iso(2026, 11, 24, 13) });
    const trip = ev({ title: "Trip", start: "2026-11-23T00:00:00.000Z", end: "2026-11-26T00:00:00.000Z", all_day: true });
    const early = ev({ title: "Run", start: iso(2026, 11, 24, 7), end: iso(2026, 11, 24, 8) });
    const gone = { ...ev({ title: "Gone", start: iso(2026, 11, 24, 9), end: iso(2026, 11, 24, 10) }), deleted_at: "2026-11-01T00:00:00.000Z" };
    const outside = ev({ title: "Later", start: iso(2026, 12, 2, 9), end: iso(2026, 12, 2, 10) });
    const by = eventsByDay([lunch, trip, early, gone, outside], viewRange("week", day(2026, 11, 24)));
    expect(by.get("2026-11-24")!.map((e) => e.fields.title)).toEqual(["Trip", "Run", "Lunch"]);
    expect(by.get("2026-11-23")!.map((e) => e.fields.title)).toEqual(["Trip"]);
    expect(by.get("2026-11-25")!.map((e) => e.fields.title)).toEqual(["Trip"]);
    expect(by.has("2026-11-26")).toBe(false);
    expect(by.has("2026-12-02")).toBe(false);
  });

  it("a hidden calendar's events are left out before they are placed", () => {
    const home = ev({ title: "Dinner", start: iso(2026, 11, 24, 19), end: iso(2026, 11, 24, 21), calendar_key: "apple:iCloud/Home" });
    const work = ev({ title: "Standup", start: iso(2026, 11, 24, 9), end: iso(2026, 11, 24, 10), calendar_key: "apple:Work/Team" });
    const mine = ev({ title: "Climbing", start: iso(2026, 11, 24, 17), end: iso(2026, 11, 24, 18) });
    const hidden = ["apple:Work/Team", "aeneas"];
    const by = eventsByDay([home, work, mine].filter((e) => calendarShown(e.fields, hidden)), viewRange("day", day(2026, 11, 24)));
    expect(by.get("2026-11-24")!.map((e) => e.fields.title)).toEqual(["Dinner"]);
  });
});

describe("calendar views: search", () => {
  it("every word, in the title or the place, ignoring case and accents", () => {
    expect(foldText("Café CRÈME")).toBe("cafe creme");
    expect(searchWords("  Dentist   maple ")).toEqual(["dentist", "maple"]);
    const f = { title: "Dentist cleaning", location: "Maple Street Dental" };
    expect(eventMatches(f, searchWords("dentist"))).toBe(true);
    expect(eventMatches(f, searchWords("maple dentist"))).toBe(true);
    expect(eventMatches(f, searchWords("street"))).toBe(true);
    expect(eventMatches(f, searchWords("dentist oak"))).toBe(false);
    expect(eventMatches({ title: "Coffee at Café Rose" }, searchWords("cafe"))).toBe(true);
    expect(eventMatches({ title: "Cafe" }, searchWords("CAFÉ"))).toBe(true);
    expect(eventMatches(f, [])).toBe(false);
    expect(eventMatches({ title: "Lunch", notes: "dentist" }, searchWords("dentist")), "events carry no notes").toBe(false);
  });

  it("results by the day they start: today on, soonest first, then earlier, newest first", () => {
    const today = day(2026, 11, 24, 10);
    const a = ev({ title: "Dentist", start: iso(2026, 11, 24, 15), end: iso(2026, 11, 24, 16) });
    const b = ev({ title: "Dentist again", start: iso(2026, 12, 8, 9), end: iso(2026, 12, 8, 10) });
    const c = ev({ title: "Dentist", start: iso(2026, 11, 24, 8), end: iso(2026, 11, 24, 9) });
    const d = ev({ title: "Old dentist", start: iso(2026, 6, 1, 9), end: iso(2026, 6, 1, 10) });
    const e = ev({ title: "Dentist long ago", start: iso(2025, 6, 1, 9), end: iso(2025, 6, 1, 10) });
    const other = ev({ title: "Lunch", start: iso(2026, 11, 25, 12), end: iso(2026, 11, 25, 13) });
    const r = searchEvents([e, other, b, a, d, c], "dentist", today);
    expect(r.total).toBe(5);
    expect(r.upcoming.map((g) => [g.date, g.events.map((x) => x.fields.title)])).toEqual([
      ["2026-11-24", ["Dentist", "Dentist"]],
      ["2026-12-08", ["Dentist again"]],
    ]);
    expect(r.upcoming[0].events.map((x) => x.id), "earlier start first inside a day").toEqual([c.id, a.id]);
    expect(r.earlier.map((g) => g.date)).toEqual(["2026-06-01", "2025-06-01"]);
    const few = searchEvents([e, b, a, d, c], "dentist", today, 3);
    expect(few.total).toBe(5);
    expect(few.upcoming.flatMap((g) => g.events).length + few.earlier.flatMap((g) => g.events).length).toBe(3);
    expect(few.earlier.map((g) => g.date), "the limit takes upcoming ones first").toEqual([]);
    expect(searchEvents([a], "   ", today)).toEqual({ upcoming: [], earlier: [], total: 0 });
  });
});

describe("calendar views: the hidden calendars in the feel setting", () => {
  it("are read from the hub's answer or a cached copy; a list that breaks a rule hides nothing", async () => {
    const { cleanPatch, viewFrom } = await import("../feel/prefs");
    expect(viewFrom({}).hidden_calendars).toEqual([]);
    expect(viewFrom({ hidden_calendars: ["apple:iCloud/Home", "aeneas"] }).hidden_calendars).toEqual(["apple:iCloud/Home", "aeneas"]);
    expect(viewFrom({ hidden_calendars: ["a", "a"] }).hidden_calendars).toEqual([]);
    expect(cleanPatch({ hidden_calendars: "aeneas" })).toEqual({});
  });
});

describe("calendar views: events side by side", () => {
  const lanes = (spans: [string, number, number][]) =>
    Object.fromEntries([...eventLanes(spans.map(([id, start, end]) => ({ id, start, end })))].map(([id, l]) => [id, `${l.lane}/${l.lanes}`]));
  it("events that do not overlap take the full width, one ending as the next starts included", () => {
    expect(lanes([["a", 540, 600], ["b", 600, 660]])).toEqual({ a: "0/1", b: "0/1" });
  });
  it("two that overlap share the width, the earlier on the left", () => {
    expect(lanes([["board", 1140, 1320], ["climb", 1080, 1170]])).toEqual({ climb: "0/2", board: "1/2" });
  });
  it("a chain of overlaps shares one lane count, and a lane is used again once it is free", () => {
    expect(lanes([["a", 540, 660], ["b", 600, 720], ["c", 660, 780]])).toEqual({ a: "0/2", b: "1/2", c: "0/2" });
  });
  it("three at once take three lanes, and a later event on its own takes the full width", () => {
    expect(lanes([["a", 540, 600], ["b", 540, 600], ["c", 540, 600], ["d", 720, 780]])).toEqual({ a: "0/3", b: "1/3", c: "2/3", d: "0/1" });
  });
  it("at the same start the longer goes first", () => {
    expect(lanes([["short", 540, 600], ["long", 540, 720]])).toEqual({ long: "0/2", short: "1/2" });
  });
});
