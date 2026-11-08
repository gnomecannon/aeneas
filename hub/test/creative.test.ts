import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Entity } from "@everythingapp/shared";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";
import { parsePlan, renderPlan } from "../src/projects.js";
import { countNumberedSteps, splitSteps } from "../src/procedures.js";
import { musicReferencesToNotes, parseQuick } from "../src/music.js";
import { buildQuiz, quizStreakDays } from "../src/quiz.js";
import { setBackendOverride, type Backend } from "../src/ai/backends.js";
import type { ChatOutput } from "../src/ai/index.js";
import type { CloseResult } from "../src/memory.js";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

test("parts: a project write fills have and inventory_id from inventory by name, and an inventory change refills them", async () => {
  const t = makeHub();
  try {
    const esp = t.hub.store.create("inventory", { name: "ESP32 DevKit", category: "component", qty: 3 });
    const project = t.hub.store.create("project", { name: "Garage sensor", status: "active", definition_of_done: "Temperature on the dashboard", parts: [{ name: "esp32 devkit", qty: 2 }, { name: "DHT22", qty: 1 }] });
    let parts = t.hub.store.get(project.id)!.fields.parts as { name: string; qty: number; have?: number; inventory_id?: string }[];
    assert.equal(parts[0].have, 3, "matched case-insensitively");
    assert.equal(parts[0].inventory_id, esp.id);
    assert.equal(parts[1].have, 0);
    assert.equal(parts[1].inventory_id, undefined);

    t.hub.store.create("inventory", { name: "dht22", category: "component", qty: 1 });
    parts = t.hub.store.get(project.id)!.fields.parts as typeof parts;
    assert.equal(parts[1].have, 1, "a new inventory row refills the project");

    t.hub.store.patch(esp.id, { qty: 1 });
    parts = t.hub.store.get(project.id)!.fields.parts as typeof parts;
    assert.equal(parts[0].have, 1, "an inventory edit refills the project");

    const summary = await (await t.api(`/projects/${project.id}/summary`)).json() as { parts: { name: string; qty: number; have: number; missing: number }[]; plan_note: unknown; last_session_close: unknown };
    // Each matched row names its inventory item, so a client can link the part to it.
    const dht = t.hub.store.list({ kind: "inventory" }).find((i) => i.fields.name === "dht22")!;
    assert.deepEqual(summary.parts, [{ name: "esp32 devkit", qty: 2, have: 1, missing: 1, inventory_id: esp.id }, { name: "DHT22", qty: 1, have: 1, missing: 0, inventory_id: dht.id }]);
    assert.equal(summary.plan_note, null);
    assert.equal(summary.last_session_close, null);
    assert.equal((await t.api("/projects/00000000-0000-0000-0000-000000000000/summary")).status, 404);
  } finally { t.cleanup(); }
});

