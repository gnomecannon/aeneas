import { describe, expect, it } from "vitest";
import { GLOBAL_KEYS, keyAction, listedKeys } from "./keys";

const press = (key: string, more: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target: null, ...more }) as unknown as KeyboardEvent;

describe("keyboard shortcuts", () => {
  it("every listed key does something, so the list in About is the list the app answers to", () => {
    for (const k of GLOBAL_KEYS) expect(keyAction(press(k.key), true), k.key).not.toBeNull();
    expect(keyAction(press("t"), true)).toEqual({ go: "/today" });
    expect(keyAction(press("o"), true)).toEqual({ go: "/ops" });
    expect(keyAction(press("c"), true)).toEqual({ focus: "capture" });
    expect(keyAction(press("/"), true)).toEqual({ focus: "search" });
  });
  it("a key not in the list does nothing", () => {
    expect(keyAction(press("x"), true)).toBeNull();
  });
  it("letters wait while typing, with Ctrl, Cmd or Alt, and on a narrow screen; Escape always closes", () => {
    expect(keyAction(press("t", { target: { tagName: "TEXTAREA" } }), true)).toBeNull();
    expect(keyAction(press("t", { ctrlKey: true }), true)).toBeNull();
    expect(keyAction(press("t", { metaKey: true }), true)).toBeNull();
    expect(keyAction(press("t", { altKey: true }), true)).toBeNull();
    expect(keyAction(press("t"), false)).toBeNull();
    expect(keyAction(press("Escape", { target: { tagName: "INPUT" } }), false)).toEqual({ escape: true });
  });
  it("lists the keys of modules that are on", () => {
    const all = listedKeys(() => true).map((k) => k.key).join("");
    // n went with the Now screen (2026-11-25); t opens Today, which says what you are on.
    expect(all).toBe("tacwofpl/");
    expect(keyAction(press("n"), true)).toBeNull();
    const noHomelab = listedKeys((m) => m !== "homelab").map((k) => k.key).join("");
    expect(noHomelab).toBe("tacwfpl/");
  });
});
