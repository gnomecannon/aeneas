import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { linkedReminder, probeTls, reminderTimeFor, rollDue, watchDaily, reminderWindow } from "../src/watches.js";

// These tests plan renewals months ahead: every reminder is made at once, as before the two-week window.
reminderWindow.days = 100_000;

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (y: number, m: number, d: number, h = 0, min = 0) => local(y, m, d, h, min).toISOString();

test("watches: a watch owns one linked reminder that follows due and lead_days", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/entities", { method: "POST", json: { kind: "watch", fields: { title: "Domain robin-rivera.example", category: "domain", due: "2026-11-15" } } });
    assert.equal(res.status, 201);
    const w = await res.json() as { id: string; fields: { reminder_id: string; lead_days: number } };
    assert.equal(w.fields.lead_days, 7);
    assert.ok(w.fields.reminder_id, "the hook wrote reminder_id before the response");
    let reminders = t.hub.store.list({ kind: "task" });
    assert.equal(reminders.length, 1);
    const r = reminders[0];
    assert.equal(r.id, w.fields.reminder_id);
    assert.equal(r.fields.title, "Renew: Domain robin-rivera.example");
    assert.equal(r.fields.friction, "reason");
    assert.equal(r.fields.linked_id, w.id);
    assert.equal(r.fields.remind_at, iso(2026, 11, 8, 9), "a date-only due is a local calendar day; 7 days before at 09:00 local");
    assert.equal(reminderTimeFor("2026-11-15T23:30:00.000Z", 7), iso(2026, 11, 8, 9), "a datetime due counts in local time too");

    // due moves: the reminder is re-planned in place, no second reminder.
    await t.api(`/entities/${w.id}`, { method: "PATCH", json: { fields: { due: "2026-12-01" } } });
    reminders = t.hub.store.list({ kind: "task" });
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].fields.remind_at, iso(2026, 11, 24, 9));
    // lead_days moves.
    await t.api(`/entities/${w.id}`, { method: "PATCH", json: { fields: { lead_days: 3 } } });
    assert.equal(t.hub.store.get(r.id)!.fields.remind_at, iso(2026, 11, 28, 9));
    // Title follows too; a finished or snoozed reminder is reopened when the plan moves.
    t.hub.store.patch(r.id, { status: "done", snoozed_until: iso(2026, 10, 2) });
    await t.api(`/entities/${w.id}`, { method: "PATCH", json: { fields: { title: "Domain", due: "2026-12-02" } } });
    const after = t.hub.store.get(r.id)!;
    assert.equal(after.fields.title, "Renew: Domain");
    assert.equal(after.fields.remind_at, iso(2026, 11, 29, 9));
    assert.equal(after.fields.status, "scheduled");
    assert.equal(after.fields.due, iso(2026, 12, 2, 9), "the deadline is the watch's due day");
    assert.equal(after.fields.snoozed_until, undefined);
    // A write that changes nothing relevant does not touch the reminder.
    const seq = t.hub.store.seq();
    await t.api(`/entities/${w.id}`, { method: "PATCH", json: { fields: { notes: "renew at the registrar" } } });
    assert.equal(t.hub.store.seq(), seq + 1, "one change row for the watch, none for the reminder");

    // The convenience read.
    const lr = await (await t.api(`/watches/${w.id}/reminder`)).json() as { id: string };
    assert.equal(lr.id, r.id);
    assert.equal((await t.api("/watches/nope/reminder")).status, 404);

    // Deleting the watch deletes its reminder.
    await t.api(`/entities/${w.id}`, { method: "DELETE" });
    assert.ok(t.hub.store.get(r.id)!.deleted_at);
    assert.equal(linkedReminder(t.hub.store, t.hub.store.get(w.id)!), null);
  } finally { t.cleanup(); }
});

