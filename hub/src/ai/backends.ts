import { AsyncLocalStorage } from "node:async_hooks";
import type { Config } from "../config.js";
import { logHost } from "../logsafe.js";

/**
 * What a model call is for, sent to the model server as `x-aeneas-priority`. Plain Ollama ignores it; the model gate
 * (gate.ts), shared by every person's hub on one machine, orders its queue by it. Calls made outside `withPriority`
 * are someone waiting on a reply (`chat`).
 */
export type ModelPriority = "chat" | "filing" | "background" | "warm";
const priorityContext = new AsyncLocalStorage<ModelPriority>();
export function withPriority<T>(priority: ModelPriority, fn: () => Promise<T>): Promise<T> { return priorityContext.run(priority, fn); }
export function currentPriority(): ModelPriority { return priorityContext.getStore() ?? "chat"; }

/** The model gate stopped a background call so someone's chat could run: a pause, tried again later. */
export class GaveWayError extends Error {
  constructor() { super("the shared model stopped this for someone's chat"); this.name = "GaveWayError"; }
}

/** A gate answer that is not a model failure: gave way to a chat (background) or busy (a warm-up never waits). */
async function gateRefusal(name: string, res: Response): Promise<Error | null> {
  const gate = res.headers.get("x-aeneas-gate");
  if (res.status !== 503 || !gate) return null;
  if (gate === "gave-way") return new GaveWayError();
  let msg = "the shared model is busy";
  try { msg = String(((await res.json()) as { error?: unknown }).error ?? msg); } catch { /* keep the default */ }
  return new Error(`${name}: ${msg}`);
}

export interface AiToolCall { function: { name: string; arguments: Record<string, unknown> } }
/** `images` are base64 (no data: prefix); Ollama passes them to vision models. */
export interface AiMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: AiToolCall[]; tool_name?: string; images?: string[] }
export interface Usage { prompt_tokens?: number; completion_tokens?: number }
export interface ChatResult { text: string; usage: Usage; tool_calls?: AiToolCall[] }

export type BackendName = "ollama" | "anthropic" | "adapter" | "openai";
export type Residency = "gpu" | "cold" | "partial" | "down";

export interface Backend {
  name: BackendName;
  model: string;
  chat(messages: AiMessage[], opts?: { json?: boolean; signal?: AbortSignal }): Promise<ChatResult>;
  stream(messages: AiMessage[], onToken: (t: string) => void, opts?: { signal?: AbortSignal }): Promise<ChatResult>;
  /** Present when the backend can call tools: one streamed round that returns text and any tool calls. */
  streamTools?(messages: AiMessage[], tools: unknown[], onToken: (t: string) => void, opts?: { signal?: AbortSignal }): Promise<ChatResult>;
  /**
   * Read a prompt into the model server's cache and answer it with one token, so a later request that starts the same
   * way skips reading that part. Returns the prompt tokens read. Ollama backends only.
   */
  warm?(messages: AiMessage[], tools: unknown[]): Promise<number>;
  /** Cheap reachability check (a couple of seconds at most) so a sleeping host is skipped instead of waited on. */
  probe?(): Promise<boolean>;
  /**
   * Where the model sits right now: wholly in GPU memory, partly spilled to the CPU (several times slower, for
   * example while a game holds the GPU), not loaded, or unreachable. Ollama backends only.
   */
  residency?(): Promise<Residency>;
  /**
   * Behind a model gate shared with other people's hubs: how many of their calls hold the model or wait ahead of a chat
   * now (0 when it is free, or the server is not a gate). Clients show "waiting for the shared model".
   */
  waiting?(): Promise<number>;
  /** Where it runs, for logs and /status. */
  host?: string;
  /**
   * Runs outside the owner's own machines (Anthropic, or an OpenAI-compatible service on the internet): it gets the
   * cloud's share of memory (no private facts, never work items) like the Anthropic backend.
   */
  cloud?: boolean;
}

