import { describe, expect, it } from "vitest";
import { joinedHubName, parseJoinLink } from "./join";
import { appLinkRoute } from "../tauri/bridge";
import { afterPairing } from "../lib/router";

const node = "b".repeat(64);
const relay = "https://euc1-1.relay.n0.iroh.link./";
// The shared test vector's secret: bytes 0 to 31.
const s = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const link = (over: Record<string, string | null> = {}) => {
  const f: Record<string, string | null> = { node, relay, s, name: "Jamie's PC", platform: "windows", ...over };
  return "everythingapp://join?" + Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
};

describe("a join code", () => {
  it("is read as the new device wrote it", () => {
    expect(parseJoinLink(link())).toEqual({ node, relay, s, name: "Jamie's PC", platform: "windows" });
    // The key is sent as the hub expects it, in lowercase.
    expect(parseJoinLink(link({ node: "B".repeat(64) }))?.node).toBe(node);
    expect(parseJoinLink(link({ platform: "android" }))?.platform).toBe("android");
  });

  it("refuses a key that is not 64 hex characters", () => {
    expect(parseJoinLink(link({ node: "b".repeat(63) }))).toBeNull();
    expect(parseJoinLink(link({ node: "g".repeat(64) }))).toBeNull();
    expect(parseJoinLink(link({ node: null }))).toBeNull();
  });

  it("refuses a secret that is not 32 bytes", () => {
    expect(parseJoinLink(link({ s: s.slice(0, 42) }))).toBeNull();
    expect(parseJoinLink(link({ s: s + "A" }))).toBeNull();
    // 43 characters whose last one carries bits past the 32nd byte.
    expect(parseJoinLink(link({ s: s.slice(0, 42) + "9" }))).toBeNull();
    expect(parseJoinLink(link({ s: s.slice(0, 42) + "=" }))).toBeNull();
    expect(parseJoinLink(link({ s: null }))).toBeNull();
  });

  it("refuses a missing relay or one that is not https", () => {
    expect(parseJoinLink(link({ relay: null }))).toBeNull();
    expect(parseJoinLink(link({ relay: "" }))).toBeNull();
    expect(parseJoinLink(link({ relay: "http://euc1-1.relay.n0.iroh.link./" }))).toBeNull();
    expect(parseJoinLink(link({ relay: "not a url" }))).toBeNull();
  });

  it("refuses a missing name or an unknown kind of device", () => {
    expect(parseJoinLink(link({ name: "  " }))).toBeNull();
    expect(parseJoinLink(link({ platform: "linux" }))).toBeNull();
    expect(parseJoinLink(link({ platform: null }))).toBeNull();
  });

  it("opens the join screen from the Camera, and only for the app's own links", () => {
    expect(appLinkRoute(link())).toBe(`/join?${link().split("?")[1]}`);
    expect(appLinkRoute("everythingapp://setup?code=ABCD-EFGH")).toBe("/setup?code=ABCD-EFGH");
    expect(appLinkRoute("https://example.com/join?node=x")).toBeNull();
    expect(appLinkRoute("everythingapp://other?x=1")).toBeNull();
  });

  it("is never the screen a device returns to after pairing", () => {
    expect(afterPairing(`/join?node=${node}&s=${s}`, "/tasks")).toBe("/tasks");
    expect(afterPairing(`/join?node=${node}&s=${s}`, null)).toBe("/now");
    expect(afterPairing("/setup?code=A", `/join?node=${node}`)).toBe("/now");
  });
});

describe("the hub a device joined", () => {
  it("is named as the hub names itself, else by the start of its key", () => {
    expect(joinedHubName({ hubName: "Alex", owner: "Jamie", named: true }, "a".repeat(64))).toBe("Alex’s hub");
    expect(joinedHubName({ hubName: null, owner: "Jamie", named: true }, "a".repeat(64))).toBe("Jamie’s hub");
    expect(joinedHubName({ owner: "Owner", named: false }, "0123456789abcdef")).toBe("the hub with key 0123456789");
  });
});
