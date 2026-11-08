import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { scripted } = await import(`${R}/test/ai-helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { sortCapture, queueFiling, fileCapture, filingPrompt, nearbyEvents } = await import(`${R}/src/capture-filer.ts`);
const { parseWhen } = await import(`${R}/src/when.ts`);
const { captureDay } = await import(`${R}/src/diary.ts`);

const down = { name: "ollama", model: "down", chat: async () => { throw new Error("model down"); }, stream: async () => { throw new Error("model down"); }, streamTools: async () => { throw new Error("model down"); } } as any;
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A capture a device saved with Save while the hub was out of reach, pushed later (sync keeps the earlier ts as created_at). */
function offlineCapture(t: any, text: string, savedAt: Date) {
  const id = randomUUID();
  t.hub.store.apply({ id, kind: "capture", space: "personal", ts: savedAt.toISOString(), create: true, fields: { text, source: "iphone", processed: false, sort: true } });
  return t.hub.store.get(id)!;
}

test("P1 offline weight said last night, filed by rule today: log lands on the filing day", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride(down);
  try {
    const now = new Date();
    const saved = new Date(now); saved.setDate(saved.getDate() - 1); saved.setHours(21, 50, 0, 0);
    const c = offlineCapture(t, "weight 116.4", saved);
    sortCapture(t.hub, c);
    await queueFiling(t.hub, "none");
    const cap = t.hub.store.get(c.id)!;
    const diary = t.hub.store.get(String(cap.fields.diary_id))!;
    const log = t.hub.store.get((cap.fields.converted_to as string[])[0])!;
    assert.equal(localDay(new Date(String(log.fields.at))), localDay(saved), "log should be on the day it was said");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P1b the hint shown to the model carries the filing time as the record's at", async () => {
  const t = makeHub();
  const b = scripted([() => ({ text: "Diary only" })]);
  setBackendOverride(b);
  try {
    const now = new Date();
    const saved = new Date(now.getTime() - 26 * 3600_000);
    const c = offlineCapture(t, "slept 7 hours", saved);
    sortCapture(t.hub, c);
    await queueFiling(t.hub, "none");
    const prompt = String(b.seen[0].at(-1)!.content);
    const hint = /A simple phrase rule read it as: (.*?)\. Use that/.exec(prompt)?.[1];
    assert.ok(!hint || !hint.includes(now.toISOString().slice(0, 13)), "hint should not stamp the filing hour");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P2 offline 'remind me ... tomorrow at 9am' saved 23:50, filed 00:10: reminder two days out", () => {
  // completeFields(reminder) calls parseWhen(title) with the real clock; replay that with the filing time.
  const saved = new Date(2026, 10, 5, 23, 50);
  const filedAt = new Date(2026, 10, 6, 0, 10);
  const asFiled = parseWhen("call mom tomorrow at 9am", filedAt);
  const asSaid = parseWhen("call mom tomorrow at 9am", saved);
  assert.equal(asFiled.at, asSaid.at);
});

test("P2b live check: offline reminder capture filed by rule uses the filing clock, not created_at", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride(down);
  try {
    const now = new Date();
    const saved = new Date(now.getTime() - 3 * 3600_000);
    const c = offlineCapture(t, "remind me to call mom in 20 minutes", saved);
    sortCapture(t.hub, c);
    await queueFiling(t.hub, "none");
    const cap = t.hub.store.get(c.id)!;
    const task = t.hub.store.get((cap.fields.converted_to as string[])[0])!;
    const mins = (Date.parse(String(task.fields.remind_at)) - Date.parse(c.created_at)) / 60000;
    assert.ok(Math.abs(mins - 20) < 2, "should be 20 minutes after it was said");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P3 just after midnight: rule fallback 'tomorrow' vs the filing prompt's 'tomorrow' (4 AM day)", () => {
  const at = new Date(2026, 10, 6, 0, 30); // Fri Nov 6 00:30 local; diary day is Thu Nov 5
  const w = parseWhen("call mom tomorrow at 9am", at);
  const prompt = filingPrompt("remind me to call mom tomorrow at 9am", at);
  const said = /tomorrow (\w+ \d{4}-\d\d-\d\d)/.exec(prompt)?.[1];
  assert.equal(localDay(new Date(w.at!)), said!.split(" ")[1]);
});

test("P4 bare hour 'tomorrow at 7' becomes 9 AM and the title keeps 'at 7'", () => {
  const at = new Date(2026, 10, 5, 14, 0);
  const w = parseWhen("call mom tomorrow at 7", at);
  assert.notEqual(new Date(w.at!).getHours(), 9);
});

test("P4b weekday words inside ordinary text", () => {
  const at = new Date(2026, 10, 5, 14, 0); // Thursday
  for (const s of ["remind me the cat sat on the charger", "remind me to buy sun block", "remind me to wed the photos"]) {
    const w = parseWhen(s.replace(/^remind me( to)?\s*/, ""), at);
  }
});
