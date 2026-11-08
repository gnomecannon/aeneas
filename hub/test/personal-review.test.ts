import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Entity } from "@everythingapp/shared";
import { makeHub, type TestHub } from "./helpers.js";
import { ctxFor, scripted } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";
import { factsAbout, mergePeople, resolvePerson, tidyPeople } from "../src/people.js";
import { healthSummary, migrateCaffeineToCups, setInjectionDay } from "../src/health.js";
import { metricSeries } from "../src/dashboard.js";
import { focusTick, openActivity } from "../src/focus.js";
import { pickFood } from "../src/food.js";
import { importHealth } from "../src/imports/health.js";
import { petPlanTitle, petSummary } from "../src/pets.js";
import { buildQuiz, quizStreakDays } from "../src/quiz.js";
import { recordGenerated, recordImage } from "../src/gallery.js";
import { createProcedure } from "../src/procedures.js";
import { FeelStore } from "../src/feel.js";
import { dayKey } from "../src/metrics.js";

/**
 * The personal data modules, after a review (2026-11-05): each test is a defect a probe confirmed (people, health,
 * dashboard, focus, food, pets, quiz, gallery, chat delete, procedures, feel).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const local = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const toolApi = (t: TestHub) => async (method: string, p: string, body?: unknown) => {
  const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const tool = (t: TestHub, name: string, args: Record<string, unknown>) => runTool(toolApi(t), { name, arguments: args }, ctxFor(t));

// ---------- people ----------

test("people: a first name two people share writes to neither, and names the two to choose from", async () => {
  const t = makeHub();
  try {
    const kim = t.hub.store.create("person", { name: "Alex Kim", given_name: "Alex", family_name: "Kim" });
    const park = t.hub.store.create("person", { name: "Alex Park", given_name: "Alex", family_name: "Park" });
    assert.throws(() => resolvePerson(t.hub.store, "Alex"), /2 people are called Alex: .*Alex (Kim|Park).*Alex (Kim|Park)/);
    const r = await tool(t, "remember", { category: "preference", key: "coffee", value: "Drinks oat lattes", person: "Alex" });
    assert.equal(r.ok, false);
    assert.match(r.text, new RegExp(kim.id));
    assert.match(r.text, new RegExp(park.id));
    assert.equal(t.hub.store.list({ kind: "fact" }).filter((f) => f.fields.key === "coffee").length, 0, "no fact goes to either Alex");
    assert.equal((await tool(t, "save_person", { name: "Alex", phones: [{ value: "555-0101" }] })).ok, false);
    assert.deepEqual([kim, park].map((p) => t.hub.store.get(p.id)!.fields.phones), [[], []], "no phone written to either");
    // The full name, or the id the error gave, picks one.
    assert.equal(resolvePerson(t.hub.store, "alex park")!.id, park.id);
    assert.equal((await tool(t, "remember", { category: "preference", key: "coffee", value: "Drinks oat lattes", person: kim.id })).ok, true);
    assert.equal(t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "coffee")!.fields.person_id, kim.id);
  } finally { t.cleanup(); }
});

test("people: a name that is only part of another is nobody, so save_person adds that person", async () => {
  const t = makeHub();
  try {
    const joanna = t.hub.store.create("person", { name: "Joanna Smith", given_name: "Joanna", family_name: "Smith" });
    assert.equal(resolvePerson(t.hub.store, "Ann"), null);
    assert.equal((await tool(t, "save_person", { name: "Ann", phones: [{ value: "312-555-0142" }], birthday: "1990-04-02" })).ok, true);
    const j = t.hub.store.get(joanna.id)!;
    assert.deepEqual(j.fields.phones, [], "Joanna's card is untouched");
    assert.equal(j.fields.birthday, undefined);
    const ann = t.hub.store.list({ kind: "person" }).find((p) => p.fields.name === "Ann")!;
    assert.deepEqual(ann.fields.phones, [{ value: "312-555-0142" }]);
    // Whole names still find people: a given name, a family name, the first word of a name.
    t.hub.store.create("person", { name: "Jen Carter", given_name: "Jen", nickname: "Jenny" });
    assert.equal(resolvePerson(t.hub.store, "Jen")!.fields.name, "Jen Carter");
    assert.equal(resolvePerson(t.hub.store, "Smith")!.id, joanna.id);
  } finally { t.cleanup(); }
});

test("people: a name with no a-z letters matches only that name", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("person", { name: "Aaron Adams", given_name: "Aaron", family_name: "Adams" });
    for (const q of ["李明", "Дмитрий", "Zoë"]) assert.equal(resolvePerson(t.hub.store, q), null, q);
    assert.equal((await tool(t, "remember", { category: "preference", key: "tea", value: "Likes oolong", person: "李明" })).ok, true);
    const f = t.hub.store.list({ kind: "fact" }).find((x) => x.fields.key === "tea")!;
    assert.equal(f.fields.person_id, undefined, "kept with the name, not linked to Aaron");
    assert.equal(f.fields.person, "李明");
    const li = t.hub.store.create("person", { name: "李明" });
    const zoe = t.hub.store.create("person", { name: "Zoë Adams", given_name: "Zoë", family_name: "Adams" });
    assert.equal(resolvePerson(t.hub.store, "李明")!.id, li.id);
    assert.equal(resolvePerson(t.hub.store, "Zoe")!.id, zoe.id, "accents do not matter");
  } finally { t.cleanup(); }
});

test("people: the nightly tidy keeps two different name-only people apart; organization cards still merge", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const a = s.create("person", { name: "Jamie Lee", phones: [{ value: "555-111-2222" }], relationship: "coworker" });
    const b = s.create("person", { name: "Jamie Lee", phones: [{ value: "555-999-8888" }], relationship: "neighbor" });
    s.create("person", { name: "Corner Auto Shop", organization: "Corner Auto Shop", phones: [{ value: "555-016-1262" }] });
    s.create("person", { name: "Corner Auto Shop", organization: "Corner Auto Shop", phones: [{ value: "555-016-9999" }] });
    assert.deepEqual(tidyPeople(s), { cleaned: 0, merged: 1 });
    assert.equal(s.get(a.id)!.deleted_at, null);
    assert.equal(s.get(b.id)!.deleted_at, null);
    assert.equal(s.get(a.id)!.fields.relationship, "coworker");
    assert.equal(s.get(b.id)!.fields.relationship, "neighbor");
    assert.equal(s.list({ kind: "person" }).filter((p) => p.fields.name === "Corner Auto Shop").length, 1, "the same company is one card");
  } finally { t.cleanup(); }
});

test("people: an address with only a state and a country survives the tidy and a merge", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const home = { label: "home", state: "TX", country: "USA" };
    const work = { label: "work", street: "1 Main St", city: "Austin" };
    const p = s.create("person", { name: "Pat Doe", given_name: "Pat", family_name: "Doe", addresses: [home, work] });
    assert.deepEqual(tidyPeople(s), { cleaned: 0, merged: 0 });
    assert.deepEqual(s.get(p.id)!.fields.addresses, [home, work]);
    const dup = s.create("person", { name: "Pat", addresses: [home, { label: "other", country: "Mexico" }] });
    mergePeople(s, p.id, [dup.id]);
    assert.deepEqual(s.get(p.id)!.fields.addresses, [home, work, { label: "other", country: "Mexico" }], "the same state and country once, another country kept");
  } finally { t.cleanup(); }
});

test("people: merging moves facts kept with the duplicate's name, not ones that may be about someone else", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const keep = s.create("person", { name: "Robert Smith", given_name: "Robert", family_name: "Smith", phones: [{ value: "555-000-1111" }] });
    const bob = s.create("person", { name: "Bobby Smith", given_name: "Bobby", family_name: "Smith", nickname: "Bob", phones: [{ value: "555-000-1111" }] });
    s.create("person", { name: "Bobby Tables", given_name: "Bobby" });
    const beer = s.create("fact", { category: "preference", key: "beer", value: "Likes IPAs", person: "Bob" });
    const boat = s.create("fact", { category: "preference", key: "boat", value: "Has a sailboat", person: "Bobby Smith" });
    const shared = s.create("fact", { category: "preference", key: "music", value: "Plays drums", person: "Bobby" });
    mergePeople(s, keep.id, [bob.id]);
    for (const f of [beer, boat]) {
      assert.equal(s.get(f.id)!.fields.person_id, keep.id);
      assert.equal(s.get(f.id)!.fields.person, "Robert Smith");
    }
    assert.deepEqual(factsAbout(s, s.get(keep.id)!).map((f) => f.fields.value).sort(), ["Has a sailboat", "Likes IPAs"]);
    assert.equal(s.get(shared.id)!.fields.person_id, undefined, "Bobby Tables is also called Bobby: left as it was");
  } finally { t.cleanup(); }
});

// ---------- health ----------

test("health: facts about other people are not the owner's medications or doctor rules", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("fact", { category: "health", key: "medications", value: "Claritin 40 mg, B12" });
    const jen = t.hub.store.create("person", { name: "Jen Carter", given_name: "Jen" });
    assert.equal((await tool(t, "remember", { category: "health", key: "medications", value: "Zoloft 50 mg", person: "Jen" })).ok, true);
    assert.deepEqual(healthSummary(t.hub).meds_expected, ["Claritin", "B12"]);
    t.hub.store.create("food_option", { name: "Salad", kind: "delivery", tags: ["plant"] });
    t.hub.store.create("fact", { category: "health", key: "doctor_rules", value: "low sodium", person_id: jen.id, person: "Jen Carter" });
    t.hub.store.create("fact", { category: "constraint", key: "diet:textures", value: "no mushroom", person: "Jen Carter" });
    assert.deepEqual(pickFood(t.hub, { meal: "dinner" }).constraints_used, ["avoid", "recency 3 days"]);
    // The owner's own card (My Card) and facts with no person are the owner's.
    const me = t.hub.store.create("person", { name: "Robin Rivera", given_name: "Robin", apple: { id: "C1", me: true } });
    t.hub.store.create("fact", { category: "health", key: "doctor_rules", value: "less sugar", person_id: me.id, person: "Robin Rivera" });
    assert.ok(pickFood(t.hub, { meal: "dinner" }).constraints_used.includes("doctor rules"));
  } finally { t.cleanup(); }
});

test("health: caffeine is kept and added up in cups, whatever unit it was logged in", async () => {
  const t = makeHub();
  try {
    assert.equal((await tool(t, "log_health", { type: "caffeine", value: 200, unit: "mg" })).ok, true);
    await t.api("/log", { method: "POST", json: { type: "caffeine", value: 1 } }); // the app's +1 cup
    await t.api("/log", { method: "POST", json: { type: "caffeine", value: 95, unit: "mg" } });
    assert.equal((await tool(t, "log_health", { type: "caffeine", value: 120 })).ok, true, "120 with no unit can only be mg");
    const logs = t.hub.store.list({ kind: "log", where: { type: "caffeine" } });
    assert.deepEqual(logs.map((l) => [l.fields.value, l.fields.unit ?? null]).sort(), [[1, null], [1, "cups"], [1.26, "cups"], [2.11, "cups"]]);
    assert.equal(healthSummary(t.hub).caffeine_today, 5.4);
    const d = metricSeries(t.hub, "log:caffeine", 7);
    assert.equal(d.unit, "cups");
    assert.equal(d.latest!.value, 5.37);
    // A log already stored in mg reads as cups and is turned into cups once at start.
    const old = t.hub.store.create("log", { type: "caffeine", value: 190, unit: "mg", at: new Date().toISOString() });
    assert.equal(healthSummary(t.hub).caffeine_today, 7.4);
    assert.equal(migrateCaffeineToCups(t.hub.store), 1);
    assert.deepEqual([t.hub.store.get(old.id)!.fields.value, t.hub.store.get(old.id)!.fields.unit], [2, "cups"]);
    assert.equal(migrateCaffeineToCups(t.hub.store), 0);
  } finally { t.cleanup(); }
});

test("health: sleep the assistant logs in hours is kept in minutes and shows as hours", async () => {
  const t = makeHub();
  try {
    assert.equal((await tool(t, "log_health", { type: "sleep", value: 7 })).ok, true);
    const log = t.hub.store.list({ kind: "log", where: { type: "sleep" } })[0];
    assert.deepEqual([log.fields.value, log.fields.unit], [420, "min"]);
    assert.equal(metricSeries(t.hub, "log:sleep", 7).latest!.value, 7);
    assert.equal(healthSummary(t.hub).sleep.last!.value, 420);
    t.hub.store.patch(log.id, { deleted_at: new Date().toISOString() });
    await tool(t, "log_health", { type: "sleep", value: 450, unit: "min" });
    assert.equal(metricSeries(t.hub, "log:sleep", 7).latest!.value, 7.5);
    // A log in hours from elsewhere is minutes in the summary too (the apps show it as hours and minutes).
    // A minute later than the one before, so "last" never depends on two logs sharing a millisecond.
    t.hub.store.create("log", { type: "sleep", value: 6.5, unit: "h", at: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(healthSummary(t.hub).sleep.last!.value, 390);
  } finally { t.cleanup(); }
});

test("dashboard: an Apple Health night counts for the day it ended, a night logged in the app for its own day", () => {
  const t = makeHub();
  try {
    const now = local(2026, 11, 7, 12);
    importHealth(t.hub, { samples: [
      // Asleep at 00:30 Nov 4 (the night ending Nov 4), at 23:30 Nov 4 (ending Nov 5), and at 00:15 Nov 6.
      { key: "sleep:2026-11-04", type: "sleep", value: 420, unit: "min", at: local(2026, 11, 4, 0, 30).toISOString() },
      { key: "sleep:2026-11-05", type: "sleep", value: 360, unit: "min", at: local(2026, 11, 4, 23, 30).toISOString() },
      { key: "sleep:2026-11-06", type: "sleep", value: 480, unit: "min", at: local(2026, 11, 6, 0, 15).toISOString() },
    ] });
    t.hub.store.create("log", { type: "sleep", value: 330, unit: "min", at: local(2026, 11, 7, 8).toISOString(), source: "api" });
    const d = metricSeries(t.hub, "log:sleep", 7, now);
    assert.deepEqual(d.points.slice(-4).map((p) => `${p.day}=${p.value}`), ["2026-11-04=7", "2026-11-05=6", "2026-11-06=8", "2026-11-07=5.5"]);
  } finally { t.cleanup(); }
});

test("focus: a forgotten activity ends at the limit even after a later activity started and ended", () => {
  const t = makeHub();
  try {
    const t0 = new Date(Date.now() - 3 * DAY);
    const at = (h: number) => new Date(t0.getTime() + h * HOUR);
    const soldering = t.hub.store.create("log", { type: "activity", value: "soldering", at: t0.toISOString(), source: "api" });
    importHealth(t.hub, { samples: [{ key: "w1", type: "activity", value: "Walking", at: at(1).toISOString(), end: at(1.5).toISOString() }] });
    assert.equal(openActivity(t.hub)!.id, soldering.id, "the walk is closed; soldering is still open");
    for (let h = 2; h <= 14; h++) focusTick(t.hub, at(h), 3, 12);
    assert.equal(openActivity(t.hub), null);
    const end = t.hub.store.list({ kind: "log" }).find((l) => l.fields.note === "end" && l.fields.value === "soldering")!;
    assert.equal(end.fields.at, at(3).toISOString(), "ended where the first check-in found it");
    assert.equal(healthSummary(t.hub).activity_hours_7d, 3.5);
  } finally { t.cleanup(); }
});

test("health: two starts of one activity before its end are one session", () => {
  const t = makeHub();
  try {
    const now = local(2026, 11, 5, 18);
    const at = (h: number) => local(2026, 11, 5, h).toISOString();
    t.hub.store.create("log", { type: "activity", value: "guitar", at: at(13) });
    t.hub.store.create("log", { type: "activity", value: "guitar", at: at(14) });
    t.hub.store.create("log", { type: "activity", value: "guitar", note: "end", at: at(15) });
    // Another activity at the same time is its own session.
    t.hub.store.create("log", { type: "activity", value: "soldering", at: at(14) });
    t.hub.store.create("log", { type: "activity", value: "soldering", note: "end", at: at(14) });
    assert.equal(healthSummary(t.hub, 30, now).activity_hours_7d, 2);
    assert.equal(metricSeries(t.hub, "log:activity", 7, now).latest!.value, 120);
    // After the end, a start opens a new session.
    t.hub.store.create("log", { type: "activity", value: "guitar", at: at(16) });
    t.hub.store.create("log", { type: "activity", value: "guitar", note: "end", at: at(17) });
    assert.equal(healthSummary(t.hub, 30, now).activity_hours_7d, 3);
  } finally { t.cleanup(); }
});

test("health: weights logged in kg and lb are shown in one unit", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    t.hub.store.create("log", { type: "weight", value: 160, unit: "lb", at: new Date(now.getTime() - 10 * DAY).toISOString() });
    t.hub.store.create("log", { type: "weight", value: 72, unit: "kg", at: now.toISOString() });
    const s = healthSummary(t.hub, 30, now);
    assert.deepEqual({ latest: s.weight.latest, unit: s.weight.unit, delta_7d: s.weight.delta_7d }, { latest: 72, unit: "kg", delta_7d: -0.6 });
    assert.deepEqual(s.weight.series.map((p) => p.value), [72.6, 72]);
    const d = metricSeries(t.hub, "log:weight", 30, now);
    assert.equal(d.unit, "kg");
    assert.equal(d.current, 72.3);
    // The newest in lb: everything in lb.
    t.hub.store.create("log", { type: "weight", value: 158, at: new Date(now.getTime() + 60_000).toISOString() });
    const later = healthSummary(t.hub, 30, new Date(now.getTime() + 120_000));
    assert.equal(later.weight.unit, "lb");
    assert.deepEqual(later.weight.series.map((p) => p.value), [160, 158.7, 158]);
  } finally { t.cleanup(); }
});

test("health: setting the injection day with the name in other letter case moves the one reminder", () => {
  const t = makeHub();
  try {
    const a = setInjectionDay(t.hub, { name: "B12", weekday: "mon", time: "09:00" });
    const b = setInjectionDay(t.hub, { name: "b12", weekday: "tue", time: "09:00" });
    assert.equal(b.created, false);
    assert.equal(b.reminder.id, a.reminder.id);
    const inj = t.hub.store.list({ kind: "task" }).filter((x) => String(x.fields.title).toLowerCase().startsWith("injection:"));
    assert.deepEqual(inj.map((x) => `${x.fields.title} ${x.fields.repeat}`), ["Injection: b12 every 1 weeks on tue"]);
  } finally { t.cleanup(); }
});

// ---------- pets ----------

const handoffTasks = (t: TestHub) => t.hub.store.list({ kind: "task" }).filter((x) => /handoff/.test(String(x.fields.title)));

test("pets: deleting a mistaken newest handoff gives the one before it its reminder back", () => {
  const t = makeHub();
  try {
    const now = Date.now();
    const a = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", with: "me", at: new Date(now - 4 * DAY).toISOString() });
    const dueA = t.hub.store.get(a.id)!.fields.next_due;
    const b = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", with: "other", at: new Date(now - 1 * DAY).toISOString() });
    assert.equal(t.hub.store.get(a.id)!.fields.next_due, undefined);
    assert.equal(handoffTasks(t).length, 1);
    t.hub.store.patch(b.id, { deleted_at: new Date().toISOString() });
    assert.equal(t.hub.store.get(a.id)!.fields.next_due, dueA);
    const tasks = handoffTasks(t);
    assert.equal(tasks.length, 1, "one handoff reminder, the older handoff's");
    assert.equal(tasks[0].fields.title, "Pepper handoff tomorrow");
    assert.equal(petSummary(t.hub, "Pepper").custody.handoff_id, a.id);
  } finally { t.cleanup(); }
});

test("pets: changing the cycle or the day of the newest handoff moves the predicted one; a date set by hand stays", () => {
  const t = makeHub();
  try {
    const now = Date.now();
    const d = (days: number, from: number) => { const x = new Date(from); return new Date(x.getFullYear(), x.getMonth(), x.getDate() + days, x.getHours(), x.getMinutes()).getTime(); };
    const at0 = new Date(now - 1 * DAY);
    at0.setSeconds(0, 0);
    const a = t.hub.store.create("pet_event", { pet: "Pepper", type: "custody", with: "me", at: at0.toISOString() });
    const due = () => new Date(String(t.hub.store.get(a.id)!.fields.next_due)).getTime();
    assert.equal(due(), d(7, at0.getTime()), "a week when nothing says otherwise");
    t.hub.store.patch(a.id, { cycle_days: 14 });
    assert.equal(due(), d(14, at0.getTime()));
    const at1 = new Date(at0.getTime() - 2 * DAY);
    t.hub.store.patch(a.id, { at: at1.toISOString() });
    assert.equal(due(), d(14, at1.getTime()));
    assert.equal(new Date(String(petSummary(t.hub, "Pepper").custody.next_handoff)).getTime(), d(14, at1.getTime()));
    const tasks = handoffTasks(t);
    assert.equal(tasks.length, 1);
    assert.equal(new Date(String(tasks[0].fields.remind_at)).getTime() < d(14, at1.getTime()), true, "the reminder moved with it, the day before");
    // Set by hand: kept when the cycle changes.
    const hand = new Date(now + 20 * DAY).toISOString();
    t.hub.store.patch(a.id, { next_due: hand });
    t.hub.store.patch(a.id, { cycle_days: 10 });
    assert.equal(t.hub.store.get(a.id)!.fields.next_due, hand);
  } finally { t.cleanup(); }
});

test("pets: a pet name in another script matches only titles that name it", () => {
  assert.deepEqual(["Dentist", "Dinner with Jen", "Pay rent"].map((x) => petPlanTitle(x, "ポチ")), [false, false, false]);
  assert.equal(petPlanTitle("ポチの散歩", "ポチ"), true);
  assert.equal(petPlanTitle("Vet for the dog", "ポチ"), true);
  assert.equal(petPlanTitle("Шарик to the groomer", "Шарик"), true);
  assert.equal(petPlanTitle("Шарикова", "Шарик"), false);
  assert.equal(petPlanTitle("Pepper's checkup", "Pepper"), true);
  assert.equal(petPlanTitle("Veterinarian", ""), true);
  assert.equal(petPlanTitle("Dentist", ""), false);
  assert.equal(petPlanTitle("Pay rent", "..."), false);
});

// ---------- quiz ----------

const chatToday = (t: TestHub, id = "q1") => t.hub.chatDb.prepare("INSERT INTO sessions (session_id, task_type, created_at, last_at, messages) VALUES (?, ?, ?, ?, ?)")
  .run(id, "general", new Date().toISOString(), new Date().toISOString(), JSON.stringify([{ role: "user", content: "how do I restart the hub unit" }, { role: "assistant", content: "systemctl restart hub" }]));

test("quiz: two builds at once make one quiz for the day", async () => {
  const t = makeHub();
  try {
    chatToday(t);
    const [a, b] = await Promise.all([buildQuiz(t.hub), buildQuiz(t.hub)]);
    assert.ok(a);
    assert.equal(a!.id, b!.id);
    assert.equal(t.hub.store.list({ kind: "quiz" }).filter((q) => q.fields.date === dayKey(new Date())).length, 1);
  } finally { t.cleanup(); }
});

test("quiz: a day with no quiz to take does not break the streak; an unfinished one does", () => {
  const t = makeHub();
  try {
    const d = (n: number) => { const x = new Date(); return dayKey(new Date(x.getFullYear(), x.getMonth(), x.getDate() - n, 12)); };
    const mk = (n: number, done: boolean) => t.hub.store.create("quiz", { date: d(n), items: [{ q: "q", a: "a", hint: "", topic: "" }], ...(done ? { completed_at: new Date().toISOString() } : {}) });
    for (const n of [0, 1, 3, 4]) mk(n, true);
    assert.equal(quizStreakDays(t.hub.store), 4, "no chats two days ago: nothing to take");
    mk(5, false);
    mk(6, true);
    assert.equal(quizStreakDays(t.hub.store), 4, "an unfinished quiz ends it");
    const u = makeHub();
    try {
      u.hub.store.create("quiz", { date: d(0), items: [{ q: "q", a: "a", hint: "", topic: "" }] });
      u.hub.store.create("quiz", { date: d(3), items: [{ q: "q", a: "a", hint: "", topic: "" }], completed_at: new Date().toISOString() });
      assert.equal(quizStreakDays(u.hub.store), 1, "today's quiz can still be finished");
    } finally { u.cleanup(); }
  } finally { t.cleanup(); }
});

test("quiz: chat transcripts never go to a cloud model, even when cloud is the default or the only model", async () => {
  const quizJson = JSON.stringify({ items: [{ q: "Restart the hub?", a: "systemctl restart hub", hint: "systemd", topic: "hub" }] });
  const t = makeHub({ allowCloudDefault: true });
  try {
    chatToday(t);
    const cloud = { ...scripted([], quizJson), name: "anthropic" as const, cloud: true };
    const localModel = scripted([], quizJson);
    (t.hub.ai as any).backends = { ollama: null, anthropic: cloud, adapter: null };
    assert.equal(await buildQuiz(t.hub), null, "no local model: no quiz");
    assert.equal(cloud.chats.length, 0, "nothing sent to the cloud model");
    (t.hub.ai as any).backends = { ollama: localModel, anthropic: cloud, adapter: null };
    const q = await buildQuiz(t.hub);
    assert.ok(q);
    assert.equal(localModel.chats.length, 1);
    assert.equal(cloud.chats.length, 0);
  } finally { t.cleanup(); }
});

// ---------- gallery and chat delete ----------

function png(seed: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(32, 16); b.writeUInt32BE(32, 20); b.writeUInt32BE(seed, 40);
  return b;
}
const upload = async (t: TestHub, bytes: Buffer, name = "Cat") => (await t.app.request(`/images/library?source=uploaded&name=${name}`, { method: "POST", headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "image/png" }, body: bytes })).json() as Promise<Entity>;

test("gallery: a picture deleted from the gallery can be added again", async () => {
  const t = makeHub();
  try {
    const first = await upload(t, png(7));
    assert.equal((await t.api(`/entities/${first.id}`, { method: "DELETE" })).status, 200);
    const again = await upload(t, png(7));
    assert.notEqual(again.id, first.id);
    assert.equal(again.deleted_at, null);
    assert.deepEqual(t.hub.store.list({ kind: "image" }).map((e) => e.id), [again.id]);
    assert.equal((await upload(t, png(7))).id, again.id, "a live one is still filed once");
    // A generated picture the owner deleted is still never brought back.
    const gen = t.hub.ai.images.saveBuffer(png(8));
    const rec = recordImage(t.hub, gen, "generated", { job_id: "b".repeat(32) });
    t.hub.store.patch(rec.id, { deleted_at: new Date().toISOString() });
    assert.equal(recordImage(t.hub, gen, "generated").id, rec.id);
  } finally { t.cleanup(); }
});

test("chat delete: pictures the gallery keeps keep their bytes; one only attached there goes", async () => {
  const t = makeHub();
  try {
    const gen = t.hub.ai.images.saveBuffer(png(11));
    const genRec = recordGenerated(t.hub, { id: "a".repeat(32), image_id: gen, status: "succeeded", plan: { prompt_original: "a fox" } } as any)!;
    const saved = await upload(t, png(12), "Saved");
    const attached = t.hub.ai.images.saveBuffer(png(13));
    const attRec = recordImage(t.hub, attached, "attached", { session_id: "img-chat" });
    t.hub.chatDb.prepare("INSERT INTO sessions (session_id, task_type, created_at, last_at, messages) VALUES (?, ?, ?, ?, ?)").run("img-chat", "general", new Date().toISOString(), new Date().toISOString(),
      JSON.stringify([{ role: "user", content: "what is this", images: [String(saved.fields.image_id), attached] }, { role: "assistant", content: "here you go", images: [gen] }]));
    const del = await t.api("/ai/sessions/img-chat", { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(((await del.json()) as { images: number }).images, 1);
    for (const id of [gen, String(saved.fields.image_id)]) assert.equal((await t.api(`/ai/images/${id}`)).status, 200, id);
    assert.equal(t.hub.store.get(genRec.id)!.deleted_at, null);
    assert.equal((await t.api(`/ai/images/${attached}`)).status, 404, "attached only in that chat: erased");
    assert.ok(t.hub.store.get(attRec.id)!.deleted_at);
  } finally { t.cleanup(); }
});

// ---------- procedures ----------

test("procedures: a done or back sent again for the same step changes nothing", async () => {
  const t = makeHub();
  try {
    const p = createProcedure(t.hub.store, { title: "Swap disk", steps: [{ text: "zpool offline tank sdb" }, { text: "pull the disk" }, { text: "zpool replace" }] });
    const advance = async (json: Record<string, unknown>) => { const r = await t.api(`/procedures/${p.id}/advance`, { method: "POST", json }); return { status: r.status, e: await r.json() as Entity }; };
    await advance({ done: true, step: 0 });
    const retry = await advance({ done: true, step: 0 });
    assert.equal(retry.status, 200);
    assert.equal(retry.e.fields.current, 1);
    assert.deepEqual((retry.e.fields.steps as any[]).map((s) => !!s.done_at), [true, false, false], "the next step is not done unseen");
    await advance({ done: true, step: 1 });
    await advance({ back: true, step: 2 });
    assert.equal((await advance({ back: true, step: 2 })).e.fields.current, 1, "one step back, not two");
    assert.equal((await advance({ done: true, step: 9 })).status, 422);
    // Without step (an older app) it works as before.
    assert.equal((await advance({ done: true })).e.fields.current, 2);
  } finally { t.cleanup(); }
});

// ---------- food ----------

test("food: last night's dinner reads picked yesterday at lunch", () => {
  const t = makeHub();
  try {
    t.hub.store.create("food_option", { name: "Luigi's", kind: "restaurant", tags: ["protein"], last_picked: local(2026, 11, 4, 20).toISOString() });
    assert.equal(pickFood(t.hub, { meal: "lunch" }, local(2026, 11, 5, 12)).why, "protein, picked yesterday");
    assert.equal(pickFood(t.hub, { meal: "lunch" }, local(2026, 11, 4, 23, 59)).why, "protein, picked today");
    // Across the change back from daylight saving time (Nov 1, 2026), still whole days.
    t.hub.store.patch(t.hub.store.list({ kind: "food_option" })[0].id, { last_picked: local(2026, 10, 31, 23).toISOString() });
    assert.equal(pickFood(t.hub, { meal: "lunch" }, local(2026, 11, 3, 0, 30)).why, "protein, not picked in 3 days");
  } finally { t.cleanup(); }
});

// ---------- feel ----------

test("feel: a write that fails part way leaves the saved palettes as they were", () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "feel-test.json");
    const feel = new FeelStore(file);
    feel.set({ palettes: [{ id: "mine", name: "Dusk", colors: ["#112233", "#ffaa00"] }], theme: "custom:mine" });
    const real = fs.writeFileSync;
    // A crash or a full disk mid-write: half the text lands, then the write fails.
    (fs as any).writeFileSync = (p: fs.PathOrFileDescriptor, data: string, opts?: fs.WriteFileOptions) => { real(p, String(data).slice(0, 10), opts); throw new Error("ENOSPC: no space left on device"); };
    try {
      assert.throws(() => feel.set({ hold: false }), /ENOSPC/);
    } finally { (fs as any).writeFileSync = real; }
    assert.deepEqual(feel.get().palettes, [{ id: "mine", name: "Dusk", colors: ["#112233", "#ffaa00"] }]);
    assert.equal(feel.get().theme, "custom:mine");
    assert.equal(fs.existsSync(`${file}.tmp`), false, "no temp file left behind");
  } finally { t.cleanup(); }
});