/** An address on the owner's own machines or network: localhost, private ranges, the tailnet, .local and .lan names. */
export function isLocalUrl(u: string): boolean {
  let h: string;
  try { h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  // An IPv6 address has no dots: only loopback, unique local (fc00::/7, the tailnet's fd7a:115c:a1e0::) and link
  // local (fe80::/10) are the owner's; a public one is the internet like any other.
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  return h === "localhost" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /\.(local|lan|home|internal|ts\.net)$/.test(h) || !h.includes(".");
}

/**
 * A function that takes the given strings (private fact values, work item titles) out of a text bound for a cloud
 * model, longest first, in one pass. Strings under 4 characters are left (they would match ordinary words).
 */
export function cloudScrubber(literals: string[]): (text: string) => string {
  const uniq = [...new Set(literals.map((l) => l.trim()).filter((l) => l.length >= 4))].sort((a, b) => b.length - a.length);
  if (!uniq.length) return (t) => t;
  const re = new RegExp(uniq.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (t) => (typeof t === "string" && t ? t.replace(re, "[withheld]") : t);
}

/**
 * Local models answer several times faster from a GPU that holds the whole model. When the hub machine's GPU is shared (a game
 * spills part of the model to the CPU), a fallback that has it wholly in GPU memory, or has nothing loaded, goes
 * first. Ties keep the configured order, so the primary stays first whenever it is fit. Backends without
 * `residency` (the cloud, the adapter) keep their places.
 */
export async function fastestFirst(chain: Backend[]): Promise<Backend[]> {
  const local = chain.filter((b) => b.residency);
  if (local.length < 2) return chain;
  const rank: Record<Residency, number> = { gpu: 0, cold: 1, partial: 2, down: 3 };
  const placed = new Map(await Promise.all(local.map(async (b) => [b, await b.residency!()] as const)));
  const order = [...local].sort((a, b) => rank[placed.get(a)!] - rank[placed.get(b)!]);
  if (order[0] !== local[0]) console.log(`[ai] ${logHost(order[0].host)} first: ${local.map((b) => `${logHost(b.host)} ${placed.get(b)}`).join(", ")}`);
  let i = 0;
  return chain.map((b) => (b.residency ? order[i++] : b));
}

/** Module-level override used by tests to inject a backend regardless of config. */
let override: Backend | null = null;
export function setBackendOverride(b: Backend | null): void { override = b; }
export function getBackendOverride(): Backend | null { return override; }

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${ms} ms`)), ms);
  outer?.addEventListener("abort", () => ctl.abort(outer.reason));
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

/** Ollama's names for models it runs on ollama.com instead of this machine (setup.ts ollamaCloudModel). */
const CLOUD_RUN = /(^|[:-])cloud$/i;

/** Ollama and the adapter share the /api/chat shape. */
function ollamaLike(name: BackendName, baseUrl: string, model: string, timeoutMs: number, numCtx: number, keepAlive = "", think = ""): Backend {
  const url = `${baseUrl}/api/chat`;
  // Ollama defaults to a 2048 token window, which truncates the memory-laden system prompt.
  // keep_alive stops Ollama unloading the model after its 5 minute default, which otherwise costs about 30 s on the first call after idle.
  // think: "false" turns reasoning off for models that allow it; "low|medium|high" sets gpt-oss effort; empty leaves the model default.
  const thinkOpt = think === "" ? {} : { think: think === "true" ? true : think === "false" ? false : think };
  const runOptions: Record<string, number> = numCtx > 0 ? { num_ctx: numCtx } : {};
  const options = { ...(numCtx > 0 ? { options: runOptions } : {}), ...(keepAlive ? { keep_alive: keepAlive } : {}), ...thinkOpt };
  let probedAt = 0;
  let probedOk = true;
  let placedAt = 0;
  let placed: Residency = "cold";
  const headers = () => ({ "content-type": "application/json", "x-aeneas-priority": currentPriority() });
  /** Whether the base URL is a model gate (learned from /gate/status; plain Ollama answers 404). */
  let gateKnown: boolean | null = null;
  return {
    name, model, host: baseUrl,
    async waiting() {
      if (gateKnown === false) return 0;
      const { signal, done } = withTimeout(1500);
      try {
        const r = await fetch(`${baseUrl}/gate/status`, { signal });
        if (!r.ok) { gateKnown = false; return 0; }
        gateKnown = true;
        const s = (await r.json()) as { slots?: number; running?: { mine?: boolean }[]; waiting?: { mine?: boolean; priority?: string }[] };
        const others = (s.running ?? []).filter((x) => x.mine === false).length + (s.waiting ?? []).filter((x) => x.mine === false && x.priority === "chat").length;
        return (s.running ?? []).length >= (s.slots ?? 1) ? others : 0;
      } catch { return 0; } finally { done(); }
    },
    async residency() {
      // Cached for 15 s, like the probe: it is asked once per turn.
      if (Date.now() - placedAt < 15_000) return placed;
      const { signal, done } = withTimeout(2000);
      try {
        const r = await fetch(`${baseUrl}/api/ps`, { signal });
        if (!r.ok) { placed = "down"; return placed; }
        const ps = (await r.json()) as { models?: { name?: string; model?: string; size?: number; size_vram?: number }[] };
        const m = ps.models?.find((x) => x.name === model || x.model === model);
        placed = !m ? "cold" : (m.size_vram ?? 0) >= (m.size ?? 0) * 0.98 ? "gpu" : "partial";
      } catch { placed = "down"; } finally { done(); placedAt = Date.now(); }
      return placed;
    },
    async probe() {
      // An Ollama model run on ollama.com ("...-cloud") is never used: this backend counts as local.
      if (CLOUD_RUN.test(model)) return false;
      // Cached for 20 s: a reply round with tools calls the backend several times.
      if (Date.now() - probedAt < 20_000) return probedOk;
      const { signal, done } = withTimeout(2500);
      try {
        const r = await fetch(`${baseUrl}/api/version`, { signal });
        probedOk = r.ok;
      } catch { probedOk = false; } finally { done(); probedAt = Date.now(); }
      return probedOk;
    },
    async chat(messages, opts = {}) {
      if (CLOUD_RUN.test(model)) throw new Error(`${model} runs on ollama.com, not on this machine; it is not used`);
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const res = await fetch(url, {
          method: "POST", signal, headers: headers(),
          body: JSON.stringify({ model, messages, stream: false, ...options, ...(opts.json ? { format: "json" } : {}) }),
        });
        if (!res.ok) throw (await gateRefusal(name, res)) ?? new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
        return { text: data.message?.content ?? "", usage: { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count } };
      } finally { done(); }
    },
    async stream(messages, onToken, opts = {}) {
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const res = await fetch(url, {
          method: "POST", signal, headers: headers(),
          body: JSON.stringify({ model, messages, stream: true, ...options }),
        });
        if (!res.ok || !res.body) throw (await gateRefusal(name, res)) ?? new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        let text = "";
        const usage: Usage = {};
        for await (const line of ndjson(res.body)) {
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          // An error in the middle of the stream (the model unloaded, out of memory) is a failure, as in streamTools:
          // taken as the end, half a reply came back as an answer and the next backend was never tried.
          if (obj?.error) throw new Error(`${name}: ${String(obj.error).slice(0, 200)}`);
          const tok = obj?.message?.content;
          if (tok) { text += tok; onToken(tok); }
          if (obj?.done) { usage.prompt_tokens = obj.prompt_eval_count; usage.completion_tokens = obj.eval_count; }
        }
        return { text, usage };
      } finally { done(); }
    },
    async warm(messages, tools) {
      const { signal, done } = withTimeout(timeoutMs);
      try {
        // Exactly what streamTools sends but one token long: the same options keep the model loaded as it is.
        const res = await fetch(url, {
          method: "POST", signal, headers: headers(),
          body: JSON.stringify({ model, messages, tools, stream: false, ...options, options: { ...runOptions, num_predict: 1 } }),
        });
        if (!res.ok) throw (await gateRefusal(name, res)) ?? new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return ((await res.json()) as { prompt_eval_count?: number }).prompt_eval_count ?? 0;
      } finally { done(); }
    },
    async streamTools(messages, tools, onToken, opts = {}) {
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const res = await fetch(url, {
          method: "POST", signal, headers: headers(),
          body: JSON.stringify({ model, messages, tools, stream: true, ...options }),
        });
        if (!res.ok || !res.body) throw (await gateRefusal(name, res)) ?? new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
        let text = "";
        const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
        const tool_calls: AiToolCall[] = [];
        for await (const line of ndjson(res.body)) {
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj?.error) throw new Error(`${name}: ${String(obj.error).slice(0, 200)}`);
          const tok = obj?.message?.content;
          if (tok) { text += tok; onToken(tok); }
          for (const tc of obj?.message?.tool_calls ?? []) {
            const fn = tc?.function;
            if (!fn?.name) continue;
            let args = fn.arguments ?? {};
            if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
            tool_calls.push({ function: { name: String(fn.name), arguments: args } });
          }
          if (obj?.done) { usage.prompt_tokens = obj.prompt_eval_count; usage.completion_tokens = obj.eval_count; }
        }
        return { text, usage, tool_calls };
      } finally { done(); }
    },
  };
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

function anthropic(apiKey: string, model: string, timeoutMs: number): Backend {
  const cloud = true;
  const url = "https://api.anthropic.com/v1/messages";
  const split = (messages: AiMessage[]) => {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    if (!rest.length || rest[0].role !== "user") rest.unshift({ role: "user", content: "(continue)" });
    return { system, rest };
  };
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  return {
    name: "anthropic", model, cloud,
    async chat(messages, opts = {}) {
      const { system, rest } = split(messages);
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const res = await fetch(url, {
          method: "POST", signal, headers,
          body: JSON.stringify({ model, max_tokens: 4096, system: system || undefined, messages: rest }),
        });
        if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
        const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        return { text, usage: { prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens } };
      } finally { done(); }
    },
    async stream(messages, onToken, opts = {}) {
      const { system, rest } = split(messages);
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const res = await fetch(url, {
          method: "POST", signal, headers,
          body: JSON.stringify({ model, max_tokens: 4096, stream: true, system: system || undefined, messages: rest }),
        });
        if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
        let text = "";
        const usage: Usage = {};
        for await (const line of ndjson(res.body)) {
          if (!line.startsWith("data:")) continue;
          let obj: any;
          try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") { text += obj.delta.text; onToken(obj.delta.text); }
          if (obj.type === "message_start" && obj.message?.usage) usage.prompt_tokens = obj.message.usage.input_tokens;
          if (obj.type === "message_delta" && obj.usage) usage.completion_tokens = obj.usage.output_tokens;
        }
        return { text, usage };
      } finally { done(); }
    },
  };
}

/**
 * Any server that speaks OpenAI's chat completions API, tools included: LM Studio, llama.cpp's server, vLLM, Ollama's
 * /v1, and cloud services (OpenAI, OpenRouter, Groq, Together, Anthropic's compatibility endpoint). `baseUrl` ends
 * before /chat/completions, e.g. http://localhost:1234/v1. The key is optional for local servers.
 */
export function openaiCompatible(baseUrl: string, apiKey: string, model: string, timeoutMs: number): Backend {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  let probedAt = 0;
  let probedOk = true;
  const post = async (body: Record<string, unknown>, signal: AbortSignal) => {
    const res = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify({ model, ...body }) });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const streamed = async (messages: AiMessage[], tools: unknown[] | null, onToken: (t: string) => void, outer?: AbortSignal): Promise<ChatResult> => {
    const { signal, done } = withTimeout(timeoutMs, outer);
    try {
      const res = await post({ messages: toOpenAiMessages(messages), stream: true, stream_options: { include_usage: true }, ...(tools && tools.length ? { tools } : {}) }, signal);
      if (!res.body) throw new Error("openai: no body");
      let text = "";
      const usage: Usage = {};
      const calls = new Map<number, { name: string; args: string }>();
      for await (const line of ndjson(res.body)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        let obj: any;
        try { obj = JSON.parse(data); } catch { continue; }
        const d = obj.choices?.[0]?.delta;
        if (typeof d?.content === "string" && d.content) { text += d.content; onToken(d.content); }
        for (const tc of d?.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : calls.size;
          const c = calls.get(i) ?? { name: "", args: "" };
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(i, c);
        }
        if (obj.usage) { usage.prompt_tokens = obj.usage.prompt_tokens; usage.completion_tokens = obj.usage.completion_tokens; }
      }
      const tool_calls: AiToolCall[] = [...calls.values()].filter((c) => c.name).map((c) => {
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
        return { function: { name: c.name, arguments: args } };
      });
      return { text, usage, ...(tool_calls.length ? { tool_calls } : {}) };
    } finally { done(); }
  };
  return {
    name: "openai", model, host: baseUrl, cloud: !isLocalUrl(baseUrl),
    async probe() {
      if (Date.now() - probedAt < 15_000) return probedOk;
      const { signal, done } = withTimeout(2500);
      try { probedOk = (await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal, headers })).status < 500; } catch { probedOk = false; } finally { done(); }
      probedAt = Date.now();
      return probedOk;
    },
    async chat(messages, opts = {}) {
      const { signal, done } = withTimeout(timeoutMs, opts.signal);
      try {
        const body = { messages: toOpenAiMessages(messages), ...(opts.json ? { response_format: { type: "json_object" } } : {}) };
        let res: Response;
        try { res = await post(body, signal); } catch (e) {
          // Some local servers do not take response_format: ask again without it (the prompt still asks for JSON).
          if (!opts.json || !/ 400:| 422:/.test((e as Error).message)) throw e;
          res = await post({ messages: body.messages }, signal);
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        return { text: data.choices?.[0]?.message?.content ?? "", usage: { prompt_tokens: data.usage?.prompt_tokens, completion_tokens: data.usage?.completion_tokens } };
      } finally { done(); }
    },
    stream: (messages, onToken, opts = {}) => streamed(messages, null, onToken, opts.signal),
    streamTools: (messages, tools, onToken, opts = {}) => streamed(messages, tools, onToken, opts.signal),
  };
}

/**
 * The hub's messages in OpenAI's shape: tool calls get ids and each tool result answers the next unanswered call of
 * the assistant turn before it; images ride along as data URLs.
 */
export function toOpenAiMessages(messages: AiMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pending: string[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const ids = m.tool_calls.map(() => `call_${++n}`);
      pending = [...ids];
      out.push({ role: "assistant", content: m.content || null, tool_calls: m.tool_calls.map((c, i) => ({ id: ids[i], type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })) });
    } else if (m.role === "tool") {
      const id = pending.shift() ?? `call_${++n}`;
      out.push({ role: "tool", tool_call_id: id, content: m.content });
    } else if (m.role === "user" && m.images?.length) {
      out.push({ role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((b) => ({ type: "image_url", image_url: { url: b.startsWith("data:") ? b : `data:image/jpeg;base64,${b}` } }))] });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Canned backend for tests: the reply deliberately violates the style rules and echoes the user text. */
export function fakeBackend(): Backend {
  const reply = (messages: AiMessage[]) => {
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (/runbook_section/.test(system)) {
      const host = /Host: (\S+)/.exec(user)?.[1] ?? "unknown";
      return JSON.stringify({
        runbook_section: `## ${new Date().toISOString().slice(0, 10)}: hub service would not start on ${host}\n\nSymptoms: unit failed at boot.\nRoot cause: stale pid file.\nFix: removed the pid file and restarted the unit.\nVerification: systemctl status hub shows active.`,
        journal: [{ what: "Removed stale pid file and restarted hub", command: "rm /run/hub.pid && systemctl restart hub", risk: "medium", rollback: "systemctl stop hub; restore the pid file from backup" }],
        snippets: [{ title: "Restart a unit and tail its log", os: "linux", language: "bash", body: "systemctl restart {{unit}} && journalctl -u {{unit}} -n {{lines}}", params: [{ name: "unit" }, { name: "lines", default: "50" }] }],
      });
    }
    if (/recall quiz/i.test(system)) {
      return JSON.stringify({ items: [
        { q: "Which file holds a stale pid that stops the hub unit from starting?", a: "/run/hub.pid", hint: "It lives under /run.", topic: "hub service" },
        { q: "Which command shows whether the hub unit is active?", a: "systemctl status hub", hint: "systemctl, then the unit name.", topic: "systemd" },
        { q: "Which command tails the hub unit's log?", a: "journalctl -u hub", hint: "The journal, filtered by unit.", topic: "systemd" },
      ] });
    }
    if (/split instructions into a procedure/i.test(system)) return JSON.stringify({ title: "Procedure", steps: [] });
    if (/strict JSON/i.test(system)) return JSON.stringify({ kind: "note", fields: { title: user.slice(0, 40), body: user } });
    return [
      "Great question! Here is what to try — first, check the service.",
      "1. Run systemctl status hub on the server as root.",
      "2. Check the logs with journalctl -u hub.",
      "I'm not a doctor, but a restart usually helps.",
      `You wrote: ${user}`,
      "Let me know if that works for you.",
    ].join("\n");
  };
  return {
    name: "ollama", model: "fake",
    async chat(messages) { return { text: reply(messages), usage: { prompt_tokens: 10, completion_tokens: 20 } }; },
    async stream(messages, onToken) { const t = reply(messages); for (const w of t.split(/(?<=\s)/)) onToken(w); return { text: t, usage: { prompt_tokens: 10, completion_tokens: 20 } }; },
  };
}

