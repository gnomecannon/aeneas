import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { downsample, purgeReadings, sensorTick } from "../src/sensors.js";
import { startFocusLoop } from "../src/focus.js";
import type { NotifyEvent } from "../src/bus.js";

const MIN = 60_000;

test("sensors: the first reading creates the config; a crossing notifies once, and once more when back to ok", async () => {
  const t = makeHub();
  try {
    const notifies: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { if (e.kind === "sensor") notifies.push(e); });
    const sensorKey = ((await (await t.api("/feeds")).json()) as { sensors: { key: string } }).sensors.key;
    const post = (value: number, at?: string) => t.api(`/sensors/cabinet_temp/readings?key=${sensorKey}`, { method: "POST", headers: { authorization: "" }, json: { value, unit: "C", ...(at ? { at } : {}) } });

    const first = await post(20);
    assert.equal(first.status, 201, "the sensor key in the link is enough for a microcontroller");
    const reading = await first.json() as any;
    assert.equal(reading.kind, "reading");
    assert.equal(reading.fields.sensor, "cabinet_temp");
    let sensors = t.hub.store.list({ kind: "sensor" });
    assert.equal(sensors.length, 1);
    assert.equal(sensors[0].fields.unit, "C");
    assert.equal(sensors[0].fields.state, "ok");
    assert.equal(sensors[0].fields.last_value, 20);
    assert.equal(notifies.length, 0, "the first reading is not a crossing");

    await t.api(`/entities/${sensors[0].id}`, { method: "PATCH", json: { fields: { min: 5, max: 30, location: "server cabinet" } } });
    await post(31);
    await post(32);
    assert.equal(notifies.length, 1, "one notify per crossing, not per reading");
    assert.equal(notifies[0].kind, "sensor");
    assert.equal(notifies[0].name, "cabinet_temp");
    assert.equal(notifies[0].value, 31);
    assert.equal(notifies[0].unit, "C");
    assert.equal(notifies[0].state, "high");
    assert.equal(t.hub.store.get(sensors[0].id)!.fields.state, "high");

    await post(25);
    assert.equal(notifies.length, 2);
    assert.equal(notifies[1].state, "ok");
    await post(2);
    assert.equal(notifies[2].state, "low");
    assert.equal(t.hub.store.get(sensors[0].id)!.fields.last_value, 2);

    // An older reading is stored but never moves the state or last_value.
    await post(100, new Date(Date.now() - 3600_000).toISOString());
    assert.equal(notifies.length, 3);
    assert.equal(t.hub.store.get(sensors[0].id)!.fields.last_value, 2);
    assert.equal(t.hub.store.list({ kind: "reading" }).length, 6);

    // alert: false keeps the state but stays quiet.
    await t.api(`/entities/${sensors[0].id}`, { method: "PATCH", json: { fields: { alert: false } } });
    await post(50);
    assert.equal(t.hub.store.get(sensors[0].id)!.fields.state, "high");
    assert.equal(notifies.length, 3);

    assert.equal((await t.api("/sensors/bad name/readings", { method: "POST", json: { value: 1 } })).status, 422);
    assert.equal((await t.api("/sensors/x/readings", { method: "POST", json: { value: "warm" } })).status, 422);
    assert.equal((await t.api("/sensors/x/readings", { method: "POST", json: { value: 1, at: "yesterday" } })).status, 422);
    sensors = t.hub.store.list({ kind: "sensor" });
    assert.equal(sensors.length, 1, "rejected posts create nothing");
  } finally { t.cleanup(); }
});

test("sensors: stale after stale_minutes without a reading, one notify, and ok again on the next reading", async () => {
  const t = makeHub();
  try {
    const notifies: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { if (e.kind === "sensor") notifies.push(e); });
    const now = new Date();
    await t.api("/sensors/humidity/readings", { method: "POST", json: { value: 40, unit: "%", at: now.toISOString() } });
    const s = t.hub.store.list({ kind: "sensor" })[0];
    assert.deepEqual(sensorTick(t.hub, new Date(now.getTime() + 179 * MIN)), []);
    assert.deepEqual(sensorTick(t.hub, new Date(now.getTime() + 181 * MIN)), ["humidity"]);
    assert.equal(t.hub.store.get(s.id)!.fields.state, "stale");
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].state, "stale");
    assert.equal(notifies[0].value, null);
    assert.deepEqual(sensorTick(t.hub, new Date(now.getTime() + 300 * MIN)), [], "stale notifies once");
    assert.equal(notifies.length, 1);

    await t.api("/sensors/humidity/readings", { method: "POST", json: { value: 41, at: new Date(now.getTime() + 301 * MIN).toISOString() } });
    assert.equal(t.hub.store.get(s.id)!.fields.state, "ok");
    assert.equal(notifies.length, 2, "back from stale is a state change worth one notify");
    assert.equal(notifies[1].state, "ok");

    // A custom stale window.
    await t.api(`/entities/${s.id}`, { method: "PATCH", json: { fields: { stale_minutes: 10 } } });
    assert.deepEqual(sensorTick(t.hub, new Date(now.getTime() + 312 * MIN)), ["humidity"]);
    const status = await (await t.api("/status")).json() as any;
    assert.equal(status.home.sensors, 1);
    assert.equal(status.home.sensors_alerting, 1);
    assert.equal(status.home.readings_24h, 2);
  } finally { t.cleanup(); }
});

