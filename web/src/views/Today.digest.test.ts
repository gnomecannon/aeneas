import { describe, expect, it } from "vitest";
import { digestBody } from "./Today";

describe("digestBody", () => {
  it("drops the Now sentence the Now card already shows", () => {
    expect(digestBody("Nothing queued\nNo blocks today")).toBe("No blocks today");
    expect(digestBody("No blocks today\nPeople: Devon at 11:30; Grammy's birthday Fri")).toBe("No blocks today");
    expect(digestBody("Wed Oct 28. Nothing queued.\n2 blocks, 1 fixed, 0 reminders.")).toBe("2 blocks, 1 fixed, 0 reminders.");
    expect(digestBody("Wed Oct 28. Now: Fix the NAS until 3:00 PM.\nFree: 2 h at 4:00 PM.")).toBe("Free: 2 h at 4:00 PM.");
  });
});
