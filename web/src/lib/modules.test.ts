import { describe, expect, it } from "vitest";
import { isOn, moduleOfScreen, SCREEN_MODULE } from "./modules";
import { AREAS } from "../components/Shell";

// The hub's module ids (hub/src/modules.ts). A screen naming any other id would never be hidden.
const HUB_IDS = ["renewals", "dashboard", "homelab", "projects", "music", "wiki", "images", "quiz", "health", "pet", "food", "sensors", "games", "films", "calc", "jobs", "layouts", "web"];
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
  });
});
