import { describe, expect, it } from "vitest";
import { directAddress, directBase, isDirect, parseDirect, relayOwner } from "./direct";
import { HubClient, normalizeHubUrl } from "./api";
import { pastedLink } from "../views/Setup";

const node = "ab".repeat(32);
const relay = "https://use1-1.relay.n0.iroh.link./";

describe("Direct link addresses", () => {
  it("round-trips the key and relay, as the iPhone and Mac apps write them", () => {
    const a = directAddress(node, relay);
    expect(a).toBe(`iroh://${node}?relay=${encodeURIComponent(relay)}`);
    expect(parseDirect(a)).toEqual({ node, relay });
    expect(isDirect(a)).toBe(true);
    expect(normalizeHubUrl(a)).toBe(a);
  });

  it("refuses a short key or a relay that is not https", () => {
    expect(parseDirect(`iroh://abc?relay=${encodeURIComponent(relay)}`)).toBeNull();
    expect(parseDirect(`iroh://${node}?relay=${encodeURIComponent("http://relay.example")}`)).toBeNull();
    expect(parseDirect(`iroh://${node}`)).toBeNull();
  });

  it("makes request URLs on the key, keeping the relay for the request", () => {
    expect(directBase(directAddress(node, relay))).toBe(`iroh://${node}`);
    expect(new HubClient({ hubUrl: directAddress(node, relay), token: "" }).url("/health")).toBe(`iroh://${node}/health`);
    expect(new HubClient({ hubUrl: "core.example.ts.net", token: "" }).url("/health")).toBe("https://core.example.ts.net/health");
  });

  it("names n0's relays plainly", () => {
    expect(relayOwner(relay)).toBe("n0, the makers of iroh (free public relay)");
    expect(relayOwner("https://relay.example.org")).toBe("relay.example.org");
  });
});

describe("a pasted pairing link", () => {
  it("fills in a Direct link hub from the app link", () => {
    const p = pastedLink(`everythingapp://setup?code=ABCD-EFGH&name=Phone&link=direct&node=${node}&relay=${encodeURIComponent(relay)}`);
    expect(p?.get("hub")).toBe(directAddress(node, relay));
    expect(p?.get("code")).toBe("ABCD-EFGH");
    expect(p?.get("name")).toBe("Phone");
  });

  it("fills in an ordinary hub from the web link", () => {
    const p = pastedLink("https://core.example.ts.net/app/#/setup?hub=https%3A%2F%2Fcore.example.ts.net&code=ABCD-EFGH&name=Laptop");
    expect(p?.get("hub")).toBe("https://core.example.ts.net");
  });

  it("leaves a plain address alone", () => {
    expect(pastedLink("https://core.example.ts.net")).toBeNull();
    expect(pastedLink("everythingapp://setup?name=x")).toBeNull();
  });
});
