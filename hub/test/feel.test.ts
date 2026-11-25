import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { FeelStore, parseKey } from "../src/feel.js";

test("feel: defaults, partial updates, refusals, and following the newest music idea's key", async () => {
  const t = makeHub();
  try {
    const first = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.equal(first.scale, "major_pentatonic");
    assert.equal(first.synth, "sine");
    assert.equal(first.hold, true);
    assert.equal(first.drag_bend, false);
    assert.equal(first.app_theme, "classic");
    assert.deepEqual(first.effective, { key: "C", scale: "major_pentatonic", from: null });
    assert.ok(first.options.synths.includes("pluck"));

    // An older client's single custom color list becomes a named palette.
    const set = await (await t.api("/prefs/feel", { method: "PUT", json: { key: "D", scale: "dorian", synth: "bell", theme: "custom", colors: ["#112233", "#ffaa00"] } })).json() as Record<string, any>;
    assert.equal(set.key, "D");
    assert.equal(set.theme, "custom:mine");
    assert.deepEqual(set.palettes, [{ id: "mine", name: "My colors", colors: ["#112233", "#ffaa00"] }]);
    assert.equal(set.motion, true, "untouched fields keep their value");
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { scale: "jazz" } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { palettes: [{ id: "a", name: "A", colors: ["red"] }] } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { theme: "custom:nope" } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { shapes: ["blob"] } })).status, 422);
    // Rename a palette, pick a custom app theme, then delete the palette in use: the choice falls back.
    const renamed = await (await t.api("/prefs/feel", { method: "PUT", json: { palettes: [{ id: "mine", name: "Dusk", colors: ["#112233"] }] } })).json() as Record<string, any>;
    assert.equal(renamed.palettes[0].name, "Dusk");
    const app = await (await t.api("/prefs/feel", { method: "PUT", json: { app_themes: [{ id: "cave", name: "Cave", mode: "dark", accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" }], app_theme: "custom:cave" } })).json() as Record<string, any>;
    assert.equal(app.app_theme, "custom:cave");
    assert.ok(app.options.app_themes.some((a: any) => a.id === "midnight"));
    const dropped = await (await t.api("/prefs/feel", { method: "PUT", json: { palettes: [] } })).json() as Record<string, any>;
    assert.equal(dropped.theme, "aurora");

    t.hub.store.create("music_idea", { title: "old riff", type: "riff", status: "idea", tags: [], key: "E minor" });
    await new Promise((r) => setTimeout(r, 5));
    const newest = t.hub.store.create("music_idea", { title: "hummed melody", type: "riff", status: "idea", tags: [], key: "Bb dorian" });
    const follow = await (await t.api("/prefs/feel", { method: "PUT", json: { follow_music: true } })).json() as Record<string, any>;
    assert.equal(follow.key, "D", "the manual key is kept for when following is turned off");
    assert.deepEqual(follow.effective, { key: "A#", scale: "dorian", from: { id: newest.id, title: "hummed melody", key: "Bb dorian" } });
  } finally { t.cleanup(); }
});

test("parseKey reads the ways a key gets written", () => {
  assert.deepEqual(parseKey("A minor"), { key: "A", scale: "minor" });
  assert.deepEqual(parseKey("Am"), { key: "A", scale: "minor" });
  assert.deepEqual(parseKey("F# mixolydian"), { key: "F#", scale: "mixolydian" });
  assert.deepEqual(parseKey("Eb"), { key: "D#", scale: "major" });
  assert.deepEqual(parseKey("C minor pentatonic"), { key: "C", scale: "minor_pentatonic" });
  assert.equal(parseKey("drop D tuning"), null);
  assert.equal(parseKey("120 bpm"), null);
});

test("feel: image shapes upload, serve, refuse the wrong thing, and delete", async () => {
  const t = makeHub();
  try {
    // A 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const up = await t.api("/prefs/feel/images?name=Leaf", { method: "POST", body: png, headers: { "content-type": "image/png" } });
    assert.equal(up.status, 201);
    const f = await up.json() as Record<string, any>;
    assert.equal(f.images.length, 1);
    assert.equal(f.images[0].name, "Leaf");
    const got = await t.api(`/prefs/feel/images/${f.images[0].id}`);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    assert.equal((await t.api("/prefs/feel/images?name=x", { method: "POST", body: Buffer.from("not an image"), headers: { "content-type": "image/png" } })).status, 415);
    assert.equal((await t.api("/prefs/feel/images?name=x", { method: "POST", body: png, headers: { "content-type": "image/jpeg" } })).status, 415);
    const off = await (await t.api("/prefs/feel", { method: "PUT", json: { images: [{ ...f.images[0], name: "Maple", enabled: false }] } })).json() as Record<string, any>;
    assert.deepEqual([off.images[0].name, off.images[0].enabled], ["Maple", false]);
    const gone = await (await t.api(`/prefs/feel/images/${f.images[0].id}`, { method: "DELETE" })).json() as Record<string, any>;
    assert.equal(gone.images.length, 0);
    assert.equal((await t.api(`/prefs/feel/images/${f.images[0].id}`)).status, 404);
  } finally { t.cleanup(); }
});

test("calendar colors: apps report each calendar's own color, the owner's choice wins and stays, and events find theirs", async () => {
  const { eventCalendarKey, calendarColor } = await import("@everythingapp/shared");
  const t = makeHub();
  try {
    const put = (p: string, json: unknown) => t.api(p, { method: "PUT", json });
    let r = await put("/prefs/feel/calendars", { calendars: [{ key: "apple:iCloud/Home", name: "Home", account: "iCloud", color: "#1badf8" }, { key: "apple:iCloud/Gym", name: "Gym" }] });
    assert.equal(r.status, 200);
    let f = (await r.json()) as { calendars: Array<{ key: string; color?: string; chosen?: string }> };
    assert.equal(f.calendars.find((c) => c.key === "apple:iCloud/Home")?.color, "#1BADF8");
    assert.equal(f.calendars.find((c) => c.key === "apple:iCloud/Gym")?.color, undefined, "no color reported, none made up");

    r = await put("/prefs/feel/calendar-color", { key: "apple:iCloud/Home", color: "#00aa55" });
    f = (await r.json()) as typeof f;
    assert.equal(calendarColor("apple:iCloud/Home", f.calendars as never), "#00AA55", "the owner's choice wins");
    // A later report (Apple Calendar's color changed) moves the calendar's own color and keeps the owner's choice.
    await put("/prefs/feel/calendars", { calendars: [{ key: "apple:iCloud/Home", name: "Home", color: "#ff2968" }, { key: "apple:iCloud/Gym", name: "Gym" }] });
    const home = t.hub.feel.get().calendars.find((c) => c.key === "apple:iCloud/Home")!;
    assert.deepEqual([home.color, home.chosen], ["#FF2968", "#00AA55"]);
    await put("/prefs/feel/calendar-color", { key: "apple:iCloud/Home", color: null });
    assert.equal(calendarColor("apple:iCloud/Home", t.hub.feel.get().calendars as never), "#FF2968", "back to the calendar's own color");

    assert.equal((await put("/prefs/feel/calendar-color", { key: "nope", color: "#000000" })).status, 404);
    assert.equal((await put("/prefs/feel/calendar-color", { key: "apple:iCloud/Gym", color: "red" })).status, 422);
    assert.equal((await put("/prefs/feel/calendars", { calendars: [{ key: "", name: "x" }] })).status, 422);

    assert.equal(eventCalendarKey({ calendar_key: "apple:iCloud/Gym", caldav: { calendar: "https://x/" } }), "apple:iCloud/Gym");
    assert.equal(eventCalendarKey({ caldav: { account: "a", calendar: "https://p01-caldav.icloud.com/1/calendars/home/", uid: "u" } }), "icloud:https://p01-caldav.icloud.com/1/calendars/home/");
    assert.equal(eventCalendarKey({ apple: { id: "x", calendar: "Home" } }), "apple:Home");
    assert.equal(eventCalendarKey({ source: "m365" }), "work:m365");
    assert.equal(eventCalendarKey({ title: "made here" }), null);
  } finally { t.cleanup(); }
});

test("a saved theme may carry its own status colors", async () => {
  const t = makeHub();
  try {
    const theme = { id: "mine", name: "Mine", mode: "light", accent: "#0A84FF", background: "#FFFFFF", surface: "#F4F4F4", text: "#111111", ok: "#1E7B3A", warn: "#8A5A00", danger: "#B00020" };
    const r = await t.api("/prefs/feel", { method: "PUT", json: { app_themes: [theme], app_theme: "custom:mine" } });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { app_themes: Array<{ danger?: string }> }).app_themes[0].danger, "#B00020");
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { app_themes: [{ ...theme, ok: "green" }] } })).status, 422);
  } finally { t.cleanup(); }
});

