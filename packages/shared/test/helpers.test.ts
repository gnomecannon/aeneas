import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrence, effectiveAt, classifyCapture, applyStyle, redact, parseRepeat, Patch, FieldsByKind, completeTaskPatch, taskAlertAt } from "../src/index.ts";

test("parseRepeat accepts the grammar and rejects junk", () => {
  assert.deepEqual(parseRepeat("every 1 days"), { n: 1, unit: "days", on: undefined });
  assert.deepEqual(parseRepeat("every 2 weeks on mon,thu"), { n: 2, unit: "weeks", on: ["mon", "thu"] });
  assert.equal(parseRepeat("daily"), null);
});

test("nextOccurrence steps forward past `after`", () => {
  const after = new Date("2026-10-21T12:00:00Z");
  assert.equal(nextOccurrence("2026-10-20T09:00:00Z", "every 1 days", after), "2026-10-22T09:00:00.000Z");
  // monthly steps keep local wall-clock time; pick dates on the same side of a DST change
  assert.equal(nextOccurrence("2026-11-05T09:00:00Z", "every 1 months", new Date("2026-11-21T12:00:00Z")), "2026-12-05T09:00:00.000Z");
  const weekly = nextOccurrence("2026-10-19T09:00:00Z", "every 1 weeks on mon,thu", after); // Mon Oct 19
  assert.equal(weekly, "2026-10-22T09:00:00.000Z"); // Thu
});

test("effectiveAt prefers a later snooze", () => {
  assert.equal(effectiveAt({ at: "2026-10-21T09:00:00Z", snoozed_until: "2026-10-21T10:00:00Z" }), "2026-10-21T10:00:00Z");
  assert.equal(effectiveAt({ at: "2026-10-21T09:00:00Z", snoozed_until: "2026-10-21T08:00:00Z" }), "2026-10-21T09:00:00Z");
});

test("classifyCapture routes the common phrasings", () => {
  assert.equal(classifyCapture("remind me to order filament tomorrow").kind, "reminder");
  assert.equal(classifyCapture("remind me to order filament tomorrow").fields.title, "order filament tomorrow");
  assert.deepEqual(classifyCapture("weight 162").fields.value, 162);
  assert.equal(classifyCapture("162 lb").kind, "log");
  assert.equal(classifyCapture("took claritin").fields.value, "claritin");
  assert.equal(classifyCapture("bp 138/92").fields.value, "138/92");
  assert.equal(classifyCapture("call the vet").kind, "task");
  assert.equal(classifyCapture("todo: fix the e1000e hang on pve2").fields.title, "fix the e1000e hang on pve2");
  assert.equal(classifyCapture("todo: fix the e1000e hang on pve2").fields.status, "next");
  assert.equal(classifyCapture("call the vet").fields.status, "inbox");
  assert.equal(classifyCapture("idea: a lamp that dims with the music").kind, "note");
  assert.equal(classifyCapture("a long paragraph of musing about nothing in particular that goes on and on and on past eighty characters").kind, "none");
});

test("applyStyle reads a dash between numbers as to", () => {
  assert.equal(applyStyle("Dentist 3:00–4:00 PM, then home — rest.").text, "Dentist 3:00 to 4:00 PM, then home, rest.");
  assert.equal(applyStyle("pages 12 — 14").text, "pages 12 to 14");
  assert.equal(applyStyle("Mon–Fri: Work 9:00 AM–5:00 PM, free Sat — Sunday").text, "Mon to Fri: Work 9:00 AM to 5:00 PM, free Sat to Sunday");
  assert.equal(applyStyle("It is free — Monday works").text, "It is free, Monday works");
  assert.equal(applyStyle("Mon - Fri, 9:00 AM - 5:00 PM - busy").text, "Mon to Fri, 9:00 AM to 5:00 PM, busy");
});

test("applyStyle turns a spaced hyphen between words into a comma, outside code and list bullets", () => {
  const r = applyStyle("1. **Pick up HDMI cable** - it is at Micro Center\n- Eggs\n- Bread\nRun `a - b` or:\n```sh\nexpr 5 - 3\n```\nwell-known 5-3");
  assert.equal(r.text, "1. **Pick up HDMI cable**, it is at Micro Center\n- Eggs\n- Bread\nRun `a - b` or:\n```sh\nexpr 5 - 3\n```\nwell-known 5-3");
  assert.ok(r.applied.includes("spaced-hyphen"));
});

test("applyStyle leaves dashes that are not ranges as commas: names, words ending in am, big numbers", () => {
  assert.equal(applyStyle("Call at 3 – Janet will pick up.").text, "Call at 3, Janet will pick up.");
  assert.equal(applyStyle("I'll be there at 5 - Marcus is driving.").text, "I'll be there at 5, Marcus is driving.");
  assert.equal(applyStyle("The team - 3 people - is set.").text, "The team, 3 people, is set.");
  assert.equal(applyStyle("Maybe — 5 of them.").text, "Maybe, 5 of them.");
  assert.equal(applyStyle("Open 5pm - 9pm, Mon - Fri, and 5 - 6 on Sat.").text, "Open 5pm to 9pm, Mon to Fri, and 5 to 6 on Sat.");
});

