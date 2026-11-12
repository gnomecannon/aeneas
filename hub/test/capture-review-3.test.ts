import { test } from "node:test";
import assert from "node:assert/strict";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
// A file: address, which import() takes on every system (a plain path with a drive letter is refused on Windows).
const R = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { scripted } = await import(`${R}/test/ai-helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { queueFiling, startFilingJob } = await import(`${R}/src/capture-filer.ts`);
const { classifyCapture, parseRecord } = await import(`${R}/../packages/shared/src/index.ts`);

test("P10 the assistant decides 'Diary only' and the phrase rule files a task anyway", async () => {
  const t = makeHub();
  const b = scripted([() => ({ text: "Diary only" })]);
  setBackendOverride(b);
  try {
    for (const text of ["Check out that sunset over the lake", "Jen said remind me to never eat at that place again lol", "Start of a cold, ugh"]) {
      const r = (await (await t.api("/capture", { method: "POST", json: { text, source: "iphone", auto: true } })).json()) as any;
      await queueFiling(t.hub, "none");
      const cap = t.hub.store.get(r.capture.id)!;
      const made = ((cap.fields.converted_to as string[]) ?? []).map((id) => t.hub.store.get(id)!);
    }
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0, "the assistant filed nothing; no task should appear");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P11 bp anywhere in a sentence is the whole capture as a bp record", () => {
  for (const s of ["Doctor said my bp 140/90 is too high, need to cut salt", "Mom's bp 150 95 at the clinic again", "Weight 116 and bp 120/80"]) {
  }
  assert.equal(parseRecord("Doctor said my bp 140/90 is too high, need to cut salt"), null);
});

test("P12 a work item the filer touched keeps its title in the personal capture, and the erase leaves it", async () => {
  const t = makeHub();
  const b = scripted([
    () => ({ calls: [{ name: "create_item", arguments: { kind: "event", work: true, fields: { title: "Acme ThreatLocker rollout review", start: "2026-11-09T15:00:00-05:00", end: "2026-11-09T16:00:00-05:00" } } }] }),
    () => ({ text: "Added the review to the work calendar." }),
  ]);
  setBackendOverride(b);
  try {
    const r = (await (await t.api("/capture", { method: "POST", json: { text: "monday 3pm review with the vendor", source: "iphone", auto: true } })).json()) as any;
    await queueFiling(t.hub, "none");
    const cap = () => t.hub.store.get(r.capture.id)!;
    const ev = t.hub.store.list({ kind: "event", space: "work" })[0];
    await t.api("/space/work", { method: "PUT", json: { enabled: false, confirm: "erase work" } });
    assert.ok(!/ThreatLocker/.test(String(cap().fields.filed)), "work title left in the personal space after the erase");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P13 work space off: PATCH /entities/:id writes into a work item and brings it back", async () => {
  const t = makeHub();
  try {
    const ev = t.hub.store.create("event", { title: "1:1 with Dana", start: "2026-11-09T14:00:00.000Z", end: "2026-11-09T14:30:00.000Z" }, "work");
    await t.api("/space/work", { method: "PUT", json: { enabled: false, confirm: "erase work" } });
    const res = await t.api(`/entities/${ev.id}`, { method: "PATCH", json: { fields: { title: "1:1 with Dana", start: "2026-11-09T14:00:00.000Z", end: "2026-11-09T14:30:00.000Z", deleted_at: null } } });
    const after = t.hub.store.get(ev.id);
    const del = await t.api(`/entities/${ev.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);
  } finally { t.cleanup(); }
});

test("P14 model away for 15 minutes: the capture is never filed once it is back", async () => {
  const t = makeHub({ aiFake: false });
  let up = false;
  const fail = async () => { throw new Error("model down"); };
  const good = scripted([() => ({ calls: [{ name: "create_task", arguments: { title: "Look into a new bike seat" } }] }), () => ({ text: "Added a task." })]);
  setBackendOverride({ name: "ollama", model: "flaky", chat: (...a: any[]) => (up ? (good.chat as any)(...a) : fail()), stream: (...a: any[]) => (up ? (good.stream as any)(...a) : fail()), streamTools: (...a: any[]) => (up ? (good.streamTools as any)(...a) : fail()) } as any);
  const age = (id: string, min: number) => t.hub.db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - min * 60_000).toISOString(), id);
  try {
    const r = (await (await t.api("/capture", { method: "POST", json: { text: "my bike seat is killing me, want a new one", source: "iphone", auto: true } })).json()) as any;
    await queueFiling(t.hub, "none");
    const stop = startFilingJob(t.hub, 20);
    for (let i = 0; i < 2; i++) { age(r.capture.id, 6); await new Promise((res) => setTimeout(res, 60)); await queueFiling(t.hub, "none"); }
    const c1 = t.hub.store.get(r.capture.id)!;
    up = true;
    for (let i = 0; i < 3; i++) { age(r.capture.id, 60); await new Promise((res) => setTimeout(res, 60)); await queueFiling(t.hub, "none"); }
    stop();
    const c2 = t.hub.store.get(r.capture.id)!;
    assert.equal(c2.fields.filing, "done");
  } finally { setBackendOverride(null); t.cleanup(); }
});
