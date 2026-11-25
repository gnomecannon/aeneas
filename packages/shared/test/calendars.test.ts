import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HIDDEN_CALENDARS_MAX, NO_CALENDAR, calendarGroups, calendarKeyOf, calendarNameFromKey, calendarShown, isCalendarKey, readHiddenCalendars,
  withCalendarShown,
} from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("week calendars: a list of at most 300 keys, each named once, else not a setting", () => {
  assert.deepEqual(readHiddenCalendars([]), []);
  assert.deepEqual(readHiddenCalendars(["apple:iCloud/Home", "aeneas"]), ["apple:iCloud/Home", "aeneas"]);
  const full = Array.from({ length: HIDDEN_CALENDARS_MAX }, (_, i) => `apple:A/${i}`);
  assert.equal(readHiddenCalendars(full)?.length, 300);
  for (const bad of [null, undefined, "aeneas", {}, ["a", "a"], [""], [7], ["x".repeat(301)], ["tab\there"], [...full, "one-more"]]) {
    assert.equal(readHiddenCalendars(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(isCalendarKey("x".repeat(300)), true);
  assert.equal(isCalendarKey("x".repeat(301)), false);
  // A copy: changing it changes nothing given.
  const given = ["a"];
  readHiddenCalendars(given)!.push("b");
  assert.deepEqual(given, ["a"]);
});

test("week calendars: an event is on its calendar's key, or on aeneas when it has none; a hidden one is not shown", () => {
  const icloud = { title: "Dinner", caldav: { account: "you@icloud.com", calendar: "https://x/cal/home/", uid: "1" } };
  const apple = { title: "Standup", calendar_key: "apple:Work/Team" };
  const older = { title: "Lunch", apple: { id: "9", calendar: "Home" } };
  const m365 = { title: "Review", source: "m365" };
  const mine = { title: "Climbing" };
  assert.equal(calendarKeyOf(icloud), "icloud:https://x/cal/home/");
  assert.equal(calendarKeyOf(apple), "apple:Work/Team");
  assert.equal(calendarKeyOf(older), "apple:Home");
  assert.equal(calendarKeyOf(m365), "work:m365");
  assert.equal(calendarKeyOf(mine), NO_CALENDAR);
  const hidden = ["apple:Work/Team", NO_CALENDAR];
  assert.deepEqual([icloud, apple, older, m365, mine].filter((f) => calendarShown(f, hidden)).map((f) => f.title), ["Dinner", "Lunch", "Review"]);
  assert.equal(calendarShown(apple, []), true);
  assert.equal(calendarShown(apple, undefined), true);
});

test("week calendars: names from a key alone", () => {
  assert.deepEqual(calendarNameFromKey("apple:iCloud/Family"), { name: "Family", account: "iCloud" });
  assert.deepEqual(calendarNameFromKey("apple:jamie@work.example/Team/Ops"), { name: "Team/Ops", account: "jamie@work.example" });
  assert.deepEqual(calendarNameFromKey("apple:Home"), { name: "Home", account: "Apple Calendar" });
  assert.deepEqual(calendarNameFromKey("icloud:https://p42-caldav.icloud.com/1/calendars/home/"), { name: "iCloud calendar", account: "iCloud" });
  assert.deepEqual(calendarNameFromKey("work:m365"), { name: "Microsoft 365", account: "Work" });
  assert.deepEqual(calendarNameFromKey("aeneas"), { name: "Made in Aeneas", account: "Aeneas" });
  assert.deepEqual(calendarNameFromKey("something:else"), { name: "something:else", account: "Other" });
});

test("week calendars: the list holds the calendars events are on and the hidden ones still known, by account, Aeneas last", () => {
  const calendars = [
    { key: "icloud:https://x/home/", name: "Home", account: "jamie@icloud.com", color: "#FF2968" },
    { key: "icloud:https://x/family/", name: "Family", account: "jamie@icloud.com", color: "#34C759", chosen: "#5856D6" },
    { key: "apple:Exchange/Calendar", name: "Calendar", account: "Exchange", color: "#0A84FF" },
    { key: "apple:Exchange/Holidays", name: "Holidays", account: "Exchange" },
    { key: "icloud:https://x/empty/", name: "Empty", account: "jamie@icloud.com" },
  ];
  const groups = calendarGroups(calendars, ["icloud:https://x/home/", "icloud:https://x/family/", "apple:Exchange/Calendar", "aeneas", "apple:Robin/Book club"], ["apple:Exchange/Holidays", "apple:Gone/Old", "aeneas"]);
  assert.deepEqual(groups.map((g) => [g.account, g.calendars.map((c) => [c.name, c.color, c.shown])]), [
    ["Exchange", [["Calendar", "#0A84FF", true], ["Holidays", null, false]]],
    ["jamie@icloud.com", [["Family", "#5856D6", true], ["Home", "#FF2968", true]]],
    ["Robin", [["Book club", null, true]]],
    ["Aeneas", [["Made in Aeneas", null, false]]],
  ]);
  // A calendar with no events and not hidden, and a hidden key nothing knows, are not listed.
  assert.ok(!groups.flatMap((g) => g.calendars).some((c) => c.name === "Empty" || c.key === "apple:Gone/Old"));
  assert.deepEqual(calendarGroups(undefined, [], undefined), []);
});

test("week calendars: showing and hiding one keeps the rest in order", () => {
  assert.deepEqual(withCalendarShown([], "a", false), ["a"]);
  assert.deepEqual(withCalendarShown(["a", "b"], "c", false), ["a", "b", "c"]);
  assert.deepEqual(withCalendarShown(["a", "b", "c"], "b", true), ["a", "c"]);
  assert.deepEqual(withCalendarShown(["a"], "a", false), ["a"], "hidden once");
  assert.deepEqual(withCalendarShown(undefined, "a", true), []);
  const full = Array.from({ length: HIDDEN_CALENDARS_MAX }, (_, i) => `k${i}`);
  const more = withCalendarShown(full, "new", false);
  assert.equal(more.length, HIDDEN_CALENDARS_MAX);
  assert.equal(more.at(-1), "new");
  assert.ok(readHiddenCalendars(more));
});

test("week calendars: the contract names the setting and its rules", () => {
  const contract = fs.readFileSync(path.join(here, "../CONTRACT.md"), "utf8");
  assert.match(contract, /`hidden_calendars` \(since 2026-11-24\)/);
  assert.match(contract, /at most 300 calendar keys, each named once/);
  assert.match(contract, /`aeneas` stands for events on no calendar/);
});
