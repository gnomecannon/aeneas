import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TODAY, TODAY_CARDS, TODAY_MAX_IDS, TODAY_PARTS, defaultToday, isDefaultToday, readToday, todayCardOrder, todayCards, todayMove,
  todayOrDefault, todayOrder, todayShown, todayShowsTop, todayWithOrder, todayWithShown, type TodaySetting,
} from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const usual = ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"];

test("today: the default is Today as it was, every part shown in its usual order", () => {
  assert.deepEqual([...TODAY_PARTS], usual);
  assert.deepEqual(DEFAULT_TODAY, { order: usual, hidden: [] });
  assert.deepEqual(todayOrder(DEFAULT_TODAY), usual);
  assert.deepEqual(todayShown(DEFAULT_TODAY), usual);
  assert.deepEqual(todayCards(DEFAULT_TODAY), usual.slice(1));
  assert.deepEqual([...TODAY_CARDS], usual.slice(1));
  assert.equal(todayShowsTop(DEFAULT_TODAY), true);
  assert.equal(isDefaultToday(DEFAULT_TODAY), true);
  // A copy to change, never the default itself.
  const copy = defaultToday();
  copy.order.pop();
  copy.hidden.push("tech");
  assert.equal(DEFAULT_TODAY.order.length, 7);
  assert.deepEqual(DEFAULT_TODAY.hidden, []);
});

test("today: a value that breaks a rule is not a setting, and the default stands in for it", () => {
  const ok = { order: ["coming", "now", "todo"], hidden: ["sofar"] };
  assert.deepEqual(readToday(ok), ok);
  assert.deepEqual(readToday({ ...ok, extra: 1 }), ok, "only the two fields are kept");
  assert.deepEqual(readToday({ order: [], hidden: [] }), { order: [], hidden: [] }, "empty lists are the default drawn");
  assert.deepEqual(readToday({ order: ["weather", "now"], hidden: ["weather-2"] }), { order: ["weather", "now"], hidden: ["weather-2"] }, "an id this build does not know is kept");
  const forty = Array.from({ length: TODAY_MAX_IDS }, (_, i) => `p${i}`);
  assert.ok(readToday({ order: forty, hidden: forty }));
  for (const bad of [
    null, undefined, "today", [], {},
    { order: ["now"] },
    { hidden: [] },
    { order: "now", hidden: [] },
    { order: ["now"], hidden: "tech" },
    { order: ["now", "now"], hidden: [] },
    { order: [], hidden: ["tech", "tech"] },
    { order: [""], hidden: [] },
    { order: ["two words"], hidden: [] },
    { order: ["1st"], hidden: [] },
    { order: [7], hidden: [] },
    { order: ["x".repeat(41)], hidden: [] },
    { order: [...forty, "one-more"], hidden: [] },
    { order: [], hidden: [...forty, "one-more"] },
  ]) {
    assert.equal(readToday(bad), null, JSON.stringify(bad));
    assert.deepEqual(todayOrDefault(bad), DEFAULT_TODAY);
  }
});

test("today: the order chosen, with unknown ids skipped and missing parts in their default places", () => {
  // Every part named: that order.
  const all = ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"];
  assert.deepEqual(todayOrder({ order: all, hidden: [] }), all);
  // Ids this build does not know are skipped.
  assert.deepEqual(todayOrder({ order: ["weather", "now", "coming", "x-1", "todo", "schedule", "needs", "tech", "sofar"], hidden: [] }), all);
  // A part left out follows the part before it in the default order: Tech after the line at the top, Needs you after
  // Tech, To do after the Schedule, Today so far after To do.
  assert.deepEqual(todayOrder({ order: ["coming", "schedule"], hidden: [] }), ["now", "tech", "needs", "coming", "schedule", "todo", "sofar"]);
  assert.deepEqual(todayOrder({ order: ["sofar", "needs"], hidden: [] }), ["now", "tech", "sofar", "coming", "needs", "schedule", "todo"]);
  // Named alone, a part has no other part to follow: every other part takes its default place around it.
  assert.deepEqual(todayOrder({ order: ["coming"], hidden: [] }), usual);
  assert.deepEqual(todayOrder({ order: [], hidden: [] }), usual);
  assert.deepEqual(todayOrder({ order: ["weather"], hidden: [] }), usual);
  // The line at the top is drawn above the cards wherever the order puts it: the cards are the same either way.
  assert.deepEqual(todayCards({ order: ["coming", "now", "needs"], hidden: [] }), todayCards({ order: ["now", "coming", "needs"], hidden: [] }));
});

