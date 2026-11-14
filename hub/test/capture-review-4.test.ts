import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
// A file: address, which import() takes on every system (a plain path with a drive letter is refused on Windows).
const R = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { scripted } = await import(`${R}/test/ai-helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { queueFiling } = await import(`${R}/src/capture-filer.ts`);
const { linkNote, noteLinking } = await import(`${R}/src/note-linker.ts`);
const { calendarFeed } = await import(`${R}/src/calendar.ts`);

test("P15 reply lost, device keeps its own copy with the same id (sort: true) and pushes it: a filed capture is back in Unsorted Info", async () => {
  const t = makeHub();
  const b = scripted([() => ({ calls: [{ name: "create_task", arguments: { title: "Buy a new bike seat" } }] }), () => ({ text: "Added a task." })]);
  setBackendOverride(b);
  try {
    const id = randomUUID();
    await t.api("/capture", { method: "POST", json: { text: "buy a new bike seat", source: "watch", auto: true, id } });
    await queueFiling(t.hub, "none");
    const filed = t.hub.store.get(id)!;
    // Actions.swift capture(): POST failed with a timeout, the entity() check failed too, so it saves locally and the outbox pushes it.
    const ts = new Date(Date.now() + 5).toISOString();
    const push = await (await t.api("/sync/push", { method: "POST", json: { device_id: "watch-1", patches: [{ id, kind: "capture", ts, create: true, fields: { text: "buy a new bike seat", source: "watch", processed: false, sort: true, suggested_kind: "task" } }] } })).json();
    const after = t.hub.store.get(id)!;
    assert.equal(after.fields.processed, true, "a filed capture should not return to Unsorted Info");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P16 note linker with the model away: each note burns its 3 tries and is never read when the model is back", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride({ name: "ollama", model: "down", chat: async () => { throw new Error("model down"); }, stream: async () => { throw new Error("model down"); } } as any);
  try {
    const n = t.hub.store.create("note", { title: "Lighthouse story", body: "A lighthouse keeper hears knocking from inside the lamp.", path: "Writing/Lighthouse story.md" });
    const before = noteLinking(t.hub).waiting;
    const states = [];
    for (let i = 0; i < 3; i++) states.push((await linkNote(t.hub, n.id)).state);
    assert.equal(noteLinking(t.hub).waiting, before, "an absent model is no reason to give up on a note");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P17 ICS: a title with a carriage return leaves a bare CR in the feed", () => {
  const t = makeHub();
  try {
    t.hub.store.create("event", { title: "Pick up\r\nJordan", start: "2026-11-07T19:00:00-05:00", end: "2026-11-07T20:00:00-05:00" });
    const ics = calendarFeed(t.hub, new Date(2026, 10, 1, 12));
    const line = ics.split("\r\n").find((l: string) => l.startsWith("SUMMARY:Pick"))!;
    assert.ok(!line.includes("\r"));
  } finally { t.cleanup(); }
});

test("P15b a late copy from a device cannot put back a photo the hub removed from a work capture", async () => {
  const t = makeHub();
  try {
    const cap = t.hub.store.create("capture", { text: "work: whiteboard from the planning meeting", source: "iphone", processed: false, attachments: [{ mime: "image/png", bytes_b64: "iVBORw0KGgo=", name: "board.png" }] });
    // What the filer does with a work: capture: the photo leaves the personal space (capture-filer.ts).
    t.hub.store.patch(cap.id, { text: "work: moved to the work space", sort: false, attachments: null });
    const ts = new Date(Date.now() + 5).toISOString();
    const push = await (await t.api("/sync/push", { method: "POST", json: { device_id: "iphone-1", patches: [{ id: cap.id, kind: "capture", ts, create: true, fields: { text: "work: whiteboard from the planning meeting", source: "iphone", processed: false, sort: true, attachments: [{ mime: "image/png", bytes_b64: "iVBORw0KGgo=", name: "board.png" }] } }] } })).json() as { applied: unknown[] };
    assert.equal(push.applied.length, 1);
    assert.equal(t.hub.store.get(cap.id)!.fields.attachments, undefined, "the removed photo must stay removed");
  } finally { t.cleanup(); }
});