test("watches: renewed with a repeat rolls due one step from the old due and re-plans the reminder", async () => {
  const t = makeHub();
  try {
    assert.equal(rollDue("2026-11-15", "every 1 years"), "2027-11-15");
    // A month roll lands on the month's last day when it is shorter, instead of spilling into the next month.
    assert.equal(rollDue("2026-01-31", "every 1 months"), "2026-02-28");
    assert.equal(rollDue("2028-02-29", "every 1 years"), "2029-02-28");
    assert.equal(rollDue("2026-11-15T10:00:00.000Z", "every 2 weeks"), "2026-11-29T10:00:00.000Z");
    assert.equal(rollDue("2026-11-15", "nonsense"), null);

    const w = t.hub.store.create("watch", { title: "B12 refill", category: "prescription", due: "2026-10-10", lead_days: 3, repeat: "every 1 months" });
    const r = linkedReminder(t.hub.store, t.hub.store.get(w.id)!)!;
    assert.equal(r.fields.remind_at, iso(2026, 10, 7, 9));
    t.hub.store.patch(r.id, { fired: [r.fields.remind_at as string], status: "done" });

    // Renewed late (today is past the 10th): the next due is one month after the old due, not after today.
    const res = await t.api(`/watches/${w.id}/renewed`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { fields: { due: string; renewed_at: string } };
    assert.equal(body.fields.due, "2026-11-10");
    assert.ok(body.fields.renewed_at);
    const again = t.hub.store.get(r.id)!;
    assert.equal(again.fields.remind_at, iso(2026, 11, 7, 9));
    assert.equal(again.fields.status, "scheduled", "reopened so the new time fires");
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);
    assert.equal((await t.api("/watches/nope/renewed", { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});

test("watches: renewed without a repeat keeps due and acknowledges the reminder", async () => {
  const t = makeHub();
  try {
    const w = t.hub.store.create("watch", { title: "Printer warranty", category: "warranty", due: "2026-11-01" });
    const r = linkedReminder(t.hub.store, t.hub.store.get(w.id)!)!;
    assert.equal(r.fields.status, "scheduled");
    const res = await t.api(`/watches/${w.id}/renewed`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as { fields: { due: string; renewed_at: string } };
    assert.equal(body.fields.due, "2026-11-01");
    assert.ok(body.fields.renewed_at);
    const after = t.hub.store.get(r.id)!;
    assert.equal(after.fields.status, "done");
    assert.equal(after.fields.remind_at, iso(2026, 10, 25, 9), "the plan did not move");
    // Renewing twice is harmless.
    assert.equal((await t.api(`/watches/${w.id}/renewed`, { method: "POST" })).status, 200);
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);
  } finally { t.cleanup(); }
});

test("watches: the daily job probes TLS with the injected reader and writes due, last_probe and the error", async () => {
  const t = makeHub();
  try {
    const calls: string[] = [];
    t.hub.tlsProbe = async (url) => { calls.push(url); return { valid_to: "2027-01-10T12:00:00.000Z" }; };
    const w = t.hub.store.create("watch", { title: "core cert", category: "cert", due: "2026-10-30", probe_url: "https://core.example-tailnet.ts.net/", lead_days: 7 });
    const plain = t.hub.store.create("watch", { title: "no probe", category: "subscription", due: "2026-12-25" });
    // Simulate a reminder that drifted (deleted by hand) so the job has something to repair.
    const rPlain = linkedReminder(t.hub.store, t.hub.store.get(plain.id)!)!;
    t.hub.store.patch(rPlain.id, { deleted_at: new Date().toISOString() });

    const out = await watchDaily(t.hub);
    assert.deepEqual(calls, ["https://core.example-tailnet.ts.net/"]);
    assert.equal(out.watches, 2);
    assert.equal(out.probed, 1);
    assert.equal(out.probe_errors, 0);
    assert.ok(out.reminders_synced >= 1, "the deleted reminder was replaced");
    const probed = t.hub.store.get(w.id)!;
    assert.equal(probed.fields.due, "2027-01-10T12:00:00.000Z");
    assert.ok(probed.fields.last_probe);
    assert.equal(probed.fields.last_probe_error, undefined);
    const r = linkedReminder(t.hub.store, probed)!;
    assert.equal(r.fields.remind_at, iso(2027, 1, 3, 9), "re-planned from the certificate expiry");
    const replacement = linkedReminder(t.hub.store, t.hub.store.get(plain.id)!)!;
    assert.notEqual(replacement.id, rPlain.id);
    assert.equal(replacement.fields.remind_at, iso(2026, 12, 18, 9));

    // A failing probe records the error, keeps due, and never throws out of the job.
    t.hub.tlsProbe = async () => { throw new Error("connect ECONNREFUSED"); };
    const out2 = await watchDaily(t.hub);
    assert.equal(out2.probe_errors, 1);
    const failed = t.hub.store.get(w.id)!;
    assert.equal(failed.fields.due, "2027-01-10T12:00:00.000Z");
    assert.equal(failed.fields.last_probe_error, "connect ECONNREFUSED");
    assert.ok(String(failed.fields.last_probe) >= String(probed.fields.last_probe));

    // The real prober refuses non-https without opening a socket.
    await assert.rejects(probeTls("http://example.test/"), /https/);
    await assert.rejects(probeTls("not a url"), /invalid/);
  } finally { t.cleanup(); }
});
