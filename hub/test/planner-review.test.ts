import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { calendarFeed } from "../src/calendar.js";
import { watchesDueSoon } from "../src/planner.js";
import { renewWatch, autopayDue } from "../src/watches.js";
import { runTool, TOOLS, type ToolContext } from "../src/ai/tools.js";

process.env.TZ = "America/New_York";

test("the calendar feed puts renewals and dated tasks on their own day, and all-day spans whole", () => {
  const t = makeHub();
  try {
    t.hub.store.create("watch", { title: "Domain", category: "domain", due: "2026-11-10", lead_days: 7 });
    t.hub.store.create("task", { title: "Pay rent", status: "next", order: 1, due: "2026-11-06" });
    t.hub.store.create("event", { title: "Trip", start: "2026-11-12T00:00:00.000Z", end: "2026-11-15T00:00:00.000Z", all_day: true });
    t.hub.store.create("event", { title: "Fall back", start: "2026-11-01T00:00:00.000Z", end: "2026-11-02T00:00:00.000Z", all_day: true });
    const ics = calendarFeed(t.hub, new Date("2026-11-05T15:00:00Z"));
    const block = (title: string) => ics.split("BEGIN:VEVENT").find((b) => b.includes(title)) ?? "";
    assert.match(block("Renewal due: Domain"), /DTSTART;VALUE=DATE:20261110[\s\S]*DTEND;VALUE=DATE:20261111/);
    assert.match(block("Due: Pay rent"), /DTSTART;VALUE=DATE:20261106/);
    assert.match(block("Trip"), /DTSTART;VALUE=DATE:20261112[\s\S]*DTEND;VALUE=DATE:20261115/);
    assert.match(block("Fall back"), /DTSTART;VALUE=DATE:20261101[\s\S]*DTEND;VALUE=DATE:20261102/);
  } finally { t.cleanup(); }
});

test("renewals: a one-time one renewed is no longer due, renewing twice moves it once, autopay keeps the 31st", () => {
  const t = makeHub();
  try {
    const passport = t.hub.store.create("watch", { title: "Passport", category: "other", due: "2026-11-10", lead_days: 30 });
    const now = new Date("2026-11-05T15:00:00Z");
    assert.ok(watchesDueSoon(t.hub, now).some((w) => w.id === passport.id));
    renewWatch(t.hub.store, passport.id, new Date("2026-11-02T15:00:00Z"));
    assert.ok(!watchesDueSoon(t.hub, now).some((w) => w.id === passport.id));
    const domain = t.hub.store.create("watch", { title: "example.com", category: "domain", due: "2026-11-10", lead_days: 7, repeat: "every 1 years" });
    renewWatch(t.hub.store, domain.id, new Date("2026-11-05T15:00:00Z"));
    renewWatch(t.hub.store, domain.id, new Date("2026-11-05T23:00:00Z"));
    assert.equal(t.hub.store.get(domain.id)!.fields.due, "2027-11-10");
    assert.equal(autopayDue("2026-10-31", "every 1 months", new Date("2026-11-05T15:00:00Z")), "2026-11-30");
    assert.equal(autopayDue("2026-10-31", "every 1 months", new Date("2026-12-05T15:00:00Z")), "2026-12-31");
  } finally { t.cleanup(); }
});

test("the assistant marking a repeating reminder done moves it to its next time", async () => {
  const t = makeHub();
  try {
    const pill = t.hub.store.create("task", { title: "Pills", status: "scheduled", order: 1, remind_at: "2026-11-05T14:00:00.000Z", repeat: "every 1 days" });
    const ctx = { sessionId: "s", lastUser: "", topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null } as ToolContext;
    const api = async (method: string, p: string, body?: unknown) => { const r = await t.api(p, { method, json: body }); return { status: r.status, data: await r.json() }; };
    const out = await runTool(api, { name: "update_task", arguments: { id: pill.id, status: "done" } }, ctx, TOOLS);
    assert.ok(out.ok, out.text);
    const after = t.hub.store.get(pill.id)!;
    assert.notEqual(after.fields.status, "done");
    assert.ok(String(after.fields.remind_at) > "2026-11-05T14:00:00.000Z");
  } finally { t.cleanup(); }
});
