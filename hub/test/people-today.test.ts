import { test } from "node:test";
import assert from "node:assert/strict";
import { datePhrase, datesSoon, peopleInPlans, plansToday } from "@everythingapp/shared";
import { makeHub } from "./helpers.js";
import { todayView } from "../src/planner.js";

test("dates: birthdays, anniversaries and labeled dates, soonest first, with ages and years", () => {
  const now = new Date(2026, 9, 31, 9, 0); // Sat Oct 31 2026
  const p = (id: string, birthday: string, name = id, dates: unknown[] = []) => ({ id, fields: { name, birthday, dates } });
  const out = datesSoon([
    p("jen", "1990-11-02", "Jen", [{ label: "anniversary", date: "2021-11-05" }, { label: "other", date: "--11-01" }]),
    p("jamie", "--10-31", "Jamie"), p("far", "1980-12-25"), p("past", "--10-30"), p("bad", "soon"),
  ], now, 14);
  assert.deepEqual(out.map((d) => [d.id, d.label, d.days, d.years]), [["jamie", "birthday", 0, undefined], ["jen", "", 1, undefined], ["jen", "birthday", 2, 36], ["jen", "anniversary", 5, 5]]);
  assert.deepEqual(out.map(datePhrase), ["Jamie's birthday today", "Jen tomorrow", "Jen's birthday Mon (turns 36)", "Jen's anniversary Thu (5 years)"]);
  const leap = datesSoon([p("leap", "2000-02-29")], new Date(2027, 1, 20), 14);
  assert.deepEqual([leap[0].date, leap[0].years], ["2027-02-28", 27]);
  assert.equal(datesSoon([p("ny", "--01-03")], new Date(2026, 11, 30), 7)[0].date, "2027-01-03");
});

test("people in plans: who today's plans name, with what the owner said about them, the plan's words first", () => {
  const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, fields: { name, ...extra } });
  const fact = (value: string, person_id: string, updated_at: string) => ({ id: value, updated_at, fields: { value, person_id } });
  const people = [person("jen", "Jennifer Carter", { given_name: "Jennifer", nickname: "Jen" }), person("jamie", "Jamie Hill"), person("jamie2", "Jamie Stone")];
  const facts = [
    fact("Jen is allergic to shellfish", "jen", "2026-10-30"),
    fact("Jen likes the house salad at Luigi's", "jen", "2026-10-01"),
    fact("Jen works at the library", "jen", "2026-10-29"),
    fact("Jen has a cat", "jen", "2026-10-20"),
  ];
  const out = peopleInPlans(people, facts, [
    { id: "e1", title: "Dinner at Luigi's with Jen", at: "2026-10-31T19:00:00" },
    { id: "t1", title: "Call Jamie back" },
    { id: "e2", title: "Jen's game night" },
  ]);
  assert.deepEqual(out.map((p) => [p.id, p.plans.map((x) => x.id)]), [["jen", ["e1", "e2"]]], "Jamie is two people, so a bare first name names neither");
  const ev = (id: string, title: string, start: string, end: string, all_day = false) => ({ id, fields: { title, start, end, all_day } });
  const plans = plansToday([
    ev("allday", "Luigi's with Jen", "2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z", true),
    ev("late", "Game night", "2026-10-31T23:00:00.000Z", "2026-11-01T02:00:00.000Z"),
    ev("over", "Lunch", "2026-10-31T12:00:00.000Z", "2026-10-31T13:00:00.000Z"),
  ], [], [{ id: "t", fields: { title: "Call Jen", status: "doing" } }], new Date("2026-10-31T22:00:00.000Z"));
  assert.deepEqual(plans.map((p) => p.id), ["late", "allday", "t"], "timed first, an all-day plan stays today's, over ones drop");
  assert.deepEqual(out[0].notes, ["Jen likes the house salad at Luigi's", "Jen is allergic to shellfish", "Jen works at the library"]);
});

test("Today: people in today's plans and dates coming up, both in the digest", () => {
  const t = makeHub();
  try {
    const jen = t.hub.store.create("person", { name: "Jennifer Carter", given_name: "Jennifer", nickname: "Jen", birthday: "1990-11-02", dates: [{ label: "anniversary", date: "--11-03" }] });
    t.hub.store.create("fact", { category: "preference", key: "jen luigis", value: "likes the house salad at Luigi's", person_id: jen.id });
    t.hub.store.create("event", { title: "Luigi's with Jen", start: new Date(2026, 9, 31, 19, 0).toISOString(), end: new Date(2026, 9, 31, 20, 30).toISOString() });
    t.hub.store.create("event", { title: "Lunch with Jen", start: new Date(2026, 9, 31, 8, 0).toISOString(), end: new Date(2026, 9, 31, 8, 30).toISOString() });
    const v = todayView(t.hub, new Date(2026, 9, 31, 9, 0));
    assert.deepEqual(v.people_today.map((p) => [p.name, p.plans.map((x) => x.title), p.notes[0]]), [["Jen", ["Luigi's with Jen"], "likes the house salad at Luigi's"]], "an event that is over is left out");
    assert.deepEqual(v.dates_soon.map((d) => d.label), ["birthday", "anniversary"]);
    assert.match(v.digest, /People: Jen at 7:00 PM \(likes the house salad at Luigi's\); Jen's birthday Mon \(turns 36\); Jen's anniversary Tue/);
  } finally {
    t.cleanup();
  }
});

test("facts that name someone count as known about them, once, and not again under Related", async () => {
  const { factsAbout } = await import("../src/people.js");
  const { relatedItems } = await import("../src/related.js");
  const t = makeHub();
  try {
    const devon = t.hub.store.create("person", { name: "Devon Park", given_name: "Devon" });
    t.hub.store.create("person", { name: "Casey Lee", given_name: "Casey" });
    const group = t.hub.store.create("fact", { category: "relationship", key: "friends", value: "Friend group for board games and hiking: Devon, Casey, Rafael" });
    const linked = t.hub.store.create("fact", { category: "preference", key: "devon movies", value: "Likes horror movies", person_id: devon.id });
    t.hub.store.create("fact", { category: "preference", key: "other", value: "Devonport is a town" });
    assert.deepEqual(factsAbout(t.hub.store, devon).map((f) => f.id), [linked.id, group.id]);
    assert.ok(!relatedItems(t.hub.store, devon.id).some((r) => r.id === group.id));
    t.hub.store.create("event", { title: "Apple picking with Devon", start: new Date(2026, 9, 31, 11, 30).toISOString(), end: new Date(2026, 9, 31, 15, 0).toISOString() });
    const v = todayView(t.hub, new Date(2026, 9, 31, 9, 0));
    assert.deepEqual(v.people_today[0].notes.sort(), ["Friend group for board games and hiking: Devon, Casey, Rafael", "Likes horror movies"]);
  } finally {
    t.cleanup();
  }
});
