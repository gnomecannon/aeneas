import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDuration, hoursSince } from "./time";

describe("time helpers for the Status view", () => {
  it("formats durations at the two largest units", () => {
    expect(fmtDuration(40)).toBe("40s");
    expect(fmtDuration(250)).toBe("4m 10s");
    expect(fmtDuration(7500)).toBe("2h 5m");
    expect(fmtDuration(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
  });

  it("formats byte counts", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(12.3 * 1024 * 1024)).toBe("12 MB");
    expect(fmtBytes(-1)).toBe("?");
  });

  it("measures backup age in hours and treats a missing backup as infinitely old", () => {
    const from = new Date("2026-10-22T12:00:00Z");
    expect(hoursSince("2026-10-22T06:00:00Z", from)).toBe(6);
    expect(hoursSince("2026-10-21T00:00:00Z", from)).toBe(36);
    expect(hoursSince(null, from)).toBe(Infinity);
    expect(hoursSince("garbage", from)).toBe(Infinity);
  });
});
