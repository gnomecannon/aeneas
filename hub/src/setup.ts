import { currentMethod, directStatus } from "./link.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Hub } from "./hub.js";
import type { Config } from "./config.js";
import { StoreError } from "./store.js";
import { showCode } from "./devicekeys.js";
import { isLoopbackHost, tlsFingerprint } from "./tls.js";
import { SecretBox } from "./secretbox.js";

/**
 * First-run setup, so someone new gets from an installed hub to a working assistant without editing files:
 * - which graphics card (or Apple chip) and how much memory the hub's machine has, and the open-licensed model that
 *   fits it (a small one for the processor when no card is usable);
 * - model servers already running there (Ollama, LM Studio, llama.cpp, vLLM, Jan) and their models;
 * - choosing the model: a local server, or a cloud one (any OpenAI-compatible address with a key, or Anthropic), kept
 *   in `<data>/ai.json` on top of hub.env and applied without a restart;
 * - fetching the recommended model into Ollama when it is not there yet (only when the owner asks), or all of the
 *   model setup in one confirmed step (`autoModel`);
 * - a pairing link (`everythingapp://setup?hub=&code=&name=`, a one-time code) and a web link the phone, Mac or a
 *   browser opens.
 */

export interface AiSettings {
  ollama_url?: string; ollama_model?: string;
  openai_url?: string; openai_model?: string; openai_key?: string;
  anthropic_key?: string; anthropic_model?: string;
}

const FIELDS: Record<keyof AiSettings, keyof Config> = {
  ollama_url: "ollamaUrl", ollama_model: "ollamaModel",
  openai_url: "openaiUrl", openai_model: "openaiModel", openai_key: "openaiKey",
  anthropic_key: "anthropicApiKey", anthropic_model: "anthropicModel",
};

export const aiSettingsFile = (dataDir: string) => path.join(dataDir, "ai.json");

/**
 * No file is no settings; a file that cannot be read is an error (as empty, the next save dropped every other key).
 * Sealed with the hub's sign-ins key (secretbox.ts) when `box` is given; an older hub's plain file is read as it is.
 */
