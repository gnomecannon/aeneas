import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
// The model gate shared by several people's hubs on one machine (hub/src/gate.ts) and the hub's side of it.
// A file: address, which import() takes on every system (a plain path with a drive letter is refused on Windows).
const R = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { Scheduler, GateBusy, WARM_GUARD_MS, createGate, uidForPort, passwdNames } = await import(`${R}/src/gate.ts`);
const { buildBackends, withPriority, GaveWayError } = await import(`${R}/src/ai/backends.ts`);
const { loadConfig } = await import(`${R}/src/config.ts`);

const tick = () => new Promise((r) => setImmediate(r));

test("scheduler: one place; a chat goes before background work queued earlier", async () => {
  const s = new Scheduler(1);
  const order: string[] = [];
  const first = await s.acquire("robin", "chat");
  const bg = s.acquire("jamie", "background").then((l: any) => { order.push("jamie background"); return l; });
  const chat = s.acquire("jamie", "chat").then((l: any) => { order.push("jamie chat"); return l; });
  await tick();
  assert.deepEqual(order, []);
  first.release();
  (await chat).release();
  (await bg).release();
  assert.deepEqual(order, ["jamie chat", "jamie background"]);
});

test("scheduler: two people asking at once take turns call by call", async () => {
  const s = new Scheduler(1);
  const order: string[] = [];
  const hold = await s.acquire("robin", "chat");
  // Robin's tool chain queues three more calls before Jamie's one arrives.
  const t1 = s.acquire("robin", "chat").then((l: any) => { order.push("robin"); return l; });
  const t2 = s.acquire("robin", "chat").then((l: any) => { order.push("robin"); return l; });
  const j1 = s.acquire("jamie", "chat").then((l: any) => { order.push("jamie"); return l; });
  hold.release();
  // Jamie was served longest ago (never), so goes before Robin's queued calls, though they came first.
  (await j1).release();
  (await t1).release();
  (await t2).release();
  assert.deepEqual(order, ["jamie", "robin", "robin"]);
});

test("scheduler: a chat stops the newest background call holding the only place", async () => {
  const s = new Scheduler(1);
  let stopped = false;
  const bg = await s.acquire("robin", "background", { onPreempt: () => { stopped = true; } });
  const chat = s.acquire("jamie", "chat");
  await tick();
  assert.equal(stopped, true);
  bg.release();
  const lease = await chat;
  lease.release();
});

test("scheduler: filing is never stopped for a chat; it waits its turn instead", async () => {
  const s = new Scheduler(1);
  let stopped = false;
  const filing = await s.acquire("robin", "filing", { onPreempt: () => { stopped = true; } });
  const chat = s.acquire("jamie", "chat");
  await tick();
  assert.equal(stopped, false);
  filing.release();
  (await chat).release();
});

test("scheduler: a warm-up never waits and is refused right after someone else used the model", async () => {
  let now = 1_000_000;
  const s = new Scheduler(1, () => now);
  const busy = await s.acquire("robin", "chat");
  await assert.rejects(s.acquire("jamie", "warm"), GateBusy);
  busy.release();
  await assert.rejects(s.acquire("jamie", "warm"), /someone else/);
  // Robin's own warm-up is fine: it is their cache.
  (await s.acquire("robin", "warm")).release();
  now += WARM_GUARD_MS + 1;
  (await s.acquire("jamie", "warm")).release();
});

test("scheduler: a caller that leaves the queue is dropped and does not hold the next place", async () => {
  const s = new Scheduler(1);
  const hold = await s.acquire("robin", "chat");
  const ctl = new AbortController();
  const gone = s.acquire("jamie", "chat", { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(gone, /left/);
  const next = s.acquire("jamie", "chat");
  hold.release();
  (await next).release();
  assert.equal(s.status().running.length, 0);
});

test("connection owner from /proc/net/tcp and names from /etc/passwd", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:2AF3 0100007F:BA1F 01 00000000:00000000 00:00000000 00000000  1001        0 123 1 0 20 4 30 10 -1",
    "   1: 0100007F:BA1F 0100007F:2AF3 01 00000000:00000000 00:00000000 00000000  1002        0 124 1 0 20 4 30 10 -1",
  ].join("\n");
  // The client side of the connection has local port 0xBA1F; its owner is uid 1002.
  assert.equal(uidForPort(0xba1f, [tcp]), 1002);
  assert.equal(uidForPort(1, [tcp]), null);
  assert.equal(passwdNames("root:x:0:0::/root:/bin/bash\njamie:x:1002:1002::/home/jamie:/usr/sbin/nologin").get(1002), "jamie");
});

