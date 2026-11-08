import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of the assistant (tools, chat loop, cloud residency); each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { buildBackends, isLocalUrl } = await import(`${R}/src/ai/backends.ts`);
const { loadConfig } = await import(`${R}/src/config.ts`);

function ndjsonResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l + "\n")); c.close(); } });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

test("B1 an Ollama error line in the middle of a plain stream is taken as a finished reply", async () => {
  process.env.EA_NO_DOTENV = "1";
  const cfg = loadConfig({ dataDir: "/nonexistent-probe", token: "x".repeat(32), ollamaUrl: "http://127.0.0.1:9", ollamaModel: "m", anthropicApiKey: "", adapterUrl: "", openaiUrl: "" } as any);
  const real = globalThis.fetch;
  // No network: every fetch is answered here.
  globalThis.fetch = (async () => ndjsonResponse([
    JSON.stringify({ message: { content: "Your backup on core failed because the" } }),
    JSON.stringify({ error: "an error was encountered while running the model: CUDA error: out of memory" }),
  ])) as any;
  try {
    const b = buildBackends(cfg).ollama!;
    let threw: string | null = null;
    let out: any = null;
    try { out = await b.stream([{ role: "user", content: "why did the backup fail?" }], () => {}); } catch (e) { threw = (e as Error).message; }
    let threwTools: string | null = null;
    try { await b.streamTools!([{ role: "user", content: "x" }], [], () => {}); } catch (e) { threwTools = (e as Error).message; }
    assert.ok(threw, "a cut reply is returned as complete");
  } finally { globalThis.fetch = real; }
});

test("B2 a public IPv6 address is classed as local, so it gets private facts and runs without cloud consent", () => {
  const cases = ["http://[2606:4700:4700::1111]:8080/v1", "https://[2001:db8::1]/v1", "http://[fd7a:115c:a1e0::1]:11434"];
  const out = cases.map((u) => `${u} local=${isLocalUrl(u)}`);
  assert.equal(isLocalUrl(cases[0]), false, "a public IPv6 server counted as the owner's own machine");
});
