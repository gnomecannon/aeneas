import { describe, expect, it } from "vitest";
import { browserAccess, doorRefusal } from "./Link";
import { HubError, type LinkView } from "../../sync/api";

const base: LinkView = {
  method: "direct",
  options: { direct: { available: true }, tailscale: { available: true }, home: { available: true } },
  direct: { state: "online", connected: 0, direct: 0 },
};

describe("what a web browser can use", () => {
  it("says nothing new for an older hub", () => {
    expect(browserAccess(base)).toEqual({ addresses: [], door: null });
  });

  it("lists the browser addresses once each, and only web addresses", () => {
    const v = { ...base, browser: ["https://192.168.1.20:9788/app/", "https://192.168.1.20:9788/app/", "iroh://abc", "https://core.tail.ts.net:8787/app/"] };
    expect(browserAccess(v).addresses).toEqual(["https://192.168.1.20:9788/app/", "https://core.tail.ts.net:8787/app/"]);
  });

  it("offers the Tailscale door on a Direct link hub, with its address while it is on", () => {
    expect(browserAccess({ ...base, tailscale_door: { available: true, on: false, url: null } }).door).toEqual({ state: "off", url: null, how: null, error: null });
    expect(browserAccess({ ...base, tailscale_door: { available: true, on: true, url: "https://core.tail.ts.net:8787" } }).door)
      .toEqual({ state: "on", url: "https://core.tail.ts.net:8787", how: null, error: null });
  });

  it("says why the door is not there, and what went wrong with it", () => {
    const how = "Tailscale is not running on the hub's computer.";
    expect(browserAccess({ ...base, tailscale_door: { available: false, on: false, url: null, how } }).door).toEqual({ state: "unavailable", url: null, how, error: null });
    expect(browserAccess({ ...base, tailscale_door: { available: true, on: true, url: "https://x:1", error: "Tailscale stopped serving." } }).door?.error).toBe("Tailscale stopped serving.");
  });

  it("leaves the door out on a hub that is not on Direct link", () => {
    expect(browserAccess({ ...base, method: "tailscale", browser: ["https://core.tail.ts.net:8787/app/"], tailscale_door: { available: false, on: false, url: null, how: "Only for Direct link." } }))
      .toEqual({ addresses: ["https://core.tail.ts.net:8787/app/"], door: null });
  });

  it("shows the hub's reason when it refuses the door", () => {
    expect(doorRefusal(new HubError(409, "Tailscale needs sudo tailscale set --operator=jamie once."))).toBe("Tailscale needs sudo tailscale set --operator=jamie once.");
    expect(doorRefusal(new HubError(409, "not available", { how: "Tailscale is not running on the hub's computer." }))).toBe("Tailscale is not running on the hub's computer.");
  });
});