test("plan: the note is written under Projects/<name>/Plan.md with six headings, kept idempotent, and log lines are appended", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("inventory", { name: "Relay board", category: "component", qty: 1 });
    const project = t.hub.store.create("project", { name: "Shed lights", status: "active", definition_of_done: "Lights switch from the app", parts: [{ name: "relay board", qty: 1 }, { name: "12V PSU", qty: 1 }] });
    const first = await t.api(`/projects/${project.id}/plan`, { method: "POST", json: { sections: { current: "Bench wired", log_line: "Started the build" } } });
    assert.equal(first.status, 200);
    const note = await first.json() as Entity;
    assert.equal(note.fields.path, "Projects/Shed lights/Plan.md");
    assert.equal(note.fields.title, "Plan: Shed lights");
    const body = String(note.fields.body);
    for (const h of ["## Goal", "## Definition of done", "## Current state", "## Next", "## Parts", "## Log"]) assert.ok(body.includes(h), `${h} present`);
    assert.ok(body.includes("Lights switch from the app"), "goal falls back to the definition of done");
    assert.ok(body.includes("- relay board: need 1, have 1"), "parts rendered with have");
    assert.ok(body.includes("- 12V PSU: need 1, have 0, missing 1"), "missing parts rendered");
    assert.ok(body.includes(`- ${day(0)}: Started the build`));
    assert.ok(fs.existsSync(path.join(t.hub.cfg.vaultDir, "Projects", "Shed lights", "Plan.md")), "file written to the vault");
    assert.equal(t.hub.store.get(project.id)!.fields.plan_doc_path, "Projects/Shed lights/Plan.md");

    const second = await (await t.api(`/projects/${project.id}/plan`, { method: "POST", json: { sections: { next: "Mount the box", log_line: "PSU ordered" } } })).json() as Entity;
    assert.equal(second.id, note.id, "same note");
    const body2 = String(second.fields.body);
    assert.equal(body2.match(/^## /gm)!.length, 6, "headings are not duplicated");
    assert.ok(body2.includes("Bench wired"), "current state kept");
    assert.ok(body2.includes("Mount the box"));
    assert.ok(body2.includes("Started the build") && body2.includes("PSU ordered"), "log appended, not replaced");
    assert.ok(body2.indexOf("Started the build") < body2.indexOf("PSU ordered"));

    const summary = await (await t.api(`/projects/${project.id}/summary`)).json() as { plan_note: Entity | null; notes: Entity[] };
    assert.equal(summary.plan_note?.id, note.id);
    assert.equal(summary.notes.length, 0, "the plan is not listed twice");
  } finally { t.cleanup(); }
});

test("plan: renderPlan keeps extra headings, uses given goal text and does not grow on a no-op rewrite", () => {
  const project = { id: "p", kind: "project", fields: { name: "X", definition_of_done: "done when", parts: [] } } as unknown as Entity;
  const once = renderPlan(project, "## Notes\n\nkeep me\n", { goal: "Ship it", log_line: "a" }, new Date("2026-10-23T12:00:00"));
  const twice = renderPlan(project, once, {}, new Date("2026-10-23T12:00:00"));
  assert.equal(once, twice, "rewriting without changes is a no-op");
  const sections = parsePlan(twice);
  assert.equal(sections.get("Goal"), "Ship it");
  assert.equal(sections.get("Notes"), "keep me");
  assert.equal(sections.get("Parts"), "No parts listed.");
  assert.equal(sections.get("Log"), "- 2026-10-23: a");
});

test("close: a session close with a project appends a dated log line and refreshes Current state and Next", async () => {
  const t = makeHub();
  try {
    const project = t.hub.store.create("project", { name: "Hub box", status: "active", definition_of_done: "Hub runs as a service" });
    await t.api("/ai/chat", { method: "POST", json: { session_id: "p1", task_type: "troubleshoot", messages: [{ role: "user", content: "hub unit will not start" }] } });
    const res = await (await t.api("/ai/sessions/p1/close", { method: "POST", json: { outcome: "parked", note: "waiting on a reboot window", project_id: project.id } })).json() as CloseResult;
    assert.ok(res.plan_note_id, "plan note id returned");
    const note = t.hub.store.get(res.plan_note_id!)!;
    const body = String(note.fields.body);
    const sections = parsePlan(body);
    assert.ok(sections.get("Log")!.startsWith(`- ${day(0)}: Session parked:`), sections.get("Log"));
    assert.ok(sections.get("Current state")!.startsWith("parked:"));
    assert.equal(sections.get("Next"), "waiting on a reboot window");
    const summary = await (await t.api(`/projects/${project.id}/summary`)).json() as { last_session_close: string | null; plan_note: Entity | null };
    assert.ok(summary.last_session_close, "last close comes from the resume card");
    assert.equal(summary.plan_note?.id, note.id);

    await t.api("/ai/sessions/p1/close", { method: "POST", json: { outcome: "fixed", project_id: project.id } });
    const again = parsePlan(String(t.hub.store.get(note.id)!.fields.body));
    assert.equal(again.get("Log")!.split("\n").length, 2, "second close appends a second line");
    assert.equal(again.get("Next"), "Nothing open from the last session.");
  } finally { t.cleanup(); }
});

