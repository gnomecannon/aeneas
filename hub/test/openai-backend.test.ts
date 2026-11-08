import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isLocalUrl, openaiCompatible, toOpenAiMessages } from "../src/ai/backends.js";
import { makeHub } from "./helpers.js";

/** A fake OpenAI-style server: the first chat asks for a tool, the next answers with text. Records what it was sent. */
async function fakeServer() {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, ...j });
      if (!j.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const askedTool = j.messages.some((m: any) => m.role === "tool");
      if (j.tools && !askedTool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "create_task", arguments: '{"title":"Buy ' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'milk"}' } }] } }] });
      } else {
        send({ choices: [{ delta: { content: "Added " } }] });
        send({ choices: [{ delta: { content: "it." } }] });
      }
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() };
}

test("openai-compatible: streams text and tool calls, sends the key, and is local or cloud by its address", async () => {
  const s = await fakeServer();
  try {
    const b = openaiCompatible(s.url, "sk-test", "local-model", 10_000);
    assert.equal(b.cloud, false);
    assert.equal(await b.probe!(), true);
    const r = await b.streamTools!([{ role: "user", content: "buy milk" }], [{ type: "function", function: { name: "create_task", parameters: {} } }], () => {});
    assert.deepEqual(r.tool_calls, [{ function: { name: "create_task", arguments: { title: "Buy milk" } } }]);
    assert.equal(s.seen[0].auth, "Bearer sk-test");
    assert.equal(s.seen[0].model, "local-model");
    const j = await b.chat([{ role: "user", content: "json" }], { json: true });
    assert.equal(j.text, '{"ok":true}');
    assert.deepEqual(s.seen[1].response_format, { type: "json_object" });
    assert.equal(openaiCompatible("https://openrouter.ai/api/v1", "k", "m", 1000).cloud, true);
    for (const u of ["http://localhost:1234/v1", "http://10.0.0.5:8080/v1", "http://core.example-tailnet.ts.net:1234/v1", "http://laptop.local:1234/v1", "http://100.64.0.10:11434/v1"]) assert.equal(isLocalUrl(u), true, u);
    assert.equal(isLocalUrl("https://api.openai.com/v1"), false);
  } finally { s.close(); }
});

test("openai-compatible: tool calls get ids and their results answer them in order; images ride as data URLs", () => {
  const out = toOpenAiMessages([
    { role: "user", content: "hi", images: ["AAAA"] },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "a", arguments: { x: 1 } } }, { function: { name: "b", arguments: {} } }] },
    { role: "tool", content: "ra", tool_name: "a" },
    { role: "tool", content: "rb", tool_name: "b" },
  ]) as any[];
  assert.equal(out[0].content[1].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.deepEqual(out[1].tool_calls.map((c: any) => [c.id, c.function.name, c.function.arguments]), [["call_1", "a", '{"x":1}'], ["call_2", "b", "{}"]]);
  assert.deepEqual([out[2].tool_call_id, out[3].tool_call_id], ["call_1", "call_2"]);
});

test("openai-compatible: with no Ollama it is the assistant's model, tools included", async () => {
  const s = await fakeServer();
  const t = makeHub({ aiFake: false, openaiUrl: s.url, openaiModel: "local-model", openaiKey: "" });
  try {
    const out = await t.hub.ai.chat({ session_id: "oa-1", message: "buy milk" });
    assert.equal(out.backend, "openai");
    assert.ok(out.actions?.some((a) => a.tool === "create_task" && a.ok), JSON.stringify(out.actions));
    assert.ok(t.hub.store.list({ kind: "task" }).some((x) => x.fields.title === "Buy milk"));
    assert.match(out.reply, /Added it/);
  } finally { s.close(); t.cleanup(); }
});
