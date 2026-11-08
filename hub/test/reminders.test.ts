import { test } from "node:test";
import assert from "node:assert/strict";
import { completeTaskPatch, nextOccurrence } from "@everythingapp/shared";
import { makeHub } from "./helpers.js";
import { migrateRemindersToTasks, reminderTick, taskIdForReminder } from "../src/reminders.js";
import type { NotifyEvent } from "../src/bus.js";
import { reminderWindow } from "../src/watches.js";

// These tests plan renewals months ahead: every reminder is made at once, as before the two-week window.
reminderWindow.days = 100_000;

const task = (fields: Record<string, unknown>) => ({ status: "scheduled", order: 1, friction: "none", ...fields });

test("reminders: done on a repeating task moves its reminder and deadline on; a one-off task is done", async () => {
  const t = makeHub();
  try {
    const at = "2026-10-20T13:00:00.000Z";
    const r = t.hub.store.create("task", task({ title: "B12", remind_at: at, due: "2026-10-20T15:00:00.000Z", repeat: "every 1 weeks" }));
    const now = new Date("2026-10-21T09:00:00.000Z");
    assert.equal(nextOccurrence(at, "every 1 weeks", now), "2026-10-27T13:00:00.000Z");
    const p = completeTaskPatch(r.fields, now);
    assert.equal(p.remind_at, "2026-10-27T13:00:00.000Z");
    assert.equal(p.due, "2026-10-27T15:00:00.000Z");
    assert.equal(p.status, undefined);
    const res = await t.api(`/reminders/${r.id}/ack`, { method: "POST" });
    assert.equal(res.status, 200);
    const e = t.hub.store.get(r.id)!;
    assert.equal(e.fields.status, "scheduled");
    assert.ok(new Date(e.fields.remind_at).getTime() > Date.now());
    const one = t.hub.store.create("task", task({ title: "vet", remind_at: at }));
    await t.api(`/reminders/${one.id}/ack`, { method: "POST" });
    assert.equal(t.hub.store.get(one.id)!.fields.status, "done");
    assert.ok(t.hub.store.get(one.id)!.fields.done_at);
    assert.equal((await t.api(`/reminders/nope/ack`, { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});

test("reminders: the loop fires each due reminder time once, a snooze fires again, done tasks never fire", () => {
  const t = makeHub();
  try {
    const events: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => events.push(e));
    const due = t.hub.store.create("task", task({ title: "order filament", remind_at: "2026-10-21T08:00:00.000Z", friction: "reason" }));
    const later = t.hub.store.create("task", task({ title: "later", remind_at: "2026-10-21T12:00:00.000Z" }));
    t.hub.store.create("task", task({ title: "no reminder", due: "2026-10-21T08:00:00.000Z" }));
    const now = new Date("2026-10-21T09:00:00.000Z");
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, now), [due.id]);
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, now), []);
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, new Date("2026-10-21T10:00:00.000Z")), []);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "order filament");
    assert.equal(events[0].friction, "reason");
    assert.equal(events[0].kind, "reminder");
    assert.deepEqual(t.hub.store.get(due.id)!.fields.fired, ["2026-10-21T08:00:00.000Z"]);
    t.hub.store.patch(due.id, { snoozed_until: "2026-10-21T11:00:00.000Z" });
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, new Date("2026-10-21T10:30:00.000Z")), []);
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, new Date("2026-10-21T11:00:00.000Z")), [due.id]);
    assert.equal(t.hub.store.get(due.id)!.fields.fired.length, 2);
    t.hub.store.patch(due.id, { status: "done", snoozed_until: "2026-10-21T11:40:00.000Z" });
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, new Date("2026-10-21T12:00:00.000Z")), [later.id]);
  } finally { t.cleanup(); }
});

