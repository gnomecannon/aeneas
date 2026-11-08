import { describe, expect, it } from "vitest";
import { frictionItems, nowHeld } from "./proof";
import type { ProofDay, ProofRun } from "../sync/api";

// The hub's answer as the contract gives it (GET /metrics/proof). The web once read an older draft of this shape
// (friction as a list, days as rows), and the Status screen threw and blanked the whole app.
const day = (d: string, extra: Partial<ProofDay> = {}): ProofDay => ({
  day: d, captures_created: 1, captures_auto_sorted: 0, tasks_done: 0, reminders_fired: 0, reminders_acked: 0, reminders_snoozed: 0,
  logs_created: 0, notes_edited: 0, ai_calls: 0, health_logs: 0, blocks_scheduled: 0, blocks_completed: 0, incidents_opened: 0,
  now_at_0900: null, next_or_doing_eod: 0, ...extra,
});
const report: ProofRun = {
  days: 2, from: "2026-11-04", to: "2026-11-05",
  rows: [day("2026-11-04", { now_at_0900: true }), day("2026-11-05", { next_or_doing_eod: 2 })],
  totals: { captures_created: 2, days_with_now_at_0900: 1, days_now_unknown: 1 },
  friction: {
    captures_stale: [{ id: "c1", text: "call the vet", created_at: "2026-11-03T10:00:00Z", age_h: 40 }],
    reminders_snoozed_3plus: [{ id: "r1", title: "Meds", snoozes: 4 }],
    tasks_parked_7d: [{ id: "t1", title: "Fix the fence", parked_since: "2026-10-20T00:00:00Z", days: 16 }],
  },
};

describe("proof run", () => {
  it("lists the hub's three friction lists as one list of links", () => {
    expect(frictionItems(report.friction)).toEqual([
      { kind: "capture", id: "c1", title: "call the vet", detail: "unsorted for 40 h" },
      { kind: "reminder", id: "r1", title: "Meds", detail: "snoozed 4 times" },
      { kind: "task", id: "t1", title: "Fix the fence", detail: "parked 16 days" },
    ]);
    expect(frictionItems(undefined)).toEqual([]);
    expect(frictionItems({})).toEqual([]);
  });

  it("counts a day as held when proven at 09:00, or when the history cannot say and a task was there at day's end", () => {
    expect(report.rows.map(nowHeld)).toEqual([true, true]);
    expect(nowHeld(day("2026-11-03", { now_at_0900: false, next_or_doing_eod: 3 }))).toBe(false);
    expect(nowHeld(day("2026-11-03"))).toBe(false);
  });
});
