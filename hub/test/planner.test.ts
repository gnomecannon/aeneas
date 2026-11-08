import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";
import { emitDigest, mondayOf, ruleAppliesOnWeek, todayView, weekModel } from "../src/planner.js";
import type { NotifyEvent } from "../src/bus.js";
import { dayKey } from "../src/metrics.js";

// The process TZ is America/New_York (loadConfig sets it), so local constructors below are New York wall clock.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (y: number, m: number, d: number, h = 0, min = 0) => local(y, m, d, h, min).toISOString();
const hhmm = (s: string) => { const d = new Date(s); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

test("planner: free slots are the day window minus blackouts, commitments, blocks and events; preferences only flag", () => {
  const t = makeHub();
  try {
    runSeed(t.hub.store, t.hub.cfg.seedDir); // Work 09:00 to 17:00 mon to fri, Evening block preference 18:00 to 22:00
    t.hub.store.create("plan_rule", { title: "Dinner", type: "commitment", days: ["wed"], start: "17:00", end: "19:00" });
    t.hub.store.create("event", { title: "Dentist", start: iso(2026, 10, 24, 12), end: iso(2026, 10, 24, 14) });
    // An all-day marker (a holiday) is not busy time: Sunday stays wholly free below.
    t.hub.store.create("event", { title: "Halloween", all_day: true, start: iso(2026, 10, 25), end: iso(2026, 10, 26) });
    const task = t.hub.store.create("task", { title: "Fix the NAS", status: "scheduled", order: 1, block: { start: iso(2026, 10, 24, 15), end: iso(2026, 10, 24, 18) } });
    t.hub.store.create("task", { title: "finished, block ignored", status: "done", order: 2, block: { start: iso(2026, 10, 24, 19), end: iso(2026, 10, 24, 22) } });

    const week = weekModel(t.hub, local(2026, 10, 19), 3);
    assert.equal(week.start, "2026-10-19");
    assert.equal(week.days.length, 7);
    assert.deepEqual(week.days.map((d) => d.date), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);

    const mon = week.days[0];
    assert.deepEqual(mon.commitments.map((c) => [c.title, c.type, hhmm(c.start), hhmm(c.end)]), [["Work", "blackout", "09:00", "17:00"]]);
    assert.deepEqual(mon.preferences.map((c) => c.title), ["Evening block"]);
    assert.deepEqual(mon.free_slots.map((s) => [hhmm(s.start), hhmm(s.end), s.hours, s.preferred]), [["17:00", "23:00", 6, true]]);

    // Wednesday: the dinner commitment eats 17:00 to 19:00; the 22:00 to 23:00 tail is too short on its own and merges into the preferred slot.
    const wed = week.days[2];
    assert.deepEqual(wed.commitments.map((c) => c.title), ["Work", "Dinner"]);
    assert.deepEqual(wed.free_slots.map((s) => [hhmm(s.start), hhmm(s.end), s.hours, s.preferred]), [["19:00", "23:00", 4, true]]);

    // Saturday: no rules, one event and one live block; the 14:00 to 15:00 gap is under min_hours and dropped.
    const sat = week.days[5];
    assert.deepEqual(sat.commitments, []);
    assert.deepEqual(sat.events.map((e) => e.fields.title), ["Dentist"]);
    assert.deepEqual(sat.blocks, [{ task_id: task.id, title: "Fix the NAS", start: iso(2026, 10, 24, 15), end: iso(2026, 10, 24, 18), status: "scheduled" }]);
    assert.deepEqual(sat.free_slots.map((s) => [hhmm(s.start), hhmm(s.end), s.hours, s.preferred]), [["09:00", "12:00", 3, undefined], ["18:00", "23:00", 5, undefined]]);
    // A larger min_hours drops the 3 hour morning slot.
    assert.deepEqual(weekModel(t.hub, local(2026, 10, 19), 4).days[5].free_slots.map((s) => s.hours), [5]);
    // Sunday is wide open.
    assert.deepEqual(week.days[6].free_slots.map((s) => [hhmm(s.start), hhmm(s.end), s.hours]), [["09:00", "23:00", 14]]);
  } finally { t.cleanup(); }
});

test("planner: an alternating rule applies on even weeks from its anchor's Monday and not on odd weeks", () => {
  const t = makeHub();
  try {
    // Anchor on a Wednesday: it still counts from that week's Monday (2026-10-05).
    const kids = t.hub.store.create("plan_rule", { title: "Kids weekend", type: "blackout", days: ["sat", "sun"], start: "09:00", end: "23:00", alternating_anchor: "2026-10-07" });
    assert.equal(mondayOf(local(2026, 10, 7)).getTime(), local(2026, 10, 5).getTime());
    assert.equal(ruleAppliesOnWeek(kids, local(2026, 10, 5)), true);
    assert.equal(ruleAppliesOnWeek(kids, local(2026, 10, 12)), false);
    assert.equal(ruleAppliesOnWeek(kids, local(2026, 10, 19)), true);
    assert.equal(ruleAppliesOnWeek(kids, local(2026, 9, 21)), true, "two weeks before the anchor");
    assert.equal(ruleAppliesOnWeek(kids, local(2026, 9, 28)), false);

    const on = weekModel(t.hub, local(2026, 10, 19));
    assert.deepEqual(on.days[5].commitments.map((c) => c.title), ["Kids weekend"]);
    assert.deepEqual(on.days[5].free_slots, []);
    assert.deepEqual(on.days[6].free_slots, []);
    assert.equal(on.days[0].commitments.length, 0, "weekdays untouched");

    const off = weekModel(t.hub, local(2026, 10, 26));
    assert.deepEqual(off.days[5].commitments, []);
    assert.deepEqual(off.days[5].free_slots.map((s) => s.hours), [14]);

    // Inactive rules never apply.
    t.hub.store.patch(kids.id, { active: false });
    assert.deepEqual(weekModel(t.hub, local(2026, 10, 19)).days[5].commitments, []);
  } finally { t.cleanup(); }
});

test("planner: GET /planner/week validates start and min_hours and defaults to this week's Monday", async () => {
  const t = makeHub();
  try {
    let res = await t.api("/planner/week");
    assert.equal(res.status, 200);
    const w = await res.json() as { start: string; min_hours: number; days: { date: string }[] };
    assert.equal(w.start, dayKey(mondayOf(new Date())));
    assert.equal(new Date(w.days[0].date + "T12:00:00").getDay(), 1, "starts on a Monday");
    assert.equal(w.min_hours, 3);
    res = await t.api("/planner/week?start=2026-10-19&min_hours=2.5");
    assert.equal(((await res.json()) as { start: string; min_hours: number }).min_hours, 2.5);
    assert.equal((await t.api("/planner/week?start=2026-13-01")).status, 400);
    assert.equal((await t.api("/planner/week?start=yesterday")).status, 400);
    assert.equal((await t.api("/planner/week?min_hours=0")).status, 400);
    assert.equal((await t.api("/planner/week?min_hours=25")).status, 400);
  } finally { t.cleanup(); }
});

test("planner: schedule answers 409 with the conflict, force overrides, unschedule clears the block", async () => {
  const t = makeHub();
  try {
    runSeed(t.hub.store, t.hub.cfg.seedDir);
    const a = t.hub.store.create("task", { title: "Write the runbook", status: "next", order: 1 });
    const b = t.hub.store.create("task", { title: "Flash the ESP32", status: "inbox", order: 2 });

    // Inside the Work blackout.
    let res = await t.api("/planner/schedule", { method: "POST", json: { task_id: a.id, start: iso(2026, 10, 19, 10) } });
    assert.equal(res.status, 409);
    let body = await res.json() as { error: string; conflict: Record<string, unknown> };
    assert.equal(body.error, "conflict");
    assert.equal(body.conflict.type, "blackout");
    assert.equal(body.conflict.title, "Work");
    assert.equal(body.conflict.start, iso(2026, 10, 19, 9));
    assert.equal(t.hub.store.get(a.id)!.fields.block, undefined, "nothing written on a conflict");

    // Free evening: scheduled with the default 3 hours. An all-day marker that day is not a conflict.
    t.hub.store.create("event", { title: "Halloween", all_day: true, start: iso(2026, 10, 19), end: iso(2026, 10, 20) });
    res = await t.api("/planner/schedule", { method: "POST", json: { task_id: a.id, start: iso(2026, 10, 19, 18) } });
    assert.equal(res.status, 200);
    let task = await res.json() as { fields: { status: string; block: { start: string; end: string } } };
    assert.equal(task.fields.status, "scheduled");
    assert.deepEqual(task.fields.block, { start: iso(2026, 10, 19, 18), end: iso(2026, 10, 19, 21) });

    // Overlapping another task's block.
    res = await t.api("/planner/schedule", { method: "POST", json: { task_id: b.id, start: iso(2026, 10, 19, 20), hours: 2 } });
    assert.equal(res.status, 409);
    body = await res.json() as typeof body;
    assert.equal(body.conflict.type, "block");
    assert.equal(body.conflict.task_id, a.id);
    assert.equal(body.conflict.title, "Write the runbook");

    // Same request with force.
    res = await t.api("/planner/schedule", { method: "POST", json: { task_id: b.id, start: iso(2026, 10, 19, 20), hours: 2, force: true } });
    assert.equal(res.status, 200);
    task = await res.json() as typeof task;
    assert.deepEqual(task.fields.block, { start: iso(2026, 10, 19, 20), end: iso(2026, 10, 19, 22) });
    assert.equal(task.fields.status, "scheduled");
    // Re-scheduling a task over its own block is not a conflict.
    res = await t.api("/planner/schedule", { method: "POST", json: { task_id: a.id, start: iso(2026, 10, 19, 17), hours: 3 } });
    assert.equal(res.status, 200);

    // Events are fixed too.
    t.hub.store.create("event", { title: "Standup", start: iso(2026, 10, 24, 10), end: iso(2026, 10, 24, 11) });
    res = await t.api("/planner/schedule", { method: "POST", json: { task_id: b.id, start: iso(2026, 10, 24, 9) } });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as typeof body).conflict.type, "event");

    // Unschedule: block gone, status back to next.
    res = await t.api("/planner/unschedule", { method: "POST", json: { task_id: b.id } });
    assert.equal(res.status, 200);
    task = await res.json() as typeof task;
    assert.equal(task.fields.block, undefined);
    assert.equal(task.fields.status, "next");
    assert.equal(t.hub.store.get(b.id)!.field_ts.block > t.hub.store.get(b.id)!.created_at, true);

    // Validation.
    assert.equal((await t.api("/planner/schedule", { method: "POST", json: { task_id: "nope", start: iso(2026, 10, 19, 18) } })).status, 404);
    assert.equal((await t.api("/planner/schedule", { method: "POST", json: { task_id: a.id } })).status, 422);
    assert.equal((await t.api("/planner/schedule", { method: "POST", json: { task_id: a.id, start: iso(2026, 10, 19, 18), hours: 0 } })).status, 422);
    assert.equal((await t.api("/planner/unschedule", { method: "POST", json: {} })).status, 422);
    assert.equal((await t.api("/planner/unschedule", { method: "POST", json: { task_id: "nope" } })).status, 404);
  } finally { t.cleanup(); }
});