export function readAiSettings(dataDir: string, box?: SecretBox): AiSettings {
  let raw: string;
  try { raw = fs.readFileSync(aiSettingsFile(dataDir), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`ai.json could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
  if (SecretBox.isSealed(raw)) {
    if (!box) throw new Error("ai.json is sealed and no key was given");
    raw = box.open("ai.json", raw);
  }
  try { return JSON.parse(raw) as AiSettings; } catch { throw new Error("ai.json is damaged; it is left as it is"); }
}

/** Seal a plain ai.json an older hub wrote. True when it was rewritten. */
export function sealAiSettings(dataDir: string, box: SecretBox): boolean {
  const file = aiSettingsFile(dataDir);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return false; }
  if (SecretBox.isSealed(raw)) return false;
  JSON.parse(raw);
  box.writeSealed(file, raw);
  return true;
}

/** Settings saved here win over hub.env; a field saved empty turns that model off. */
export function applyAiSettings(cfg: Config, s: AiSettings): void {
  const c = cfg as unknown as Record<string, unknown>;
  for (const [k, field] of Object.entries(FIELDS) as [keyof AiSettings, keyof Config][]) {
    const v = s[k];
    if (typeof v === "string") c[field] = /url$/.test(k) ? v.replace(/\/+$/, "") : v;
  }
}

function writeAiSettings(hub: Hub, s: AiSettings): void {
  hub.secretBox.writeSealed(aiSettingsFile(hub.cfg.dataDir), JSON.stringify(s, null, 2));
  applyAiSettings(hub.cfg, s);
  hub.ai.rebuildBackends();
}

// ---------- what the machine has ----------

export interface Gpu { name: string; vram_mib: number; kind: "nvidia" | "apple" | "amd" }

function run(file: string, args: string[], timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => execFile(file, args, { timeout: timeoutMs }, (err, out) => resolve(err ? null : String(out))));
}

export const probe = {
  run,
  fetch: (url: string, init: RequestInit = {}, timeoutMs = 2500) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  /** The machine's memory in MiB. */
  memoryMib: () => Math.round(os.totalmem() / 1048576),
  /** Free bytes on the disk holding `dir`, or null when it is not there. */
  freeBytes: (dir: string): number | null => {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
  },
};

export async function detectGpus(): Promise<Gpu[]> {
  const nv = await probe.run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) {
    return nv.trim().split("\n").filter(Boolean).map((l) => {
      const [name, mib] = l.split(",").map((x) => x.trim());
      return { name, vram_mib: Number(mib) || 0, kind: "nvidia" as const };
    });
  }
  if (process.platform === "darwin" && os.arch() === "arm64") {
    const chip = (await probe.run("sysctl", ["-n", "machdep.cpu.brand_string"]))?.trim() || "Apple chip";
    // Apple chips share memory with the system; about three quarters of it can hold a model.
    return [{ name: chip, vram_mib: Math.round(probe.memoryMib() * 0.75), kind: "apple" }];
  }
  const amd = await probe.run("rocm-smi", ["--showmeminfo", "vram", "--json"]);
  if (amd) {
    try {
      const j = JSON.parse(amd) as Record<string, Record<string, string>>;
      return Object.entries(j).filter(([k]) => /^card/.test(k)).map(([k, v]) => ({ name: `AMD ${k}`, vram_mib: Math.round(Number(v["VRAM Total Memory (B)"] ?? 0) / 1048576), kind: "amd" as const }));
    } catch { /* not JSON */ }
  }
  return [];
}

export interface Recommendation { model: string; size_gb: number; why: string; license: string }

/** Graphics memory below this (3.5 GB) holds no useful model: the processor runs it, chosen by system memory. */
export const USABLE_VRAM_MIB = 3584;

/**
 * Only open-licensed models are suggested. Sizes are the download from the Ollama library (model, template, license
 * and parameters), measured 2026-11-05; every qwen3 model there is Apache-2.0.
 */
const MODELS: Record<string, { size_gb: number; license: string }> = {
  "qwen3:30b": { size_gb: 18.6, license: "Apache-2.0" },
  "qwen3:14b": { size_gb: 9.3, license: "Apache-2.0" },
  "qwen3:8b": { size_gb: 5.2, license: "Apache-2.0" },
  "qwen3:4b": { size_gb: 2.5, license: "Apache-2.0" },
  "qwen3:1.7b": { size_gb: 1.4, license: "Apache-2.0" },
  "qwen3:0.6b": { size_gb: 0.5, license: "Apache-2.0" },
};

const pick = (model: keyof typeof MODELS & string, why: string): Recommendation => ({ model, ...MODELS[model], why });

/**
 * The model to run: with a usable card, the biggest one that fits its memory with room for the context; without
 * one, a model the processor can run in the system memory (`memoryMib`, 0 when unknown). Tool calling, which the
 * assistant needs, works in all of these.
 */
export function recommendModel(vramMib: number, memoryMib = 0): Recommendation {
  const gb = vramMib / 1024;
  if (gb >= 22) return pick("qwen3:30b", "it fits in 24 GB with room for a long conversation");
  if (gb >= 14) return pick("qwen3:14b", "it fits in 16 GB");
  if (gb >= 7) return pick("qwen3:8b", "it fits in 8 to 12 GB");
  if (vramMib >= USABLE_VRAM_MIB) return pick("qwen3:4b", "it fits in a small amount of graphics memory");
  const mem = memoryMib / 1024;
  if (mem > 0 && mem < 3.5) return pick("qwen3:0.6b", "no graphics card found and little memory: the smallest model, on the processor; a cloud model answers better");
  if (mem > 0 && mem < 12) return pick("qwen3:1.7b", "no graphics card found: a small model the processor runs in under 12 GB of memory; a cloud model answers better");
  return pick("qwen3:4b", "no graphics card found: it runs on the processor, slowly; a cloud model is faster");
}

export interface FoundServer { kind: "ollama" | "openai"; label: string; url: string; models: string[] }

/**
 * An Ollama model that runs on ollama.com, not on the machine: Ollama names them "...-cloud" or ":cloud" and lists
 * them with a remote_host. The hub treats every Ollama model as local, so these are never listed or used.
 */
export function ollamaCloudModel(m: { name?: string; remote_host?: string; remote_model?: string }): boolean {
  return !!(m.remote_host || m.remote_model) || /(^|[:-])cloud$/i.test(m.name ?? "");
}

/** Model servers answering on the hub's machine (or the Docker host, when the hub runs in a container). */
export async function findServers(cfg: Config): Promise<FoundServer[]> {
  const ollama = [...new Set([cfg.ollamaUrl, "http://127.0.0.1:11434", "http://172.17.0.1:11434", "http://host.docker.internal:11434"].filter(Boolean))];
  const openai: [string, string][] = [["LM Studio", "http://127.0.0.1:1234/v1"], ["llama.cpp", "http://127.0.0.1:8080/v1"], ["vLLM", "http://127.0.0.1:8000/v1"], ["Jan", "http://127.0.0.1:1337/v1"]];
  if (cfg.openaiUrl && /^http:\/\/(127\.|localhost|10\.|192\.168\.|172\.)/.test(cfg.openaiUrl)) openai.unshift(["Your server", cfg.openaiUrl]);
  const out = await Promise.all([
    ...ollama.map(async (url): Promise<FoundServer | null> => {
      try {
        const r = await probe.fetch(`${url}/api/tags`);
        if (!r.ok) return null;
        const j = (await r.json()) as { models?: { name: string; remote_host?: string }[] };
        return { kind: "ollama", label: "Ollama", url, models: (j.models ?? []).filter((m) => !ollamaCloudModel(m)).map((m) => m.name) };
      } catch { return null; }
    }),
    ...openai.map(async ([label, url]): Promise<FoundServer | null> => {
      try {
        const r = await probe.fetch(`${url}/models`);
        if (!r.ok) return null;
        const j = (await r.json()) as { data?: { id: string }[] };
        return { kind: "openai", label, url, models: (j.data ?? []).map((m) => m.id) };
      } catch { return null; }
    }),
  ]);
  // The same Ollama found at two addresses is listed once.
  const seen = new Set<string>();
  return out.filter((s): s is FoundServer => !!s).filter((s) => {
    const key = `${s.kind}:${s.models.join(",")}`;
    if (s.kind === "ollama" && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What the hub uses now, without keys. */
export function aiView(cfg: Config) {
  return {
    ollama: cfg.ollamaUrl ? { url: cfg.ollamaUrl, model: cfg.ollamaModel } : null,
    openai: cfg.openaiUrl && cfg.openaiModel ? { url: cfg.openaiUrl, model: cfg.openaiModel, key_set: !!cfg.openaiKey } : null,
    anthropic: cfg.anthropicApiKey ? { model: cfg.anthropicModel, key_set: true } : null,
  };
}

/** What the machine has for a model: its cards, its memory, whether no card is usable, and the model that fits. */
async function machine() {
  const gpus = await detectGpus();
  const best = gpus.reduce((m, g) => Math.max(m, g.vram_mib), 0);
  const memory_mib = probe.memoryMib();
  return { gpus, memory_mib, cpu_only: best < USABLE_VRAM_MIB, recommended: recommendModel(best, memory_mib) };
}

/**
 * Where the installer's Ollama keeps models (EA_MODELS_DIR, chosen during setup) and the free space there, so the
 * Welcome page can say where a download goes and stop one that does not fit. `missing`: the folder is not there (an
 * external drive unplugged, a network share offline). Null when the hub was not told (Ollama was already installed).
 */
export function modelsFolder(cfg: Config): { path: string; free_gb: number | null; missing: boolean } | null {
  if (!cfg.modelsDir) return null;
  const free = probe.freeBytes(cfg.modelsDir);
  return { path: cfg.modelsDir, free_gb: free === null ? null : Math.round((free / 1024 ** 3) * 10) / 10, missing: free === null };
}

export async function setupDetect(hub: Hub) {
  const [m, servers] = await Promise.all([machine(), findServers(hub.cfg)]);
  return { platform: process.platform, ...m, servers, current: aiView(hub.cfg), models_dir: modelsFolder(hub.cfg) };
}

/**
 * `GET /setup`: like `setupView`, but a local Ollama counts as ready only when it answers and has the chosen model.
 * The installer points a new hub at the Ollama it set up before any model is downloaded, so "a server is chosen"
 * alone said ready too early.
 */
export async function setupViewChecked(hub: Hub) {
  const v = setupView(hub);
  if (!v.ai.ollama || v.ai.openai || v.ai.anthropic) return v;
  let ready = false;
  try {
    const r = await probe.fetch(`${v.ai.ollama.url}/api/tags`);
    const names = r.ok ? ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [] : [];
    ready = names.some((n) => n === v.ai.ollama!.model || n === `${v.ai.ollama!.model}:latest`);
  } catch { /* Ollama does not answer */ }
  return { ...v, model_ready: ready };
}

export function setupView(hub: Hub) {
  const p = hub.profile.get();
  const ai = aiView(hub.cfg);
  return { owner: p.name, named: hub.profile.named(), ai, model_ready: !!(ai.ollama || ai.openai || ai.anthropic), password_manager: !!hub.connections.get().password_manager };
}

// ---------- choosing the model ----------

const URL_RE = /^https?:\/\/[^\s'"]+$/;

/**
 * Use a model. `ollama` and `openai` are checked first (the server answers and, for Ollama, says whether the model is
 * there yet); `anthropic` is checked by listing its models with the key. Keys are kept in ai.json, never shown again.
 */
export async function saveAi(hub: Hub, body: { kind?: unknown; url?: unknown; model?: unknown; key?: unknown }) {
  const kind = String(body.kind ?? "");
  const url = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  // The changes are collected while the checks run (each awaits a server) and applied to the file as it is then:
  // read before the awaits, a second save at the same time was overwritten (an Anthropic key lost from ai.json).
  const s: Record<string, unknown> & ReturnType<typeof readAiSettings> = { ...readAiSettings(hub.cfg.dataDir, hub.secretBox) };
  const changes: Record<string, unknown> = {};
  let note = "";
  if (kind === "ollama") {
    if (!URL_RE.test(url) || !model) throw new StoreError(422, "an Ollama address and a model are needed");
    if (ollamaCloudModel({ name: model })) throw new StoreError(422, `${model} runs on ollama.com, not on your machine: choose a local model`);
    let names: string[];
    try {
      const r = await probe.fetch(`${url}/api/tags`, {}, 5000);
      names = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    } catch { throw new StoreError(422, `Ollama does not answer at ${url}`); }
    const have = names.some((n) => n === model || n === `${model}:latest`);
    if (!have) note = `${model} is not in Ollama yet: fetch it below.`;
    Object.assign(changes, { ollama_url: url, ollama_model: model });
  } else if (kind === "openai") {
    if (!URL_RE.test(url) || !model) throw new StoreError(422, "an address (ending in /v1) and a model are needed");
    try {
      const r = await probe.fetch(`${url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} }, 8000);
      if (r.status === 401 || r.status === 403) throw new StoreError(422, "the server did not accept that key");
      if (!r.ok) throw new StoreError(422, `the server answered ${r.status} at ${url}/models`);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(422, `nothing answers at ${url}`);
    }
    Object.assign(changes, { openai_url: url, openai_model: model, openai_key: key || (s.openai_url === url ? s.openai_key ?? hub.cfg.openaiKey : "") });
  } else if (kind === "anthropic") {
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new StoreError(422, "that is not an Anthropic API key (it starts with sk-ant-)");
    try {
      const r = await probe.fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }, 8000);
      if (r.status === 401 || r.status === 403) throw new StoreError(422, "Anthropic did not accept that key");
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(502, "Anthropic could not be reached to check the key");
    }
    Object.assign(changes, { anthropic_key: key, ...(model ? { anthropic_model: model } : {}) });
  } else throw new StoreError(422, "kind is ollama, openai or anthropic");
  writeAiSettings(hub, { ...readAiSettings(hub.cfg.dataDir, hub.secretBox), ...changes });
  return { ...setupView(hub), note };
}

