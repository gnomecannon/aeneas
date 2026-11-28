import { describe, expect, it } from "vitest";
import { lastSynced, pairAgainText, unreachableLine } from "./lastSynced";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

describe("how long since the last sync", () => {
  it("is unsaid for the first hour, then hours, then days", () => {
    expect(lastSynced(undefined, NOW)).toBeNull();
    expect(lastSynced(NOW - 59 * 60_000, NOW)).toBeNull();
    expect(lastSynced(NOW - H, NOW)).toBeNull();
    expect(lastSynced(NOW - 61 * 60_000, NOW)).toBe("last synced 1 h ago");
    expect(lastSynced(NOW - 47.5 * H, NOW)).toBe("last synced 47 h ago");
    expect(lastSynced(NOW - 48 * H, NOW)).toBe("last synced 2 days ago");
    expect(lastSynced(NOW - 10.4 * 24 * H, NOW)).toBe("last synced 10 days ago");
  });

  it("follows local copy, hub unreachable on Today and Week", () => {
    expect(unreachableLine(NOW - 5 * 60_000, NOW)).toBe("local copy, hub unreachable");
    expect(unreachableLine(undefined, NOW)).toBe("local copy, hub unreachable");
    expect(unreachableLine(NOW - 3 * H, NOW)).toBe("local copy, hub unreachable, last synced 3 h ago");
  });
});

describe("the Pair again banner", () => {
  it("shows only while pairing again is what helps", () => {
    expect(pairAgainText(undefined, "offline")).toBeNull();
    expect(pairAgainText("key", "synced")).toBeNull();
    expect(pairAgainText("key", "setup")).toBeNull();
    expect(pairAgainText("key", "offline")?.title).toBe("This device needs to be paired again");
    expect(pairAgainText("other_hub", "offline")?.title).toBe("This address leads to another hub");
    expect(pairAgainText("other_hub", "syncing")).not.toBeNull();
  });
});
