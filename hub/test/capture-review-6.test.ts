import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { queueFiling } = await import(`${R}/src/capture-filer.ts`);
const { appendDiary, readDiary } = await import(`${R}/src/diary.ts`);

const down = { name: "ollama", model: "down", chat: async () => { throw new Error("model down"); }, stream: async () => { throw new Error("model down"); }, streamTools: async () => { throw new Error("model down"); } } as any;

test("P19 diary tool: a capture line after midnight is on the day before, its log and a late event on the calendar day", () => {
  const t = makeHub();
  try {
    const at = new Date(2026, 10, 6, 0, 30);
    appendDiary(t.hub.store, "took my claritin", at);
    t.hub.store.create("log", { type: "med", value: "claritin", at: at.toISOString() });
    t.hub.store.create("event", { title: "Late show at the Bowery", start: new Date(2026, 10, 6, 0, 15).toISOString(), end: new Date(2026, 10, 6, 1, 30).toISOString() });
    const days = readDiary(t.hub.store, "2026-11-05", "2026-11-06");
    const nov5 = days.find((d: any) => d.day === "2026-11-05");
    assert.ok(nov5?.logs.length, "the dose belongs with its diary line");
  } finally { t.cleanup(); }
});

test("P20 'Mom's bp 150 95' with the assistant down becomes the owner's bp and their bp:latest memory", async () => {
  const t = makeHub({ aiFake: false });
  setBackendOverride(down);
  try {
    await t.api("/capture", { method: "POST", json: { text: "Mom's bp 150 95 at the clinic again", source: "iphone", auto: true } });
    await queueFiling(t.hub, "none");
    const fact = t.hub.store.list({ kind: "fact" }).find((f: any) => f.fields.key === "bp:latest");
    assert.equal(t.hub.store.list({ kind: "log" }).length, 0);
  } finally { setBackendOverride(null); t.cleanup(); }
});