test("procedures: the splitter takes numbered and bulleted lines, fenced commands, inline code and host prefixes", () => {
  const text = [
    "# Rotate the hub token",
    "Some context first.",
    "1. on desk-pc as root: stop the unit",
    "```bash",
    "systemctl stop hub",
    "```",
    "2. Edit the env file",
    "   and keep a copy of the old token.",
    "3. Start it again with `systemctl start hub`",
    "- Check the log",
    "```",
    "journalctl -u hub -n 50",
    "```",
  ].join("\n");
  const p = splitSteps(text);
  assert.equal(p.title, "Rotate the hub token");
  assert.equal(p.steps.length, 4);
  assert.deepEqual(p.steps[0], { text: "stop the unit", host: "desk-pc", user: "root", command: "systemctl stop hub" });
  assert.equal(p.steps[1].text, "Edit the env file and keep a copy of the old token.");
  assert.equal(p.steps[1].command, undefined);
  assert.equal(p.steps[2].command, "systemctl start hub");
  assert.deepEqual(p.steps[3], { text: "Check the log", command: "journalctl -u hub -n 50" });
  assert.equal(countNumberedSteps(text), 3);
  assert.equal(countNumberedSteps("1. a\n```\n2. not a step inside a fence\n```\n2. b"), 2);
  assert.equal(splitSteps("just prose", "Given title").title, "Given title");
  assert.equal(splitSteps("just prose").steps.length, 0);
});

test("procedures: from-text falls back to the rules with the fake backend, advance runs to completion, back and reset", async () => {
  const t = makeHub();
  try {
    const made = await t.api("/procedures/from-text", { method: "POST", json: { text: "1. on core as robin: pull the image\n```\ndocker pull hub:latest\n```\n2. restart\n3. verify", title: "Deploy", host: "desk-pc" } });
    assert.equal(made.status, 201);
    const proc = await made.json() as Entity & { via: string };
    assert.equal(proc.via, "rules");
    assert.equal(proc.fields.title, "Deploy");
    const steps = proc.fields.steps as { text: string; host?: string; user?: string; command?: string; done_at?: string }[];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].host, "core", "a step's own host wins");
    assert.equal(steps[0].user, "robin");
    assert.equal(steps[0].command, "docker pull hub:latest");
    assert.equal(steps[1].host, "desk-pc", "the body host fills the rest");
    assert.equal(proc.fields.current, 0);

    const one = await (await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { done: true } })).json() as Entity;
    assert.equal(one.fields.current, 1);
    assert.ok(one.fields.started_at);
    assert.ok((one.fields.steps as typeof steps)[0].done_at);
    assert.equal(one.fields.done_at, undefined);

    const back = await (await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { back: true } })).json() as Entity;
    assert.equal(back.fields.current, 0);
    assert.ok((back.fields.steps as typeof steps)[0].done_at, "back does not clear the step");

    await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { done: true } });
    await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { done: true } });
    const done = await (await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { done: true } })).json() as Entity;
    assert.equal(done.fields.current, 3);
    assert.ok(done.fields.done_at, "procedure done after the last step");
    assert.ok((done.fields.steps as typeof steps).every((s) => s.done_at));
    const again = await (await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: { done: true } })).json() as Entity;
    assert.equal(again.fields.current, 3, "advancing past the end is a no-op");

    const reset = await (await t.api(`/procedures/${proc.id}/reset`, { method: "POST", json: {} })).json() as Entity;
    assert.equal(reset.fields.current, 0);
    assert.equal(reset.fields.done_at, undefined);
    assert.equal(reset.fields.started_at, undefined);
    assert.ok((reset.fields.steps as typeof steps).every((s) => !s.done_at));

    assert.equal((await t.api(`/procedures/${proc.id}/advance`, { method: "POST", json: {} })).status, 422);
    assert.equal((await t.api("/procedures/from-text", { method: "POST", json: { text: "   " } })).status, 422);
    assert.equal((await t.api("/procedures/from-text", { method: "POST", json: { text: "no steps here at all" } })).status, 422);
  } finally { t.cleanup(); }
});

