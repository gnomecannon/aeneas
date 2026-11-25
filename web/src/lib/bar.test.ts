import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BAR_GONE, BAR_LIBRARY, BAR_SCREENS, DEFAULT_BAR, barLayout, barTabs, type Bar } from "@everythingapp/shared";
import { AREAS, PRIMARY, SCREEN_LABELS, listedPaths } from "../components/Shell";
import { SCREEN_ICONS } from "../components/ScreenIcon";
import { BottomBar, type BarItem } from "../components/BottomBar";
import { BAR_TEXT, barSummary } from "../views/settings/BottomBar";
import { cleanPatch, viewFrom } from "../feel/prefs";
import { MAIN_SCREENS, barAvailable, barShowing, screenId, screenPath, settlesOpen } from "./bar";

const swift = fs.readFileSync(path.join(__dirname, "../../../apple/Packages/EACore/Sources/EACore/Bar.swift"), "utf8");
const allOn = () => true;
/** What the phone draws with these modules on, as Shell's useBar works it out. */
const drawn = (bar: Bar, on: (m: string | undefined) => boolean) => {
  const available = barAvailable(listedPaths(on));
  return barLayout(bar, (id) => available.has(id));
};

describe("bottom bar", () => {
  it("has a name, an icon and a path for every screen id, the same ids the Apple apps know", () => {
    for (const id of BAR_SCREENS) {
      expect(SCREEN_LABELS[id], id).toBeTruthy();
      expect(SCREEN_ICONS[id], id).toBeTruthy();
      expect(screenId(screenPath(id))).toBe(id);
    }
    expect(screenPath("images")).toBe("/gallery");
    // Every screen the phone can reach from its bar or its Library is one the bar can hold.
    for (const item of [...PRIMARY, ...AREAS.flatMap((a) => a.items)]) expect(BAR_SCREENS as readonly string[]).toContain(screenId(item.path));
    for (const p of listedPaths(allOn)) expect(BAR_SCREENS as readonly string[]).toContain(screenId(p));
    const list = /public static let all: \[String\] = \[([^\]]+)\]/.exec(swift);
    expect(list, "BarScreen.all in Bar.swift").toBeTruthy();
    expect([...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...BAR_SCREENS]);
    // The screens taken out, which leave a setting when it is read: the same on both sides, and none of them shown.
    const gone = /public static let gone: \[String\] = \[([^\]]*)\]/.exec(swift);
    expect(gone, "BarScreen.gone in Bar.swift").toBeTruthy();
    expect([...gone![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...BAR_GONE]);
    for (const id of BAR_GONE) expect(SCREEN_LABELS[id], id).toBeUndefined();
  });

  it("lights the screen that is showing when it has a place, else Library", () => {
    const tabs = barTabs(DEFAULT_BAR);
    expect(barShowing("/today", tabs)).toBe("today");
    expect(barShowing("/tasks", tabs)).toBe("tasks");
    expect(barShowing("/notes/abc", tabs)).toBe("notes");
    expect(barShowing("/mail", tabs)).toBe(BAR_LIBRARY);
    expect(barShowing("/library", tabs)).toBe(BAR_LIBRARY);
    expect(barShowing("/more", tabs)).toBe(BAR_LIBRARY);
    expect(barShowing("/settings/theme", tabs)).toBe(BAR_LIBRARY);
    // A screen's own pages are its: a machine's page is the Overview's, Create image the Image Gallery's.
    const mine = ["ops", "images", "lists", "library"];
    expect(barShowing("/hosts/alpha", mine)).toBe("ops");
    expect(barShowing("/journal", mine)).toBe("ops");
    expect(barShowing("/images", mine)).toBe("images");
    expect(barShowing("/gallery", mine)).toBe("images");
    expect(barShowing("/lists/abc", mine)).toBe("lists");
    expect(barShowing("/today", mine)).toBe(BAR_LIBRARY);
  });

  it("skips the screens of modules that are off, keeps them in the setting, and always draws Library", () => {
    const bar: Bar = { count: 5, first: ["today", "music", "capture", "library", "search"], second: ["mail", "sensors", "ops", "tasks"] };
    // Music off, Mail off (it is off until switched on), Machines on: the Overview holds the sensors.
    const on = (m: string | undefined) => m !== "music" && m !== "mail_inbox";
    const d = drawn(bar, on);
    expect(d.first).toEqual(["today", "capture", "library", "search"]);
    expect(d.second).toEqual(["ops", "tasks"]);
    expect(bar.first).toContain("music");
    // Machines off: Sensors is a screen of its own again, and the Overview goes.
    expect(drawn(bar, (m) => on(m) && m !== "homelab").second).toEqual(["sensors", "tasks"]);
    // Every module off: the core screens stay, and Library is drawn whatever the setting says.
    const none: Bar = { count: 3, first: ["music", "films", "games"], second: [] };
    expect(drawn(none, (m) => m === undefined).first).toEqual([BAR_LIBRARY]);
    expect(drawn({ count: 3, first: ["today", "capture", "search"], second: [] }, allOn).first).toEqual(["today", "capture", BAR_LIBRARY]);
    // The main screens are always available, so one left out of the bar is listed at the top of the Library.
    for (const id of MAIN_SCREENS) expect(barAvailable([]).has(id)).toBe(true);
  });

  it("keeps a bar from the hub or the cache only when it keeps the rules", () => {
    const bar = { count: 4, first: ["today", "library"], second: ["tasks"] };
    expect(cleanPatch({ bar }).bar).toEqual(bar);
    expect(cleanPatch({ bar: { count: 3, first: ["a", "b", "c", "d"], second: [] } }).bar).toBeUndefined();
    expect(cleanPatch({ bar: { count: 5, first: ["today"], second: ["today"] } }).bar).toBeUndefined();
    expect(viewFrom({ bar }).bar).toEqual(bar);
    // A hub from before the bottom bar answers without one: the default.
    expect(viewFrom({ key: "D" }).bar).toEqual(DEFAULT_BAR);
  });

  it("settles the second row by a flick's direction, else by whether more than half shows", () => {
    expect(settlesOpen(10, 60, 0.9)).toBe(true);
    expect(settlesOpen(50, 60, -0.9)).toBe(false);
    expect(settlesOpen(31, 60, 0)).toBe(true);
    expect(settlesOpen(29, 60, 0.1)).toBe(false);
  });

  it("says the same on the iPhone, iPad and Mac, in plain words", () => {
    for (const text of Object.values(BAR_TEXT)) {
      expect(swift, text).toContain(`"${text}"`);
      expect(text).not.toMatch(/[\u2013\u2014!]/);
    }
    expect(barSummary(DEFAULT_BAR)).toBe("5 across, 5 in the second row");
    expect(barSummary({ count: 3, first: ["today"], second: [] })).toBe("3 across, no second row");
    expect(swift).toContain('"\\(bar.count) across, "');
    expect(swift).toContain('"\\(more) in the second row"');
    expect(swift).toContain('"no second row"');
  });
});

