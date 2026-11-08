import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

test("the calendar and sensor keys each open one door, and a new key ends the old one", async () => {
  const t = makeHub();
  try {
    const feeds = await (await t.api("/feeds")).json() as { calendar: { key: string; path: string }; sensors: { key: string } };
    assert.match(feeds.calendar.path, /^\/calendar\.ics\?key=/);
    const bare = (p: string, init: RequestInit = {}) => t.app.request(p, init);
    // The calendar key reads the feed, and nothing else.
    assert.equal((await bare(`/calendar.ics?key=${feeds.calendar.key}`)).status, 200);
    assert.equal((await bare(`/entities?key=${feeds.calendar.key}`)).status, 401);
    assert.equal((await bare(`/calendar.ics?token=${feeds.calendar.key}`)).status, 401, "it is not a token");
    assert.equal((await bare(`/calendar.ics?key=${feeds.sensors.key}`)).status, 401, "the sensor key does not read the calendar");
    // The sensor key posts readings, and nothing else.
    const post = (key: string) => bare(`/sensors/balcony/readings?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: 21.5, unit: "C" }) });
    assert.ok((await post(feeds.sensors.key)).status < 300);
    assert.equal((await bare(`/sensors?key=${feeds.sensors.key}`)).status, 401);
    assert.equal((await post(feeds.calendar.key)).status, 401);
    // A new calendar key ends the old one.
    const next = await (await t.api("/feeds/calendar/rotate", { method: "POST" })).json() as { calendar: { key: string } };
    assert.notEqual(next.calendar.key, feeds.calendar.key);
    assert.equal((await bare(`/calendar.ics?key=${feeds.calendar.key}`)).status, 401);
    assert.equal((await bare(`/calendar.ics?key=${next.calendar.key}`)).status, 200);
    assert.equal((await t.api("/feeds/nope/rotate", { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});
