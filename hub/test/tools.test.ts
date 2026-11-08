import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { availableTools, renderResult, runTool, type ToolContext } from "../src/ai/tools.js";
import type { ChatOutput } from "../src/ai/index.js";

function ctxFor(t: ReturnType<typeof makeHub>, sessionId = "s-test", lastUser = ""): ToolContext {
  return { sessionId, lastUser, topic: "test", store: t.hub.store, cfg: t.hub.cfg, hosts: t.hub.ai.hosts };
}

/** A scripted model: each round returns the next step; it records what it was sent. */
function scripted(steps: ((msgs: AiMessage[]) => { text?: string; calls?: { name: string; arguments: Record<string, unknown> }[] })[]): Backend & { seen: AiMessage[][]; toolsOffered: number } {
  let i = 0;
  const b = {
    name: "ollama" as const, model: "scripted", seen: [] as AiMessage[][], toolsOffered: 0,
    chat: async () => ({ text: "plain", usage: {} }),
    stream: async (_m: AiMessage[], on: (t: string) => void) => { on("plain"); return { text: "plain", usage: {} }; },
    streamTools: async (msgs: AiMessage[], tools: unknown[], on: (t: string) => void) => {
      b.seen.push(msgs.map((m) => ({ ...m }))); b.toolsOffered = tools.length;
      const s = steps[Math.min(i++, steps.length - 1)](msgs);
      if (s.text) on(s.text);
      return { text: s.text ?? "", usage: { prompt_tokens: 10, completion_tokens: 5 }, tool_calls: (s.calls ?? []).map((c) => ({ function: c })) };
    },
  };
  return b;
}

