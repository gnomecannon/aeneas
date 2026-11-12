import { test } from "node:test";
import assert from "node:assert/strict";
// Each case was a finding of the 2026-11-05 review of the assistant (tools, chat loop, cloud residency); each fails on the code before the fix.
// A file: address, which import() takes on every system (a plain path with a drive letter is refused on Windows).
const R = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { runTool, TOOLS } = await import(`${R}/src/ai/tools.ts`);

type Msg = { role: string; content: string; tool_calls?: any[]; images?: string[] };

function ctx(t: any, extra: Record<string, unknown> = {}) {
  return { sessionId: "probe", lastUser: "", topic: "probe", store: t.hub.store, cfg: t.hub.cfg, hosts: null, cloud: true, ...extra };
}
const api = (t: any) => (t.hub.ai as any).api;

/** A cloud model with tools (an OpenAI-compatible cloud server): scripted rounds, records every request. */
function cloudScripted(steps: ((m: Msg[]) => { text?: string; calls?: { name: string; arguments: any }[] })[]) {
  let i = 0;
  const b: any = {
    name: "openai", model: "cloud-scripted", cloud: true, seen: [] as Msg[][], chats: [] as Msg[][],
    chat: async (m: Msg[]) => { b.chats.push(m.map((x) => ({ ...x }))); return { text: "summary text", usage: {} }; },
    stream: async (m: Msg[], on: (t: string) => void) => { b.seen.push(m.map((x) => ({ ...x }))); on("ok"); return { text: "ok", usage: {} }; },
    streamTools: async (m: Msg[], _tools: unknown[], on: (t: string) => void) => {
      b.seen.push(m.map((x) => ({ ...x })));
      const s = steps[Math.min(i++, steps.length - 1)](m);
      if (s.text) on(s.text);
      return { text: s.text ?? "", usage: {}, tool_calls: (s.calls ?? []).map((c) => ({ function: c })) };
    },
  };
  return b;
}

test("R1 get_today on a cloud model: work meeting, work task and its block reach the model", async () => {
  const t = makeHub();
  try {
    const now = Date.now();
    t.hub.store.create("event", { title: "WORK-SECRET Q4 layoffs review", start: new Date(now + 20 * 60_000).toISOString(), end: new Date(now + 50 * 60_000).toISOString(), all_day: false, source: "eventkit" }, "work");
    t.hub.store.create("task", { title: "WORK-TASK prep board deck", status: "doing", order: 1 }, "work");
    t.hub.store.create("task", { title: "WORK-BLOCK budget sheet", status: "scheduled", order: 2, block: { start: new Date(now + 60 * 60_000).toISOString(), end: new Date(now + 120 * 60_000).toISOString() } }, "work");
    const out = await runTool(api(t), { name: "get_today", arguments: {} }, ctx(t) as any, TOOLS);
    const leaked = ["WORK-SECRET", "WORK-TASK", "WORK-BLOCK"].filter((w) => out.text.includes(w));
    assert.deepEqual(leaked, [], "no work title should reach a cloud model");
  } finally { t.cleanup(); }
});

test("R2 diary on a cloud model: work meetings in the day's events reach the model", async () => {
  const t = makeHub();
  try {
    const start = new Date(Date.now() - 3 * 3600_000);
    t.hub.store.create("event", { title: "WORK-SECRET acquisition call", start: start.toISOString(), end: new Date(start.getTime() + 1800_000).toISOString(), all_day: false, source: "eventkit" }, "work");
    const out = await runTool(api(t), { name: "diary", arguments: {} }, ctx(t) as any, TOOLS);
    assert.ok(!out.text.includes("WORK-SECRET"), "work meeting title reached the cloud model through diary");
  } finally { t.cleanup(); }
});

test("R3 list_items by list on a cloud model: a work task in a list of the same name has no work marker", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("task", { title: "milk", status: "next", order: 1, apple: { id: "a1", list: "L1", list_title: "Errands" } }, "personal");
    t.hub.store.create("task", { title: "WORK-TASK courier the contract", status: "next", order: 1, apple: { id: "a2", list: "L2", list_title: "Errands" } }, "work");
    const out = await runTool(api(t), { name: "list_items", arguments: { kind: "task", list: "Errands" } }, ctx(t) as any, TOOLS);
    const local = await runTool(api(t), { name: "list_items", arguments: { kind: "task", list: "Errands" } }, ctx(t, { cloud: false }) as any, TOOLS);
    assert.ok(!out.text.includes("WORK-TASK"), "work task reached the cloud model");
  } finally { t.cleanup(); }
});

test("R4 create_task work=true on a cloud model: the task is written, the tool says it failed", async () => {
  const t = makeHub();
  try {
    const out = await runTool(api(t), { name: "create_task", arguments: { title: "Send the Q4 numbers", work: true } }, ctx(t) as any, TOOLS);
    const made = t.hub.store.list({ kind: "task", space: "work" }).filter((x: any) => x.fields.title === "Send the Q4 numbers");
    const del = t.hub.store.create("event", { title: "standup", start: new Date().toISOString(), end: new Date(Date.now() + 900_000).toISOString(), all_day: false }, "work");
    const d = await runTool(api(t), { name: "delete_item", arguments: { id: del.id } }, ctx(t) as any, TOOLS);
    assert.ok(!(made.length === 1 && !out.ok), "a write that happened is reported as a failure");
  } finally { t.cleanup(); }
});

