import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceKey, makeHub, TOKEN } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";

test("calendar feed: task blocks, events, reminders and renewals, without work items, with the token in the link", async () => {
  const t = makeHub();
  try {
    const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    t.hub.store.create("task", { title: "Fix the NAS, then rest", status: "scheduled", order: 1, block: { start: soon(2), end: soon(4) } });
    t.hub.store.create("event", { title: "Vet; Pepper", start: soon(24), end: soon(25) });
    t.hub.store.create("event", { title: "Standup", start: soon(26), end: soon(27) }, "work");
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "Call the pharmacy", remind_at: soon(5), friction: "none" });
    t.hub.store.create("task", { order: 1, title: "Old one", remind_at: soon(6), friction: "none", status: "done" });
    t.hub.store.create("watch", { title: "Domain", category: "domain", due: soon(24 * 10), lead_days: 7 });
    assert.equal((await t.app.request(`/calendar.ics?token=${TOKEN}`)).status, 401, "the main key never works in a link");
    const r = await t.app.request(`/calendar.ics?token=${encodeURIComponent(await deviceKey(t))}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/calendar/);
    const ics = await r.text();
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /SUMMARY:Fix the NAS\\, then rest/);
    assert.match(ics, /SUMMARY:Vet\\; Pepper/);
    assert.match(ics, /SUMMARY:Reminder: Call the pharmacy/);
    assert.match(ics, /SUMMARY:Renewal due: Domain\r\nDTSTART;VALUE=DATE:\d{8}/);
    assert.doesNotMatch(ics, /Standup/, "work items stay out");
    assert.doesNotMatch(ics, /Old one/, "acknowledged reminders stay out");
    assert.equal((await t.app.request("/calendar.ics")).status, 401, "needs the token");
  } finally {
    t.cleanup();
  }
});

test("calendar: an assistant event from midnight to midnight is all day even when the model leaves the flag out", async () => {
  const t = makeHub();
  try {
    const a = async (method: string, p: string, body?: unknown) => {
      const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const ctx = ctxFor(t, "allday-1");
    await runTool(a, { name: "create_item", arguments: { kind: "event", fields: { title: "Apple picking with Jen", start: "2026-10-31T00:00:00-05:00", end: "2026-11-01T00:00:00-05:00" } } }, ctx);
    await runTool(a, { name: "create_item", arguments: { kind: "event", fields: { title: "Dentist", start: "2026-11-03T15:00:00-05:00", end: "2026-11-03T16:00:00-05:00" } } }, ctx);
    const ev = t.hub.store.list({ kind: "event" });
    assert.equal(ev.find((e) => e.fields.title === "Apple picking with Jen")!.fields.all_day, true);
    assert.equal(ev.find((e) => e.fields.title === "Dentist")!.fields.all_day, undefined);

    // An all-day plan is on its own date only, whatever offset it was written with.
    const week = await (await t.app.request("/planner/week?start=2026-10-26", { headers: { authorization: `Bearer ${t.hub.cfg.token}` } })).json() as { days: { date: string; events: { fields: { title: string } }[] }[] };
    const on = week.days.filter((d) => d.events.some((e) => e.fields.title === "Apple picking with Jen")).map((d) => d.date);
    assert.deepEqual(on, ["2026-10-31"]);
    t.hub.store.create("event", { title: "Stored at UTC midnight", start: "2026-10-30T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", all_day: true });
    const week2 = await (await t.app.request("/planner/week?start=2026-10-26", { headers: { authorization: `Bearer ${t.hub.cfg.token}` } })).json() as typeof week;
    assert.deepEqual(week2.days.filter((d) => d.events.some((e) => e.fields.title === "Stored at UTC midnight")).map((d) => d.date), ["2026-10-30"], "not the evening before west of UTC");

    // A clock time on an all-day plan makes it timed.
    const apple = ev.find((e) => e.fields.title === "Apple picking with Jen")!;
    await runTool(a, { name: "update_item", arguments: { id: apple.id, fields: { start: "2026-10-31T19:00:00-04:00", end: "2026-10-31T20:00:00-04:00" } } }, ctx);
    assert.equal(t.hub.store.get(apple.id)!.fields.all_day, false);
    // A start alone on an all-day plan gets an hour, not the old midnight end.
    const allDay = t.hub.store.create("event", { title: "Dinner with Rafael", start: "2026-11-06T00:00:00-05:00", end: "2026-11-07T00:00:00-05:00", all_day: true });
    await runTool(a, { name: "update_item", arguments: { id: allDay.id, fields: { start: "2026-11-06T19:00:00-05:00" } } }, ctx);
    const dinner = t.hub.store.get(allDay.id)!.fields;
    assert.equal(dinner.all_day, false);
    assert.equal(Date.parse(String(dinner.end)) - Date.parse(String(dinner.start)), 3600_000);
    // all_day alone does not stretch a timed plan over the day.
    const planned = t.hub.store.create("event", { title: "Apple picking", start: "2026-11-01T11:30:00-05:00", end: "2026-11-01T23:29:00-05:00" });
    await runTool(a, { name: "update_item", arguments: { id: planned.id, fields: { title: "Apple picking with Jen", all_day: true } } }, ctx);
    assert.equal(t.hub.store.get(planned.id)!.fields.all_day, undefined);
    assert.equal(t.hub.store.get(planned.id)!.fields.title, "Apple picking with Jen");
    // Other updates leave the flag alone.
    const day = t.hub.store.create("event", { title: "Trip", start: "2026-11-07T00:00:00-05:00", end: "2026-11-08T00:00:00-05:00", all_day: true });
    await runTool(a, { name: "update_item", arguments: { id: day.id, fields: { title: "Trip to Maine" } } }, ctx);
    assert.equal(t.hub.store.get(day.id)!.fields.all_day, true);
  } finally { t.cleanup(); }
});
