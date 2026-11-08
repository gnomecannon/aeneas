import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { followUpsDue, regularMeds } from "./today";

let n = 0;
function e(kind: string, fields: Record<string, unknown>): Entity {
  n += 1;
  return { id: `id${n}`, kind, space: "personal", fields, field_ts: {}, created_at: "", updated_at: "", deleted_at: null } as unknown as Entity;
}

describe("followUpsDue", () => {
  it("keeps open applications due by tonight, oldest first", () => {
    const now = new Date(2026, 9, 28, 12, 0);
    const late = e("application", { company: "A", stage: "applied", next_at: new Date(2026, 9, 26, 9).toISOString() });
    const tonight = e("application", { company: "B", stage: "screen", next_at: new Date(2026, 9, 28, 20).toISOString() });
    const tomorrow = e("application", { company: "C", stage: "applied", next_at: new Date(2026, 9, 29, 9).toISOString() });
    const closed = e("application", { company: "D", stage: "rejected", next_at: new Date(2026, 9, 27, 9).toISOString() });
    const none = e("application", { company: "E", stage: "saved" });
    expect(followUpsDue([tonight, tomorrow, closed, none, late], now).map((x) => x.fields.company)).toEqual(["A", "B"]);
  });
});

describe("regularMeds", () => {
  const now = new Date(2026, 9, 28, 12, 0);
  const at = (daysAgo: number, h = 8) => new Date(2026, 9, 28 - daysAgo, h).toISOString();
  it("needs two different days in the last week, and says when today's was taken", () => {
    const logs = [
      e("log", { type: "med", value: "Claritin", at: at(1) }),
      e("log", { type: "med", value: "claritin", at: at(2) }),
      e("log", { type: "med", value: "Claritin", at: at(0, 9) }),
      e("log", { type: "med", value: "Ibuprofen", at: at(3) }),
      e("log", { type: "med", value: "Ibuprofen", at: at(3, 20) }),
      e("log", { type: "med", value: "Zyrtec", at: at(1) }),
      e("log", { type: "med", value: "Zyrtec", at: at(4) }),
      e("log", { type: "med", value: "Old", at: at(10) }),
      e("log", { type: "med", value: "Old", at: at(12) }),
      e("log", { type: "caffeine", value: 1, at: at(1) }),
    ];
    expect(regularMeds(logs, now)).toEqual([
      { name: "Claritin", takenAt: at(0, 9) },
      { name: "Zyrtec", takenAt: null },
    ]);
  });
});
