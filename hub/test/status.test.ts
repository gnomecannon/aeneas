import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, TOKEN } from "./helpers.js";
import { runBackup } from "../src/backup.js";
import { dayKey } from "../src/metrics.js";
import { reminderWindow } from "../src/watches.js";

// These tests plan renewals months ahead: every reminder is made at once, as before the two-week window.
reminderWindow.days = 100_000;

test("devices: liveness through sync/changes, push and live is throttled and silent", async () => {
  const t = makeHub();
  try {
    const reg = await (await t.api("/devices/register", { method: "POST", json: { name: "Robin's iPhone", platform: "iphone" } })).json() as { device_id: string };
    const id = reg.device_id;
    t.hub.store.patch(id, { last_seen: "2020-01-01T00:00:00.000Z" });
    const seqBefore = t.hub.store.seq();

    let res = await t.api(`/sync/changes?since=0&device_id=${id}`);
    assert.equal(res.status, 200);
    let dev = t.hub.store.get(id)!;
    assert.ok(String(dev.fields.last_seen) > "2026", "last_seen moved to now");
    assert.equal(t.hub.store.seq(), seqBefore, "no change row for a liveness write");
    const firstSeen = dev.fields.last_seen;
    const row = t.hub.db.prepare("SELECT last_seen FROM devices WHERE device_id = ?").get(id) as { last_seen: string };
    assert.equal(row.last_seen, firstSeen);

    // Inside the throttle window nothing is written, through any of the three routes.
    await new Promise((r) => setTimeout(r, 5));
    await t.api(`/sync/push`, { method: "POST", json: { device_id: id, patches: [] } });
    const live = await t.app.request(`/live?token=${TOKEN}&device_id=${id}`);
    await live.body!.cancel();
    assert.equal(t.hub.store.get(id)!.fields.last_seen, firstSeen);

    // The tracker itself: once per 60 s per device, unknown ids are ignored.
    const t0 = new Date("2026-10-21T10:00:00.000Z");
    t.hub.devices.reset();
    assert.equal(t.hub.devices.touch(id, t0), true);
    assert.equal(t.hub.devices.touch(id, new Date(t0.getTime() + 30_000)), false);
    assert.equal(t.hub.devices.touch(id, new Date(t0.getTime() + 61_000)), true);
    assert.equal(t.hub.store.get(id)!.fields.last_seen, "2026-10-21T10:01:01.000Z");
    assert.equal(t.hub.devices.touch("not-a-device", t0), false);
    assert.equal(t.hub.store.seq(), seqBefore);
    assert.equal(t.hub.devices.list()[0].id, id);
  } finally { t.cleanup(); }
});

test("status: one page of hub health", async () => {
  const t = makeHub();
  try {
    const reg = await (await t.api("/devices/register", { method: "POST", json: { name: "Mac", platform: "mac" } })).json() as { device_id: string };
    t.hub.store.create("task", { title: "a", status: "next", order: 1 });
    t.hub.store.create("capture", { text: "loose", source: "api" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "soon", remind_at: new Date(Date.now() + 3600_000).toISOString(), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "later", remind_at: new Date(Date.now() + 7200_000).toISOString(), friction: "none" });
    t.hub.store.create("task", { order: 1, title: "fired", remind_at: "2026-01-01T00:00:00.000Z", friction: "none", fired: [new Date(Date.now() - 3600_000).toISOString(), "2026-01-01T00:00:00.000Z"], status: "done" });
    await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey);
    await t.api("/ai/chat", { method: "POST", json: { session_id: "s", messages: [{ role: "user", content: "hi" }] } });

    const res = await t.api("/status");
    assert.equal(res.status, 200);
    const s = await res.json() as any;
    assert.equal(typeof s.version, "string");
    assert.ok(s.started_at && s.uptime_s >= 0);
    assert.equal(s.db.path, t.hub.cfg.dbPath);
    assert.ok(s.db.bytes > 0);
    assert.equal(s.db.seq, t.hub.store.seq());
    assert.equal(s.db.entities_by_kind.task, 4, "one task and three with reminders");
    assert.deepEqual(s.devices.map((d: any) => d.id), [reg.device_id]);
    assert.equal(s.devices[0].platform, "mac");
    assert.equal(s.backups.dir, t.hub.cfg.backupDir);
    assert.equal(s.backups.count, 1);
    assert.match(s.backups.latest_file, /^hub-\d{8}-\d{6}\.sqlite\.age$/);
    assert.ok(s.backups.latest_at);
    assert.deepEqual(s.ai.backends_configured, ["ollama", "anthropic", "adapter"]);
    assert.equal(s.ai.calls_24h, 1);
    assert.equal(s.ai.last_backend, "ollama");
    assert.ok(s.ai.last_call_at);
    assert.equal(typeof s.ai.avg_latency_ms_24h, "number");
    assert.equal(s.reminders.due_next.fields.title, "soon");
    assert.equal(s.reminders.fired_24h, 1);
    assert.equal(s.captures_unprocessed, 1);
    assert.equal((await t.app.request("/status")).status, 401);
  } finally { t.cleanup(); }
});

