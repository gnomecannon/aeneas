import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { availableMetrics, defaultTiles, metricSeries, parseMetric, periodValue } from "../src/dashboard.js";
import { dayKey } from "../src/metrics.js";

// The hub runs on New York time (loadConfig sets TZ), so the local constructors below are New York wall clock. Set it
// before NOW is built, which happens before any hub is made.
process.env.TZ = "America/New_York";
const NOW = new Date(2026, 9, 29, 15, 0, 0);
const day = (offset: number, h = 12, m = 0) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, h, m, 0).toISOString();

test("dashboard series: weight is a daily mean with the newest reading as latest and the change against the week before", () => {
  const t = makeHub();
  try {
    t.hub.store.create("log", { type: "weight", value: 170, unit: "lb", at: day(-10) });
    t.hub.store.create("log", { type: "weight", value: 168, unit: "lb", at: day(-8) });
    t.hub.store.create("log", { type: "weight", value: 164, unit: "lb", at: day(-2, 8) });
    t.hub.store.create("log", { type: "weight", value: 162, unit: "lb", at: day(-2, 20) });
    t.hub.store.create("log", { type: "weight", value: 161, unit: "lb", at: day(0, 7) });
    const s = metricSeries(t.hub, "log:weight", 7, NOW);
    assert.equal(s.points.length, 7);
    assert.equal(s.to, dayKey(NOW));
    assert.equal(s.points[4].value, 163, "two readings on one day average");
    assert.equal(s.points[0].value, null, "a day with no reading is null, not zero");
    assert.deepEqual(s.latest, { day: dayKey(NOW), value: 161, at: day(0, 7) });
    assert.equal(s.unit, "lb");
    assert.equal(s.period, "average");
    assert.equal(s.current, 162.33);
    assert.equal(s.previous, 169);
    assert.equal(s.change, -6.67);
    assert.equal(s.chart, "line");
  } finally { t.cleanup(); }
});

test("dashboard series: counts, sums, blood pressure, sleep hours, activity minutes split at midnight, custom logs by name", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("task", { title: "a", status: "done", order: 1, done_at: day(0, 9) });
    s.create("task", { title: "b", status: "done", order: 2, done_at: day(0, 10) });
    s.create("task", { title: "c", status: "done", order: 3, done_at: day(-1) });
    s.create("task", { title: "repeat", status: "scheduled", order: 4, done_at: day(-9), remind_at: day(5) });
    s.create("task", { title: "open", status: "next", order: 5 });
    const done = metricSeries(t.hub, "tasks:done", 7, NOW);
    assert.deepEqual(done.points.slice(-2).map((p) => p.value), [1, 2]);
    assert.equal(done.points[0].value, 0, "counts are zero on empty days");
    assert.deepEqual(done.latest, { day: dayKey(NOW), value: 2 });
    assert.equal(done.period, "total");
    assert.equal(done.current, 3);
    assert.equal(done.previous, 1, "a repeating task counts on the day it was last done");
    assert.equal(done.change, 2);
    assert.equal(done.change_pct, 200);

    s.create("log", { type: "bp", value: "120/80", at: day(-1, 8) });
    s.create("log", { type: "bp", value: "130/84", at: day(-1, 20) });
    assert.equal(metricSeries(t.hub, "log:bp_systolic", 7, NOW).points[5].value, 125);
    assert.equal(metricSeries(t.hub, "log:bp_diastolic", 7, NOW).points[5].value, 82);

    s.create("log", { type: "sleep", value: 450, unit: "min", at: day(0, 7) });
    s.create("log", { type: "sleep", value: 6.5, unit: "h", at: day(-1, 7) });
    const sleep = metricSeries(t.hub, "log:sleep", 7, NOW);
    assert.deepEqual(sleep.points.slice(-2).map((p) => p.value), [6.5, 7.5]);
    assert.equal(sleep.unit, "h");

    s.create("log", { type: "caffeine", value: 2, at: day(0, 8) });
    s.create("log", { type: "caffeine", value: 1, at: day(0, 14) });
    assert.equal(metricSeries(t.hub, "log:caffeine", 7, NOW).latest?.value, 3);

    // 23:00 yesterday to 01:30 today: 60 minutes yesterday, 90 today. An open one runs until now.
    s.create("log", { type: "activity", value: "soldering", at: day(-1, 23) });
    s.create("log", { type: "activity", value: "soldering", note: "end", at: day(0, 1, 30) });
    s.create("log", { type: "activity", value: "reading", at: day(0, 14, 30) });
    const act = metricSeries(t.hub, "log:activity", 7, NOW);
    assert.deepEqual(act.points.slice(-2).map((p) => p.value), [60, 120]);

    s.create("log", { type: "custom", name: "Pushups", value: 20, unit: "reps", at: day(0, 9) });
    s.create("log", { type: "custom", name: "pushups", value: 15, unit: "reps", at: day(0, 13) });
    s.create("log", { type: "custom", value: 30, unit: "pages", at: day(-1) });
    const push = metricSeries(t.hub, "log:custom:pushups", 7, NOW);
    assert.equal(push.latest?.value, 35);
    assert.equal(push.unit, "reps");
    assert.equal(metricSeries(t.hub, "log:custom:pages", 7, NOW).points[5].value, 30, "a custom log without a name goes by its unit");

    s.create("capture", { text: "x", source: "api" });
    assert.equal(metricSeries(t.hub, "captures:created", 7).latest?.value, 1);
  } finally { t.cleanup(); }
});