test("R5 condensing a long chat on a cloud model sends private fact values unredacted", async () => {
  const t = makeHub({ ollamaNumCtx: 4096 });
  const b = cloudScripted([() => ({ text: "fine" })]);
  setBackendOverride(b);
  try {
    t.hub.store.create("fact", { category: "identity", key: "home_address", value: "4417 Elmwood Lane", private: true });
    const filler = "x ".repeat(4000);
    const hist = [
      { role: "user", content: `My address is 4417 Elmwood Lane, can you note the delivery? ${filler}` },
      { role: "assistant", content: `Noted. ${filler}` },
      { role: "user", content: `another long turn ${filler}` },
      { role: "assistant", content: `ok ${filler}` },
    ];
    t.hub.ai.sessions.save("long-1", "general", hist as any);
    const r = await t.api("/ai/chat", { method: "POST", json: { session_id: "long-1", message: "what next?", task_type: "general", allow_cloud: true } });
    const summaryCalls = b.chats.map((m: Msg[]) => m.map((x) => x.content).join("\n"));
    const main = b.seen.map((m: Msg[]) => m.map((x) => x.content).join("\n"));
    assert.ok(!summaryCalls.some((s: string) => s.includes("4417 Elmwood Lane")), "private fact value sent to the cloud in the summary call");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("R6 a chat that made a work task locally, continued on a cloud model: its title rides in the context note", async () => {
  const t = makeHub();
  // Turn 1: local model creates a work task.
  let step = 0;
  const local: any = {
    name: "ollama", model: "local", chat: async () => ({ text: "", usage: {} }), stream: async () => ({ text: "", usage: {} }),
    streamTools: async () => (step++ === 0 ? { text: "", usage: {}, tool_calls: [{ function: { name: "create_task", arguments: { title: "WORK-TASK draft the reorg memo", work: true } } }] } : { text: "Added the work task.", usage: {} }),
  };
  setBackendOverride(local);
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "mix-1", message: "work task: draft the reorg memo", task_type: "general" } });
    const b = cloudScripted([() => ({ text: "Sure." })]);
    setBackendOverride(b);
    await t.api("/ai/chat", { method: "POST", json: { session_id: "mix-1", message: "what's a good pasta recipe?", task_type: "general", allow_cloud: true } });
    const sent = b.seen.flat().map((m: Msg) => m.content).join("\n");
    const note = /Items saved or changed earlier in this chat[^\n]*\n[^\n]*/.exec(sent)?.[0];
    assert.ok(!sent.includes("WORK-TASK"), "work task title sent to the cloud model");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("R7 private facts reach a cloud model through tool results (list_items kind=fact, people)", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("fact", { category: "health", key: "diagnosis", value: "PRIVATE-VALUE bipolar II, lamotrigine 200 mg", private: true });
    const jen = t.hub.store.create("person", { name: "Jen Example" });
    t.hub.store.create("fact", { category: "relationship", key: "jen_health", value: "PRIVATE-JEN pregnant, not telling family yet", private: true, person_id: jen.id, person: "Jen Example" });
    const a = await runTool(api(t), { name: "list_items", arguments: { kind: "fact" } }, ctx(t) as any, TOOLS);
    const p = await runTool(api(t), { name: "people", arguments: { query: "Jen" } }, ctx(t) as any, TOOLS);
    assert.ok(!a.text.includes("PRIVATE-VALUE") && !p.text.includes("PRIVATE-JEN"), "a private fact reached a cloud model");
  } finally { t.cleanup(); }
});

test("R8 host memory in the context note goes to a cloud model unredacted (private literal inside a runbook)", async () => {
  const t = makeHub();
  const b = cloudScripted([() => ({ text: "Try restarting." })]);
  setBackendOverride(b);
  try {
    t.hub.store.create("fact", { category: "host", key: "host:core", value: "Ubuntu box in the closet" });
    t.hub.store.create("fact", { category: "identity", key: "wifi_pass", value: "Tr0ub4dor-closet", private: true });
    t.hub.store.create("runbook", { host: "core", title: "Fix notes: core", body: "## Facts\nWiFi for the closet AP is Tr0ub4dor-closet\n" });
    await t.api("/ai/chat", { method: "POST", json: { session_id: "r8", message: "core is offline and ssh fails", task_type: "auto", allow_cloud: true } });
    const sent = b.seen.flat().map((m: Msg) => m.content).join("\n");
    assert.ok(!sent.includes("Tr0ub4dor-closet"), "a private value went to the cloud in the host memory");
  } finally { setBackendOverride(null); t.cleanup(); }
});
