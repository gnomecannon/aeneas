import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { probe, recommendModel, detectGpus, pullState, readAiSettings, type PullState } from "../src/setup.js";

function fakeProbe(answers: Record<string, unknown>, gpu: string | null) {
  const orig = { ...probe };
  const asked: { url: string; headers: Record<string, string> }[] = [];
  probe.fetch = async (url, init = {}) => {
    asked.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const a = answers[url];
    if (a === undefined) throw new Error("connection refused");
    if (typeof a === "number") return new Response("{}", { status: a });
    return new Response(JSON.stringify(a), { status: 200 });
  };
  probe.run = async (file) => (file === "nvidia-smi" ? gpu : null);
  return { asked, restore: () => Object.assign(probe, orig) };
}

test("setup: the card decides the recommended model", async () => {
  assert.equal(recommendModel(24576).model, "qwen3:30b");
  assert.equal(recommendModel(16384).model, "qwen3:14b");
  assert.equal(recommendModel(12288).model, "qwen3:8b");
  assert.equal(recommendModel(0).model, "qwen3:4b");
  assert.match(recommendModel(0).why, /processor/);
  const f = fakeProbe({}, "NVIDIA GeForce RTX 4080, 16376\n");
  try { assert.deepEqual(await detectGpus(), [{ name: "NVIDIA GeForce RTX 4080", vram_mib: 16376, kind: "nvidia" }]); } finally { f.restore(); }
});

test("setup: finds Ollama and LM Studio, chooses a model without a restart, and keeps keys out of every answer", async () => {
  const t = makeHub();
  const f = fakeProbe({
    "http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen3:8b" }] },
    "http://127.0.0.1:1234/v1/models": { data: [{ id: "local-model" }] },
    "https://api.example.ai/v1/models": 401,
  }, "NVIDIA GeForce RTX 4070, 12282\n");
  try {
    t.hub.cfg.ollamaUrl = "";
    t.hub.ai.rebuildBackends();
    let view = (await (await t.api("/setup")).json()) as { named: boolean; model_ready: boolean };
    assert.deepEqual([view.named, view.model_ready], [false, false]);
    const d = (await (await t.api("/setup/detect")).json()) as { gpus: { name: string }[]; recommended: { model: string }; servers: { kind: string; label: string; url: string; models: string[] }[] };
    assert.equal(d.recommended.model, "qwen3:8b");
    assert.deepEqual(d.servers.map((s) => [s.label, s.url, s.models.join()]), [["Ollama", "http://127.0.0.1:11434", "qwen3:8b"], ["LM Studio", "http://127.0.0.1:1234/v1", "local-model"]]);
    // Choose Ollama: it is used at once.
    assert.equal((await t.api("/setup/ai", { method: "PUT", json: { kind: "ollama", url: "http://127.0.0.1:9", model: "x" } })).status, 422, "nothing answers there");
    const ok = (await (await t.api("/setup/ai", { method: "PUT", json: { kind: "ollama", url: "http://127.0.0.1:11434/", model: "qwen3:14b" } })).json()) as { model_ready: boolean; note: string };
    assert.equal(ok.model_ready, true);
    assert.match(ok.note, /not in Ollama yet/);
    assert.equal(t.hub.cfg.ollamaUrl, "http://127.0.0.1:11434");
    // A cloud server with a wrong key is refused; with the right one it is kept, and never shown.
    assert.equal((await t.api("/setup/ai", { method: "PUT", json: { kind: "openai", url: "https://api.example.ai/v1", model: "big", key: "sk-wrong" } })).status, 422);
    f.restore();
    const g = fakeProbe({ "https://api.example.ai/v1/models": { data: [] } }, null);
    try {
      await t.api("/setup/ai", { method: "PUT", json: { kind: "openai", url: "https://api.example.ai/v1", model: "big", key: "sk-right-key-123" } });
      assert.equal(g.asked.at(-1)!.headers.authorization, "Bearer sk-right-key-123");
    } finally { g.restore(); }
    const text = await (await t.api("/setup")).text();
    assert.ok(!text.includes("sk-right"), "no key in the answer");
    assert.match(text, /"key_set":true/);
    assert.deepEqual([t.hub.cfg.openaiUrl, t.hub.cfg.openaiModel, t.hub.cfg.openaiKey], ["https://api.example.ai/v1", "big", "sk-right-key-123"], "applied to the running hub");
    const saved = path.join(t.hub.cfg.dataDir, "ai.json");
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    // Turned off again, and the setting survives a restart (read back at start).
    await t.api("/setup/ai/openai", { method: "DELETE" });
    assert.equal(t.hub.cfg.openaiUrl, "");
    const { readAiSettings } = await import("../src/setup.js");
    assert.deepEqual([readAiSettings(t.hub.cfg.dataDir, t.hub.secretBox).ollama_model, readAiSettings(t.hub.cfg.dataDir, t.hub.secretBox).openai_url], ["qwen3:14b", ""]);
    assert.equal((await t.api("/setup/ai", { method: "PUT", json: { kind: "anthropic", key: "nope" } })).status, 422);
  } finally { f.restore(); t.cleanup(); }
});