/** Stop using one model. */
export function removeAi(hub: Hub, kind: string) {
  const s = readAiSettings(hub.cfg.dataDir, hub.secretBox);
  if (kind === "ollama") Object.assign(s, { ollama_url: "" });
  else if (kind === "openai") Object.assign(s, { openai_url: "", openai_model: "", openai_key: "" });
  else if (kind === "anthropic") Object.assign(s, { anthropic_key: "" });
  else throw new StoreError(422, "kind is ollama, openai or anthropic");
  writeAiSettings(hub, s);
  return setupView(hub);
}

// ---------- fetching a model into Ollama ----------

export interface PullState { model: string; status: string; completed: number; total: number; done: boolean; error: string | null }
let pull: PullState | null = null;

export function pullState(): PullState | null {
  return pull;
}

const MODEL_RE = /^[\w.\-/]+(:[\w.\-]+)?$/;

/** Fetch a model into the Ollama the hub uses. One at a time; progress comes from Ollama's own stream. */
export function startPull(hub: Hub, model: string): PullState {
  if (!hub.cfg.ollamaUrl) throw new StoreError(409, "choose an Ollama first");
  if (!MODEL_RE.test(model)) throw new StoreError(422, "that is not a model name");
  if (pull && !pull.done) throw new StoreError(409, `already fetching ${pull.model}`);
  const state: PullState = { model, status: "starting", completed: 0, total: 0, done: false, error: null };
  pull = state;
  void (async () => {
    try {
      const r = await probe.fetch(`${hub.cfg.ollamaUrl}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) }, 3 * 3600_000);
      if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const j = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (j.error) throw new Error(j.error);
          state.status = j.status ?? state.status;
          if (j.total) { state.total = j.total; state.completed = j.completed ?? state.completed; }
        }
      }
      state.status = "success";
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.done = true;
    }
  })();
  return state;
}

export const NO_OLLAMA = "Ollama is not installed on the hub's computer, or it is not running: nothing answers at 127.0.0.1:11434. Run the hub's installer again and it sets Ollama up, then try this again.";

/**
 * The one click on the Welcome page, after it showed the model and its size: the Ollama on this machine (the one in
 * use when it answers, else the first found where `findServers` looks) becomes the model in use with `model` (the
 * recommended one when none is named), and the download starts when Ollama does not have it yet. A download of the
 * same model already running is reported, not started again.
 */
export async function autoModel(hub: Hub, body: { model?: unknown }) {
  if (body.model !== undefined && typeof body.model !== "string") throw new StoreError(422, "model is text");
  let model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !MODEL_RE.test(model)) throw new StoreError(422, "that is not a model name");
  const [servers, m] = await Promise.all([findServers(hub.cfg), model ? null : machine()]);
  if (!model) model = m!.recommended.model;
  const ollamas = servers.filter((s) => s.kind === "ollama");
  const server = ollamas.find((s) => s.url === hub.cfg.ollamaUrl) ?? ollamas[0];
  if (!server) throw new StoreError(409, NO_OLLAMA);
  const present = server.models.some((n) => n === model || n === `${model}:latest`);
  // A download into the folder chosen during setup: refused before anything changes when that folder is not there or
  // the model does not fit (1 GB kept spare).
  const where = present ? null : modelsFolder(hub.cfg);
  const size = MODELS[model]?.size_gb;
  if (where?.missing) throw new StoreError(409, `The models folder ${where.path} is not there (a drive unplugged, or a network share offline). Connect it, then try again.`);
  if (where && size && where.free_gb !== null && where.free_gb < size + 1) {
    throw new StoreError(507, `${model} needs ${size} GB and ${where.path} has ${where.free_gb} GB free. Free some space there, or run the installer again and choose another drive for models.`);
  }
  await saveAi(hub, { kind: "ollama", url: server.url, model });
  let state: PullState | null = null;
  if (!present) {
    const now = pullState();
    state = now && !now.done && now.model === model ? now : startPull(hub, model);
  }
  return { ...setupView(hub), url: server.url, model, ...(MODELS[model] ?? {}), present, pull: state };
}

// ---------- pairing devices ----------

/** The address devices reach the hub at: EA_PUBLIC_URL, else the one this request came in on. */
export function hubAddress(hub: Hub, requestUrl: string, forwardedHost?: string, forwardedProto?: string): string {
  if (hub.cfg.publicUrl) return hub.cfg.publicUrl;
  const u = new URL(requestUrl);
  const host = forwardedHost?.split(",")[0].trim() || u.host;
  const proto = forwardedProto?.split(",")[0].trim() || u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/**
 * Links that set a device up in one step: the app's own (iPhone, iPad, Mac) and the web app's. They carry a one-time
 * code that works for 10 minutes (devicekeys.ts), never a lasting secret: a photo of the QR code or a link left in a
 * message is useless afterwards.
 */
function hostName(address: string): string {
  try { return new URL(address).hostname.replace(/^\[|\]$/g, ""); } catch { return ""; }
}

export function pairingLinks(hub: Hub, address: string, name: string, by?: string) {
  const c = hub.deviceKeys.newCode(name || "My device", Date.now(), by);
  // A hub serving its own certificate (a home network, no Tailscale) puts its fingerprint in the link, so the app
  // accepts that certificate and no other: nobody on the network can stand in for the hub.
  const fp = address.startsWith("https:") ? tlsFingerprint(hub.cfg) : null;
  // A Direct link hub adds its public key and relay (link.ts): the app connects to that key and no other. The
  // address is left out when it is this machine only, which no other device can use.
  const direct = currentMethod(hub.cfg) === "direct" ? directStatus() : null;
  const node = direct?.state === "online" && direct.id && direct.relay ? { link: "direct", node: direct.id, relay: direct.relay } : null;
  const local = isLoopbackHost(hostName(address));
  const params: Record<string, string> = { ...(node && local ? {} : { hub: address }), code: c.code, name: c.name, ...(fp ? { fp } : {}), ...(node ?? {}) };
  // Spaces as %20, not "+": every client reads that the same way (Apple's URLComponents keeps a "+" as a plus).
  const q = new URLSearchParams(params).toString().replace(/\+/g, "%20");
  return { hub: address, code: showCode(c.code), expires_at: c.expires_at, fp, link: node ? "direct" : currentMethod(hub.cfg), node: node?.node ?? null, app: `everythingapp://setup?${q}`, web: `${address}/app/#/setup?${q}` };
}
