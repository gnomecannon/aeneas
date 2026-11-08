import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { makeHub, type TestHub } from "./helpers.js";
import { importsIdle, type ImportJob } from "../src/imports/bulk.js";
import { fileRead, nextDue, type MailMeta, type MailRead } from "../src/mail-filer.js";
import { upsertFilms } from "../src/imports/letterboxd.js";
import { applyWikiFeed } from "../src/wiki.js";

// Each case below was a finding of the 2026-11-05 review of mail filing and imports.

async function upload(t: TestHub, name: string, data: Uint8Array): Promise<ImportJob> {
  const r = await t.api(`/imports/upload?name=${encodeURIComponent(name)}`, { method: "POST", body: data as unknown as RequestInit["body"] });
  assert.equal(r.status, 200, await r.clone().text());
  const job = (await r.json()) as ImportJob;
  await importsIdle();
  return ((await (await t.api("/imports/jobs")).json()) as { jobs: ImportJob[] }).jobs.find((j) => j.id === job.id)!;
}

let n = 0;
const meta = (at: Date, subject = "Your receipt"): MailMeta => ({ account: "robin@example.com", id: `m${++n}`, at, from: "billing@example.com", subject });

test("mail: a monthly renewal from the 31st keeps the month's last day instead of drifting into the next month", () => {
  const now = new Date(2026, 1, 2, 12);
  assert.deepEqual(nextDue({ type: "charge", period: "month" }, new Date(2026, 0, 31, 9), now), { due: "2026-02-28", repeat: "every 1 months" });
  // Read on Mar 1, a Jan 31 charge rolls on from Jan 31 (Mar 31), not from the clamped Feb 28 (Mar 28).
  assert.deepEqual(nextDue({ type: "charge", period: "month" }, new Date(2026, 0, 31, 9), new Date(2026, 2, 1, 12)), { due: "2026-03-31", repeat: "every 1 months" });
  assert.equal(nextDue({ type: "renewal_notice", due: "2026-02-30" }, new Date(2026, 1, 1), new Date(2026, 1, 1)), null, "an impossible date is no due date");
});

test("mail: cancelled, then subscribed again, the renewal comes back; the owner's own rename stays", () => {
  const t = makeHub();
  try {
    const charge: MailRead = { type: "charge", service: "Netflix Standard - Monthly", vendor: "Netflix", amount: 15.49, period: "month" };
    const first = fileRead(t.hub, charge, meta(new Date(2026, 9, 3, 9)), new Date(2026, 9, 3, 12));
    assert.equal(first[0].action, "created");
    const id = first[0].id;
    assert.equal(t.hub.store.get(id)!.fields.mail_title, "Netflix Standard - Monthly");

    // The owner renames it; a later receipt with a shorter name must not undo that.
    t.hub.store.patch(id, { title: "Netflix (shared)" });
    fileRead(t.hub, { ...charge, service: "Netflix" }, meta(new Date(2026, 10, 3, 9)), new Date(2026, 10, 3, 12));
    assert.equal(t.hub.store.get(id)!.fields.title, "Netflix (shared)");

    // Cancelled by mail: the renewal goes.
    const gone = fileRead(t.hub, { type: "cancelled", service: "Netflix" }, meta(new Date(2026, 10, 10, 9), "Your membership is cancelled"), new Date(2026, 10, 10, 12));
    assert.equal(gone[0]?.action, "deleted");
    assert.ok(t.hub.store.get(id)!.deleted_at);

    // A new charge a month later: subscribed again, so it is back with the new date.
    const back = fileRead(t.hub, charge, meta(new Date(2026, 11, 12, 9)), new Date(2026, 11, 12, 12));
    assert.equal(back[0]?.action, "updated");
    const w = t.hub.store.get(id)!;
    assert.equal(w.deleted_at, null);
    assert.equal(w.fields.due, "2027-01-12");
    assert.equal(w.fields.cancelled_by_mail, undefined);
    assert.equal(t.hub.store.list({ kind: "watch" }).length, 1);

    // One the owner deleted themself stays deleted, receipts or not.
    t.hub.store.patch(id, { deleted_at: new Date().toISOString() });
    assert.deepEqual(fileRead(t.hub, charge, meta(new Date(2027, 0, 12, 9)), new Date(2027, 0, 12, 12)), []);
    assert.ok(t.hub.store.get(id)!.deleted_at);
  } finally { t.cleanup(); }
});

