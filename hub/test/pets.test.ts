import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { custodyOf, petReminder } from "../src/pets.js";
import { dayKey } from "../src/metrics.js";
import { mondayOf } from "../src/planner.js";

const iso = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).toISOString();

test("pets: a pet_event with next_due owns one reminder a day before at 09:00, friction none, and follows edits", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/entities", { method: "POST", json: { kind: "pet_event", fields: { pet: "Pepper", type: "vet", at: "2026-10-20T15:00:00.000Z", note: "annual", cost: 180, next_due: "2026-12-10" } } });
    assert.equal(res.status, 201);
    const ev = await res.json() as any;
    assert.ok(ev.fields.reminder_id);
    const reminders = t.hub.store.list({ kind: "task" });
    assert.equal(reminders.length, 1);
    const r = reminders[0];
    assert.equal(r.id, ev.fields.reminder_id);
    assert.equal(r.fields.title, "Pepper: vet due");
    assert.equal(r.fields.friction, "none");
    assert.equal(r.fields.linked_id, ev.id);
    assert.equal(r.fields.remind_at, iso(2026, 12, 9, 9));

    await t.api(`/entities/${ev.id}`, { method: "PATCH", json: { fields: { next_due: "2027-01-05", type: "med" } } });
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);
    assert.equal(t.hub.store.get(r.id)!.fields.remind_at, iso(2027, 1, 4, 9));
    assert.equal(t.hub.store.get(r.id)!.fields.title, "Pepper: med due");

    // An event without next_due has no reminder.
    const plain = await (await t.api("/entities", { method: "POST", json: { kind: "pet_event", fields: { pet: "Pepper", type: "food", at: "2026-10-21T12:00:00.000Z" } } })).json() as any;
    assert.equal(plain.fields.reminder_id, undefined);
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);

    // Clearing next_due removes the reminder; deleting the event does too.
    await t.api(`/entities/${ev.id}`, { method: "PATCH", json: { fields: { next_due: null } } });
    assert.ok(t.hub.store.get(r.id)!.deleted_at);
    assert.equal(petReminder(t.hub.store, t.hub.store.get(ev.id)!), null);
    await t.api(`/entities/${ev.id}`, { method: "PATCH", json: { fields: { next_due: "2027-02-01" } } });
    const r2 = petReminder(t.hub.store, t.hub.store.get(ev.id)!)!;
    assert.ok(r2 && r2.id !== r.id);
    await t.api(`/entities/${ev.id}`, { method: "DELETE" });
    assert.ok(t.hub.store.get(r2.id)!.deleted_at);
  } finally { t.cleanup(); }
});

test("pets: custody comes from the info rule '<pet> week' and its anchor, on and off weeks", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    const thisMonday = mondayOf(now);
    const nextMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + 7);
    const lastMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);

    t.hub.store.create("pet_event", { pet: "Pepper", type: "weight", at: now.toISOString(), note: "68 lb" });
    t.hub.store.create("pet_event", { pet: "Pepper", type: "vet", at: new Date(now.getTime() - 40 * 86400_000).toISOString(), next_due: dayKey(new Date(now.getTime() + 20 * 86400_000)) });
    t.hub.store.create("pet_event", { pet: "Pepper", type: "incident", at: new Date(now.getTime() - 40 * 86400_000).toISOString(), next_due: "2020-01-01" });
    t.hub.store.create("pet_event", { pet: "Other", type: "note", at: now.toISOString() });

    let s = await (await t.api("/pets/pepper/summary")).json() as any;
    assert.equal(s.pet, "Pepper");
    assert.equal(s.events_30d.length, 1);
    assert.equal(s.next_due.length, 1, "past next_due rows are not upcoming");
    assert.deepEqual(s.custody, { with_me_now: null, next_handoff: null }, "no rule, nothing known");
    assert.deepEqual(s.plans, []);

    // Calendar plans about him (by name, a vet, a groomer) in the next 60 days, an all-day one by its date.
    const inDays = (n: number) => dayKey(new Date(now.getTime() + n * 86400_000));
    t.hub.store.create("event", { title: "Give Pepper Heartworm Chewable", start: `${inDays(3)}T00:00:00-05:00`, end: `${inDays(4)}T00:00:00-05:00`, all_day: true });
    t.hub.store.create("event", { title: "Vet: annual checkup", start: new Date(now.getTime() + 10 * 86400_000).toISOString(), end: new Date(now.getTime() + 10 * 86400_000 + 3600_000).toISOString(), all_day: false });
    t.hub.store.create("event", { title: "Veterans Day parade", start: `${inDays(5)}T00:00:00-05:00`, end: `${inDays(6)}T00:00:00-05:00`, all_day: true });
    t.hub.store.create("event", { title: "Pepper to the groomer", start: `${inDays(90)}T00:00:00-05:00`, end: `${inDays(91)}T00:00:00-05:00`, all_day: true });
    t.hub.store.create("event", { title: "Old vet visit", start: `${inDays(-5)}T00:00:00-05:00`, end: `${inDays(-4)}T00:00:00-05:00`, all_day: true });
    s = await (await t.api("/pets/pepper/summary")).json() as any;
    assert.deepEqual(s.plans.map((p: any) => [p.title, p.all_day]), [["Give Pepper Heartworm Chewable", true], ["Vet: annual checkup", false]]);
    assert.equal(s.plans[0].start, inDays(3));

    const rule = t.hub.store.create("plan_rule", { title: "Pepper week", type: "info", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "24:00", alternating_anchor: dayKey(thisMonday) });
    s = await (await t.api("/pets/Pepper/summary")).json() as any;
    assert.equal(s.custody.with_me_now, true, "anchored on this week");
    assert.equal(s.custody.next_handoff, nextMonday.toISOString());

    t.hub.store.patch(rule.id, { alternating_anchor: dayKey(lastMonday) });
    assert.equal(custodyOf(t.hub, "Pepper", now).with_me_now, false, "anchored on last week: odd week now");
    assert.equal(custodyOf(t.hub, "Pepper", now).next_handoff, nextMonday.toISOString());

    t.hub.store.patch(rule.id, { alternating_anchor: null });
    assert.deepEqual(custodyOf(t.hub, "Pepper", now), { with_me_now: true, next_handoff: null }, "a rule without an anchor means always here");
    t.hub.store.patch(rule.id, { active: false });
    assert.equal(custodyOf(t.hub, "Pepper", now).with_me_now, null);

    // An info rule never blocks the planner.
    const week = await (await t.api("/planner/week")).json() as any;
    assert.ok(week.days.every((d: any) => d.commitments.length === 0));
  } finally { t.cleanup(); }
});

