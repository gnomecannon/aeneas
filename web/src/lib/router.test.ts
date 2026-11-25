import { afterEach, describe, expect, it, vi } from "vitest";
import { afterPairing, replace, routeOf } from "./router";

describe("after pairing", () => {
  it("a device with no hub stays on the screen Setup stood in for", () => {
    expect(afterPairing("/capture", null)).toBe("/capture");
    expect(afterPairing("/tasks?focus=abc", "/today")).toBe("/tasks?focus=abc");
    expect(afterPairing("", null)).toBe("/today");
  });
  it("a pairing link goes back to the screen before it, never to the link or the hub's setup page", () => {
    expect(afterPairing("/setup?hub=https%3A%2F%2Fcore&code=ABCDEFGH", "/assistant/123")).toBe("/assistant/123");
    expect(afterPairing("/setup?hub=https%3A%2F%2Fcore&code=ABCDEFGH", null)).toBe("/today");
    expect(afterPairing("/setup?hub=a&code=B", "/setup?hub=a&code=C")).toBe("/today");
    expect(afterPairing("/setup", "/settings/connection")).toBe("/settings/connection");
  });
});

describe("routes", () => {
  it("open on Today, an old link to Now or Layout sketches opens Today, and one to Job applications opens Lists", () => {
    expect(routeOf("").path).toBe("/today");
    expect(routeOf("#/now").path).toBe("/today");
    expect(routeOf("#/now/abc").path).toBe("/today");
    expect(routeOf("#/layouts").path).toBe("/today");
    expect(routeOf("#/layouts/0123456789abcdef").path).toBe("/today");
    expect(routeOf("#/layoutsx").path).toBe("/layoutsx");
    // Job applications went with Job search on 2026-11-25; it was a page in Lists (/career before that).
    for (const old of ["#/lists/jobs", "#/lists/jobs/0123456789abcdef", "#/career", "#/career/0123456789abcdef"]) {
      expect(routeOf(old).path, old).toBe("/lists");
      expect(routeOf(old).parts, old).toEqual(["lists"]);
    }
    expect(routeOf("#/lists/abc").parts).toEqual(["lists", "abc"]);
    expect(routeOf("#/careers").path).toBe("/careers");
    expect(routeOf("#/notes/abc?x=1").parts).toEqual(["notes", "abc"]);
    expect(routeOf("#/notes/abc?x=1").params.get("x")).toBe("1");
  });
});

describe("replace", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("swaps the current history entry instead of adding one", () => {
    const location = { hash: "#/assistant", replace: vi.fn() };
    vi.stubGlobal("window", { location });
    replace("/assistant/abc");
    expect(location.replace).toHaveBeenCalledWith("#/assistant/abc");
    expect(location.hash).toBe("#/assistant");
  });
});