test("metrics: proof rows per local day, totals and friction signals", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    // The calendar day before, not 24 hours back: on the day clocks fall back, 24 hours ago is still today.
    const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
    const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    const yesterdayEve = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0).toISOString();
    // Inside today even just after midnight (two hours ago would land on yesterday).
    const todayEarly = new Date(Math.max(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), now.getTime() - 2 * 3600_000)).toISOString();
    // Over 48 hours old but still inside the three-day window, at any time of day.
    const staleAt = new Date(Math.max(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2).getTime(), now.getTime() - 49 * 3600_000)).toISOString();
    const apply = (kind: any, ts: string, fields: Record<string, unknown>, id = crypto.randomUUID()) => { t.hub.store.apply({ id, kind, ts, fields, create: true }); return id; };

    // Yesterday: two captures, one auto sorted, one still loose (and now stale); a task done; a reminder fired, acked, snoozed; a log; a note edit.
    const c1 = apply("capture", yesterdayNoon, { text: "sorted", source: "api", processed: false });
    t.hub.store.apply({ id: c1, kind: "capture", ts: yesterdayEve, fields: { processed: true, sorted_by: "auto", suggested_kind: "task" } });
    apply("capture", staleAt, { text: "stale and loose", source: "api", processed: false });
    apply("task", ago(60), { title: "since three days ago", status: "next", order: 1 });
    const done = apply("task", ago(60), { title: "finished", status: "next", order: 2 });
    t.hub.store.apply({ id: done, kind: "task", ts: yesterdayEve, fields: { status: "done", done_at: yesterdayEve } });
    apply("task", ago(10 * 24), { title: "parked long ago", status: "parked", order: 3 });
    const rem = apply("task", ago(80), { title: "nag", status: "scheduled", order: 4, remind_at: yesterdayNoon, friction: "none", fired: [yesterdayNoon] });
    t.hub.store.apply({ id: rem, kind: "task", ts: yesterdayEve, fields: { status: "done", done_at: yesterdayEve } });
    apply("task", ago(80), { title: "snoozer", status: "scheduled", order: 5, remind_at: ago(1), friction: "none", snooze_log: [
      { at: yesterdayNoon, until: yesterdayEve, reason: "" }, { at: yesterdayEve, until: ago(1), reason: "" }, { at: todayEarly, until: now.toISOString(), reason: "" },
    ] });
    apply("log", yesterdayNoon, { type: "weight", value: 160, at: yesterdayNoon });
    apply("note", yesterdayNoon, { title: "Edited", path: "Inbox/Edited.md", body: "text" });
    t.hub.chatDb.prepare("INSERT INTO ai_calls (at, backend, model, redactions, ms, ok) VALUES (?, 'ollama', 'm', 0, 10, 1)").run(yesterdayNoon);

    const res = await t.api("/metrics/proof?days=3");
    assert.equal(res.status, 200);
    const m = await res.json() as any;
    assert.equal(m.days, 3);
    assert.equal(m.rows.length, 3);
    assert.equal(m.rows[2].day, dayKey(now));
    const y = m.rows.find((r: any) => r.day === yesterday);
    assert.ok(y, "yesterday row");
    assert.equal(y.captures_created, 1);
    assert.equal(y.captures_auto_sorted, 1);
    assert.equal(y.tasks_done, 2, "the finished reminder is a done task too");
    assert.equal(y.reminders_fired, 1);
    assert.equal(y.reminders_acked, 1);
    assert.equal(y.reminders_snoozed, 2);
    assert.equal(y.logs_created, 1);
    assert.equal(y.notes_edited, 1);
    assert.equal(y.ai_calls, 1);
    assert.equal(y.now_at_0900, true, "a next task existed since three days before");
    assert.equal(y.next_or_doing_eod, 1, "the done task no longer counts");
    assert.equal(m.totals.captures_created, 2);
    assert.equal(m.totals.reminders_snoozed, 3);
    assert.ok(m.totals.days_with_now_at_0900 >= 1);
    assert.equal(m.friction.captures_stale.length, 1);
    assert.equal(m.friction.captures_stale[0].text, "stale and loose");
    assert.ok(m.friction.captures_stale[0].age_h >= 48);
    assert.deepEqual(m.friction.reminders_snoozed_3plus.map((r: any) => [r.title, r.snoozes]), [["snoozer", 3]]);
    assert.equal(m.friction.tasks_parked_7d[0].title, "parked long ago");
    assert.ok(m.friction.tasks_parked_7d[0].days >= 9);
    assert.equal((await t.api("/metrics/proof?days=0")).status, 400);
    assert.equal((await t.api("/metrics/proof?days=91")).status, 400);
    assert.equal((await (await t.api("/metrics/proof")).json() as any).rows.length, 14);
  } finally { t.cleanup(); }
});

