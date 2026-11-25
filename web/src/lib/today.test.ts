import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { regularMeds } from "./today";

let n = 0;
function e(kind: string, fields: Record<string, unknown>): Entity {
  n += 1;
  return { id: `id${n}`, kind, space: "personal", fields, field_ts: {}, created_at: "", updated_at: "", deleted_at: null } as unknown as Entity;
}

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

  it("after midnight, yesterday's dose no longer counts as taken today", () => {
    const logs = [at(2), at(1), at(0, 9)].map((when) => e("log", { type: "med", value: "Claritin", at: when }));
    expect(regularMeds(logs, now)).toEqual([{ name: "Claritin", takenAt: at(0, 9) }]);
    expect(regularMeds(logs, new Date(2026, 9, 29, 0, 1))).toEqual([{ name: "Claritin", takenAt: null }]);
  });
});