test("bottom bar: the default, a change kept beside the rest of the setting, and what is refused", async () => {
  const t = makeHub();
  try {
    const put = (json: unknown) => t.api("/prefs/feel", { method: "PUT", json });
    const usual = { count: 5, first: ["today", "assistant", "capture", "library", "search"], second: ["tasks", "week", "notes", "memory", "people"] };
    const first = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.deepEqual(first.bar, usual, "a hub that was never told has the bar as it always was");

    // Three across, a screen only a newer app knows, and nothing but the three fields kept.
    const bar = { count: 3, first: ["today", "library", "mail"], second: ["tasks", "someNewScreen"] };
    const set = await (await put({ bar: { ...bar, extra: true } })).json() as Record<string, any>;
    assert.deepEqual(set.bar, bar);
    assert.equal(set.scale, "major_pentatonic", "the rest of the setting is as it was");
    // An app from before the bottom bar changes another field and never names the bar: it stays.
    const later = await (await put({ key: "D" })).json() as Record<string, any>;
    assert.deepEqual(later.bar, bar);
    assert.deepEqual(((await (await t.api("/prefs/feel")).json()) as Record<string, any>).bar, bar, "kept in the file");
    // Library may be left out (the apps draw it) and the second row may be empty.
    const bare = { count: 4, first: ["today", "capture"], second: [] };
    assert.deepEqual(((await (await put({ bar: bare })).json()) as Record<string, any>).bar, bare);

    for (const bad of [
      null,
      "five",
      { count: 2, first: ["library"], second: [] },
      { count: 6, first: ["library"], second: [] },
      { count: 5, first: ["library"] },
      { count: 5, first: ["today", "library", "today"], second: [] },
      { count: 5, first: ["today", "library"], second: ["today"] },
      { count: 5, first: ["a", "b", "c", "d", "e", "library"], second: [] },
      { count: 3, first: ["today", "assistant", "library", "capture"], second: [] },
      { count: 4, first: ["library"], second: ["a", "b", "c", "d", "e"] },
      { count: 5, first: ["library", "two words"], second: [] },
      { count: 5, first: ["library", 7], second: [] },
    ]) {
      const r = await put({ bar: bad });
      assert.equal(r.status, 422, JSON.stringify(bad));
      assert.match(((await r.json()) as { error: string }).error, /^bar: count is 3, 4 or 5/);
    }
    // Refused whole: the good field beside a bad bar is not taken either.
    assert.equal((await put({ key: "E", bar: { count: 9, first: [], second: [] } })).status, 422);
    const after = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.equal(after.key, "D");
    assert.deepEqual(after.bar, bare);
  } finally { t.cleanup(); }
});