test("reminders: /reminders/due returns the window sorted by effective time, overdue included, acknowledged excluded", async () => {
  const t = makeHub();
  try {
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "in 45", remind_at: at(45), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "overdue", remind_at: at(-30), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "snoozed into window", remind_at: at(-60), snoozed_until: at(10), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "in 90", remind_at: at(90), friction: "none" });
    t.hub.store.create("task", { order: 1, title: "acked", remind_at: at(5), friction: "none", status: "done" });
    let res = await t.api("/reminders/due?within=60");
    assert.equal(res.status, 200);
    let body = await res.json() as { reminders: any[]; now: string; until: string };
    assert.deepEqual(body.reminders.map((r) => r.fields.title), ["overdue", "snoozed into window", "in 45"]);
    assert.ok(body.until > body.now);
    body = await (await t.api("/reminders/due?within=120")).json() as typeof body;
    assert.equal(body.reminders.length, 4);
    body = await (await t.api("/reminders/due?within=0")).json() as typeof body;
    assert.deepEqual(body.reminders.map((r) => r.fields.title), ["overdue"]);
    assert.equal((await t.api("/reminders/due?within=abc")).status, 400);
    assert.equal((await t.api("/reminders/due?within=99999")).status, 400);
  } finally { t.cleanup(); }
});

test("status and metrics: the planner block and the proof row block counters", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    const today = (h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0).toISOString();
    const live = t.hub.store.create("task", { title: "live block", status: "scheduled", order: 1, block: { start: today(18), end: today(21) } });
    t.hub.store.create("task", { title: "done with a block", status: "done", order: 2, done_at: now.toISOString(), block: { start: today(6), end: today(8) } });
    t.hub.store.create("task", { title: "done without a block", status: "done", order: 3, done_at: now.toISOString() });
    t.hub.store.create("watch", { title: "soon", category: "cert", due: new Date(now.getTime() + 10 * 86400_000).toISOString() });
    t.hub.store.create("watch", { title: "later", category: "cert", due: new Date(now.getTime() + 60 * 86400_000).toISOString() });

    const s = await (await t.api("/status")).json() as any;
    assert.equal(s.planner.blocks_this_week, 1, "done tasks no longer hold a block");
    assert.equal(typeof s.planner.free_hours_this_week, "number");
    assert.ok(s.planner.free_hours_this_week > 0);
    assert.equal(s.planner.watches_due_30d, 1);
    assert.equal(s.db.entities_by_kind.watch, 2);
    assert.equal(s.db.entities_by_kind.task, 5, "three tasks, and each watch has its linked task");

    const m = await (await t.api("/metrics/proof?days=2")).json() as any;
    const row = m.rows[1];
    assert.equal(row.day, dayKey(now));
    assert.equal(row.blocks_scheduled, 2);
    assert.equal(row.blocks_completed, 1);
    assert.equal(row.tasks_done, 2);
    assert.equal(m.rows[0].blocks_scheduled, 0);
    assert.equal(m.totals.blocks_scheduled, 2);
    assert.equal(m.totals.blocks_completed, 1);
    t.hub.store.patch(live.id, { deleted_at: now.toISOString() });
    assert.equal(((await (await t.api("/status")).json()) as any).planner.blocks_this_week, 0);
  } finally { t.cleanup(); }
});
