import { describe, expect, it } from "vitest";
import { checkPreflight, rollbackText } from "./preflight";
import type { PreflightCheck } from "./api";

const hit: PreflightCheck = {
  destructive: true,
  name: "zfs destroy",
  command: "zfs destroy -r tank/scratch",
  backup: "Back up: `zfs snapshot <dataset>@pre-destroy` and send it off the pool.",
  verify: "Verify: `zfs list -r -t all <dataset>`; check for children, clones and holds.",
  rollback: "Rollback: receive the sent snapshot back. A destroyed dataset is gone from the pool.",
  block: "Pre-flight for `zfs destroy -r tank/scratch` (zfs destroy):\n- Back up: ...",
};

describe("journal pre-flight", () => {
  it("passes the hub's answer through for a destructive command", async () => {
    const seen: string[] = [];
    const r = await checkPreflight("zfs destroy -r tank/scratch", { preflight: async (t) => (seen.push(t), hit) });
    expect(r).toEqual(hit);
    expect(seen).toEqual(["zfs destroy -r tank/scratch"]);
  });

  it("is null for harmless text and never asks about blank text", async () => {
    let asked = 0;
    const client = { preflight: async () => (asked++, { destructive: false }) as PreflightCheck };
    expect(await checkPreflight("zpool status", client)).toBeNull();
    expect(await checkPreflight("   ", client)).toBeNull();
    expect(asked).toBe(1);
  });

  it("stays quiet offline: no client, or the hub cannot be reached", async () => {
    expect(await checkPreflight("rm -rf /srv/old", null)).toBeNull();
    expect(await checkPreflight("rm -rf /srv/old", { preflight: () => Promise.reject(new TypeError("Failed to fetch")) })).toBeNull();
  });

  it("drops the label when filling the rollback field", () => {
    expect(rollbackText(hit as Extract<PreflightCheck, { destructive: true }>)).toBe("receive the sent snapshot back. A destroyed dataset is gone from the pool.");
  });
});