test("reminders: snooze friction returns 422 without a reason", async () => {
  const t = makeHub();
  try {
    const r = t.hub.store.create("task", task({ title: "call the vet", remind_at: "2026-10-21T08:00:00.000Z", friction: "reason" }));
    let res = await t.api(`/reminders/${r.id}/snooze`, { method: "POST", json: { until: "2026-10-22T08:00:00.000Z" } });
    assert.equal(res.status, 422);
    res = await t.api(`/reminders/${r.id}/snooze`, { method: "POST", json: { until: "2026-10-22T08:00:00.000Z", reason: "   " } });
    assert.equal(res.status, 422);
    res = await t.api(`/reminders/${r.id}/snooze`, { method: "POST", json: { until: "2026-10-22T08:00:00.000Z", reason: "vet closed today" } });
    assert.equal(res.status, 200);
    const e = await res.json() as { fields: { snoozed_until: string; snooze_log: { reason: string }[] } };
    assert.equal(e.fields.snoozed_until, "2026-10-22T08:00:00.000Z");
    assert.equal(e.fields.snooze_log[0].reason, "vet closed today");
    const free = t.hub.store.create("task", task({ title: "water", remind_at: "2026-10-21T08:00:00.000Z" }));
    res = await t.api(`/reminders/${free.id}/snooze`, { method: "POST", json: { until: "2026-10-22T08:00:00.000Z" } });
    assert.equal(res.status, 200);
  } finally { t.cleanup(); }
});

test("reminders become tasks: fields carried over, owners re-pointed, finished ones done, a rerun moves nothing", () => {
  const t = makeHub();
  try {
    const insert = t.hub.db.prepare("INSERT INTO entities (id, kind, space, created_at, updated_at, deleted_at, fields, field_ts) VALUES (?, 'reminder', 'personal', ?, ?, NULL, ?, '{}')");
    const now = new Date().toISOString();
    const gym = "00000000-0000-4000-8000-000000000001";
    const vet = "00000000-0000-4000-8000-000000000002";
    insert.run(gym, now, now, JSON.stringify({ title: "Gym", at: "2030-01-01T12:00:00.000Z", repeat: "every 1 days", friction: "witness", snooze_log: [{ at: now, until: now, reason: "rain" }] }));
    insert.run(vet, now, now, JSON.stringify({ title: "Vet", at: "2026-01-01T12:00:00.000Z", friction: "none", acknowledged_at: "2026-01-01T12:05:00.000Z" }));
    const renew = "00000000-0000-4000-8000-000000000003";
    const w = t.hub.store.create("watch", { title: "Domain", category: "domain", due: "2031-01-01", lead_days: 7 });
    insert.run(renew, now, now, JSON.stringify({ title: "Renew: Domain", at: "2030-12-25T15:00:00.000Z", friction: "reason", linked_id: w.id }));
    // Point the watch at the old reminder, as a hub from before the change would have.
    t.hub.db.prepare("UPDATE entities SET fields = json_set(fields, '$.reminder_id', ?) WHERE id = ?").run(renew, w.id);
    assert.equal(migrateRemindersToTasks(t.hub.store), 3);
    const g = t.hub.store.get(taskIdForReminder(gym))!;
    assert.equal(g.kind, "task");
    assert.equal(g.fields.title, "Gym");
    assert.equal(g.fields.remind_at, "2030-01-01T12:00:00.000Z");
    assert.equal(g.fields.repeat, "every 1 days");
    assert.equal(g.fields.friction, "reason");
    assert.equal(g.fields.status, "scheduled");
    assert.equal(g.fields.snooze_log.length, 1);
    const v = t.hub.store.get(taskIdForReminder(vet))!;
    assert.equal(v.fields.status, "done");
    assert.equal(v.fields.done_at, "2026-01-01T12:05:00.000Z");
    assert.ok(t.hub.store.get(gym)!.deleted_at);
    assert.equal(t.hub.store.get(w.id)!.fields.reminder_id, taskIdForReminder(renew));
    assert.equal(t.hub.store.get(taskIdForReminder(renew))!.fields.linked_id, w.id);
    assert.equal(migrateRemindersToTasks(t.hub.store), 0);
  } finally { t.cleanup(); }
});