test("procedures: a model that answers with steps is used, and a model that answers badly falls back to the rules", async () => {
  const t = makeHub();
  const good: Backend = { name: "ollama", model: "m", async chat() { return { text: '{"title":"From the model","steps":[{"text":"Snapshot first","command":"zfs snapshot tank@pre","host":"Desk-PC"},{"text":"Upgrade"}]}', usage: {} }; }, async stream() { throw new Error("no"); } };
  const bad: Backend = { name: "ollama", model: "m", async chat() { return { text: "sorry, no", usage: {} }; }, async stream() { throw new Error("no"); } };
  try {
    setBackendOverride(good);
    const a = await (await t.api("/procedures/from-text", { method: "POST", json: { text: "snapshot then upgrade" } })).json() as Entity & { via: string };
    assert.equal(a.via, "model");
    assert.equal(a.fields.title, "From the model");
    assert.deepEqual(a.fields.steps, [{ text: "Snapshot first", command: "zfs snapshot tank@pre", host: "desk-pc" }, { text: "Upgrade" }]);
    setBackendOverride(bad);
    const b = await (await t.api("/procedures/from-text", { method: "POST", json: { text: "1. one\n2. two" } })).json() as Entity & { via: string };
    assert.equal(b.via, "rules");
    assert.equal((b.fields.steps as unknown[]).length, 2);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("chat: a troubleshoot reply with three or more numbered steps carries procedure_id; two steps or a general session do not", async () => {
  const t = makeHub();
  const stepsReply = "Do this:\n1. Check the unit with `systemctl status hub`.\n2. Read the log.\n3. Restart the unit.\nThen report back.";
  const stepsBackend: Backend = { name: "ollama", model: "m", async chat() { return { text: stepsReply, usage: {} }; }, async stream() { throw new Error("no"); } };
  try {
    setBackendOverride(stepsBackend);
    const out = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "s1", task_type: "troubleshoot", messages: [{ role: "user", content: "hub will not start on core" }] } })).json() as ChatOutput;
    assert.ok(out.procedure_id, "procedure attached");
    assert.ok(out.ledger_id, "ledger still there");
    const proc = t.hub.store.get(out.procedure_id!)!;
    assert.equal(proc.kind, "procedure");
    assert.equal(proc.fields.title, "hub will not start on core");
    assert.equal(proc.fields.source_session, "s1");
    const steps = proc.fields.steps as { text: string; command?: string }[];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].command, "systemctl status hub");

    const calls = (t.hub.chatDb.prepare("SELECT COUNT(*) AS n FROM ai_calls").get() as { n: number }).n;
    const general = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "s2", task_type: "general", messages: [{ role: "user", content: "same again" }] } })).json() as ChatOutput;
    assert.equal(general.procedure_id, undefined, "general sessions are left alone");
    assert.equal((t.hub.chatDb.prepare("SELECT COUNT(*) AS n FROM ai_calls").get() as { n: number }).n, calls + 1, "exactly one model call per chat");
    setBackendOverride(null);
    const two = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "s3", task_type: "troubleshoot", messages: [{ role: "user", content: "only two steps" }] } })).json() as ChatOutput;
    assert.equal(two.procedure_id, undefined, "the fake backend's two steps are not enough");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("music: quick parse reads chords, time signature, bpm and tuning from three inputs", () => {
  const a = parseQuick("Am F C G 6/8 112bpm drop D");
  assert.deepEqual(a, { title: "Am F C G", type: "progression", body: "Am F C G", key: "Am", time_sig: "6/8", bpm: 112, tuning: "drop D" });
  const b = parseQuick("Rainy garden riff DADGAD bpm 90");
  assert.deepEqual(b, { title: "Rainy garden riff", type: "riff", body: "", tuning: "DADGAD", bpm: 90 });
  const c = parseQuick("Bridge idea F#m7 Bb C/G 4/4 E standard");
  assert.equal(c.title, "Bridge idea");
  assert.equal(c.type, "progression");
  assert.equal(c.body, "F#m7 Bb C/G");
  assert.equal(c.key, "F#m");
  assert.equal(c.time_sig, "4/4");
  assert.equal(c.tuning, "E standard");
  assert.equal(c.bpm, undefined);
  assert.throws(() => parseQuick("   "));
  // As said out loud: a label, joining words, "at 112" and punctuation.
  const d = parseQuick("riff idea: Am F C G in 6/8 at 112, drop D");
  assert.deepEqual(d, { title: "Am F C G", type: "riff", body: "Am F C G", key: "Am", time_sig: "6/8", bpm: 112, tuning: "drop D" });
  assert.equal(parseQuick("Cave theme @96 Dm Bb").bpm, 96);
  assert.equal(parseQuick("Cave theme Dm Bb").title, "Cave theme");
});

