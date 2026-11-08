import { describe, expect, it } from "vitest";
import { HubError } from "./api";
import { conflictMessage } from "./planner";

// The hub's 409 from POST /planner/schedule, as it sends it: the clash beside `error`, its kind under `type`.
// The web read only `detail` and `kind`, so Today and Week said just "conflict".
describe("schedule conflict message", () => {
  it("names what the block overlaps and when", () => {
    const e = new HubError(409, "conflict", { conflict: { type: "block", task_id: "t1", title: "Audit block A", start: "2026-11-05T18:00:00.000Z", end: "2026-11-05T20:00:00.000Z" } });
    expect(conflictMessage(e)).toMatch(/^Overlaps block: Audit block A, /);
  });
  it("still reads a detail in the older shape, and says something useful without one", () => {
    expect(conflictMessage(new HubError(409, "conflict", { kind: "event", title: "Dentist", start: "2026-11-05T18:00:00.000Z", end: "2026-11-05T19:00:00.000Z" }))).toMatch(/^Overlaps event: Dentist/);
    expect(conflictMessage(new HubError(409, "conflict"))).toBe("conflict");
    expect(conflictMessage(new HubError(500, "x"))).toBeNull();
  });
});