test("dashboard series: sensor readings average per day with the last reading as latest; monitor uptime percent per day", async () => {
  const t = makeHub();
  try {
    for (const [h, v] of [[1, 20], [2, 22], [14, 24]] as const) {
      const r = await t.api("/sensors/cabinet_temp/readings", { method: "POST", json: { value: v, unit: "C", at: day(0, h) } });
      assert.equal(r.status, 201);
    }
    await t.api("/sensors/cabinet_temp/readings", { method: "POST", json: { value: 18, at: day(-3, 23, 30) } });
    const s = metricSeries(t.hub, "sensor:cabinet_temp", 7, NOW);
    assert.equal(s.points[6].value, 22);
    assert.equal(s.points[3].value, 18, "23:30 local stays on its local day though it is the next day in UTC");
    assert.equal(s.latest?.value, 24);
    assert.equal(s.unit, "C");

    const mon = t.hub.store.create("monitor", { name: "storage", type: "ping", target: "10.0.0.16" });
    const ins = t.hub.db.prepare("INSERT INTO checks (monitor_id, at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)");
    ins.run(mon.id, day(0, 9), 1, 3, null);
    ins.run(mon.id, day(0, 10), 1, 3, null);
    ins.run(mon.id, day(0, 11), 1, 3, null);
    ins.run(mon.id, day(0, 12), 0, null, "timeout");
    ins.run(mon.id, day(-8), 1, 3, null);
    const up = metricSeries(t.hub, `monitor:${mon.id}`, 7, NOW);
    assert.equal(up.points[6].value, 75);
    assert.equal(up.points[5].value, null);
    assert.equal(up.label, "storage uptime");
    assert.equal(up.current, 75);
    assert.equal(up.previous, 100);
    assert.equal(up.change, -25);
  } finally { t.cleanup(); }
});

test("dashboard metrics and default tiles: only what has data, in the usual order", () => {
  const t = makeHub();
  try {
    assert.deepEqual(availableMetrics(t.hub), []);
    assert.deepEqual(defaultTiles([]), []);
    t.hub.store.create("log", { type: "steps", value: 8000, at: day(0) });
    t.hub.store.create("log", { type: "weight", value: 160, at: day(0) });
    t.hub.store.create("log", { type: "bp", value: "118/76", at: day(0) });
    t.hub.store.create("sensor", { name: "garage", unit: "C" });
    t.hub.store.create("sensor", { name: "attic", unit: "C" });
    t.hub.store.create("reading", { sensor: "attic", value: 30, at: day(0) });
    const ms = availableMetrics(t.hub);
    assert.deepEqual(ms.map((m) => m.id), ["log:weight", "log:steps", "log:bp_systolic", "log:bp_diastolic", "sensor:attic"]);
    assert.equal(ms.find((m) => m.id === "sensor:attic")?.count, 1);
    assert.deepEqual(defaultTiles(ms), [
      { metric: "log:weight", range: 30, chart: "line" },
      { metric: "log:steps", range: 30, chart: "bar" },
      { metric: "log:bp_systolic", range: 90, chart: "line" },
      { metric: "sensor:attic", range: 7, chart: "line" },
    ]);
  } finally { t.cleanup(); }
});