test("pets: a handoff with no cycle of its own keeps the one on record, else the gap before it, else a week", () => {
  const t = makeHub();
  try {
    const at = (d: number) => new Date(2026, 9, d, 12, 0, 0).toISOString();
    const first = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", at: at(4), with: "me" });
    assert.equal(custodyOf(t.hub, "Pepper", new Date(2026, 9, 5)).cycle_days, 7, "nothing on record: a week");
    t.hub.store.patch(first.id, { cycle_days: 14 });
    // Logged by the assistant or the Watch, with no cycle: the two weeks already on record carry on.
    t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", at: at(18), with: "other" });
    assert.equal(custodyOf(t.hub, "Pepper", new Date(2026, 9, 19)).cycle_days, 14);
    // No cycle anywhere: the days between the last two handoffs.
    const other = "Biscuit";
    t.hub.store.create("pet_event", { pet: other, type: "custody", at: at(1), with: "me" });
    t.hub.store.create("pet_event", { pet: other, type: "custody", at: at(11), with: "other" });
    assert.equal(custodyOf(t.hub, other, new Date(2026, 9, 12)).cycle_days, 10);
  } finally { t.cleanup(); }
});

test("pets: custody follows logged handoffs, predicts the next one, and keeps one reminder", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("plan_rule", { title: "Pepper week", type: "info", days: ["mon"], start: "00:00", end: "24:00", alternating_anchor: "2026-10-19" });
    // Handed over on Sunday 2026-10-25 at noon, every two weeks.
    const sunday = new Date(2026, 9, 25, 12, 0, 0).toISOString();
    const ev = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", at: sunday, with: "other", cycle_days: 14 });
    const fresh = t.hub.store.get(ev.id)!;
    assert.equal(fresh.fields.next_due, new Date(2026, 10, 8, 12, 0, 0).toISOString(), "next handoff two weeks later, same time");
    const r = petReminder(t.hub.store, fresh)!;
    assert.equal(r.fields.title, "Pepper handoff tomorrow");
    assert.equal(t.hub.store.list({ kind: "plan_rule" }).find((x) => x.fields.title === "Pepper week")!.fields.active, false, "the old alternating-week rule is turned off");

    const wed = new Date(2026, 9, 28, 9, 0, 0);
    assert.deepEqual(custodyOf(t.hub, "Pepper", wed), { with_me_now: false, next_handoff: new Date(2026, 10, 8, 12, 0, 0).toISOString(), since: sunday, cycle_days: 14, handoff_id: ev.id });
    // Nothing logged past the predicted day: assume it happened and keep alternating.
    const later = custodyOf(t.hub, "Pepper", new Date(2026, 10, 10, 9, 0, 0));
    assert.equal(later.with_me_now, true);
    assert.equal(later.next_handoff, new Date(2026, 10, 22, 12, 0, 0).toISOString());

    // The schedule changed: picked him up early on Thursday. The new handoff answers and owns the only reminder.
    const thu = new Date(2026, 10, 5, 18, 0, 0).toISOString();
    const early = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", at: thu, with: "me", cycle_days: 7 });
    assert.equal(t.hub.store.get(ev.id)!.fields.next_due ?? null, null);
    assert.ok(t.hub.store.get(r.id)!.deleted_at, "the old prediction's reminder is gone");
    const c = custodyOf(t.hub, "Pepper", new Date(2026, 10, 6, 9, 0, 0));
    assert.equal(c.with_me_now, true);
    assert.equal(c.next_handoff, new Date(2026, 10, 12, 18, 0, 0).toISOString());
    assert.equal(c.handoff_id, early.id);
    const live = t.hub.store.list({ kind: "task" }).filter((x) => String(x.fields.title).includes("handoff"));
    assert.equal(live.length, 1);
  } finally { t.cleanup(); }
});