test("planner: today's digest is one to six plain lines, all-day plans first, and the digest notify carries it, plans first", async () => {
  const t = makeHub();
  try {
    const now = local(2026, 10, 21, 8, 30); // a Wednesday
    let view = todayView(t.hub, now);
    assert.equal(view.date, "2026-10-21");
    assert.equal(view.now, null);
    assert.equal(view.digest, "Nothing queued");
    // The notification leaves "Nothing queued" out once there is something else to say.
    t.hub.store.create("event", { title: "Tonight: pottery", start: "2026-10-21T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z", all_day: true });
    const seen: NotifyEvent[] = [];
    const off = t.hub.bus.on("notify", (e) => seen.push(e));
    emitDigest(t.hub, now);
    off();
    assert.equal(seen[0].title, "Plans: Tonight: pottery");
    t.hub.store.patch(t.hub.store.list({ kind: "event" })[0].id, { deleted_at: new Date().toISOString() });

    t.hub.store.create("task", { title: "Fix the NAS", status: "doing", order: 1 });
    t.hub.store.create("task", { title: "Second", status: "next", order: 2 });
    t.hub.store.create("task", { title: "Write chapter", status: "scheduled", order: 3, block: { start: iso(2026, 10, 21, 18), end: iso(2026, 10, 21, 21) } });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "call the vet", remind_at: iso(2026, 10, 21, 10), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "tomorrow", remind_at: iso(2026, 10, 22, 10), friction: "none" });
    t.hub.store.create("task", { order: 1, title: "acked", remind_at: iso(2026, 10, 21, 7), friction: "none", status: "done" });
    t.hub.store.create("watch", { title: "Domain", category: "domain", due: "2026-10-24", lead_days: 7 });
    t.hub.store.create("watch", { title: "Far away", category: "cert", due: "2027-01-01", lead_days: 7 });
    t.hub.store.create("capture", { text: "one", source: "api" });
    t.hub.store.create("capture", { text: "two", source: "api" });
    t.hub.store.create("event", { title: "Tonight: dinner at Luigi's", start: "2026-10-21T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z", all_day: true });
    t.hub.store.create("event", { title: "Dentist", start: iso(2026, 10, 21, 15), end: iso(2026, 10, 21, 16) });

    view = todayView(t.hub, now);
    assert.equal(view.now!.fields.title, "Fix the NAS");
    assert.deepEqual(view.next.map((x) => x.fields.title), ["Second"]);
    assert.deepEqual(view.blocks.map((b) => b.title), ["Write chapter"]);
    assert.deepEqual(view.reminders_due.map((r) => r.fields.title), ["Renew: Domain", "call the vet"], "the watch reminder (due 2026-10-17 09:00) is overdue and listed first");
    assert.deepEqual(view.watches_due_soon.map((w) => w.fields.title), ["Domain"]);
    assert.equal(view.captures_unprocessed, 2);
    assert.deepEqual(view.digest.split("\n"), [
      "Now: Fix the NAS",
      "Plans: Tonight: dinner at Luigi's",
      "Calendar: 3:00 PM Dentist",
      "Blocks: 6:00 PM to 9:00 PM Write chapter",
      "Due: 1 reminder: call the vet; renew Domain by 2026-10-24",
      "2 captures to sort",
    ]);
    // Free slots are clipped to what is still ahead of now.
    for (const s of view.free_slots) assert.ok(new Date(s.start) >= now);
    assert.ok(view.free_slots.every((s) => s.hours >= 3));

    const events: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => events.push(e));
    const digest = emitDigest(t.hub, now);
    assert.equal(digest.split("\n").length, 6);
    assert.deepEqual(events, [{ id: "digest:2026-10-21", kind: "digest", at: now.toISOString(),
      title: "Plans: Tonight: dinner at Luigi's\nCalendar: 3:00 PM Dentist\nNow: Fix the NAS\nBlocks: 6:00 PM to 9:00 PM Write chapter\nDue: 1 reminder: call the vet; renew Domain by 2026-10-24\n2 captures to sort" }]);

    const res = await t.api("/planner/today");
    assert.equal(res.status, 200);
    const api = await res.json() as { date: string; digest: string; now: { fields: { title: string } } };
    assert.equal(api.now.fields.title, "Fix the NAS");
    assert.ok(api.digest.split("\n").length >= 2 && api.digest.split("\n").length <= 4);
    assert.doesNotMatch(api.digest, /[\u2013\u2014!]/);
  } finally { t.cleanup(); }
});

