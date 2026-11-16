import { describe, expect, it } from "vitest";
import { OWN_KEY_SAVE, type Connections } from "./api";
import { connectionsSummary } from "../views/settings/Connections";

describe("guided setup", () => {
  it("sends a guide's fields only to the hub's own setup routes, iCloud Mail's link included", () => {
    for (const p of ["/connections/google/app", "/connections/atlassian/app", "/connections/steam/key", "/connections/icloud"]) expect(OWN_KEY_SAVE.test(p)).toBe(true);
    // A guide that names anything else (another route, a sub-path, another host) gets nothing typed into it.
    for (const p of ["/connections/icloud/sync", "/connections/icloud/x", "/connections/icloudx", "/setup/pair", "https://evil.example/connections/icloud", "//evil.example/connections/icloud", "/connections/icloud?to=x"]) expect(OWN_KEY_SAVE.test(p)).toBe(false);
  });

  it("names iCloud Mail among the linked accounts", () => {
    const c = { steam: { connected: false, hub_key: false }, letterboxd: { connected: false }, health: { last_import: null, samples: 0, total: 0 }, icloud: { accounts: [{ email: "robin@icloud.example" }] } } as unknown as Connections;
    expect(connectionsSummary(c)).toBe("iCloud Mail");
    expect(connectionsSummary(null)).toContain("iCloud Mail");
  });
});