test("the vague offer step stays fast on long runs of spaces", () => {
  const t0 = Date.now();
  applyStyle(`${" ".repeat(20000)}x`);
  applyStyle(`a table row${" ".repeat(8000)}| want me to add anything else`);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test("applyStyle drops vague closing offers, sentence by sentence", () => {
  assert.equal(applyStyle("Two left: eggs and bread. Want me to add anything else?").text, "Two left: eggs and bread.");
  assert.equal(applyStyle("Moved to 7 PM. Say the word if you want it longer.").text, "Moved to 7 PM.");
  assert.equal(applyStyle("Saved.\n\nIf you'd like, I can set a reminder too.").text, "Saved.");
  assert.equal(applyStyle("Log Allegra too?").text, "Log Allegra too?");
});

test("applyStyle strips the phrases the style rules forbid", () => {
  const r = applyStyle("Great question! Use sssd — it is simpler.\nThis is the final fix.\nLet me know if you need more.\n```sh\necho ok ✅\n```");
  assert.ok(!/[—–]/.test(r.text));
  assert.ok(!/Great question/.test(r.text));
  assert.ok(!/final fix/i.test(r.text));
  assert.ok(!/let me know/i.test(r.text));
  assert.ok(!/✅/.test(r.text));
  assert.ok(r.applied.includes("em-dash"));
});

test("redact masks secrets and private literals", () => {
  const r = redact("password=hunter2 and AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnopqrstuvwxyz and my dog is Pepper", ["Pepper"]);
  assert.ok(!/hunter2/.test(r.text));
  assert.ok(!/AKIAABCDEFGHIJKLMNOP/.test(r.text));
  assert.ok(!/abcdefghijklmnopqrstuvwxyz/.test(r.text));
  assert.ok(!/Pepper/.test(r.text));
  assert.equal(r.count, 4);
});

test("schemas validate a patch and reject bad fields", () => {
  const p = Patch.parse({ id: "6c1f2a4e-9a1b-4c3d-8e2f-123456789abc", kind: "task", ts: "2026-10-21T12:00:00Z", fields: { title: "x" } });
  assert.equal(p.kind, "task");
  assert.throws(() => FieldsByKind.reminder.parse({ title: "x", at: "2026-10-21T09:00:00Z", friction: "loud" }));
  assert.ok(FieldsByKind.reminder.parse({ title: "x", at: "2026-10-21T09:00:00Z", friction: "reason", repeat: "every 2 weeks on mon" }));
});

test("repeats and reminders keep their day and time (2026-11-05 review)", () => {
  process.env.TZ = "America/New_York";
  // Times sent with an offset are stored in UTC, so a 3 PM reminder fires at 3 PM, not 10 AM.
  const t = FieldsByKind.task.parse({ title: "Call vet", status: "scheduled", order: 1, remind_at: "2026-11-05T15:00:00-05:00", snoozed_until: "2026-11-05T16:00:00-05:00" });
  assert.equal(t.remind_at, "2026-11-05T20:00:00.000Z");
  assert.equal(t.snoozed_until, "2026-11-05T21:00:00.000Z");
  assert.equal(FieldsByKind.task.parse({ title: "x", status: "next", order: 1, due: "2026-11-06" }).due, "2026-11-06", "a date alone stays a date");
  assert.equal(taskAlertAt({ remind_at: "2026-11-05T15:00:00-05:00" }), "2026-11-05T20:00:00.000Z", "old offset times compare in UTC");
  // Finished before its time: the next one is tomorrow's.
  const pill = completeTaskPatch({ repeat: "every 1 days", remind_at: "2026-11-06T02:00:00.000Z" }, new Date("2026-11-06T01:00:00Z"));
  assert.equal(pill.remind_at, "2026-11-07T02:00:00.000Z");
  // Month ends: Jan 31 goes to Feb 28, not Mar 3; Feb 29 goes to Feb 28 next year.
  assert.equal(nextOccurrence("2027-01-31T14:00:00.000Z", "every 1 months", new Date("2027-02-01T00:00:00Z")), "2027-02-28T14:00:00.000Z");
  assert.equal(nextOccurrence("2027-01-31T14:00:00.000Z", "every 1 months", new Date("2027-03-01T00:00:00Z")), "2027-03-31T13:00:00.000Z", "back to the 31st, 10 AM local after the clock change");
  assert.equal(nextOccurrence("2028-02-29T14:00:00.000Z", "every 1 years", new Date("2028-03-01T00:00:00Z")), "2029-02-28T14:00:00.000Z");
  // Every second week on Monday and Thursday.
  const days: string[] = [];
  let after = new Date("2026-11-02T13:00:00Z");
  for (let i = 0; i < 4; i++) { const n = nextOccurrence("2026-11-02T14:00:00.000Z", "every 2 weeks on mon,thu", after)!; days.push(n.slice(0, 10)); after = new Date(n); }
  assert.deepEqual(days, ["2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19"]);
  // A daily task due on a date alone moves to the next date, not to 7 PM the same evening.
  assert.equal(completeTaskPatch({ repeat: "every 1 days", due: "2026-11-05" }, new Date("2026-11-05T15:00:00Z")).due, "2026-11-06");
  assert.equal(completeTaskPatch({ repeat: "every 1 weeks", due: "2026-11-05" }, new Date("2026-11-05T15:00:00Z")).due, "2026-11-12");
});