test("tools: the assistant creates a task, reads Today, and answers; the stream reports each tool", async () => {
  const t = makeHub();
  const b = scripted([
    () => ({ calls: [{ name: "create_task", arguments: { title: "Replace the UPS battery" } }] }),
    () => ({ calls: [{ name: "get_today", arguments: {} }] }),
    (msgs) => ({ text: `Added it. ${msgs.filter((m) => m.role === "tool").length} tool results seen.` }),
  ]);
  setBackendOverride(b);
  try {
    const body = { session_id: "tools-1", task_type: "general", messages: [{ role: "user", content: "add a task to replace the UPS battery" }] };
    const raw = await (await t.api("/ai/chat/stream", { method: "POST", json: body })).text();
    assert.match(raw, /event: tool\ndata: \{"type":"tool","tool":"create_task","ok":true,"writes":true\}/);
    assert.match(raw, /"tool":"get_today","ok":true,"writes":false/);
    const done = JSON.parse(/event: done\ndata: (.+)/.exec(raw)![1]) as ChatOutput;
    assert.equal(done.reply, "Added it. 2 tool results seen.");
    assert.deepEqual(done.actions?.map(({ items: _items, ...a }) => a), [{ tool: "create_task", ok: true, writes: true }, { tool: "get_today", ok: true, writes: false }]);
    assert.equal(done.actions?.[0].items?.[0].title, "Replace the UPS battery", "the task it made is named for the next turn");
    const tasks = t.hub.store.list({ kind: "task" });
    assert.deepEqual(tasks.map((x) => [x.fields.title, x.fields.status, x.space]), [["Replace the UPS battery", "next", "personal"]]);
    // The model was offered every available tool (web search is off without SearXNG) and given the clock and the rules.
    assert.equal(b.toolsOffered, availableTools(t.hub.cfg).length);
    assert.ok(!availableTools(t.hub.cfg).some((x) => x.name === "web_search"));
    // The clock rides on the newest user turn; the system prompt has none, so it is reused from cache turn to turn.
    const newestUser = [...b.seen[0]].reverse().find((m) => m.role === "user")!;
    assert.match(newestUser.content, /^\[Context from Aeneas, not typed by the owner\]\nToday is \w+day \d{4}-\d\d-\d\d\. Current local time: \d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d/);
    assert.ok(newestUser.content.endsWith("add a task to replace the UPS battery"));
    assert.ok(!/Current local time/.test(b.seen[0][0].content));
    // Times in results are local with an offset, never UTC "Z", and Today carries its weekday.
    const todayMsg = b.seen[2].find((m) => m.role === "tool" && m.tool_name === "get_today")!;
    assert.match(todayMsg.content, /"weekday":"\w+day"/);
    assert.ok(!/T\d\d:\d\d(:\d\d(\.\d+)?)?Z"/.test(todayMsg.content), todayMsg.content.slice(0, 300));
    // Tool results are compact: no sync bookkeeping reaches the model.
    const toolMsg = b.seen[1].find((m) => m.role === "tool")!;
    assert.equal(toolMsg.tool_name, "create_task");
    assert.ok(!toolMsg.content.includes("field_ts"));
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("tools: bad calls come back to the model as errors, never as exceptions", async () => {
  const t = makeHub();
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await t.app.request(path, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const unknown = await runTool(api, { name: "launch_rocket", arguments: {} }, ctxFor(t));
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /no tool named launch_rocket/);
    const missing = await runTool(api, { name: "get_item", arguments: { id: "nope" } }, ctxFor(t));
    assert.equal(missing.ok, false);
    assert.match(missing.text, /404/);
    const badKind = await runTool(api, { name: "list_items", arguments: { kind: "secrets" } }, ctxFor(t));
    assert.match(badKind.text, /unknown kind/);
    const stringArgs = await runTool(api, { name: "create_reminder", arguments: JSON.stringify({ title: "call vet", at: "2026-11-01T10:00:00-04:00" }) as unknown as Record<string, unknown> }, ctxFor(t));
    assert.equal(stringArgs.ok, true, stringArgs.text);
    const work = await runTool(api, { name: "create_task", arguments: { title: "Send the report", work: true } }, ctxFor(t));
    assert.equal(work.ok, true);
    assert.equal(t.hub.store.list({ kind: "task" }).find((x) => x.fields.title === "Send the report")!.space, "work");
    assert.ok(renderResult({ big: "x".repeat(20000) }).length < 6200, "results are capped");
  } finally { t.cleanup(); }
});

test("tools: a model that keeps calling tools is stopped and made to answer", async () => {
  const t = makeHub();
  const b = scripted([() => ({ calls: [{ name: "get_today", arguments: {} }] })]);
  setBackendOverride(b);
  try {
    const res = await t.api("/ai/chat", { method: "POST", json: { session_id: "tools-loop", task_type: "general", messages: [{ role: "user", content: "what's today" }] } });
    const out = await res.json() as ChatOutput;
    assert.equal(out.reply, "plain");
    assert.equal(out.actions?.length, 8);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("tools: drafts and classification never get tools", async () => {
  const t = makeHub();
  const b = scripted([() => ({ calls: [{ name: "create_task", arguments: { title: "should not happen" } }] })]);
  setBackendOverride(b);
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "d1", task_type: "draft", messages: [{ role: "user", content: "draft a note" }] } });
    assert.equal(b.seen.length, 0);
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("fallback: when the main model server is down, the second one answers within seconds", async () => {
  const http = await import("node:http");
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/api/version") { res.end(JSON.stringify({ version: "test" })); return; }
    if (req.url === "/api/ps") { res.end(JSON.stringify({ models: [] })); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/x-ndjson");
      res.end(JSON.stringify({ model: j.model, message: { role: "assistant", content: `hi from ${j.model}` }, done: true, eval_count: 3 }) + "\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const t = makeHub({ aiFake: false, ollamaUrl: "http://127.0.0.1:9", ollamaModel: "main-model", ollamaFallbackUrl: `http://127.0.0.1:${port}`, ollamaFallbackModel: "spare-model" });
  try {
    const t0 = Date.now();
    const res = await t.api("/ai/chat", { method: "POST", json: { session_id: "fb", task_type: "general", messages: [{ role: "user", content: "hello" }] } });
    const out = await res.json() as ChatOutput;
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.reply, "hi from spare-model");
    assert.ok(Date.now() - t0 < 5000, "no long wait on the dead server");
    assert.ok(seen.some((s) => s === "POST /api/chat"));
    assert.ok(seen.includes("GET /api/ps"), "the turn asked where the model is loaded");
    const health = await (await t.api("/health")).json() as { ai: { tools: boolean; cloud: boolean } };
    assert.equal(health.ai.cloud, false);
    assert.equal(health.ai.tools, true);
  } finally { t.cleanup(); srv.close(); }
});

test("tools: model wording for pet and health types is mapped to the allowed values", async () => {
  const t = makeHub();
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await t.app.request(path, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    assert.equal((await runTool(api, { name: "log_pet", arguments: { type: "medication", note: "heartworm" } }, ctxFor(t))).ok, true);
    assert.equal((await runTool(api, { name: "log_health", arguments: { type: "Blood Pressure", value: "120/80" } }, ctxFor(t))).ok, true);
    assert.equal(t.hub.store.list({ kind: "pet_event" })[0].fields.type, "med");
    assert.equal(t.hub.store.list({ kind: "log" })[0].fields.type, "bp");
  } finally { t.cleanup(); }
});
