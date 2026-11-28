import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { CONNECTION_SECTIONS, MODULE_SETUP, connectionSection, moduleSetup } from "./moduleSetup";
import { routeOf } from "./router";

const hubModules = fs.readFileSync(new URL("../../../hub/src/modules.ts", import.meta.url), "utf8");
/** The hub's modules that say they need an account, a key or an app of the person's own (`setup`). */
const withSetup = [...hubModules.matchAll(/\{ id: "([a-z_]+)"[^\n]*?\bsetup: \{/g)].map((m) => m[1]);

describe("set up a module now", () => {
  it("leads every module that needs its own setup somewhere, and the ones that need a link or a download too", () => {
    expect(withSetup.length).toBeGreaterThan(3);
    for (const id of withSetup) expect(moduleSetup(id), id).not.toBeNull();
    for (const id of ["mail_inbox", "mail", "calendars", "reference", "games", "films", "wiki"]) expect(moduleSetup(id), id).not.toBeNull();
  });

  it("names a module the hub has, and opens a Settings page that exists", () => {
    const pages = ["/settings/accounts/add", "/settings/reference", "/settings/connections"];
    for (const [id, s] of Object.entries(MODULE_SETUP)) {
      expect(hubModules, id).toContain(`{ id: "${id}"`);
      expect(pages, id).toContain(routeOf(`#${s.href}`).path);
      expect(`${s.label} ${s.what}`, id).not.toMatch(/[\u2013\u2014]/);
    }
    expect(routeOf(`#${MODULE_SETUP.calendars.href}`).params.get("kind")).toBe("icloud");
  });

  it("opens Connections at the section asked for, and only at one it has", () => {
    for (const s of CONNECTION_SECTIONS) expect(connectionSection(s)).toBe(s);
    for (const id of ["games", "films", "wiki"]) expect(connectionSection(routeOf(`#${MODULE_SETUP[id].href}`).params.get("show"))).not.toBeNull();
    expect(connectionSection("password")).toBeNull();
    expect(connectionSection(null)).toBeNull();
    expect(moduleSetup("pet")).toBeNull();
    expect(moduleSetup("homelab")).toBeNull();
  });
});