test("setup: with no usable card the processor model is chosen by memory, and every suggestion is open-licensed", async () => {
  assert.equal(recommendModel(0, 2048).model, "qwen3:0.6b");
  assert.equal(recommendModel(0, 8192).model, "qwen3:1.7b");
  assert.equal(recommendModel(0, 11 * 1024).model, "qwen3:1.7b");
  assert.equal(recommendModel(0, 16384).model, "qwen3:4b");
  assert.equal(recommendModel(2048, 8192).model, "qwen3:1.7b", "a 2 GB card counts as none");
  assert.equal(recommendModel(4096, 8192).model, "qwen3:4b", "a 4 GB card is used");
  for (const [v, m] of [[24576, 0], [16384, 0], [8192, 0], [4096, 0], [0, 2048], [0, 8192], [0, 65536], [0, 0]]) {
    const r = recommendModel(v, m);
    assert.equal(r.license, "Apache-2.0", r.model);
    assert.ok(r.size_gb > 0 && r.why && !/[\u2013\u2014]/.test(r.why), r.model);
  }
  // Detect reports the memory and that no card is usable.
  const t = makeHub();
  const f = fakeProbe({}, null);
  probe.memoryMib = () => 8192;
  try {
    const d = (await (await t.api("/setup/detect")).json()) as { memory_mib: number; cpu_only: boolean; recommended: { model: string; size_gb: number; license: string } };
    assert.equal(d.memory_mib, 8192);
    if (process.platform === "darwin" && process.arch === "arm64") {
      // An Apple chip shares memory with the system: three quarters of 8 GB is a usable card.
      assert.deepEqual([d.cpu_only, d.recommended.model], [false, "qwen3:4b"]);
    } else {
      assert.deepEqual([d.cpu_only, d.recommended.model, d.recommended.size_gb, d.recommended.license], [true, "qwen3:1.7b", 1.4, "Apache-2.0"]);
    }
    f.restore();
    const g = fakeProbe({}, "NVIDIA GeForce RTX 3060, 12288\n");
    try {
      const d2 = (await (await t.api("/setup/detect")).json()) as { cpu_only: boolean; recommended: { model: string } };
      assert.deepEqual([d2.cpu_only, d2.recommended.model], [false, "qwen3:8b"]);
    } finally { g.restore(); }
  } finally { f.restore(); t.cleanup(); }
});

/** An Ollama that lists `have` and streams a pull the way Ollama does, adding the model when it is done. */
function fakeOllama(base: string, have: string[], gpu: string | null) {
  const orig = { ...probe };
  const pulls: string[] = [];
  probe.fetch = async (url, init = {}) => {
    if (url === `${base}/api/tags`) return new Response(JSON.stringify({ models: have.map((name) => ({ name })) }), { status: 200 });
    if (url === `${base}/api/pull` && init.method === "POST") {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      pulls.push(model);
      const lines = [{ status: "pulling manifest" }, { status: "downloading", total: 1000, completed: 400 }, { status: "downloading", total: 1000, completed: 1000 }, { status: "success" }];
      have.push(model);
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200 });
    }
    throw new Error("connection refused");
  };
  probe.run = async (file) => (file === "nvidia-smi" ? gpu : null);
  probe.memoryMib = () => 16384;
  return { pulls, restore: () => Object.assign(probe, orig) };
}

