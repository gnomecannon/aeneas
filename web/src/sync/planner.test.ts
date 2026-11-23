import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { db } from "./db";
import { localConflict, localWeek } from "./planner";

const at = "2026-11-01T10:00:00.000Z";
const event = (id: string, fields: Record<string, unknown>): Entity => ({ id, kind: "event", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields, field_ts: {} });
const rule = (id: string, fields: Record<string, unknown>): Entity => ({ id, kind: "plan_rule", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields, field_ts: {} });

describe("the offline clash check", () => {
  beforeEach(async () => {
    await db.entities.clear();
  });

  it("compares moments, not text, when an event keeps its offset", async () => {
    // 7 to 9 PM at -05:00 is midnight to 2 AM UTC, the same moments in any zone.
    await db.entities.put(event("e1", { title: "Dinner with Robin", start: "2026-11-16T19:00:00-05:00", end: "2026-11-16T21:00:00-05:00" }));
    // A block from 23:30 UTC runs into the dinner; as text it looked clear.
    expect(await localConflict("t1", { start: "2026-11-16T23:30:00.000Z", end: "2026-11-17T02:30:00.000Z" })).toMatchObject({ kind: "event", title: "Dinner with Robin" });
    // A block from 19:00 to 22:00 UTC ends two hours before it; as text it looked like a clash.
    expect(await localConflict("t1", { start: "2026-11-16T19:00:00.000Z", end: "2026-11-16T22:00:00.000Z" })).toBeNull();
  });
});

describe("an info rule with the hub out of reach", () => {
  beforeEach(async () => {
    await db.entities.clear();
  });

  // The hub: "Info rules (a custody week) take no time and weigh no slot". Offline the whole day read as taken.
  it("takes no free time and stops no block, as on the hub", async () => {
    const clear = await localWeek("2030-01-07");
    await db.entities.put(rule("r1", { title: "Pepper weeks", type: "info", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "24:00", active: true }));
    const week = await localWeek("2030-01-07");
    expect(week.days[0].commitments.map((c) => c.title)).toEqual(["Pepper weeks"]);
    expect(clear.days[0].free_slots.length).toBeGreaterThan(0);
    expect(week.days[0].free_slots).toEqual(clear.days[0].free_slots);
    expect(await localConflict("t1", { start: "2030-01-07T19:00:00.000Z", end: "2030-01-07T22:00:00.000Z" })).toBeNull();
  });
});
