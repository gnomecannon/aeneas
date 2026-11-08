import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { parseWhen } from "../src/when.js";
import { setBackendOverride, type Backend } from "../src/ai/backends.js";
import { scripted } from "./ai-helpers.js";
import { fileCapture, filingPrompt, linkCaptureThreads, nearbyEvents, queueFiling } from "../src/capture-filer.js";
import { captureInPrompt } from "../src/ai/sessions.js";

interface CaptureResponse { capture: any; suggested_kind: string; created?: any[] }

test("capture: auto classification for the four canonical phrases", async () => {
  const t = makeHub();
  try {
    // Filing is asynchronous: wait for it, then read what the capture became (the test model makes no tool calls,
    // so these clear phrasings are filed by the rule fallback).
    const cap = async (text: string) => {
      const res = await t.api("/capture", { method: "POST", json: { text, source: "api", auto: true } });
      assert.equal(res.status, 201);
      const r = (await res.json()) as CaptureResponse;
      await queueFiling(t.hub, "none");
      const capture = t.hub.store.get(r.capture.id)!;
      return { ...r, capture, created: ((capture.fields.converted_to as string[]) ?? []).map((id) => t.hub.store.get(id)!) } as CaptureResponse;
    };
    const a = await cap("remind me to order filament");
    assert.equal(a.suggested_kind, "reminder");
    assert.equal(a.created![0].kind, "task", "a reminder is a task with a reminder time");
    assert.equal(a.created![0].fields.status, "scheduled");
    assert.equal(a.created![0].fields.title, "order filament");
    assert.equal(a.created![0].fields.friction, "none");
    assert.ok(a.created![0].fields.remind_at);
    assert.equal(a.capture.fields.processed, true);
    assert.deepEqual(a.capture.fields.converted_to, [a.created![0].id]);

    const b = await cap("weight 162");
    assert.equal(b.suggested_kind, "log");
    assert.equal(b.created![0].fields.type, "weight");
    assert.equal(b.created![0].fields.value, 162);
    assert.equal(b.created![0].fields.unit, "lb");

    const c = await cap("took claritin");
    assert.equal(c.suggested_kind, "log");
    assert.equal(c.created![0].fields.type, "med");
    assert.equal(c.created![0].fields.value, "claritin");

    // A task guessed from its first word is the assistant's call: answering without filing it, it stays in the
    // diary (since 2026-11-05; "Check out that sunset" was made a task). With the assistant down the rule files it.
    const d = await cap("call the vet");
    assert.equal(d.suggested_kind, "task");
    assert.deepEqual(d.created, []);
    assert.equal(d.capture.fields.filed, "Diary only");
    assert.equal(d.capture.fields.sorted_by, "auto");
    const todo = await cap("todo: call the vet");
    assert.equal(todo.created![0].fields.title, "call the vet", "a command at the start is still filed by rule");

    // Without auto nothing is converted.
    const res = await t.api("/capture", { method: "POST", json: { text: "weight 160", source: "watch" } });
    const e = (await res.json()) as CaptureResponse;
    assert.equal(e.suggested_kind, "none");
    assert.equal(e.capture.fields.processed, false);
    // Manual convert.
    const conv = await t.api(`/capture/${e.capture.id}/convert`, { method: "POST", json: { kind: "log", fields: { type: "weight", value: 160, unit: "lb" } } });
    assert.equal(conv.status, 201);
    assert.equal(t.hub.store.get(e.capture.id)!.fields.processed, true);
    assert.equal(t.hub.store.get(e.capture.id)!.fields.sorted_by, "manual");
    assert.equal(t.hub.store.get(e.capture.id)!.fields.filed, "Logs: weight 160 lb");
  } finally { t.cleanup(); }
});

test("capture: the reminder time parser reads tomorrow and relative phrases", () => {
  const now = new Date("2026-10-21T14:00:00.000Z");
  const a = parseWhen("order filament tomorrow", now);
  assert.equal(a.rest, "order filament");
  assert.ok(a.at && new Date(a.at).getTime() > now.getTime());
  const b = parseWhen("stretch in 20 minutes", now);
  assert.equal(b.rest, "stretch");
  assert.equal(b.at, "2026-10-21T14:20:00.000Z");
  const c = parseWhen("call the vet", now);
  assert.equal(c.at, null);
});


