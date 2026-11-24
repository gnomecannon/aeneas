import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAR_SCREENS, DEFAULT_BAR, barAt, barCanEmpty, barCanPick, barCountChange, barEmpty, barLayout, barOrDefault, barPick, barTabs,
  barWhere, barWithCount, barWithLibrary, defaultBar, readBar, sameBar, type Bar, type BarCount,
} from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const all = () => true;
const libraries = (b: { first: string[]; second: string[] }) => [...b.first, ...b.second].filter((id) => id === "library").length;

test("bar: the default keeps the bar as it was, with five more screens in the second row", () => {
  assert.deepEqual(DEFAULT_BAR, { count: 5, first: ["today", "assistant", "capture", "library", "search"], second: ["tasks", "week", "notes", "memory", "people"] });
  assert.deepEqual(barLayout(DEFAULT_BAR, all), DEFAULT_BAR);
  // A copy to change, never the default itself.
  const copy = defaultBar();
  copy.first.pop();
  assert.equal(DEFAULT_BAR.first.length, 5);
  for (const id of [...DEFAULT_BAR.first, ...DEFAULT_BAR.second]) assert.ok((BAR_SCREENS as readonly string[]).includes(id), id);
  assert.equal(new Set(BAR_SCREENS).size, BAR_SCREENS.length);
});

test("bar: a value that breaks a rule is not a setting, and the default stands in for it", () => {
  const ok = { count: 4, first: ["today", "library"], second: [] };
  assert.deepEqual(readBar(ok), ok);
  assert.deepEqual(readBar({ ...ok, extra: 1 }), ok, "only the three fields are kept");
  assert.deepEqual(readBar({ count: 3, first: ["today", "someNewScreen", "library"], second: ["x-1"] }), { count: 3, first: ["today", "someNewScreen", "library"], second: ["x-1"] }, "an id this build does not know is kept");
  assert.deepEqual(readBar({ count: 5, first: [], second: [] }), { count: 5, first: [], second: [] }, "Library may be left out: clients draw it");
  for (const bad of [
    null, undefined, "bar", [], {},
    { count: 2, first: [], second: [] },
    { count: 6, first: [], second: [] },
    { count: "5", first: [], second: [] },
    { count: 4.5, first: [], second: [] },
    { count: 5, first: "today", second: [] },
    { count: 5, first: ["today"] },
    { count: 5, first: ["today", "today"], second: [] },
    { count: 5, first: ["today"], second: ["today"] },
    { count: 5, first: ["a", "b", "c", "d", "e", "f"], second: [] },
    { count: 3, first: ["a", "b", "c", "d"], second: [] },
    { count: 4, first: ["library"], second: ["a", "b", "c", "d", "e"] },
    { count: 5, first: [""], second: [] },
    { count: 5, first: ["two words"], second: [] },
    { count: 5, first: ["1st"], second: [] },
    { count: 5, first: [7], second: [] },
    { count: 5, first: ["x".repeat(41)], second: [] },
  ]) {
    assert.equal(readBar(bad), null, JSON.stringify(bad));
    assert.deepEqual(barOrDefault(bad), DEFAULT_BAR);
  }
});

test("bar: a lower count cuts each row, and Library keeps a place in its own row", () => {
  const three = barWithCount(DEFAULT_BAR, 3);
  // Library was fourth: it takes the third place, and Capture and Search leave the bar.
  assert.deepEqual(three, { count: 3, first: ["today", "assistant", "library"], second: ["tasks", "week", "notes"] });
  assert.deepEqual(barWithCount(DEFAULT_BAR, 4), { count: 4, first: ["today", "assistant", "capture", "library"], second: ["tasks", "week", "notes", "memory"] });
  // Library in the second row stays in the second row.
  const low: Bar = { count: 5, first: ["today", "assistant", "capture", "search", "tasks"], second: ["week", "notes", "memory", "people", "library"] };
  assert.deepEqual(barWithCount(low, 3), { count: 3, first: ["today", "assistant", "capture"], second: ["week", "notes", "library"] });
  // A higher count cuts nothing: the new places are free.
  assert.deepEqual(barWithCount(three, 5), { count: 5, first: ["today", "assistant", "library"], second: ["tasks", "week", "notes"] });
  // What it makes is always a setting the hub takes, with Library in it once.
  for (const count of [3, 4, 5] as const) {
    for (const b of [DEFAULT_BAR, low, { count: 5, first: ["a", "b", "c", "d", "e"], second: [] } as Bar]) {
      const out = barWithCount(b, count);
      assert.ok(readBar(out), JSON.stringify(out));
      assert.equal(libraries(out), 1);
    }
  }
});