test("music: /music/quick creates the idea and /music filters by type and status", async () => {
  const t = makeHub();
  try {
    const made = await t.api("/music/quick", { method: "POST", json: { text: "Am F C G 6/8 112bpm drop D" } });
    assert.equal(made.status, 201);
    const idea = await made.json() as Entity;
    assert.equal(idea.kind, "music_idea");
    assert.equal(idea.fields.type, "progression");
    assert.equal(idea.fields.status, "idea");
    assert.equal(idea.fields.bpm, 112);
    await t.api("/music/quick", { method: "POST", json: { text: "campfire riff drop C" } });
    t.hub.store.patch(idea.id, { status: "wip" });
    const all = await (await t.api("/music")).json() as Entity[];
    assert.equal(all.length, 2);
    assert.equal(((await (await t.api("/music?type=riff")).json()) as Entity[]).length, 1);
    assert.equal(((await (await t.api("/music?status=wip")).json()) as Entity[])[0].id, idea.id);
    assert.equal(((await (await t.api("/music?type=riff&status=wip")).json()) as Entity[]).length, 0);
    assert.equal((await t.api("/music/quick", { method: "POST", json: {} })).status, 422);
  } finally { t.cleanup(); }
});

test("quiz: built from today's sessions with the fake backend, answers recorded, completion and the streak", async () => {
  const t = makeHub();
  try {
    assert.equal(await buildQuiz(t.hub), null, "no sessions today, no quiz");
    assert.equal(await (await t.api("/quiz/today")).json(), null);

    await t.api("/ai/chat", { method: "POST", json: { session_id: "q1", task_type: "troubleshoot", messages: [{ role: "user", content: "hub unit will not start" }] } });
    const notes: unknown[] = [];
    const off = t.hub.bus.on("notify", (e) => notes.push(e));
    const quiz = await buildQuiz(t.hub);
    off();
    assert.ok(quiz, "quiz built");
    assert.equal(quiz!.fields.date, day(0));
    assert.deepEqual(quiz!.fields.source_sessions, ["q1"]);
    const items = quiz!.fields.items as { q: string; result?: string }[];
    assert.equal(items.length, 3);
    assert.deepEqual(notes, [{ id: `quiz:${day(0)}`, kind: "quiz", title: "Recall quiz: 3 questions", at: (notes[0] as { at: string }).at, date: day(0) }]);
    assert.equal((await buildQuiz(t.hub))!.id, quiz!.id, "a second build returns the same quiz");
    assert.equal(((await (await t.api("/quiz/today")).json()) as Entity).id, quiz!.id);

    const a1 = await (await t.api(`/quiz/${quiz!.id}/answer`, { method: "POST", json: { index: 0, result: "right" } })).json() as Entity;
    const i1 = a1.fields.items as { result?: string; asked_at?: string }[];
    assert.equal(i1[0].result, "right");
    assert.ok(i1[0].asked_at);
    assert.equal(a1.fields.completed_at, undefined);
    assert.equal(quizStreakDays(t.hub.store), 0);
    await t.api(`/quiz/${quiz!.id}/answer`, { method: "POST", json: { index: 1, result: "wrong" } });
    const a3 = await (await t.api(`/quiz/${quiz!.id}/answer`, { method: "POST", json: { index: 2, result: "revealed" } })).json() as Entity;
    assert.ok(a3.fields.completed_at, "completed once every item has a result");
    assert.equal(quizStreakDays(t.hub.store), 1);

    assert.equal((await t.api(`/quiz/${quiz!.id}/answer`, { method: "POST", json: { index: 9, result: "right" } })).status, 422);
    assert.equal((await t.api(`/quiz/${quiz!.id}/answer`, { method: "POST", json: { index: 0, result: "maybe" } })).status, 422);
    assert.equal((await t.api("/quiz/00000000-0000-0000-0000-000000000000/answer", { method: "POST", json: { index: 0, result: "right" } })).status, 404);
  } finally { t.cleanup(); }
});

