import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TODAY, TODAY_PARTS } from "@everythingapp/shared";
import { TODAY_PART_TEXT, TODAY_TEXT, todaySummary, todoListsSummary } from "../views/settings/TodayParts";
import { choosableLists } from "../components/ListChooser";
import { cleanPatch, viewFrom } from "../feel/prefs";

const swift = fs.readFileSync(path.join(__dirname, "../../../apple/Packages/EACore/Sources/EACore/TodayParts.swift"), "utf8");

describe("Theme, Today", () => {
  it("says the same words as the Apple apps' page", () => {
    for (const text of Object.values(TODAY_TEXT)) expect(swift, text).toContain(`"${text}"`);
    for (const p of TODAY_PARTS) {
      expect(swift, p).toContain(`case .${p}: return "${TODAY_PART_TEXT[p].name}"`);
      expect(swift, p).toContain(`case .${p}: return "${TODAY_PART_TEXT[p].holds}"`);
    }
    // The parts, in the same order.
    expect(/case now, tech, needs, schedule, todo, sofar, coming\n/.test(swift)).toBe(true);
    expect([...TODAY_PARTS].join(", ")).toBe("now, tech, needs, schedule, todo, sofar, coming");
  });

  it("sums the setting up in one line", () => {
    expect(todaySummary(DEFAULT_TODAY)).toBe("Usual order, all shown");
    expect(todaySummary({ order: ["coming", "tech"], hidden: ["sofar", "needs", "weather"] })).toBe("Your order, 2 hidden");
    expect(todaySummary({ order: [], hidden: ["now"] })).toBe("Usual order, 1 hidden");
  });

  it("is read from the hub's answer and a cached copy, the default when absent or broken", () => {
    expect(viewFrom({}).today).toEqual(DEFAULT_TODAY);
    const today = { order: ["now", "coming", "todo"], hidden: ["sofar"] };
    expect(viewFrom({ today }).today).toEqual(today);
    expect(viewFrom({ today: { order: ["now", "now"], hidden: [] } }).today).toEqual(DEFAULT_TODAY);
    expect(cleanPatch({ today: { order: "now", hidden: [] } })).toEqual({});
    expect(cleanPatch({ today })).toEqual({ today });
  });
});

describe("Theme, Today page", () => {
  it("lists the line at the top, then every card with its switch, its handle and Move up and Move down", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { TodayParts } = await import("../views/settings/TodayParts");
    const page = (saved: typeof DEFAULT_TODAY) => renderToStaticMarkup(createElement(TodayParts, { saved, edit: () => {} }));
    const html = page(DEFAULT_TODAY);
    for (const p of TODAY_PARTS) expect(html).toContain(TODAY_PART_TEXT[p].name);
    expect(html.match(/type="checkbox"/g)).toHaveLength(TODAY_PARTS.length);
    expect(html.match(/class="grip"/g)).toHaveLength(TODAY_PARTS.length - 1);
    expect(html).toContain(`aria-label="${TODAY_TEXT.moveUp}: Tech" title="${TODAY_TEXT.moveUp}" disabled=""`);
    expect(html).toContain(`aria-label="${TODAY_TEXT.moveDown}: Coming up" title="${TODAY_TEXT.moveDown}" disabled=""`);
    // Nothing changed yet: Reset has nothing to put back.
    expect(html).toMatch(/<button type="button" disabled="">Reset<\/button>/);
    // A custom order with two parts hidden: the cards in that order, the hidden ones still listed with their switch off.
    const custom = page({ order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: ["sofar", "needs"] });
    const at = (name: string) => custom.indexOf(`<span class="t">${name}</span>`);
    expect(at("Coming up")).toBeLessThan(at("To do"));
    expect(at("To do")).toBeLessThan(at("Schedule"));
    expect(at("Needs you")).toBeLessThan(at("Tech"));
    expect(at("Tech")).toBeLessThan(at("Today so far"));
    expect(custom.match(/type="checkbox" checked=""/g)).toHaveLength(TODAY_PARTS.length - 2);
    expect(custom.match(/class="item today-part off"/g)).toHaveLength(2);
    expect(custom).toMatch(/<button type="button">Reset<\/button>/);
  });
});

describe("Theme, Today, Lists in To do", () => {
  const TODO = { key: "icloud:iCloud/To-Do", title: "To-Do", on: true, account: "iCloud", kind: "icloud", space: "personal" as const };
  const SHOP = { key: "icloud:iCloud/Shopping", title: "Shopping", on: true, account: "iCloud", kind: "icloud", space: "personal" as const };
  const HOMEWORK = { key: "exchange:/Homework", title: "Homework", on: true, account: "", kind: "exchange", space: "work" as const };
  const OFF = { key: "caldav:Google/Errands", title: "Errands", on: false, account: "Google", kind: "caldav" };

  it("sums the choice up in one line, as the Apple apps do", () => {
    const lists = [TODO, SHOP];
    expect(todoListsSummary(DEFAULT_TODAY, lists)).toBe("All lists");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: null }, lists)).toBe("All lists");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: [] }, lists)).toBe("None");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: [TODO.key] }, lists)).toBe("To-Do");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: ["none"] }, lists)).toBe("No list");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: ["icloud:iCloud/Gone"] }, lists)).toBe("1 list");
    expect(todoListsSummary({ ...DEFAULT_TODAY, todo_lists: [TODO.key, "none"] }, lists)).toBe("2 lists");
    for (const w of ["None", "lists", "1 list"]) expect(swift).toContain(w);
  });

  it("offers the lists that are on, by account and name", () => {
    expect(choosableLists([SHOP, OFF, TODO, HOMEWORK]).map((l) => l.title)).toEqual(["Homework", "Shopping", "To-Do"]);
  });

  it("draws All lists, or a box for each list that is on and one for tasks in no list", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { TodayParts } = await import("../views/settings/TodayParts");
    const page = (saved: typeof DEFAULT_TODAY) => renderToStaticMarkup(createElement(TodayParts, { saved, edit: () => {}, lists: [TODO, SHOP, HOMEWORK, OFF] }));
    const all = page(DEFAULT_TODAY);
    expect(all).toContain(TODAY_TEXT.todoLists);
    expect(all.match(/type="radio"/g)).toHaveLength(2);
    expect(all).toMatch(/type="radio" name="today-todo-lists" checked=""\/><span class="body"><span class="t">All lists/);
    expect(all).not.toContain("Shopping");
    const only = page({ ...DEFAULT_TODAY, todo_lists: [TODO.key, "none"] });
    expect(only).toMatch(/type="radio" name="today-todo-lists" checked=""\/><span class="body"><span class="t">Only these lists/);
    expect(only).toContain('<span class="t">Shopping</span><span class="meta">iCloud</span>');
    expect(only).toContain('<span class="t">Homework</span><span class="meta">Exchange, Work</span>');
    expect(only).not.toContain("Errands");
    expect(only).toMatch(/checked=""\/><span class="body"><span class="t">To-Do/);
    expect(only).toMatch(/type="checkbox"\/><span class="body"><span class="t">Shopping/);
    expect(only).toMatch(/checked=""\/><span class="body"><span class="t">No list<\/span><span class="meta">Tasks made in Aeneas/);
    // No list known yet: the box for tasks in no list, and a line saying where lists come from.
    const none = renderToStaticMarkup(createElement(TodayParts, { saved: { ...DEFAULT_TODAY, todo_lists: [] }, edit: () => {}, lists: [] }));
    expect(none).toContain(TODAY_TEXT.noListsYet);
  });
});
