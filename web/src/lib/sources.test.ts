import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { db } from "../sync/db";
import { localToday, localWeek } from "../sync/planner";
import { isShown, keepSources, shownOnly } from "./sources";
import { localDate } from "./planner";

const at = "2026-11-01T10:00:00.000Z";
const task = (id: string, fields: Record<string, unknown>): Entity => ({ id, kind: "task", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields: { status: "next", order: 1, ...fields }, field_ts: {} });
const SHOP = { key: "icloud:iCloud/Shopping", title: "Shopping", on: false };
const TODO = { key: "icloud:iCloud/To do", title: "To do", on: true };

describe("tasks of a Reminders list that is switched off", () => {
  afterEach(async () => {
    keepSources(null);
    await db.entities.clear();
  });

  it("are hidden by its key, or by its name for a link an older app made", () => {
    keepSources({ lists: [SHOP, TODO] } as never);
    const milk = task("t1", { title: "Oat milk", apple: { id: "a1", list: "L", list_key: SHOP.key, list_title: "Shopping" } });
    const eggs = task("t2", { title: "Eggs", apple: { id: "a2", list: "L", list_title: "Shopping" } });
    const call = task("t3", { title: "Call the plumber", apple: { id: "a3", list: "L", list_key: TODO.key, list_title: "To do" } });
    const plain = task("t4", { title: "Water the plants" });
    const note: Entity = { ...plain, id: "n1", kind: "note", fields: { title: "Shopping", apple: { list_title: "Shopping" } } };
    expect(shownOnly([milk, eggs, call, plain, note]).map((e) => e.id)).toEqual(["t3", "t4", "n1"]);
    // On again (or a hub from before the setting, which has none): nothing is hidden.
    keepSources({ lists: [{ ...SHOP, on: true }, TODO] } as never);
    expect(isShown(milk)).toBe(true);
    keepSources(null);
    expect(isShown(eggs)).toBe(true);
  });

  it("stay out of the offline Today and week", async () => {
    keepSources({ lists: [SHOP, TODO] } as never);
    const now = new Date();
    // Noon today: "in 30 minutes" fell on tomorrow when the tests ran after 11:30 PM.
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    const soon = noon.toISOString();
    await db.entities.bulkPut([
      task("t1", { title: "Oat milk", status: "scheduled", remind_at: soon, apple: { id: "a1", list: "L", list_key: SHOP.key, list_title: "Shopping" } }),
      task("t3", { title: "Call the plumber", status: "scheduled", remind_at: soon, apple: { id: "a3", list: "L", list_key: TODO.key, list_title: "To do" } }),
      task("t5", { title: "Buy stamps", status: "next", apple: { id: "", list: "", list_title: "Shopping" } }),
    ]);
    const today = await localToday();
    expect(today.reminders_due.map((t) => t.id)).toEqual(["t3"]);
    expect(today.next.map((t) => t.id)).toEqual([]);
    const week = await localWeek(localDate(now));
    expect(week.days.flatMap((d) => d.reminders).map((t) => t.id)).not.toContain("t1");
  });
});