test("mail: a rescheduled vet appointment moves the event instead of leaving the old time too", () => {
  const t = makeHub();
  try {
    const now = new Date(2026, 10, 5, 8);
    t.hub.store.create("pet_event", { pet: "Pepper", type: "note", at: now.toISOString(), note: "adopted" });
    const appt = (date: string): MailRead => ({ type: "vet_appointment", pet: "Pepper", what: "annual exam", vendor: "Pinecrest", date });
    const made = fileRead(t.hub, appt("2026-11-15T10:00"), meta(new Date(2026, 10, 1, 9), "Appointment confirmed"), now);
    assert.equal(made[0].action, "created");
    const moved = fileRead(t.hub, appt("2026-11-17T14:30"), meta(new Date(2026, 10, 3, 9), "Your appointment was rescheduled"), now);
    assert.deepEqual([moved[0].action, moved[0].id], ["updated", made[0].id]);
    const events = t.hub.store.list({ kind: "event" });
    assert.equal(events.length, 1);
    assert.equal(new Date(String(events[0].fields.start)).getTime(), new Date("2026-11-17T14:30").getTime());

    // A backfill reads newest first: the older booking mail changes nothing.
    assert.deepEqual(fileRead(t.hub, appt("2026-11-15T10:00"), meta(new Date(2026, 10, 1, 9), "Appointment confirmed"), now), []);
    assert.equal(t.hub.store.list({ kind: "event" }).length, 1);

    // A different visit at the same place, booked separately, is its own event.
    const other = fileRead(t.hub, { ...appt("2026-12-02T09:00"), what: "dental cleaning" }, meta(new Date(2026, 10, 4, 9), "Appointment confirmed"), now);
    assert.equal(other[0].action, "created");
    assert.equal(t.hub.store.list({ kind: "event" }).length, 2);
  } finally { t.cleanup(); }
});

test("import: notes with the same title are all kept, and importing again adds none; Google Tasks dates stay dates", async () => {
  const t = makeHub();
  try {
    const data = zipSync({
      "Takeout/Keep/Groceries.json": strToU8(JSON.stringify({ title: "Groceries", textContent: "eggs, rice", userEditedTimestampUsec: 1700000000000000 })),
      "Takeout/Keep/Groceries(1).json": strToU8(JSON.stringify({ title: "Groceries", textContent: "cat food, coffee", userEditedTimestampUsec: 1700000500000000 })),
      "Takeout/Tasks/Tasks.json": strToU8(JSON.stringify({ items: [{ title: "My Tasks", items: [{ title: "Call the dentist", status: "needsAction", due: "2026-12-01T00:00:00.000Z" }] }] })),
    });
    const job = await upload(t, "takeout.zip", data);
    assert.equal(job.state, "done", job.error ?? "");
    const groceries = t.hub.store.list({ kind: "note" }).filter((x) => x.fields.title === "Groceries");
    assert.equal(groceries.length, 2, "the second Groceries note is not dropped");
    assert.deepEqual(groceries.map((g) => String(g.fields.body).trim()).sort(), ["cat food, coffee", "eggs, rice"]);
    const task = t.hub.store.list({ kind: "task" }).find((x) => x.fields.title === "Call the dentist")!;
    assert.equal(task.fields.due, "2026-12-01", "Dec 1, not 7 PM on Nov 30 in New York");

    const again = await upload(t, "takeout.zip", data);
    assert.equal(again.counts.notes, 0);
    assert.equal(t.hub.store.list({ kind: "note" }).filter((x) => x.fields.title === "Groceries").length, 2);
  } finally { t.cleanup(); }
});

test("letterboxd: a film the owner added by hand is filled in, not doubled, and keeps their rating", () => {
  const t = makeHub();
  try {
    const mine = t.hub.store.create("film", { title: "Arrival", year: 2016, rating: 5, watched: true, watched_on: [], tags: [] });
    const r = upsertFilms(t.hub, [{ title: "Arrival", year: 2016, rating: 4, watched: true, watched_on: ["2026-11-01"], url: "https://letterboxd.com/x/film/arrival/" }]);
    assert.deepEqual(r, { created: 0, updated: 1 });
    const films = t.hub.store.list({ kind: "film" });
    assert.equal(films.length, 1);
    assert.equal(films[0].id, mine.id);
    assert.equal(films[0].fields.rating, 5);
    assert.deepEqual(films[0].fields.watched_on, ["2026-11-01"]);
    assert.equal(films[0].fields.url, "https://letterboxd.com/x/film/arrival/");
    // A film of the same name from another year is another film.
    upsertFilms(t.hub, [{ title: "Arrival", year: 1996, watched: true, watched_on: ["2026-11-02"] }]);
    assert.equal(t.hub.store.list({ kind: "film" }).length, 2);
  } finally { t.cleanup(); }
});

test("wiki: an empty manifest does not wipe a project's docs unless it says remove_all", () => {
  const t = makeHub();
  try {
    applyWikiFeed(t.hub, { project: "Demo", manifest: [{ path: "README.md", sha: "a" }], pages: [{ path: "README.md", markdown: "# Demo\nHello" }] });
    assert.throws(() => applyWikiFeed(t.hub, { project: "Demo", manifest: [] }), /manifest is empty/);
    assert.equal(t.hub.wiki.pagesOf("repo:Demo").length, 1);
    const r = applyWikiFeed(t.hub, { project: "Demo", manifest: [], remove_all: true });
    assert.equal(r.removed, 1);
    assert.equal(t.hub.wiki.pagesOf("repo:Demo").length, 0);
  } finally { t.cleanup(); }
});
