import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";
import { appendDiary, readDiary } from "../src/diary.js";

test("diary: recall by day and by words, with that day's events and logs", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    appendDiary(s, "Going out to eat at Luigi's with Jen tonight", new Date(2026, 9, 30, 17, 5));
    appendDiary(s, "Took the trash out", new Date(2026, 9, 30, 19, 40));
    appendDiary(s, "Gym, legs", new Date(2026, 9, 28, 7, 15));
    s.create("event", { title: "Tonight: dinner at Luigi's with Jen", start: "2026-10-30T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", all_day: true });
    s.create("log", { type: "weight", value: 116.4, unit: "lb", at: new Date(2026, 9, 30, 8, 0).toISOString() });

    const all = readDiary(s, "2026-10-24", "2026-10-30");
    assert.deepEqual(all.map((d) => d.day), ["2026-10-30", "2026-10-28"]);
    assert.deepEqual(all[0].lines.map((l) => l.time), ["17:05", "19:40"]);
    assert.equal(all[0].events[0].start, "all day");
    assert.equal(all[0].logs[0].value, 116.4);

    const luigis = readDiary(s, "2026-01-01", "2026-10-31", "luigi's");
    assert.equal(luigis.length, 1);
    assert.equal(luigis[0].lines.length, 1);
    assert.equal(luigis[0].events.length, 1);
    assert.equal(luigis[0].logs.length, 0);

    const ctx = ctxFor(t, "diary-1");
    const api = async () => ({ status: 200, data: null });
    const out = JSON.parse((await runTool(api, { name: "diary", arguments: { query: "gym", to: "2026-10-31" } }, ctx)).text);
    assert.equal(out.days[0].day, "2026-10-28");
    assert.equal(out.days[0].weekday, "Wednesday");
    assert.equal(out.days[0].lines[0].text, "Gym, legs");
  } finally {
    t.cleanup();
  }
});

test("diary: a capture before 4 AM belongs to the day before, after that night's lines", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    appendDiary(s, "Carving pumpkins", new Date(2026, 9, 31, 21, 30));
    const note = appendDiary(s, "Went apple picking on Halloween with Jen", new Date(2026, 10, 1, 0, 18));
    assert.equal(note.fields.path, "Diary/2026-10-31.md");
    appendDiary(s, "Coffee", new Date(2026, 10, 1, 8, 0));
    const days = readDiary(s, "2026-10-31", "2026-11-01");
    assert.deepEqual(days.map((d) => d.day), ["2026-11-01", "2026-10-31"]);
    assert.deepEqual(days[1].lines.map((l) => l.time), ["21:30", "00:18"]);
  } finally {
    t.cleanup();
  }
});