test("capture: every sorted capture goes into the day's diary, and the assistant files the rest with its tools", async () => {
  const t = makeHub();
  const b = scripted([
    () => ({ calls: [
      { name: "create_item", arguments: { kind: "event", fields: { title: "Dinner at Luigi's with Jen", start: "2026-10-30T17:00:00-04:00", end: "2026-10-30T23:59:00-04:00" } } },
      { name: "remember", arguments: { category: "preference", key: "restaurant:luigis", value: "Eats at Luigi's with Jen" } },
    ] }),
    () => ({ text: "Added dinner at Luigi's to the calendar." }),
  ]);
  setBackendOverride(b);
  try {
    const cap = async (text: string) => (await (await t.api("/capture", { method: "POST", json: { text, source: "iphone", auto: true } })).json()) as CaptureResponse;
    const a = await cap("Tonight I'm going to dinner at Luigi's with Jen");
    // Not left in Unsorted Info: it is in the diary and being filed.
    assert.equal(a.capture.fields.processed, true);
    assert.equal(a.capture.fields.filing, "pending");
    const diary = t.hub.store.get(String(a.capture.fields.diary_id))!;
    assert.match(String(diary.fields.path), /^Diary\/\d{4}-\d\d-\d\d\.md$/);
    assert.match(String(diary.fields.body), /- \d\d:\d\d Tonight I'm going to dinner at Luigi's with Jen/);
    await queueFiling(t.hub, "none");
    const done = t.hub.store.get(a.capture.id)!;
    assert.equal(done.fields.filing, "done");
    assert.match(String(done.fields.filed), /^Calendar: Dinner at Luigi's with Jen; Memory: /);
    const event = t.hub.store.list({ kind: "event" }).find((e) => e.fields.title === "Dinner at Luigi's with Jen");
    assert.ok(event && (done.fields.converted_to as string[]).includes(event.id));
    assert.ok(t.hub.store.list({ kind: "fact" }).some((f) => f.fields.key === "restaurant:luigis"));
    assert.match(b.seen[0].at(-1)!.content, /\[Capture to file\]/);
    // The filing chat keeps the capture, not the prompt, and is titled as a capture; the capture points at it.
    assert.equal(done.fields.thread, `capture-${a.capture.id}`);
    const thread = t.hub.ai.sessions.get(`capture-${a.capture.id}`)!;
    assert.equal(thread.messages[0].content, "Tonight I'm going to dinner at Luigi's with Jen");
    assert.equal(thread.title, "Capture: Tonight I'm going to dinner at Luigi's with Jen");
    assert.equal(thread.messages.length, 2);
    // Older hubs stored the prompt: the tidy step puts the capture back.
    const prompt = filingPrompt("Tonight I'm going to dinner at Luigi's with Jen", new Date(), "", []);
    t.hub.chatDb.prepare("UPDATE sessions SET messages = ?, title = NULL WHERE session_id = ?").run(JSON.stringify([{ role: "user", content: prompt }, { role: "assistant", content: "Filed." }]), thread.session_id);
    assert.equal(t.hub.ai.sessions.tidyCaptureThreads(), 1);
    assert.equal(t.hub.ai.sessions.get(thread.session_id)!.messages[0].content, "Tonight I'm going to dinner at Luigi's with Jen");
    assert.equal(t.hub.ai.sessions.get(thread.session_id)!.title, "Capture: Tonight I'm going to dinner at Luigi's with Jen");
    assert.equal(t.hub.ai.sessions.tidyCaptureThreads(), 0);
    // A capture filed before the thread field gets it on start.
    t.hub.db.prepare("UPDATE entities SET fields = json_remove(fields, '$.thread') WHERE id = ?").run(a.capture.id);
    assert.equal(linkCaptureThreads(t.hub), 1);
    assert.equal(t.hub.store.get(a.capture.id)!.fields.thread, `capture-${a.capture.id}`);
    assert.equal(linkCaptureThreads(t.hub), 0);
    assert.equal(captureInPrompt('[Capture to file] Robin wrote this quick note to self on Sunday, November 1, 2026 at 12:18 AM: "Halloween party at Rafael\'s" It is already saved in the diary for 2026-10-31.'), "Halloween party at Rafael's");

    // Rule-sorted captures are in the same diary, one line each.
    await cap("weight 115");
    assert.equal((String(t.hub.store.get(diary.id)!.fields.body).match(/^- /gm) ?? []).length, 2);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("capture: a capture the assistant cannot file goes back to Unsorted Info after three tries, still in the diary", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride({ name: "ollama", model: "down", chat: async () => { throw new Error("model down"); }, stream: async () => { throw new Error("model down"); }, streamTools: async () => { throw new Error("model down"); } } as unknown as Backend);
  try {
    const a = (await (await t.api("/capture", { method: "POST", json: { text: "random thought about bikes", source: "api", auto: true } })).json()) as CaptureResponse;
    await queueFiling(t.hub, "none");
    assert.equal(t.hub.store.get(a.capture.id)!.fields.filing, "failed");
    assert.equal(t.hub.store.get(a.capture.id)!.fields.processed, true, "still out of Unsorted while retries remain");
    await fileCapture(t.hub, a.capture.id);
    await fileCapture(t.hub, a.capture.id);
    const last = t.hub.store.get(a.capture.id)!;
    assert.equal(last.fields.processed, false);
    assert.equal(last.fields.filing_attempts, 3);
    assert.match(String(t.hub.store.get(String(last.fields.diary_id))!.fields.body), /random thought about bikes/);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("work: prefix creates a work-space task and leaves no work text in the personal capture", async () => {
  const { makeHub } = await import("./helpers.ts");
  const t = makeHub();
  try {
    const res = await (await t.api("/capture", { method: "POST", json: { text: "work: call the Dell rep about the N3048P RMA", source: "web", auto: true } })).json() as any;
    assert.equal(res.suggested_kind, "task");
    const task = res.created[0];
    assert.equal(task.space, "work");
    assert.equal(task.fields.title, "call the Dell rep about the N3048P RMA");
    assert.equal(res.capture.space, "personal");
    assert.ok(!/Dell/.test(res.capture.fields.text), "personal capture must not keep work text");
    const personal = await (await t.api("/entities?kind=task&space=personal")).json() as any[];
    assert.equal(personal.length, 0);
  } finally { t.cleanup(); }
});

test("capture: records said in plain words become logs, and weight keeps its memory current", async () => {
  const t = makeHub();
  try {
    const cap = async (text: string) => {
      const res = await t.api("/capture", { method: "POST", json: { text, source: "api", auto: true } });
      const r = (await res.json()) as CaptureResponse;
      await queueFiling(t.hub, "none");
      const capture = t.hub.store.get(r.capture.id)!;
      return { ...r, capture, created: ((capture.fields.converted_to as string[]) ?? []).map((id) => t.hub.store.get(id)!) } as CaptureResponse;
    };
    const a = await cap("Today I weigh 116.4");
    assert.equal(a.suggested_kind, "log");
    assert.deepEqual([a.created![0].fields.type, a.created![0].fields.value, a.created![0].fields.unit], ["weight", 116.4, "lb"]);
    for (const [text, type, value] of [["slept 7 and a half hours", "sleep", 450], ["8k steps", "steps", 8000], ["Blood pressure 130 over 85", "bp", "130/85"], ["took my claritin", "med", "claritin"]] as const) {
      const r = await cap(text);
      assert.equal(r.created?.[0]?.fields.type, type, text);
      assert.equal(r.created?.[0]?.fields.value, value, text);
    }
    // Sentences that only mention a number stay what they were.
    assert.notEqual((await cap("I weigh more than I want to")).suggested_kind, "log");
    assert.notEqual((await cap("take out the trash")).suggested_kind, "log");

    const fact = () => t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "weight:current");
    assert.match(String(fact()?.fields.value), /^Weight 116\.4 lb on \d{4}-\d\d-\d\d$/);
    assert.equal(fact()?.fields.category, "health");
    const later = await cap("weighed in at 115 lb");
    assert.match(String(fact()?.fields.value), /^Weight 115 lb on .*before that 116\.4 lb/);
    // Deleting a wrong entry puts the one before it back.
    await t.api(`/entities/${later.created![0].id}`, { method: "DELETE" });
    assert.match(String(fact()?.fields.value), /^Weight 116\.4 lb on \d{4}-\d\d-\d\d$/);
    assert.ok(t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "bp:latest"));
  } finally { t.cleanup(); }
});

test("capture: with the assistant down, a clear record is still filed by the rule, and says so", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride({ name: "ollama", model: "down", chat: async () => { throw new Error("model down"); }, stream: async () => { throw new Error("model down"); }, streamTools: async () => { throw new Error("model down"); } } as unknown as Backend);
  try {
    const a = (await (await t.api("/capture", { method: "POST", json: { text: "weight 115", source: "watch", auto: true } })).json()) as CaptureResponse;
    await queueFiling(t.hub, "none");
    const c = t.hub.store.get(a.capture.id)!;
    assert.equal(c.fields.filing, "done");
    assert.match(String(c.fields.filed), /^Logs: weight 115 lb \(the assistant was unavailable\)$/);
    assert.equal(t.hub.store.list({ kind: "log", where: { type: "weight" } }).length, 1);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("filer: sees the personal events around the capture's day, so a planned outing is changed instead of doubled", () => {
  const t = makeHub();
  try {
    const at = new Date(2026, 10, 1, 0, 18); // 12:18 AM Nov 1 is still Oct 31
    const planned = t.hub.store.create("event", { title: "Apple picking and movie night with Devon", start: new Date(2026, 9, 31, 11, 30).toISOString(), end: new Date(2026, 9, 31, 23, 29).toISOString() });
    t.hub.store.create("event", { title: "Halloween", start: "2026-10-31T00:00:00-04:00", end: "2026-11-01T00:00:00-04:00", all_day: true });
    t.hub.store.create("event", { title: "Far off", start: new Date(2026, 11, 20, 9).toISOString(), end: new Date(2026, 11, 20, 10).toISOString() });
    t.hub.store.create("event", { title: "Standup", start: new Date(2026, 9, 31, 9).toISOString(), end: new Date(2026, 9, 31, 10).toISOString() }, "work");
    const near = nearbyEvents(t.hub.store, at);
    assert.deepEqual(near, ['"Halloween" (id ' + t.hub.store.list({ kind: "event" }).find((e) => e.fields.title === "Halloween")!.id + ", 2026-10-31 all day)", `"Apple picking and movie night with Devon" (id ${planned.id}, 2026-10-31 11:30 AM)`]);
    const prompt = filingPrompt("Went apple picking with Jen and Devon", at, undefined, near);
    assert.match(prompt, /Already on the calendar around then: .*Apple picking and movie night with Devon.*change only that event's title with update_item/);
    assert.doesNotMatch(filingPrompt("x", at), /Already on the calendar/);
  } finally { t.cleanup(); }
});

test("capture: the filer is shown open tasks that share words with the note, so it adds no twin", async () => {
  const { makeHub } = await import("./helpers.js");
  const { similarTasks } = await import("../src/capture-filer.js");
  const t = makeHub();
  try {
    const hdmi = t.hub.store.create("task", { title: "Pick up HDMI cable at Micro Center", status: "next", order: 1 });
    t.hub.store.create("task", { title: "Call the vet", status: "next", order: 2 });
    t.hub.store.create("task", { title: "HDMI splitter", status: "done", order: 3 });
    const found = similarTasks(t.hub.store, "still need to grab that HDMI cable at Micro Center");
    assert.equal(found.length, 1);
    assert.match(found[0], new RegExp(hdmi.id));
    assert.deepEqual(similarTasks(t.hub.store, "Jen loves dark chocolate"), []);
    assert.match(filingPrompt("grab the HDMI cable", new Date(), "", [], found), /Open tasks like it: "Pick up HDMI cable at Micro Center"/);
  } finally { t.cleanup(); }
});

test("a capture sent again with its own id (its reply was lost) is the one the hub already has, sorted once", async () => {
  const t = makeHub();
  try {
    const id = "3f2a9c1e-0000-4000-8000-000000000001";
    const first = await t.api("/capture", { method: "POST", json: { text: "Buy dog food", source: "watch", auto: true, id } });
    assert.equal(first.status, 201);
    assert.equal(((await first.json()) as { capture: { id: string } }).capture.id, id);
    const again = await t.api("/capture", { method: "POST", json: { text: "Buy dog food", source: "watch", auto: true, id } });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { capture: { id: string } }).capture.id, id);
    assert.equal(t.hub.store.list({ kind: "capture" }).filter((c) => c.fields.text === "Buy dog food").length, 1);
    const notes = t.hub.store.list({ kind: "note" }).filter((n) => String(n.fields.body ?? "").includes("Buy dog food"));
    assert.ok(notes.length <= 1, "one diary line");
    // An id that belongs to something else is refused.
    const note = t.hub.store.create("note", { title: "x", body: "", path: "Inbox/x.md" });
    assert.equal((await t.api("/capture", { method: "POST", json: { text: "y", source: "watch", id: note.id } })).status, 409);
  } finally { t.cleanup(); }
});