/** A stand-in model server: answers /api/chat after `delayMs`, records the bodies, and has /api/pull. */
function fakeOllama(delayMs: number) {
  const seen: { path: string; model?: string; priorityHeader?: string }[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let model: string | undefined;
      try { model = JSON.parse(b).model; } catch { /* none */ }
      seen.push({ path: req.url ?? "", model, priorityHeader: req.headers["x-aeneas-priority"] as string | undefined });
      if (req.url === "/api/version") { res.end(JSON.stringify({ version: "0" })); return; }
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { content: `answer for ${model}` }, done: true, prompt_eval_count: 3, eval_count: 2 }));
      }, delayMs);
    });
  });
  return { server, seen };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("gate: owner-only model changes, model list, private status, and background giving way to a chat", async () => {
  const up = fakeOllama(300);
  const upUrl = await listen(up.server);
  // Tests name the caller with a header; on Linux the gate reads it from the operating system instead.
  const uids: Record<string, number> = { robin: 1000, jamie: 1002 };
  const { server } = createGate({
    port: 0, upstream: upUrl, slots: 1, models: ["qwen:27b"], ownerUid: 1000,
    identify: (req: http.IncomingMessage) => { const p = String(req.headers["x-aeneas-person"] ?? "x"); return { uid: uids[p] ?? null, person: p }; },
  });
  const gate = await listen(server);
  const call = (person: string, path: string, body?: unknown, priority?: string) => fetch(`${gate}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-aeneas-person": person, "content-type": "application/json", ...(priority ? { "x-aeneas-priority": priority } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call("jamie", "/api/pull", { model: "huge:70b" })).status, 403);
    assert.equal((await call("jamie", "/api/chat", { model: "other:8b", messages: [] })).status, 403);
    // Passed through without a place: version and status.
    assert.equal((await call("jamie", "/api/version")).status, 200);

    const bg = call("robin", "/api/chat", { model: "qwen:27b", messages: [] }, "background");
    await new Promise((r) => setTimeout(r, 50));
    const status: any = await (await call("jamie", "/gate/status")).json();
    assert.equal(status.running.length, 1);
    assert.equal(status.running[0].person, undefined, "another person's status names nobody");
    assert.equal(status.running[0].mine, false);
    const ownerView: any = await (await call("robin", "/gate/status")).json();
    assert.equal(ownerView.running[0].person, "robin");

    const chat = call("jamie", "/api/chat", { model: "qwen:27b", messages: [] }, "chat");
    const bgRes = await bg;
    assert.equal(bgRes.status, 503);
    assert.equal(bgRes.headers.get("x-aeneas-gate"), "gave-way");
    const chatRes = await chat;
    assert.equal(chatRes.status, 200);
    assert.match(((await chatRes.json()) as any).message.content, /answer/);
    // The priority header stays between the hub and the gate.
    assert.ok(up.seen.every((s) => s.priorityHeader === undefined));
  } finally {
    server.close(); up.server.close();
  }
});

test("hub side: calls carry their priority; a gave-way answer is a pause for background work", async () => {
  process.env.EA_NO_DOTENV = "1";
  const cfg = loadConfig({ dataDir: "/nonexistent-probe", token: "x".repeat(32), ollamaUrl: "http://127.0.0.1:9", ollamaModel: "m", anthropicApiKey: "", adapterUrl: "", openaiUrl: "" } as any);
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    sent.push(init?.headers?.["x-aeneas-priority"]);
    return new Response(JSON.stringify({ error: "stopped" }), { status: 503, headers: { "x-aeneas-gate": "gave-way" } });
  }) as any;
  try {
    const b = buildBackends(cfg).ollama!;
    await assert.rejects(withPriority("background", () => b.chat([{ role: "user", content: "x" }])), GaveWayError);
    await assert.rejects(b.chat([{ role: "user", content: "x" }]), GaveWayError);
    assert.deepEqual(sent, ["background", "chat"]);
  } finally { globalThis.fetch = real; }
});

test("hub through the gate: a streamed reply arrives token by token, and the gate answers /gate/status to the hub", async () => {
  // A stand-in Ollama that streams three lines with pauses, as a real reply does.
  const up = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const parts = ["Hel", "lo", "!"];
      let i = 0;
      const next = () => {
        if (i < parts.length) { res.write(JSON.stringify({ message: { content: parts[i++] } }) + "\n"); setTimeout(next, 40); }
        else res.end(JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 3 }) + "\n");
      };
      next();
    });
  });
  const upUrl = await listen(up);
  const { server } = createGate({ port: 0, upstream: upUrl, slots: 1, models: [], ownerUid: 1, identify: () => ({ uid: 1, person: "robin" }) });
  const gate = await listen(server);
  process.env.EA_NO_DOTENV = "1";
  const cfg = loadConfig({ dataDir: "/nonexistent-probe", token: "x".repeat(32), ollamaUrl: gate, ollamaModel: "m", anthropicApiKey: "", adapterUrl: "", openaiUrl: "" } as any);
  try {
    const b = buildBackends(cfg).ollama!;
    const seen: { t: string; at: number }[] = [];
    const out = await b.stream([{ role: "user", content: "hi" }], (t: string) => seen.push({ t, at: Date.now() }));
    assert.equal(out.text, "Hello!");
    assert.deepEqual(seen.map((s) => s.t), ["Hel", "lo", "!"]);
    // Tokens came as they were written, not all at the end.
    assert.ok(seen[2].at - seen[0].at >= 50, "the gate held the stream back until it ended");
    assert.equal(out.usage.completion_tokens, 3);
    // Free gate: nothing to wait for.
    assert.equal(await b.waiting!(), 0);
  } finally { server.close(); up.close(); }
});
