import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTHING_ELSE, durationWords, freeTime, lineWords, nextLine, startedTask, type DayThing, type LineTask } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The cases EACore's NextLineTests reads too, so the Apple apps and the rest say the same words. */
interface Case {
  name: string;
  now: string;
  tasks: { id: string; title: string; status: string; order: number; started?: string; block?: [string, string] }[];
  things: { kind: string; title?: string; start: string; end?: string; all_day?: boolean; type?: string }[];
  started: string | null;
  kind: string;
  label: string;
  text: string;
  today: string;
}
const file = JSON.parse(fs.readFileSync(path.join(here, "next-line-cases.json"), "utf8")) as { day: string; cases: Case[] };

const [y, mo, d] = file.day.split("-").map(Number);
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m);
};
const iso = (hhmm: string) => at(hhmm).toISOString();
const pad = (n: number) => String(n).padStart(2, "0");
/** A 24 hour clock, so the words do not depend on the machine's locale. */
const clock = (s: string) => { const t = new Date(s); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };

function tasksOf(c: Case): LineTask[] {
  return c.tasks.map((t) => ({
    id: t.id,
    fields: { title: t.title, status: t.status, order: t.order, ...(t.block ? { block: { start: iso(t.block[0]), end: iso(t.block[1]) } } : {}) },
    updated_at: iso("00:00"),
    field_ts: (t.started ? { status: iso(t.started) } : {}) as Record<string, string>,
  }));
}

function thingsOf(c: Case): DayThing[] {
  return c.things.map((x) => ({ ...x, start: iso(x.start), ...(x.end ? { end: iso(x.end) } : {}) }));
}

for (const c of JSON.parse(JSON.stringify(file.cases)) as Case[]) {
  test(`next line: ${c.name}`, () => {
    const now = at(c.now);
    const started = startedTask(tasksOf(c));
    assert.equal(started?.id ?? null, c.started);
    const things = thingsOf(c);
    const line = nextLine(things, now, started);
    assert.equal(line.kind, c.kind);
    const alone = lineWords(line, freeTime(things, now, clock), clock);
    assert.equal(alone.label, c.label);
    assert.equal(alone.text, c.text);
    assert.equal(lineWords(line, null, clock).text, c.today, "Today shows the free time on a line of its own");
    assert.doesNotMatch(alone.text, /[\u2013\u2014]/);
  });
}

test("next line: a deleted or finished task is never the one started", () => {
  const t = (id: string, status: string, extra: Partial<LineTask> = {}): LineTask => ({ id, fields: { title: id, status, order: 1 }, updated_at: "2026-11-25T10:00:00.000Z", ...extra });
  assert.equal(startedTask([t("a", "done"), t("b", "next"), t("c", "doing", { deleted_at: "2026-11-25T11:00:00.000Z" })]), null);
  // Without a status stamp, the last change says which was started last.
  assert.equal(startedTask([t("a", "doing"), t("b", "doing", { updated_at: "2026-11-25T11:00:00.000Z" })])?.id, "b");
});

test("next line: a started task whose block is over or not begun says no time", () => {
  const task: LineTask = { id: "r", fields: { title: "Write the report", status: "doing", block: { start: iso("09:00"), end: iso("12:00") } } };
  assert.deepEqual(nextLine([], at("13:00"), task), { kind: "started", title: "Write the report", id: "r" });
  assert.deepEqual(nextLine([], at("08:00"), task), { kind: "started", title: "Write the report", id: "r" });
  assert.equal(lineWords(nextLine([], at("10:00"), task), null, clock).text, "Doing: Write the report until 12:00, 2 h left");
});

test("next line: the words", () => {
  assert.equal(durationWords(46 * 60_000), "46 min");
  assert.equal(durationWords(2 * 3600_000), "2 h");
  assert.equal(durationWords(130 * 60_000), "2 h 10 min");
  assert.equal(NOTHING_ELSE, "Nothing else today");
  const w = lineWords({ kind: "next", title: "Dentist", at: iso("15:00"), wait: "2 h", what: "event" }, null, clock);
  assert.deepEqual(w, { label: "Next", lead: "Next: ", title: "Dentist", when: "at 15:00", aside: "in 2 h", text: "Next: Dentist at 15:00, in 2 h" });
});