test("bar: going back to a larger count while the editor is open brings back what the smaller one cut", () => {
  const three = barCountChange(DEFAULT_BAR, 3, null);
  assert.deepEqual(three.first, ["today", "assistant", "library"]);
  // From the bar as it was before: four is the default cut at four, five is the default again.
  assert.deepEqual(barCountChange(three, 4, DEFAULT_BAR), barWithCount(DEFAULT_BAR, 4));
  assert.equal(barCountChange(three, 5, DEFAULT_BAR), DEFAULT_BAR);
  // Without it (the page opened again), the new places are free.
  assert.deepEqual(barCountChange(three, 5, null).first, ["today", "assistant", "library"]);
});

test("bar: Library is always reachable", () => {
  // In neither row: the last place of the first row, a free one when there is one.
  assert.deepEqual(barLayout({ count: 5, first: ["today", "capture"], second: ["tasks"] }, all), { count: 5, first: ["today", "capture", "library"], second: ["tasks"] });
  assert.deepEqual(barLayout({ count: 3, first: ["today", "capture", "search"], second: [] }, all).first, ["today", "capture", "library"]);
  assert.deepEqual(barLayout({ count: 5, first: [], second: [] }, all).first, ["library"]);
  assert.deepEqual(barWithLibrary({ count: 3, first: ["today", "capture", "search"], second: ["x"] }), { count: 3, first: ["today", "capture", "library"], second: ["x"] });
  // In the second row is enough: the first row is left alone.
  const low: Bar = { count: 3, first: ["today", "capture", "search"], second: ["library"] };
  assert.equal(barWithLibrary(low), low);
  assert.deepEqual(barLayout(low, all), low);
  // Whatever the modules say, Library is drawn.
  assert.deepEqual(barLayout(DEFAULT_BAR, () => false), { count: 5, first: ["library"], second: [] });
  // Every arrangement draws it once.
  for (const count of [3, 4, 5] as const) {
    for (const first of [[], ["a"], ["a", "b", "c"], ["a", "b", "library"], ["a", "b", "c", "d", "e"].slice(0, count)]) {
      for (const second of [[], ["x", "y", "library"].filter((id) => !first.includes(id))]) {
        for (const has of [all, (id: string) => id !== "a" && id !== "x"]) {
          const drawn = barLayout({ count, first, second }, has);
          assert.equal(libraries(drawn), 1, JSON.stringify({ count, first, second }));
          assert.ok(drawn.first.length >= 1 && drawn.first.length <= count && drawn.second.length <= count);
        }
      }
    }
  }
});

test("bar: a screen that is off or unknown on this device is skipped when drawn and stays in the setting", () => {
  const bar: Bar = { count: 5, first: ["today", "music", "capture", "library", "layouts"], second: ["tasks", "futureScreen", "mail"] };
  const on = (id: string) => !["music", "layouts", "futureScreen", "mail"].includes(id);
  const drawn = barLayout(bar, on);
  assert.deepEqual(drawn, { count: 5, first: ["today", "capture", "library"], second: ["tasks"] });
  assert.deepEqual(barTabs(drawn), ["today", "capture", "library", "tasks"]);
  assert.deepEqual(bar.first, ["today", "music", "capture", "library", "layouts"], "the setting is as it was");
  // Its place waits for it: back on, it is drawn where it was.
  assert.deepEqual(barLayout(bar, all).first, bar.first);
  // A second row with nothing to draw is an empty second row: no grabber.
  assert.deepEqual(barLayout({ count: 5, first: ["today", "library"], second: ["music", "mail"] }, on).second, []);
  // A skipped screen frees its place for Library.
  assert.deepEqual(barLayout({ count: 3, first: ["today", "music", "search"], second: [] }, on).first, ["today", "search", "library"]);
  // Nothing of the first row to draw: the second row is drawn in its place.
  assert.deepEqual(barLayout({ count: 4, first: ["music", "mail"], second: ["library", "tasks"] }, on), { count: 4, first: ["library", "tasks"], second: [] });
});