test("seed: plan rules are created once by title and never overwrite the user's edits", () => {
  const t = makeHub();
  try {
    const first = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.deepEqual(first.plan_rules, { created: 2, kept: 0 });
    const rules = t.hub.store.list({ kind: "plan_rule" });
    assert.deepEqual(rules.map((r) => r.fields.title).sort(), ["Evening block", "Work"]);
    const work = rules.find((r) => r.fields.title === "Work")!;
    assert.equal(work.fields.type, "blackout");
    assert.deepEqual(work.fields.days, ["mon", "tue", "wed", "thu", "fri"]);
    assert.equal(work.fields.start, "09:00");
    assert.equal(work.fields.end, "17:00");
    assert.equal(work.fields.active, true);
    const evening = rules.find((r) => r.fields.title === "Evening block")!;
    assert.equal(evening.fields.type, "preference");
    assert.equal(evening.fields.start, "18:00");
    assert.equal(evening.fields.end, "22:00");

    // The user shortens the work day and deletes the preference; a redeploy's seed leaves both alone.
    t.hub.store.patch(work.id, { end: "15:00" });
    t.hub.store.patch(evening.id, { deleted_at: new Date().toISOString() });
    const seqBefore = t.hub.store.seq();
    assert.deepEqual(runSeed(t.hub.store, t.hub.cfg.seedDir).plan_rules, { created: 0, kept: 2 });
    assert.equal(t.hub.store.seq(), seqBefore, "no writes on the second run");
    assert.equal(t.hub.store.get(work.id)!.fields.end, "15:00");
    assert.ok(t.hub.store.get(evening.id)!.deleted_at);
    assert.equal(t.hub.store.list({ kind: "plan_rule" }).length, 1);
    assert.equal(t.hub.store.list({ kind: "watch" }).length, 0, "watches are never seeded");
  } finally { t.cleanup(); }
});

