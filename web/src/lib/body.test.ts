import { describe, expect, it } from "vitest";
import { csvFilename, custodyLabel, custodyNow, fmtDelta, mealForTime, mergeMeds, sensorState, sensorTone } from "./body";

const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m);

describe("mealForTime", () => {
  it("is lunch before 15:00 and dinner from 15:00", () => {
    expect(mealForTime(at(9))).toBe("lunch");
    expect(mealForTime(at(14, 59))).toBe("lunch");
    expect(mealForTime(at(15))).toBe("dinner");
    expect(mealForTime(at(22))).toBe("dinner");
  });
  it("is snack when toggled, whatever the hour", () => {
    expect(mealForTime(at(9), true)).toBe("snack");
    expect(mealForTime(at(20), true)).toBe("snack");
  });
});

describe("mergeMeds", () => {
  it("fills expected chips from today's logs by drug name, case and dose insensitive", () => {
    const chips = mergeMeds(["Claritin", "Vitamin D", "Lisinopril"], ["claritin 30mg", "Lisinopril"]);
    expect(chips.map((c) => [c.name, c.taken])).toEqual([
      ["Claritin", true],
      ["Vitamin D", false],
      ["Lisinopril", true],
    ]);
    expect(chips.every((c) => !c.extra)).toBe(true);
  });
  it("appends meds logged today that are not expected, once each", () => {
    const chips = mergeMeds(["Claritin"], ["Ibuprofen", "ibuprofen 200", "Claritin"]);
    expect(chips).toEqual([
      { name: "Claritin", taken: true, extra: false },
      { name: "Ibuprofen", taken: true, extra: true },
    ]);
  });
  it("handles empty lists", () => {
    expect(mergeMeds([], [])).toEqual([]);
    expect(mergeMeds(["", " "], [])).toEqual([]);
  });
});

describe("sensorState and sensorTone", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("trusts the hub's state when given", () => {
    expect(sensorState({ state: "high", last_value: 1, last_at: now.toISOString(), min: 5 }, now)).toBe("high");
  });
  it("derives low, high, ok and stale", () => {
    const fresh = new Date(now.getTime() - 10 * 60_000).toISOString();
    expect(sensorState({ last_value: 18, last_at: fresh, min: 20, max: 60 }, now)).toBe("low");
    expect(sensorState({ last_value: 65, last_at: fresh, min: 20, max: 60 }, now)).toBe("high");
    expect(sensorState({ last_value: 40, last_at: fresh, min: 20, max: 60 }, now)).toBe("ok");
    const old = new Date(now.getTime() - 200 * 60_000).toISOString();
    expect(sensorState({ last_value: 40, last_at: old, min: 20, max: 60 }, now)).toBe("stale");
    expect(sensorState({ last_value: 40, last_at: old, stale_minutes: 300 }, now)).toBe("ok");
    expect(sensorState({}, now)).toBe("stale");
  });
  it("maps states to tones", () => {
    expect(sensorTone("ok")).toBe("ok");
    expect(sensorTone("low")).toBe("warn");
    expect(sensorTone("high")).toBe("warn");
    expect(sensorTone("stale")).toBe("muted");
  });
});

describe("small formatters", () => {
  it("signs deltas", () => {
    expect(fmtDelta(1.25)).toBe("+1.3");
    expect(fmtDelta(-0.8)).toBe("-0.8");
    expect(fmtDelta(0)).toBe("0.0");
    expect(fmtDelta(null)).toBe("");
  });
  it("words custody", () => {
    expect(custodyLabel(true)).toBe("With you this week");
    expect(custodyLabel(false)).toBe("At the other home this week");
    expect(custodyLabel(null)).toBe("Custody not set");
  });
});

describe("custody from handoffs", () => {
  const sunday = new Date(2026, 9, 25, 12, 0, 0).toISOString();
  const ev = (id: string, fields: Record<string, unknown>) => ({ id, fields: { pet: "Pepper", type: "custody", ...fields } });
  it("is unknown until a handoff is logged", () => {
    expect(custodyNow([ev("a", { at: sunday })])).toBeNull();
  });
  it("predicts a week out when nothing says otherwise", () => {
    expect(custodyNow([ev("a", { at: sunday, with: "other" })], new Date(2026, 9, 28, 9))!.next).toBe(new Date(2026, 10, 1, 12).toISOString());
  });
  it("keeps the cycle on record for a handoff logged without one", () => {
    const events = [ev("a", { at: sunday, with: "other", cycle_days: 14 }), ev("b", { at: new Date(2026, 10, 8, 12).toISOString(), with: "me" })];
    expect(custodyNow(events, new Date(2026, 10, 9))!.cycleDays).toBe(14);
  });
  it("predicts two weeks out on a two week cycle and keeps alternating when nothing is logged", () => {
    const c = custodyNow([ev("a", { at: sunday, with: "other", cycle_days: 14 })], new Date(2026, 9, 28, 9))!;
    expect(c.withMe).toBe(false);
    expect(c.next).toBe(new Date(2026, 10, 8, 12).toISOString());
    const later = custodyNow([ev("a", { at: sunday, with: "other", cycle_days: 14 })], new Date(2026, 10, 10, 9))!;
    expect(later.withMe).toBe(true);
    expect(later.next).toBe(new Date(2026, 10, 22, 12).toISOString());
  });
  it("lets the newest handoff and a hand-set next date win", () => {
    const events = [ev("a", { at: sunday, with: "other" }), ev("b", { at: new Date(2026, 10, 5, 18).toISOString(), with: "me", next_due: new Date(2026, 10, 15, 10).toISOString() })];
    const c = custodyNow(events, new Date(2026, 10, 6))!;
    expect(c.handoff.id).toBe("b");
    expect(c.withMe).toBe(true);
    expect(c.next).toBe(new Date(2026, 10, 15, 10).toISOString());
  });
});

describe("csvFilename", () => {
  it("names the local day, not the UTC day that turns over in the evening", () => {
    expect(csvFilename("garage", 7, new Date(2026, 10, 4, 21, 30))).toBe("garage-7d-2026-11-04.csv");
  });
});