test("bar: choosing a screen for a place swaps, moves or replaces", () => {
  // One that already has a place swaps with what was there, across rows too.
  let b = barPick(DEFAULT_BAR, "first", 0, "tasks");
  assert.deepEqual(b, { count: 5, first: ["tasks", "assistant", "capture", "library", "search"], second: ["today", "week", "notes", "memory", "people"] });
  b = barPick(DEFAULT_BAR, "first", 1, "search");
  assert.deepEqual(b.first, ["today", "search", "capture", "library", "assistant"]);
  // One with no place takes it, and what was there leaves the bar.
  b = barPick(DEFAULT_BAR, "second", 2, "mail");
  assert.deepEqual(b.second, ["tasks", "week", "mail", "memory", "people"]);
  assert.equal(barWhere(b, "notes"), null);
  // The screen already there: nothing changes.
  assert.ok(sameBar(barPick(DEFAULT_BAR, "first", 0, "today"), DEFAULT_BAR));
  // A free place is the next one of its row, whichever free place was chosen.
  const short: Bar = { count: 5, first: ["today", "library"], second: ["tasks"] };
  assert.deepEqual(barPick(short, "first", 4, "mail").first, ["today", "library", "mail"]);
  assert.deepEqual(barPick(short, "second", 1, "today"), { count: 5, first: ["library"], second: ["tasks", "today"] }, "a screen with a place moves into a free one");
  assert.deepEqual(barPick(short, "first", 2, "today").first, ["library", "today"], "also within its own row");
  assert.equal(barAt(short, "second", 1), null);
  // An id is never in two places, and every result is a setting the hub takes.
  for (const id of ["tasks", "mail", "library", "today"]) {
    for (const row of ["first", "second"] as const) {
      for (let i = 0; i < 5; i++) {
        for (const start of [DEFAULT_BAR, short, barWithCount(DEFAULT_BAR, 3)]) {
          const out = barPick(start, row, i, id);
          assert.ok(readBar(out), JSON.stringify(out));
          assert.equal(libraries(out), 1);
          assert.ok(out.first.length >= 1);
        }
      }
    }
  }
  // A place past the count, or an id that is not one, changes nothing.
  const three = barWithCount(DEFAULT_BAR, 3);
  assert.equal(barCanPick(three, "first", 3, "mail"), false);
  assert.ok(sameBar(barPick(three, "first", 3, "mail"), three));
  assert.ok(sameBar(barPick(DEFAULT_BAR, "first", 0, "not an id"), DEFAULT_BAR));
});

test("bar: Library cannot be removed from both rows", () => {
  // Its place takes only a swap with a screen that has a place: one with no place would push it out.
  assert.equal(barCanPick(DEFAULT_BAR, "first", 3, "mail"), false);
  assert.ok(sameBar(barPick(DEFAULT_BAR, "first", 3, "mail"), DEFAULT_BAR));
  assert.equal(barCanPick(DEFAULT_BAR, "first", 3, "tasks"), true);
  const low = barPick(DEFAULT_BAR, "first", 3, "tasks");
  assert.deepEqual(low.second, ["library", "week", "notes", "memory", "people"], "it may live in the second row");
  // It is not emptied out of the second row.
  assert.equal(barCanEmpty(low, "second", 0), false);
  assert.ok(sameBar(barEmpty(low, 0), low));
  // A setting that left it out is edited as it is drawn: Library in the last place of the first row.
  const none: Bar = { count: 3, first: ["today", "capture", "search"], second: [] };
  assert.equal(barAt(none, "first", 2), "library");
  assert.deepEqual(barPick(none, "second", 0, "mail"), { count: 3, first: ["today", "capture", "library"], second: ["mail"] });
});

test("bar: the first row keeps a screen", () => {
  const one: Bar = { count: 3, first: ["today"], second: ["library"] };
  assert.equal(barCanPick(one, "second", 1, "today"), false);
  assert.ok(sameBar(barPick(one, "second", 1, "today"), one));
  // Swapping is fine: the row still holds one.
  assert.deepEqual(barPick(one, "second", 0, "today"), { count: 3, first: ["library"], second: ["today"] });
});

test("bar: a second row place can be emptied, a first row place cannot", () => {
  assert.equal(barCanEmpty(DEFAULT_BAR, "first", 0), false);
  assert.equal(barCanEmpty(DEFAULT_BAR, "second", 1), true);
  assert.deepEqual(barEmpty(DEFAULT_BAR, 1).second, ["tasks", "notes", "memory", "people"]);
  assert.equal(barCanEmpty(barEmpty(DEFAULT_BAR, 1), "second", 4), false, "a free place has nothing to empty");
  let b: Bar = DEFAULT_BAR;
  for (let i = 0; i < 5; i++) b = barEmpty(b, 0);
  assert.deepEqual(b, { count: 5, first: DEFAULT_BAR.first, second: [] });
  assert.equal(barAt(b, "second", 0), null);
  assert.deepEqual(barLayout(b, all).second, [], "an empty second row: nothing to reveal");
});

test("bar: the contract lists the same screen ids", () => {
  const contract = fs.readFileSync(path.join(here, "../CONTRACT.md"), "utf8");
  const m = /Screen ids: ([^.]+)\./.exec(contract);
  assert.ok(m, "CONTRACT.md names the screen ids after 'Screen ids:'");
  const ids = [...m![1].matchAll(/`([A-Za-z][A-Za-z0-9_-]*)`/g)].map((x) => x[1]);
  assert.deepEqual(ids, [...BAR_SCREENS]);
  // And the counts it allows.
  for (const n of [3, 4, 5] satisfies BarCount[]) assert.ok(readBar({ count: n, first: [], second: [] }));
});