export interface BackendSet { ollama: Backend | null; ollamaFallback?: Backend | null; anthropic: Backend | null; adapter: Backend | null; openai?: Backend | null }

export function buildBackends(cfg: Config): BackendSet {
  if (cfg.aiFake) { const f = fakeBackend(); return { ollama: f, anthropic: { ...f, name: "anthropic" }, adapter: { ...f, name: "adapter" } }; }
  return {
    // No model chosen yet (a new hub before the Welcome page): no local backend, rather than requests Ollama refuses.
    ollama: cfg.ollamaUrl && cfg.ollamaModel ? ollamaLike("ollama", cfg.ollamaUrl, cfg.ollamaModel, cfg.aiTimeoutMs, cfg.ollamaNumCtx, cfg.ollamaKeepAlive, cfg.ollamaThink) : null,
    ollamaFallback: cfg.ollamaFallbackUrl && (cfg.ollamaFallbackModel || cfg.ollamaModel) ? ollamaLike("ollama", cfg.ollamaFallbackUrl, cfg.ollamaFallbackModel || cfg.ollamaModel, cfg.aiTimeoutMs, cfg.ollamaNumCtx, cfg.ollamaKeepAlive, cfg.ollamaFallbackThink) : null,
    anthropic: cfg.anthropicApiKey ? anthropic(cfg.anthropicApiKey, cfg.anthropicModel, cfg.aiTimeoutMs) : null,
    adapter: cfg.adapterUrl ? ollamaLike("adapter", cfg.adapterUrl, cfg.adapterModel || cfg.ollamaModel, cfg.aiTimeoutMs, cfg.ollamaNumCtx, cfg.ollamaKeepAlive) : null,
    openai: cfg.openaiUrl && cfg.openaiModel ? openaiCompatible(cfg.openaiUrl, cfg.openaiKey, cfg.openaiModel, cfg.aiTimeoutMs) : null,
  };
}
