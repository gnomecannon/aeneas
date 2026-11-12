import { test } from "node:test";
import assert from "node:assert/strict";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
// A file: address, which import() takes on every system (a plain path with a drive letter is refused on Windows).
const R = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { queueFiling, startFilingJob } = await import(`${R}/src/capture-filer.ts`);

test("P18 a slow filing still running at 10 minutes is queued again on every tick, and the copies run past 3 tries", async () => {
  const t = makeHub({ aiFake: false });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowThenFail = async () => { calls++; if (calls === 1) await gate; throw new Error("timeout after 120000 ms"); };
  setBackendOverride({ name: "ollama", model: "slow", chat: slowThenFail, stream: slowThenFail, streamTools: slowThenFail } as any);
  try {
    const r = (await (await t.api("/capture", { method: "POST", json: { text: "thinking about a bike trip up the coast", source: "iphone", auto: true } })).json()) as any;
    await new Promise((res) => setTimeout(res, 30));
    // Run 1 is waiting on the model. Ten minutes pass (the capture is not written while the model works).
    t.hub.db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), r.capture.id);
    const stop = startFilingJob(t.hub, 20);
    await new Promise((res) => setTimeout(res, 130));
    stop();
    release();
    await queueFiling(t.hub, "none");
    const c = t.hub.store.get(r.capture.id)!;
    assert.ok(Number(c.fields.filing_attempts) <= 3, "never more than three tries");
  } finally { setBackendOverride(null); t.cleanup(); }
});