test("sensors: GET /sensors carries a 24 h series downsampled to 288 points; csv and the sync feed exclusion", async () => {
  const t = makeHub();
  try {
    const now = Date.now();
    await t.api("/sensors/lux/readings", { method: "POST", json: { value: 1, unit: "lux", at: new Date(now - 2 * 86400_000).toISOString() } });
    for (let i = 0; i < 600; i++) t.hub.store.create("reading", { sensor: "lux", value: i, at: new Date(now - 20 * 3600_000 + i * 60_000).toISOString() });
    const list = await (await t.api("/sensors")).json() as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].fields.name, "lux");
    assert.equal(list[0].series_24h.length, 288);
    assert.ok(list[0].series_24h.every((p: any, i: number, a: any[]) => i === 0 || p.at > a[i - 1].at), "ascending");
    assert.equal(list[0].series_24h[0].value, 0.5, "the first bucket averages readings 0 and 1");
    assert.deepEqual(downsample([{ at: "a", value: 1 }, { at: "b", value: 2 }], 288), [{ at: "a", value: 1 }, { at: "b", value: 2 }], "small series pass through");
    assert.equal(downsample(Array.from({ length: 1000 }, (_, i) => ({ at: String(i).padStart(4, "0"), value: i })), 288).length, 288);

    const csv = await t.api("/sensors/lux/csv?days=1");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const lines = (await csv.text()).trim().split("\n");
    assert.equal(lines[0], "at,value,unit");
    assert.equal(lines.length, 601, "header plus the 600 readings inside one day");
    assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T.*,0,lux$/);
    const all = (await (await t.api("/sensors/lux/csv?days=3")).text()).trim().split("\n");
    assert.equal(all.length, 602);
    assert.equal((await t.api("/sensors/nope/csv")).status, 404);
    assert.equal((await t.api("/sensors/lux/csv?days=0")).status, 400);

    // Readings stay out of the change feed unless asked for by kind.
    const feed = await (await t.api("/sync/changes?since=0")).json() as any;
    assert.ok(feed.changes.length > 0);
    assert.ok(feed.changes.every((c: any) => c.entity.kind !== "reading"));
    assert.equal(feed.more, false);
    const asked = await (await t.api("/sync/changes?since=0&kinds=reading")).json() as any;
    assert.ok(asked.changes.length >= 500 && asked.changes.every((c: any) => c.entity.kind === "reading"));

    // Nightly purge: rows older than the retention window are gone without tombstones.
    t.hub.store.create("reading", { sensor: "lux", value: 9, at: new Date(now - 400 * 86400_000).toISOString() });
    t.hub.store.create("reading", { sensor: "lux", value: 9, at: new Date(now - 370 * 86400_000).toISOString() });
    assert.equal(purgeReadings(t.hub, 365, new Date(now)), 2);
    assert.equal(t.hub.store.list({ kind: "reading", includeDeleted: true }).length, 601);
    assert.equal(purgeReadings(t.hub, 365, new Date(now)), 0);
    assert.equal(purgeReadings(t.hub, 1, new Date(now)), 1, "the 2 day old reading goes with a 1 day window");
  } finally { t.cleanup(); }
});

test("sensors: the minute loop runs the sensor tick beside the focus tick, and a throwing tick does not stop the others", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    await t.api("/sensors/soil/readings", { method: "POST", json: { value: 12, unit: "moisture", at: new Date(now.getTime() - 200 * MIN).toISOString() } });
    let ran = 0;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: unknown) => { errors.push(String(msg)); };
    const stop = startFocusLoop(t.hub, 5, [
      { label: "boom", tick: () => { throw new Error("tick failed on purpose"); } },
      { label: "sensors", tick: () => { ran++; sensorTick(t.hub); } },
    ]);
    try {
      await new Promise((r) => setTimeout(r, 40));
    } finally { stop(); console.error = orig; }
    assert.ok(ran >= 2, "the tick kept running on the interval");
    assert.ok(errors.some((e) => e.includes("[boom] tick failed")), "the error is logged with its label");
    assert.equal(t.hub.store.list({ kind: "sensor" })[0].fields.state, "stale", "200 minutes without a reading");
  } finally { t.cleanup(); }
});