test("quiz: the streak counts consecutive completed days ending today or yesterday, and the job is skipped without a model", async () => {
  const t = makeHub();
  try {
    const item = [{ q: "q", a: "a", hint: "", topic: "" , result: "right" }];
    const mk = (d: string, done: boolean) => t.hub.store.create("quiz", { date: d, items: item, ...(done ? { completed_at: `${d}T21:30:00.000Z` } : {}) });
    mk(day(-1), true); mk(day(-2), true); mk(day(-3), true);
    assert.equal(quizStreakDays(t.hub.store), 3, "ending yesterday still counts");
    mk(day(-4), false);
    mk(day(-5), true);
    assert.equal(quizStreakDays(t.hub.store), 3, "an incomplete day breaks the streak");
    mk(day(0), true);
    assert.equal(quizStreakDays(t.hub.store), 4);
    const status = await (await t.api("/status")).json() as { creative: { projects_active: number; procedures_open: number; music_ideas: number; quiz_streak_days: number } };
    assert.deepEqual(status.creative, { projects_active: 0, procedures_open: 0, music_ideas: 0, quiz_streak_days: 4 });
  } finally { t.cleanup(); }

  const u = makeHub({ aiFake: false });
  try {
    await u.hub.ai.chat({ session_id: "x", task_type: "general", messages: [{ role: "user", content: "hi" }] }).catch(() => undefined);
    u.hub.chatDb.prepare("INSERT INTO sessions (session_id, task_type, created_at, last_at, messages) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING").run("x", "general", new Date().toISOString(), new Date().toISOString(), JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]));
    assert.equal(u.hub.ai.available(), false);
    assert.equal(await buildQuiz(u.hub), null, "no model, no quiz");
  } finally { u.cleanup(); }
});

test("status: creative counts active projects, open procedures and music ideas", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("project", { name: "A", status: "active", definition_of_done: "x" });
    t.hub.store.create("project", { name: "B", status: "parked", definition_of_done: "x" });
    const p = t.hub.store.create("procedure", { title: "P", steps: [{ text: "one" }], current: 0 });
    t.hub.store.create("procedure", { title: "Q", steps: [{ text: "one" }], current: 1, done_at: new Date().toISOString() });
    t.hub.store.create("music_idea", { title: "M", type: "riff" });
    const status = await (await t.api("/status")).json() as { creative: Record<string, number>; home: unknown; captures_unprocessed: number };
    assert.deepEqual(status.creative, { projects_active: 1, procedures_open: 1, music_ideas: 1, quiz_streak_days: 0 });
    assert.ok(status.home, "existing blocks stay");
    await t.api(`/procedures/${p.id}/advance`, { method: "POST", json: { done: true } });
    assert.equal(((await (await t.api("/status")).json()) as { creative: Record<string, number> }).creative.procedures_open, 0);
  } finally { t.cleanup(); }
});