const items = (ids: string[]): BarItem[] => ids.map((id) => ({ id, path: `/${id}`, label: id[0].toUpperCase() + id.slice(1) }));
/** The bar's markup as the phone layout first draws it (folded; effects and drags need a browser). */
const draw = (props: Partial<Parameters<typeof BottomBar>[0]>) =>
  renderToStaticMarkup(
    createElement(BottomBar, { count: 5, first: items(["today", "assistant", "library"]), second: items(["tasks", "week"]), lit: "today", inbox: 0, at: "/today", ...props }),
  );

describe("bottom bar, as drawn", () => {
  it("draws each screen as a link with its icon and name, the one showing marked as the current page", () => {
    const html = draw({ count: 4, lit: "assistant", at: "/assistant" });
    expect(html).toContain('class="tabs count-4"');
    expect(html).toContain('aria-label="Sections"');
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html.match(/<svg class="screen-icon"/g)).toHaveLength(5);
    expect(html).toMatch(/<a href="#\/assistant"[^>]*class="active"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/<a href="#\/today"[^>]*aria-current/);
    expect(html).toContain('<span class="tab-name">Assistant</span>');
  });

  it("keeps Library's count of captures to sort", () => {
    expect(draw({ inbox: 3 })).toMatch(/<a href="#\/library"[^>]*>.*<span class="badge" aria-label="3 to sort">3<\/span><\/a>/);
    expect(draw({ inbox: 0 })).not.toContain("to sort");
  });

  it("has a grabber that is a real button only when there is a second row, lit while a screen of that row shows", () => {
    const html = draw({});
    expect(html).toMatch(/<button type="button" class="tabs-grab" aria-label="More screens" aria-expanded="false" aria-controls="tabs-more">/);
    expect(html).toContain('id="tabs-more" class="tabs-row" role="group" aria-label="More screens"');
    expect(draw({ lit: "week", at: "/week" })).toContain('class="tabs-grab lit"');
    const none = draw({ second: [] });
    expect(none).not.toContain("tabs-grab");
    expect(none).not.toContain("tabs-more");
  });

  it("starts folded, with no screen covered", () => {
    const html = draw({});
    expect(html).not.toContain("tabs-scrim");
    expect(html).not.toContain(" open");
  });
});
