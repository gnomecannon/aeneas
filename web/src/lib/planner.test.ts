import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import {
  atMinutes,
  buildDigest,
  commitmentsFor,
  daysLeft,
  findConflict,
  fmtDaysLeft,
  freeSlots,
  gridPlacement,
  groupWatches,
  hhmmToMinutes,
  hourRows,
  localDate,
  minutesAtFraction,
  minutesToHhmm,
  mondayOf,
  overlaps,
  parseLocalDate,
  ruleAppliesOn,
  timeline,
  weekdayOf,
  weeksFromAnchor,
} from "./planner";

// A Thursday. Everything below is built with local-time constructors so the tests hold in any zone.
const THU = new Date(2026, 9, 22);
const at = (h: number, m = 0, d = THU) => atMinutes(d, h * 60 + m).toISOString();

function ent(kind: Entity["kind"], fields: Record<string, unknown>, id = `${kind}-${Math.random().toString(36).slice(2, 8)}`): Entity {
  return { id, kind, space: "personal", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", deleted_at: null, fields, field_ts: {} };
}

describe("local dates", () => {
  it("formats and parses local calendar dates", () => {
    expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(parseLocalDate("2026-01-05").getTime()).toBe(new Date(2026, 0, 5).getTime());
  });
  it("finds the Monday of the week and weekday keys", () => {
    expect(localDate(mondayOf(THU))).toBe("2026-10-19");
    expect(localDate(mondayOf(new Date(2026, 9, 19)))).toBe("2026-10-19");
    expect(localDate(mondayOf(new Date(2026, 9, 25)))).toBe("2026-10-19");
    expect(weekdayOf(THU)).toBe("thu");
    expect(weekdayOf(new Date(2026, 9, 25))).toBe("sun");
  });
  it("converts HH:MM including 24:00", () => {
    expect(hhmmToMinutes("09:00")).toBe(540);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(hhmmToMinutes("x")).toBeNaN();
    expect(minutesToHhmm(1380)).toBe("23:00");
    expect(hourRows("09:00", "23:00")).toHaveLength(14);
    expect(hourRows("09:30", "22:30")).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });
});

describe("plan rules", () => {
  const custody = { days: ["mon", "wed"], start: "17:00", end: "20:00", alternating_anchor: "2026-10-05" };
  it("applies alternating rules only on even weeks from the anchor week", () => {
    expect(weeksFromAnchor("2026-10-05", new Date(2026, 9, 7))).toBe(0);
    expect(weeksFromAnchor("2026-10-05", new Date(2026, 9, 14))).toBe(1);
    expect(weeksFromAnchor("2026-10-05", new Date(2026, 9, 21))).toBe(2);
    expect(weeksFromAnchor("2026-10-08", new Date(2026, 8, 30))).toBe(-1);
    expect(ruleAppliesOn(custody, new Date(2026, 9, 7))).toBe(true); // Wed, week 0
    expect(ruleAppliesOn(custody, new Date(2026, 9, 14))).toBe(false); // Wed, week 1
    expect(ruleAppliesOn(custody, new Date(2026, 9, 21))).toBe(true); // Wed, week 2
    expect(ruleAppliesOn(custody, new Date(2026, 8, 30))).toBe(false); // Wed, week -1
    expect(ruleAppliesOn(custody, new Date(2026, 9, 22))).toBe(false); // Thu
  });
  it("skips inactive rules and builds spans on the date", () => {
    expect(ruleAppliesOn({ ...custody, active: false }, new Date(2026, 9, 7))).toBe(false);
    const rules = [
      ent("plan_rule", { title: "Standup", type: "commitment", days: ["mon", "tue", "wed", "thu", "fri"], start: "09:30", end: "10:00" }),
      ent("plan_rule", { title: "Kids", type: "blackout", ...custody }),
      ent("plan_rule", { title: "Deep", type: "preference", days: ["thu"], start: "10:00", end: "14:00", active: true }),
    ];
    const c = commitmentsFor(rules, THU);
    expect(c.map((x) => x.title)).toEqual(["Standup", "Deep"]);
    expect(c[0].start).toBe(at(9, 30));
    expect(c[0].end).toBe(at(10));
    expect(c[1].type).toBe("preference");
  });
});

describe("overlap and free slots", () => {
  it("detects strict overlap only", () => {
    expect(overlaps({ start: at(9), end: at(12) }, { start: at(11), end: at(13) })).toBe(true);
    expect(overlaps({ start: at(9), end: at(12) }, { start: at(12), end: at(13) })).toBe(false);
    expect(overlaps({ start: at(13), end: at(14) }, { start: at(9), end: at(12) })).toBe(false);
    const busy = [
      { start: at(9), end: at(10), title: "a" },
      { start: at(15), end: at(18), title: "b" },
    ];
    expect(findConflict({ start: at(14), end: at(17) }, busy)?.title).toBe("b");
    expect(findConflict({ start: at(10), end: at(13) }, busy)).toBeNull();
  });
  it("finds gaps of at least the minimum inside the day bounds, clipping edge spans", () => {
    const busy = [
      { start: at(9, 30), end: at(10) },
      { start: at(13), end: at(14) },
      { start: at(20), end: at(2, 0, new Date(2026, 9, 23)) },
      { start: at(3), end: at(5) },
    ];
    const slots = freeSlots(THU, busy, 3);
    expect(slots.map((s) => [s.start, s.end, s.hours])).toEqual([
      [at(10), at(13), 3],
      [at(14), at(20), 6],
    ]);
    expect(freeSlots(THU, busy, 4)).toHaveLength(1);
    expect(freeSlots(THU, [], 3)).toEqual([{ start: at(9), end: at(23), hours: 14 }]);
  });
});

describe("week grid placement", () => {
  it("places a span as percent offsets inside the 09:00 to 23:00 column", () => {
    expect(gridPlacement({ start: at(9), end: at(12, 30) }, THU)).toEqual({ top: 0, height: 25 });
    expect(gridPlacement({ start: at(16), end: at(23) }, THU)).toEqual({ top: 50, height: 50 });
  });
  it("clips spans that cross the day edges and drops spans outside", () => {
    const clipped = gridPlacement({ start: at(7), end: at(10) }, THU)!;
    expect(clipped.top).toBe(0);
    expect(clipped.height).toBeCloseTo(100 / 14);
    expect(gridPlacement({ start: at(22), end: at(1, 0, new Date(2026, 9, 23)) }, THU)!.height).toBeCloseTo(100 / 14);
    expect(gridPlacement({ start: at(6), end: at(8) }, THU)).toBeNull();
    expect(gridPlacement({ start: at(10, 0, new Date(2026, 9, 23)), end: at(12, 0, new Date(2026, 9, 23)) }, THU)).toBeNull();
  });
  it("snaps a pointer fraction to half hours and keeps the block start inside the day", () => {
    expect(minutesAtFraction(0)).toBe(540);
    expect(minutesAtFraction(0.5)).toBe(960);
    expect(minutesAtFraction(0.51)).toBe(960);
    expect(minutesAtFraction(1)).toBe(1380 - 30);
  });
});

describe("watches", () => {
  const now = new Date(2026, 9, 22, 15);
  it("counts whole local days to a date-only or datetime due", () => {
    expect(daysLeft("2026-10-22", now)).toBe(0);
    expect(daysLeft("2026-10-27", now)).toBe(5);
    expect(daysLeft("2026-10-19", now)).toBe(-3);
    expect(daysLeft(new Date(2026, 10, 1, 9).toISOString(), now)).toBe(10);
    expect(fmtDaysLeft(0)).toBe("today");
    expect(fmtDaysLeft(5)).toBe("in 5 d");
    expect(fmtDaysLeft(-3)).toBe("3 d overdue");
  });
  it("groups by overdue, next 30 days and later, sorted by due", () => {
    const g = groupWatches(
      [
        ent("watch", { title: "later", due: "2026-12-30" }),
        ent("watch", { title: "soon", due: "2026-11-10" }),
        ent("watch", { title: "edge", due: "2026-11-21" }),
        ent("watch", { title: "over", due: "2026-10-20" }),
        ent("watch", { title: "gone", due: "2026-10-01", deleted: true }, "x"),
      ].map((w) => (w.fields.deleted ? { ...w, deleted_at: "2026-10-02T00:00:00Z" } : w)),
      now,
    );
    expect(g.overdue.map((w) => w.fields.title)).toEqual(["over"]);
    expect(g.soon.map((w) => w.fields.title)).toEqual(["soon", "edge"]);
    expect(g.later.map((w) => w.fields.title)).toEqual(["later"]);
  });
});

describe("timeline and digest", () => {
  const day = {
    blocks: [{ task_id: "t1", title: "UPS", start: at(14), end: at(17), status: "scheduled" }],
    commitments: [{ rule_id: "r1", title: "Standup", type: "commitment" as const, start: at(9, 30), end: at(10) }],
    events: [ent("event", { title: "Dentist", start: at(11), end: at(12) }, "e1")],
    reminders: [ent("reminder", { title: "Meds", at: at(9, 30), friction: "none" }, "rm1")],
    free_slots: [{ start: at(18), end: at(23), hours: 5 }],
  };
  it("orders everything by time with the now marker and reminders before spans at the same time", () => {
    const items = timeline(day, new Date(2026, 9, 22, 12, 30));
    expect(items.map((i) => i.kind)).toEqual(["reminder", "commitment", "event", "now", "block", "free"]);
  });
  it("writes a two to four line digest", () => {
    const text = buildDigest(
      {
        now: ent("task", { title: "UPS", status: "doing", block: { start: at(14), end: at(17) } }),
        blocks: day.blocks,
        commitments: day.commitments,
        reminders_due: day.reminders,
        watches_due_soon: [ent("watch", { title: "Tailscale cert", due: "2026-10-27" })],
        captures_unprocessed: 2,
        free_slots: day.free_slots,
      },
      new Date(2026, 9, 22, 15),
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Thu Oct 22\. Now: UPS until /);
    expect(lines[1]).toMatch(/^1 block, 1 fixed, 1 reminder\. Free: 5 h at /);
    expect(lines[2]).toBe("Renewals: Tailscale cert in 5 d.");
    expect(lines[3]).toBe("2 waiting in Unsorted Info.");
    expect(text).not.toMatch(/[—–!]/);
  });
});

describe("all-day events", () => {
  it("cover their own local day, not the evening before, and show as All day on the timeline", async () => {
    const { spanOf: span, overlaps: over, daySpan: day, timeline: tl } = await import("./planner");
    const e = { id: "w", kind: "event", fields: { title: "Luigi's", all_day: true, start: "2026-10-31T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" } } as unknown as Entity;
    const s = span(e);
    expect(new Date(s.start).getDate()).toBe(31);
    expect(new Date(s.start).getHours()).toBe(0);
    expect(over(s, day(new Date(2026, 9, 31, 12)))).toBe(true);
    expect(over(s, day(new Date(2026, 9, 30, 12)))).toBe(false);
    const items = tl({ blocks: [], commitments: [], events: [e], reminders: [], free_slots: [] }, null);
    expect(items[0]).toMatchObject({ kind: "event", all_day: true });
  });
});