test("seed: the two music reference sheets are notes in Music/Reference, created once by title, and a deleted one stays deleted", async () => {
  const t = makeHub();
  try {
    const first = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.deepEqual(first.music_notes, { created: 2, kept: 0 });
    assert.equal(t.hub.store.list({ kind: "music_idea" }).length, 0, "the Music section holds songs and ideas, not reference sheets");
    const refs = t.hub.store.list({ kind: "note" }).filter((n) => String(n.fields.path).startsWith("Music/Reference/"));
    const gain = refs.find((m) => m.fields.title === "Mix checklist")!;
    const session = refs.find((m) => m.fields.title === "Session checklist")!;
    assert.ok(gain && session);
    assert.deepEqual(gain.fields.tags, ["music", "reference", "mixing"]);
    for (const needle of ["dBFS", "LUFS", "-18 dBFS", "-1 dBTP", "-14 LUFS", "Mix bus order"]) assert.ok(String(gain.fields.body).includes(needle), `mix checklist mentions ${needle}`);
    for (const needle of ["sample rate", "Buffer size", "template", "Name every track", "mixdown"]) assert.ok(String(session.fields.body).includes(needle), `session checklist mentions ${needle}`);
    assert.ok(!/[\u2013\u2014!]/.test(String(gain.fields.body) + String(session.fields.body)), "no dashes or exclamation marks");

    t.hub.store.patch(gain.id, { body: "my own version" });
    t.hub.store.patch(session.id, { deleted_at: new Date().toISOString() });
    const second = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.deepEqual(second.music_notes, { created: 0, kept: 2 });
    assert.equal(t.hub.store.get(gain.id)!.fields.body, "my own version", "edits survive a reseed");
    assert.equal(t.hub.store.list({ kind: "note" }).filter((n) => String(n.fields.path).startsWith("Music/Reference/")).length, 1, "a deleted note is not resurrected");
  } finally { t.cleanup(); }
});

test("music: reference sheets, templates and settings kept as music ideas move to notes", () => {
  const t = makeHub();
  try {
    const ref = t.hub.store.create("music_idea", { title: "Gain staging cheat sheet", type: "reference", status: "done", body: "-18 dBFS", tags: ["mixing", "reference"] });
    const tpl = t.hub.store.create("music_idea", { title: "Vocal chain", type: "template", status: "done", body: "EQ, comp", tags: [], bpm: 90 });
    const riff = t.hub.store.create("music_idea", { title: "Garden riff", type: "riff", status: "idea", body: "e|-0-3-", tags: [] });
    assert.equal(musicReferencesToNotes(t.hub.store), 2);
    assert.ok(t.hub.store.get(ref.id)!.deleted_at && t.hub.store.get(tpl.id)!.deleted_at);
    assert.equal(t.hub.store.get(riff.id)!.deleted_at, null, "a riff stays in Music");
    const notes = t.hub.store.list({ kind: "note" });
    const vocal = notes.find((n) => n.fields.title === "Vocal chain")!;
    assert.equal(vocal.fields.path, "Music/Reference/Vocal chain.md");
    assert.deepEqual(vocal.fields.tags, ["music", "reference", "template"]);
    assert.equal(vocal.fields.body, "Tempo: 90 bpm\n\nEQ, comp");
    assert.equal(musicReferencesToNotes(t.hub.store), 0, "idempotent");
    assert.equal(notes.filter((n) => n.fields.title === "Gain staging cheat sheet").length, 1);
  } finally { t.cleanup(); }
});