test("bottom bar: a file from before it, or with a bar that breaks a rule, reads with the default bar and keeps the rest", () => {
  const t = makeHub();
  try {
    const usual = { count: 5, first: ["today", "assistant", "capture", "library", "search"], second: ["tasks", "week", "notes", "memory", "people"] };
    const file = path.join(t.dir, "feel-bar.json");
    const store = new FeelStore(file);
    store.set({ key: "A", synth: "bell" });
    const { bar: _bar, ...older } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(older));
    assert.deepEqual(store.get().bar, usual);
    assert.equal(store.get().key, "A");
    for (const broken of [{ count: 7, first: ["today", "today"], second: "none" }, { count: 3, first: ["a", "b", "c", "d"], second: [] }]) {
      fs.writeFileSync(file, JSON.stringify({ ...older, bar: broken }));
      assert.deepEqual(store.get().bar, usual);
      assert.equal(store.get().synth, "bell", "a bad bar does not cost the rest of the setting");
    }
    // The default handed out is a copy: changing it changes no other answer.
    store.get().bar.first.pop();
    assert.equal(store.get().bar.first.length, 5);
  } finally { t.cleanup(); }
});

test("today: the default, a change kept beside the rest of the setting, and what is refused", async () => {
  const t = makeHub();
  try {
    const put = (json: unknown) => t.api("/prefs/feel", { method: "PUT", json });
    const usual = { order: ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"], hidden: [] };
    const first = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.deepEqual(first.today, usual, "a hub that was never told has Today as it always was");

    // A new order with two parts hidden, a part only a newer app knows, and nothing but the two fields kept.
    const today = { order: ["now", "coming", "todo", "schedule", "weather", "needs", "tech", "sofar"], hidden: ["sofar", "needs"] };
    const set = await (await put({ today: { ...today, extra: true } })).json() as Record<string, any>;
    assert.deepEqual(set.today, today);
    assert.equal(set.scale, "major_pentatonic", "the rest of the setting is as it was");
    // An app from before this setting changes another field and never names it: it stays.
    const later = await (await put({ key: "D" })).json() as Record<string, any>;
    assert.deepEqual(later.today, today);
    assert.deepEqual(((await (await t.api("/prefs/feel")).json()) as Record<string, any>).today, today, "kept in the file");
    // Parts left out of the order go in their default places when drawn: the hub keeps the lists as sent.
    const short = { order: ["coming"], hidden: [] };
    assert.deepEqual(((await (await put({ today: short })).json()) as Record<string, any>).today, short);

    for (const bad of [
      null,
      "coming first",
      [],
      { order: ["now"] },
      { hidden: [] },
      { order: "now", hidden: [] },
      { order: ["now", "now"], hidden: [] },
      { order: [], hidden: ["tech", "tech"] },
      { order: ["two words"], hidden: [] },
      { order: [7], hidden: [] },
      { order: Array.from({ length: 41 }, (_, i) => `p${i}`), hidden: [] },
    ]) {
      const r = await put({ today: bad });
      assert.equal(r.status, 422, JSON.stringify(bad));
      assert.match(((await r.json()) as { error: string }).error, /^today: order and hidden are lists/);
    }
    // Refused whole: the good field beside a bad Today is not taken either.
    assert.equal((await put({ key: "E", today: { order: ["now", "now"], hidden: [] } })).status, 422);
    const after = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.equal(after.key, "D");
    assert.deepEqual(after.today, short);
  } finally { t.cleanup(); }
});

test("today: a file from before it, or with a Today that breaks a rule, reads with the default and keeps the rest", () => {
  const t = makeHub();
  try {
    const usual = { order: ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"], hidden: [] };
    const file = path.join(t.dir, "feel-today.json");
    const store = new FeelStore(file);
    store.set({ key: "A", synth: "bell", bar: { count: 4, first: ["today", "library"], second: [] } });
    const { today: _today, ...older } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(older));
    assert.deepEqual(store.get().today, usual);
    assert.equal(store.get().key, "A");
    for (const broken of [{ order: ["now", "now"], hidden: [] }, { order: [], hidden: "tech" }, "default"]) {
      fs.writeFileSync(file, JSON.stringify({ ...older, today: broken }));
      assert.deepEqual(store.get().today, usual);
      assert.equal(store.get().synth, "bell", "a bad Today does not cost the rest of the setting");
      assert.equal(store.get().bar.count, 4);
    }
    // The default handed out is a copy: changing it changes no other answer.
    store.get().today.order.pop();
    assert.equal(store.get().today.order.length, 7);
  } finally { t.cleanup(); }
});

test("today: which Reminders lists fill the To do card, kept when an older app sends Today without them", async () => {
  const t = makeHub();
  try {
    const put = (json: unknown) => t.api("/prefs/feel", { method: "PUT", json });
    const read = async (r: Promise<Response>) => ((await (await r).json()) as Record<string, any>).today;
    const usual = { order: ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"], hidden: [] };
    assert.equal("todo_lists" in (await read(t.api("/prefs/feel"))), false, "every list until one is chosen");

    // Only the list To-Do and the tasks in no list.
    const chosen = { ...usual, todo_lists: ["icloud:iCloud/To-Do", "none"] };
    assert.deepEqual(await read(put({ today: chosen })), chosen);
    // An app from before the choice moves a card and never names the lists: the choice stays.
    const moved = { order: ["now", "todo", "tech", "needs", "schedule", "sofar", "coming"], hidden: ["sofar"] };
    assert.deepEqual(await read(put({ today: moved })), { ...moved, todo_lists: ["icloud:iCloud/To-Do", "none"] });
    assert.deepEqual((await read(t.api("/prefs/feel"))).todo_lists, ["icloud:iCloud/To-Do", "none"], "kept in the file");
    // Nothing chosen is a choice too: the card shows no task.
    assert.deepEqual((await read(put({ today: { ...moved, todo_lists: [] } }))).todo_lists, []);
    // Null asks for every list again, and then the answer says nothing about lists.
    const all = await read(put({ today: { ...moved, todo_lists: null } }));
    assert.deepEqual(all, moved);
    assert.equal("todo_lists" in all, false);

    for (const bad of ["none", ["icloud:iCloud/To-Do", "icloud:iCloud/To-Do"], ["ab"], [7], Array.from({ length: 301 }, (_, i) => `icloud:iCloud/L${i}`)]) {
      const r = await put({ today: { ...usual, todo_lists: bad } });
      assert.equal(r.status, 422, JSON.stringify(bad).slice(0, 60));
      assert.match(((await r.json()) as { error: string }).error, /todo_lists is null or a list of at most 300 list keys or none/);
    }
    assert.deepEqual(await read(t.api("/prefs/feel")), moved, "a refused body changes nothing");
  } finally { t.cleanup(); }
});

test("week calendars: none hidden at first, a change kept beside the rest of the setting, and what is refused", async () => {
  const t = makeHub();
  try {
    const put = (json: unknown) => t.api("/prefs/feel", { method: "PUT", json });
    const first = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.deepEqual(first.hidden_calendars, [], "a hub that was never told shows every calendar");

    // Two calendars and the events made here on none; a key no calendar has any more is kept, and hides nothing.
    const hidden = ["apple:iCloud/Family", "icloud:https://p42-caldav.icloud.com/1234/calendars/work/", "aeneas", "apple:Gone/Old"];
    const set = await (await put({ hidden_calendars: hidden })).json() as Record<string, any>;
    assert.deepEqual(set.hidden_calendars, hidden);
    assert.equal(set.scale, "major_pentatonic", "the rest of the setting is as it was");
    // An app from before this setting changes another field and never names it: it stays.
    const later = await (await put({ key: "D" })).json() as Record<string, any>;
    assert.deepEqual(later.hidden_calendars, hidden);
    assert.deepEqual(((await (await put({ hidden_calendars: [] })).json()) as Record<string, any>).hidden_calendars, [], "every calendar shown again");

    for (const bad of [null, "aeneas", {}, ["aeneas", "aeneas"], [""], [7], ["x".repeat(301)], ["line\nbreak"], Array.from({ length: 301 }, (_, i) => `apple:A/${i}`)]) {
      const r = await put({ hidden_calendars: bad });
      assert.equal(r.status, 422, JSON.stringify(bad).slice(0, 80));
      assert.match(((await r.json()) as { error: string }).error, /^hidden_calendars: a list of at most 300 calendar keys/);
    }
    // Refused whole: the good field beside a bad list is not taken either.
    assert.equal((await put({ key: "E", hidden_calendars: ["a", "a"] })).status, 422);
    const after = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.equal(after.key, "D");
    assert.deepEqual(after.hidden_calendars, []);
    assert.equal((await put({ hidden_calendars: Array.from({ length: 300 }, (_, i) => `apple:A/${i}`) })).status, 200, "300 is allowed");
  } finally { t.cleanup(); }
});

test("week calendars: a file from before it, or with a list that breaks a rule, reads as none hidden and keeps the rest", () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "feel-week.json");
    const store = new FeelStore(file);
    store.set({ key: "A", hidden_calendars: ["apple:iCloud/Home"] });
    assert.deepEqual(store.get().hidden_calendars, ["apple:iCloud/Home"]);
    const { hidden_calendars: _h, ...older } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(older));
    assert.deepEqual(store.get().hidden_calendars, []);
    for (const broken of [["x", "x"], "aeneas", [3]]) {
      fs.writeFileSync(file, JSON.stringify({ ...older, hidden_calendars: broken }));
      assert.deepEqual(store.get().hidden_calendars, []);
      assert.equal(store.get().key, "A", "a bad list does not cost the rest of the setting");
    }
  } finally { t.cleanup(); }
});
