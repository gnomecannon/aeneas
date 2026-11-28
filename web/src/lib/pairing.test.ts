import { describe, expect, it } from "vitest";
import { newlyPaired } from "./pairing";
import type { DeviceRow } from "../sync/api";

const row = (id: string, name: string, current = false): DeviceRow => ({ id, name, platform: "iphone", last_seen: null, paired_at: null, own_key: true, current });

describe("a device paired while the code shows", () => {
  it("is the one the hub lists that was not there when the code was made", () => {
    const before = new Set(["a", "me"]);
    expect(newlyPaired(before, [row("me", "This Mac", true), row("a", "iPad")])).toBeNull();
    expect(newlyPaired(before, [row("me", "This Mac", true), row("a", "iPad"), row("b", "Jamie's iPhone")])?.name).toBe("Jamie's iPhone");
  });

  it("is never this device, even when it was not in the list before", () => {
    expect(newlyPaired(new Set(), [row("me", "This browser", true)])).toBeNull();
  });
});