test("dashboard parsing and period rules", () => {
  assert.deepEqual(parseMetric("log:custom:Glasses of water"), { source: "custom", name: "Glasses of water" });
  assert.deepEqual(parseMetric("sensor:cabinet_temp"), { source: "sensor", name: "cabinet_temp" });
  assert.equal(parseMetric("log:height"), null);
  assert.equal(parseMetric("weather"), null);
  assert.equal(periodValue([undefined, undefined], "count"), 0);
  assert.equal(periodValue([undefined, undefined], "mean"), null);
  assert.equal(periodValue([{ sum: 3, n: 3, last: 1, lastAt: "" }, { sum: 1, n: 1, last: 1, lastAt: "" }], "pct"), 100);
});

test("prefs/dashboard: defaults until saved, one board for every device, refusals, reset; board and series routes", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("log", { type: "weight", value: 160, at: new Date().toISOString() });
    t.hub.store.create("task", { title: "x", status: "done", order: 1, done_at: new Date().toISOString() });
    const first = await (await t.api("/prefs/dashboard")).json() as any;
    assert.equal(first.saved, false);
    assert.deepEqual(first.tiles.map((x: any) => x.metric), ["log:weight", "tasks:done"]);
    assert.deepEqual(first.options.ranges, [7, 30, 90, 365]);

    const tiles = [{ metric: "tasks:done", range: 7, chart: "bar" }, { metric: "log:weight", range: 365, chart: "line" }, { metric: "sensor:not_yet", range: 30, chart: "line" }];
    const put = await (await t.api("/prefs/dashboard", { method: "PUT", json: { tiles } })).json() as any;
    assert.equal(put.saved, true);
    assert.deepEqual(put.tiles, tiles);
    assert.ok(fs.existsSync(path.join(t.dir, "dashboard.json")));
    const seqBefore = t.hub.store.seq();
    assert.equal((await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: [{ metric: "tasks:done", range: 14, chart: "bar" }] } })).status, 422);
    assert.equal((await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: [{ metric: "tasks:done", range: 7, chart: "pie" }] } })).status, 422);
    assert.equal((await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: [{ metric: "weather", range: 7, chart: "bar" }] } })).status, 422);
    assert.equal((await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: "all" } })).status, 422);
    assert.deepEqual(((await (await t.api("/prefs/dashboard")).json()) as any).tiles, tiles, "a refused body changes nothing");
    assert.equal(t.hub.store.seq(), seqBefore, "the board is a setting, not a change on the feed");

    const board = await (await t.api("/dashboard/board")).json() as any;
    assert.equal(board.tiles.length, 3);
    assert.equal(board.tiles[0].series.points.length, 7);
    assert.equal(board.tiles[0].series.latest.value, 1);
    assert.equal(board.tiles[1].series.points.length, 365);
    assert.equal(board.tiles[2].series.latest, null, "a sensor with no readings yet is an empty series");

    const series = await t.api("/dashboard/series?metric=log:weight&days=90");
    assert.equal(series.status, 200);
    assert.equal(((await series.json()) as any).points.length, 90);
    assert.equal((await t.api("/dashboard/series?metric=weather")).status, 400);
    assert.equal((await t.api("/dashboard/series")).status, 400);
    const metrics = await (await t.api("/dashboard/metrics")).json() as any;
    assert.deepEqual(metrics.metrics.map((m: any) => m.id), ["log:weight", "tasks:done"]);

    await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: [] } });
    assert.deepEqual(((await (await t.api("/dashboard/board")).json()) as any).tiles, [], "an emptied board stays empty");
    const reset = await (await t.api("/prefs/dashboard", { method: "DELETE" })).json() as any;
    assert.equal(reset.saved, false);
    assert.equal(reset.tiles.length, 2);
  } finally { t.cleanup(); }
});