test("today: hidden parts are not drawn, the rest keep their order", () => {
  const s: TodaySetting = { order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: ["sofar", "needs", "weather"] };
  assert.deepEqual(todayShown(s), ["now", "coming", "todo", "schedule", "tech"]);
  assert.deepEqual(todayCards(s), ["coming", "todo", "schedule", "tech"]);
  assert.deepEqual(todayCardOrder(s), ["coming", "todo", "schedule", "needs", "tech", "sofar"], "the editor lists the hidden ones too");
  assert.equal(todayShowsTop(s), true);
  const top: TodaySetting = { order: [], hidden: ["now"] };
  assert.equal(todayShowsTop(top), false);
  assert.deepEqual(todayCards(top), usual.slice(1));
  const none: TodaySetting = { order: [], hidden: [...usual] };
  assert.deepEqual(todayShown(none), []);
  assert.deepEqual(todayCards({ order: [], hidden: usual.slice(1) }), []);
  assert.equal(isDefaultToday(s), false);
  assert.equal(isDefaultToday(top), false);
  assert.equal(isDefaultToday({ order: [], hidden: ["weather"] }), true, "hiding a part this build does not know changes nothing here");
  assert.equal(isDefaultToday({ order: ["coming", "tech"], hidden: [] }), false);
  assert.equal(isDefaultToday({ order: ["needs", "now"], hidden: [] }), true, "the line at the top has no place among the cards");
});

test("today: the editor moves a card, shows and hides a part, and keeps ids it does not know", () => {
  let s = defaultToday();
  s = todayMove(s, "coming", 0);
  assert.deepEqual(s.order, ["now", "coming", "tech", "needs", "schedule", "todo", "sofar"]);
  s = todayMove(s, "tech", 99);
  assert.deepEqual(todayCardOrder(s), ["coming", "needs", "schedule", "todo", "sofar", "tech"]);
  s = todayMove(s, "needs", -3);
  assert.deepEqual(todayCardOrder(s), ["needs", "coming", "schedule", "todo", "sofar", "tech"]);
  s = todayMove(s, "schedule", 1);
  assert.deepEqual(todayCardOrder(s), ["needs", "schedule", "coming", "todo", "sofar", "tech"]);
  s = todayWithShown(s, "sofar", false);
  s = todayWithShown(s, "now", false);
  assert.deepEqual(s.hidden, ["sofar", "now"]);
  assert.deepEqual(todayWithShown(s, "sofar", false).hidden, ["now", "sofar"], "hidden once");
  s = todayWithShown(s, "sofar", true);
  assert.deepEqual(s.hidden, ["now"]);
  assert.ok(readToday(s), "every edit is a setting the hub takes");
  // A part a newer app added stays after the part it followed (and moves with it), and stays hidden.
  const newer: TodaySetting = { order: ["now", "weather", "tech", "needs", "schedule", "todo", "sofar", "coming", "x-1"], hidden: ["weather"] };
  const moved = todayMove(newer, "coming", 0);
  assert.deepEqual(moved.order, ["now", "weather", "coming", "x-1", "tech", "needs", "schedule", "todo", "sofar"]);
  assert.deepEqual(moved.hidden, ["weather"]);
  assert.deepEqual(todayWithOrder({ order: ["first-one"], hidden: [] }, ["todo"]).order, ["first-one", "now", "tech", "needs", "schedule", "todo", "sofar", "coming"]);
  // However many it holds, an edit stays within the limit.
  const crowded: TodaySetting = { order: Array.from({ length: TODAY_MAX_IDS }, (_, i) => `p${i}`), hidden: [] };
  assert.ok(readToday(todayMove(crowded, "coming", 0)));
  assert.ok(readToday(todayWithOrder(crowded, [...TODAY_CARDS].reverse())));
});

test("today: the contract lists the same part ids", () => {
  const contract = fs.readFileSync(path.join(here, "../CONTRACT.md"), "utf8");
  const m = /Today parts: ([^.]+)\./.exec(contract);
  assert.ok(m, "CONTRACT.md names the parts after 'Today parts:'");
  const ids = [...m![1].matchAll(/`([A-Za-z][A-Za-z0-9_-]*)`/g)].map((x) => x[1]);
  assert.deepEqual(ids, [...TODAY_PARTS]);
});