async function pullDone(): Promise<PullState> {
  for (let i = 0; i < 100; i++) {
    const p = pullState();
    if (p?.done) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the pull did not finish");
}

test("setup: one click finds this machine's Ollama, uses it with the recommended model and starts the download", async () => {
  const t = makeHub();
  // Nothing answers: the owner is told Ollama is missing and that the installer sets it up.
  const none = fakeProbe({}, null);
  try {
    const r = await t.api("/setup/model/auto", { method: "POST" });
    assert.equal(r.status, 409);
    const msg = ((await r.json()) as { error: string }).error;
    assert.match(msg, /Ollama is not installed/);
    assert.match(msg, /installer again/);
    assert.ok(!/[\u2013\u2014]/.test(msg));
    assert.equal(t.hub.cfg.ollamaUrl, "", "nothing was saved");
  } finally { none.restore(); }
  // An Ollama on 127.0.0.1 with no models, and a 12 GB card: qwen3:8b is chosen and fetched.
  const o = fakeOllama("http://127.0.0.1:11434", [], "NVIDIA GeForce RTX 4070, 12282\n");
  try {
    t.hub.cfg.ollamaUrl = "";
    const r = await t.api("/setup/model/auto", { method: "POST" });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { url: string; model: string; size_gb: number; license: string; present: boolean; model_ready: boolean; pull: PullState | null };
    assert.deepEqual([j.url, j.model, j.size_gb, j.license, j.present, j.model_ready], ["http://127.0.0.1:11434", "qwen3:8b", 5.2, "Apache-2.0", false, true]);
    assert.equal(j.pull?.model, "qwen3:8b");
    assert.deepEqual([t.hub.cfg.ollamaUrl, t.hub.cfg.ollamaModel], ["http://127.0.0.1:11434", "qwen3:8b"], "in use at once");
    assert.deepEqual([readAiSettings(t.hub.cfg.dataDir, t.hub.secretBox).ollama_url, readAiSettings(t.hub.cfg.dataDir, t.hub.secretBox).ollama_model], ["http://127.0.0.1:11434", "qwen3:8b"], "kept for the next start");
    const done = await pullDone();
    assert.deepEqual([done.status, done.error, done.completed, done.total], ["success", null, 1000, 1000]);
    // Clicked again once the model is there: nothing is fetched again.
    const again = (await (await t.api("/setup/model/auto", { method: "POST", json: {} })).json()) as { present: boolean; pull: PullState | null };
    assert.deepEqual([again.present, again.pull], [true, null]);
    assert.deepEqual(o.pulls, ["qwen3:8b"]);
    // A named model is used instead; a name that is not one is refused before anything changes.
    assert.equal((await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:4b; rm -rf" } })).status, 422);
    assert.equal((await t.api("/setup/model/auto", { method: "POST", json: { model: 4 } })).status, 422);
    assert.equal(t.hub.cfg.ollamaModel, "qwen3:8b");
    const named = (await (await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:1.7b" } })).json()) as { model: string; size_gb: number; present: boolean };
    assert.deepEqual([named.model, named.size_gb, named.present], ["qwen3:1.7b", 1.4, false]);
    await pullDone();
    assert.deepEqual(o.pulls, ["qwen3:8b", "qwen3:1.7b"]);
  } finally { o.restore(); t.cleanup(); }
});

test("setup: the one click keeps the Ollama in use when it answers, and a download already running is not started twice", async () => {
  const t = makeHub();
  const o = fakeOllama("http://10.0.0.5:11434", ["qwen3:4b"], null);
  try {
    t.hub.cfg.ollamaUrl = "http://10.0.0.5:11434";
    // Its own model is there: used as it is, nothing fetched.
    const j = (await (await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:4b" } })).json()) as { url: string; present: boolean; pull: unknown };
    assert.deepEqual([j.url, j.present, j.pull], ["http://10.0.0.5:11434", true, null]);
    assert.deepEqual(o.pulls, []);
  } finally { o.restore(); }
  // A slow download: a second click for the same model reports it; another model must wait.
  const orig = { ...probe };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let pulls = 0;
  probe.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (url.endsWith("/api/pull") && init.method === "POST") {
      pulls++;
      const body = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode('{"status":"pulling manifest"}\n')); await gate; c.enqueue(new TextEncoder().encode('{"status":"success"}\n')); c.close(); } });
      return new Response(body, { status: 200 });
    }
    throw new Error("connection refused");
  };
  try {
    const a = (await (await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:14b" } })).json()) as { pull: PullState };
    const b = (await (await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:14b" } })).json()) as { pull: PullState };
    assert.deepEqual([a.pull.model, b.pull.model, b.pull.done, pulls], ["qwen3:14b", "qwen3:14b", false, 1]);
    const other = await t.api("/setup/model/auto", { method: "POST", json: { model: "qwen3:30b" } });
    assert.equal(other.status, 409);
    assert.match(((await other.json()) as { error: string }).error, /already fetching qwen3:14b/);
    release();
    assert.equal((await pullDone()).status, "success");
  } finally { release(); Object.assign(probe, orig); t.cleanup(); }
});

test("setup: a pairing link carries the hub's address, a one-time code and the device's name, never the token", async () => {
  const t = makeHub();
  try {
    const r = (await (await t.api("/setup/pair?name=Jamie's%20iPhone")).json()) as { hub: string; app: string; web: string; code: string };
    const u = new URL(r.app);
    assert.equal(u.protocol, "everythingapp:");
    assert.equal(u.searchParams.get("token"), null);
    assert.ok(!r.app.includes(t.hub.cfg.token) && !r.web.includes(t.hub.cfg.token));
    assert.equal(u.searchParams.get("code"), r.code.replace("-", ""));
    assert.equal(u.searchParams.get("name"), "Jamie's iPhone");
    assert.ok(r.app.includes("name=Jamie%27s%20iPhone") && !r.app.includes("+"), "spaces as %20, which every client reads as a space");
    assert.equal(u.searchParams.get("hub"), r.hub);
    assert.match(r.web, /\/app\/#\/setup\?hub=/);
    t.hub.cfg.publicUrl = "https://hub.example.ts.net:8787";
    const r2 = (await (await t.api("/setup/pair")).json()) as { hub: string };
    assert.equal(r2.hub, "https://hub.example.ts.net:8787");
  } finally { t.cleanup(); }
});

test("setup: a local model counts as ready only when Ollama answers and has it", async () => {
  const t = makeHub();
  const o = fakeOllama("http://127.0.0.1:11434", [], null);
  try {
    t.hub.cfg.ollamaUrl = "http://127.0.0.1:11434";
    t.hub.cfg.ollamaModel = "qwen3:4b";
    const before = (await (await t.api("/setup")).json()) as { model_ready: boolean };
    assert.equal(before.model_ready, false, "pointed at Ollama with nothing downloaded is not ready");
    o.restore();
    const o2 = fakeOllama("http://127.0.0.1:11434", ["qwen3:4b"], null);
    try {
      const after = (await (await t.api("/setup")).json()) as { model_ready: boolean };
      assert.equal(after.model_ready, true);
    } finally { o2.restore(); }
  } finally { o.restore(); t.cleanup(); }
});

test("Ollama models run on ollama.com are never offered or saved", async () => {
  const { ollamaCloudModel, saveAi } = await import("../src/setup.js");
  assert.equal(ollamaCloudModel({ name: "gpt-oss:120b-cloud" }), true);
  assert.equal(ollamaCloudModel({ name: "qwen3-coder:cloud" }), true);
  assert.equal(ollamaCloudModel({ name: "deepseek", remote_host: "https://ollama.com:443" }), true);
  assert.equal(ollamaCloudModel({ name: "qwen3:8b" }), false);
  assert.equal(ollamaCloudModel({ name: "soundcloud-helper:latest" }), false);
  const { hub, cleanup } = makeHub();
  try {
    await assert.rejects(saveAi(hub, { kind: "ollama", url: "http://127.0.0.1:11434", model: "gpt-oss:120b-cloud" }), /ollama\.com/);
  } finally { cleanup(); }
});
