import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isOn, moduleOfScreen, SCREEN_MODULE } from "./modules";
import { screenId } from "./bar";
import { AREAS } from "../components/Shell";

// The hub's module ids (hub/src/modules.ts). A screen naming any other id would never be hidden.
const HUB_IDS = ["renewals", "dashboard", "homelab", "projects", "music", "wiki", "images", "quiz", "health", "pet", "food", "sensors", "games", "films", "apple_music", "calc", "jobs", "layouts", "mail_inbox", "web", "reference"];
const CORE = ["/inbox", "/tasks", "/week", "/notes", "/memory", "/people", "/lists"];

describe("modules", () => {
  it("maps every Library screen to a hub module or the core", () => {
    for (const id of Object.values(SCREEN_MODULE)) expect(HUB_IDS).toContain(id);
    for (const item of AREAS.flatMap((a) => a.items)) {
      if (CORE.includes(item.path)) expect(moduleOfScreen(item.path)).toBeUndefined();
      else expect(moduleOfScreen(item.path), item.path).toBeDefined();
    }
  });

  it("finds the module of a screen's sub-paths by the longest match", () => {
    expect(moduleOfScreen("/lists/jobs/123")).toBe("jobs");
    expect(moduleOfScreen("/lists/abc")).toBeUndefined();
    expect(moduleOfScreen("/hosts/core")).toBe("homelab");
    expect(moduleOfScreen("/petition")).toBeUndefined();
  });

  it("counts a module as on until the hub says otherwise", () => {
    expect(isOn(null, "pet")).toBe(true);
    expect(isOn([{ id: "pet", title: "Pet", summary: "", group: "Body and home", on: false }], "pet")).toBe(false);
    expect(isOn([{ id: "pet", title: "Pet", summary: "", group: "Body and home", on: false }], "food")).toBe(true);
    expect(isOn([], undefined)).toBe(true);
    // Music shows only once the hub lists it as on: a hub from before it has no Music to switch on.
    expect(isOn([], "apple_music")).toBe(false);
    expect(isOn(null, "apple_music")).toBe(false);
    expect(isOn([{ id: "apple_music", title: "Music", summary: "", group: "Media", on: true }], "apple_music")).toBe(true);
  });

  it("has the Library areas of every client, each module's screens in the area the hub names (CONTRACT.md, Modules)", () => {
    const root = path.join(__dirname, "../../..");
    expect(AREAS.map((a) => a.title)).toEqual(["Plan", "Notes", "People", "Media", "Body and home", "Life admin", "Making", "Tech"]);
    // The hub's module list: each module's group is the area its screens are in.
    const hub = fs.readFileSync(path.join(root, "hub/src/modules.ts"), "utf8");
    const group = new Map([...hub.matchAll(/\{ id: "([a-z_]+)",.*?group: "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(group.get("music")).toBe("Making");
    for (const a of AREAS) for (const i of a.items) {
      const m = moduleOfScreen(i.path);
      if (m) expect(group.get(m), i.path).toBe(a.title);
    }
    // The Apple app's Library (and the iPad and Mac sidebar): the same areas with the same screens, in the same order.
    // Layout sketches is a screen of the web, Windows and Android apps only.
    const swift = fs.readFileSync(path.join(root, "apple/EverythingApp/AppModel.swift"), "utf8");
    const apple = [...swift.matchAll(/LibraryArea\(title: "([^"]+)", sections: \[([^\]]*)\]\)/g)]
      .map((m) => ({ title: m[1], ids: m[2].split(",").map((x) => x.trim().replace(/^\./, "")) }));
    expect(apple).toEqual(AREAS.map((a) => ({ title: a.title, ids: a.items.map((i) => screenId(i.path)).filter((id) => id !== "layouts") })));
  });
});