test("planner: today lists the day's events, work meetings included, and the digest names them", () => {
  const t = makeHub();
  try {
    const now = local(2026, 10, 27, 8, 30); // a Tuesday, inside nothing yet
    t.hub.store.create("event", { title: "Standup", start: iso(2026, 10, 27, 10), end: iso(2026, 10, 27, 10, 30), all_day: false, source: "eventkit", external_id: "a|1" }, "work");
    t.hub.store.create("event", { title: "Earlier", start: iso(2026, 10, 27, 7), end: iso(2026, 10, 27, 8), all_day: false, source: "eventkit", external_id: "b|1" }, "work");
    t.hub.store.create("event", { title: "Tomorrow", start: iso(2026, 10, 28, 10), end: iso(2026, 10, 28, 11), all_day: false }, "work");
    const view = todayView(t.hub, now);
    assert.deepEqual(view.events.map((e) => e.fields.title), ["Earlier", "Standup"]);
    assert.equal(view.events[1].space, "work");
    assert.ok(view.digest.split("\n").includes("Calendar: 10:00 AM Standup"), view.digest);
  } finally { t.cleanup(); }
});

test("today: autopay renewals are charges coming, not things to renew", () => {
  const t = makeHub();
  try {
    const now = new Date(2026, 10, 3, 9, 0);
    t.hub.store.create("watch", { title: "StreamCo Plus", category: "subscription", due: "2026-11-05", lead_days: 3, cost: 20, autopay: true });
    t.hub.store.create("watch", { title: "Domain example.net", category: "domain", due: "2026-11-20", lead_days: 30 });
    const view = todayView(t.hub, now);
    assert.equal(view.watches_due_soon.length, 2, "both still show as coming up");
    assert.match(view.digest, /^Due: renew Domain example\.net by 2026-11-20$/m);
    assert.match(view.digest, /^Charges: StreamCo Plus \$20\.00 on 2026-11-05$/m);
    assert.doesNotMatch(view.digest, /renew StreamCo Plus/);
  } finally { t.cleanup(); }
});
