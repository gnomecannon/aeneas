import { personalBackend, personalBackends } from "../profile.js";
import { applyStyle, classifyCapture, nowIso, redact } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Config } from "../config.js";
import type { DB } from "../db.js";
import { Store, StoreError } from "../store.js";
import { buildBackends, cloudScrubber, fastestFirst, getBackendOverride, GaveWayError, withPriority, type AiMessage, type Backend, type BackendSet, type Usage } from "./backends.js";
import { buildSystemPrompt, CLASSIFY_SYSTEM, loadMemory, turnContext, type Memory } from "./prompt.js";
import { appendPending, openLedger, recordFailure } from "./ledger.js";
import { insertPreflight, recordPlanned } from "../preflight.js";
import { hostsIn, knownHosts } from "../memory.js";
import { countNumberedSteps, createProcedure, splitSteps } from "../procedures.js";
import path from "node:path";
import crypto from "node:crypto";
import { harvestSnippets, saysWorked } from "./harvest.js";
import { availableTools, cloudSecrets, runTool, toolGuide, toolSpecs, type ApiCall, type DevicePhoto, type PendingApproval, type ToolContext } from "./tools.js";
import { Sessions, type StoredMessage, type TouchedItem } from "./sessions.js";
import { recordImage } from "../gallery.js";
import { ImageStore } from "./images.js";
import { HostActions } from "./hosts.js";
import type { ModuleCheck } from "../modules.js";
import { estimateTokens, fallbackSummary, fitToolResults, planWindow, SUMMARY_SYSTEM, summaryPrompt } from "./history.js";
import { errCode, logHost } from "../logsafe.js";
import { webPrivate } from "./web.js";
import { gpuBusyNow, onThisMachine } from "../gpu.js";

export interface ChatInput {
  session_id: string;
  /** Whole history from the client (older clients and internal callers). */
  messages?: AiMessage[];
  /** One new user turn; the hub holds the history. */
  message?: string;
  /** With `messages`: what the stored chat keeps as the last user turn (the filer keeps the capture, not its filing prompt). */
  store_as?: string;
  /** Base64 images attached to `message`. */
  images?: string[];
  /** Approve the host command this session is waiting on, then continue. */
  approve_action_id?: string;
  task_type?: "auto" | "general" | "troubleshoot" | "draft" | "classify" | "plan";
  space?: "personal" | "work";
  allow_cloud?: boolean;
  allow_work?: boolean;
  /** What the sending device can do: `photos` when the iPhone app may read its photo library. */
  device?: { photos?: boolean };
  /** Hub-internal: no web tools and no web instructions this turn, whatever the Web lookups module says (capture
   * filing: a private diary line must never become a search query or a page fetch). */
  no_web?: boolean;
}

type Mode = "general" | "troubleshoot" | "draft" | "classify" | "plan";

export interface ChatOutput {
  reply: string;
  model: string;
  backend: "ollama" | "anthropic" | "adapter" | "openai";
  redactions: number;
  rules_applied: string[];
  session_id?: string;
  /** What the hub decided this turn was (auto mode). */
  mode?: Mode;
  ledger_id?: string;
  /** Module 5: set when a troubleshoot or plan reply held three or more numbered steps and became a procedure. */
  procedure_id?: string;
  /** Tools the assistant called for this reply, in order. */
  actions?: ToolAction[];
  /** A host command that waits for the owner's approval. */
  pending_action?: PendingApproval;
  /** Image ids stored with the user turn. */
  images?: string[];
  /** Image ids a tool made for this reply (generate_image), also stored on the assistant turn. */
  reply_images?: string[];
}

export interface ToolAction { tool: string; ok: boolean; writes: boolean; items?: TouchedItem[] }

/**
 * The items a write tool returned (an entity, or entities one level down such as `created`), so the next turn knows
 * what "that event" is. Without them a follow-up like "make it one block" guessed ids and failed first.
 */
/** The items this chat saved or changed, newest state of each, most recent last (at most 12). */
export function recentItems(history: StoredMessage[]): TouchedItem[] {
  const byId = new Map<string, TouchedItem>();
  for (const m of history) for (const a of m.actions ?? []) for (const i of a.items ?? []) {
    byId.delete(i.id);
    byId.set(i.id, { ...(byId.get(i.id) ?? {}), ...i });
  }
  return [...byId.values()].slice(-12);
}

export function touchedItems(tool: string, text: string): TouchedItem[] {
  let out: unknown;
  try { out = JSON.parse(text); } catch { return []; }
  const items: TouchedItem[] = [];
  const take = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const e = v as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.kind !== "string") return false;
    const label = [e.title, e.name, e.text, e.key].find((x) => typeof x === "string" && x) as string | undefined;
    items.push({ id: e.id, kind: e.kind, ...(label ? { title: label.slice(0, 80) } : {}), ...(tool === "delete_item" ? { deleted: true } : {}) });
    return true;
  };
  if (!take(out) && out && typeof out === "object") {
    for (const v of Object.values(out as Record<string, unknown>)) {
      if (Array.isArray(v)) v.slice(0, 5).forEach(take); else take(v);
    }
  }
  return items.slice(0, 8);
}
export type ChatEvent =
  | { type: "tool"; tool: string; ok: boolean; writes: boolean }
  | { type: "approval"; action: PendingApproval }
  | { type: "status"; text: string }
  /** The assistant wants recent photos from the iPhone that is streaming this chat; it answers on POST /ai/photos/:id. */
  | { type: "photos_request"; id: string; count: number; since_days?: number };

const MAX_TOOL_ROUNDS = 8;
/** Tokens kept free for the reply and for tool results inside one turn. */
const REPLY_RESERVE = 6000;
/** Images sent per request; older ones in the window are described as "[image]" only. */
const MAX_IMAGES_SENT = 3;
/** No warm-up this soon after the model was last used: its cache most likely still holds the shared start. */
const WARM_QUIET_MS = 3 * 60_000;
/** Questions about the record ("how often has it failed", "when did it last fail") read history; they are not a fault to fix. */
/** The Watch's chats ("watch-<day>-...") are read aloud on the wrist: lists and long answers do not work there. */
const WATCH_NOTE = "{{owner}} is asking from the Apple Watch and hears the answer read aloud: answer in one to three short spoken sentences, with no lists, headings, tables or formatting.";

/** A reply line that opens by saying something was saved or changed. */
const CLAIMS_CHANGE = /^\W*(?:done(?=[.!,:\s]|$)|(?:logged|saved|added|deleted|removed|moved|marked|snoozed|renamed|parked|scheduled|blocked|stopped|updated|changed|created|cancell?ed)\b)/im;

/** The owner's message is about sleep or the hour: then a reply may talk about going to bed. */
const SLEEP_ASKED = /\b(sleep|slept|bed|tired|rest|nap|late|insomnia|awake)\b/i;
/**
 * A sentence telling the owner to go to bed when they did not ask. The prompt says not to, and the model still opened
 * one reply in three after midnight with "it's 3 AM, go to bed".
 */
const UNASKED_BEDTIME = { name: "unasked-bedtime", pattern: /[^.!?\n]*\b(go to bed|get some sleep|get some rest|head to bed|go to sleep)\b[^.!?\n]*[.!?]?[ \t]*/gi, replacement: "" };

const RECORD_QUESTION = /^\s*(how (often|many times|many)|when (did|was)|how long (did|was))\b/i;
const TROUBLE = /\b(error|errors|failed|failing|fails|failure|exception|traceback|stack trace|not working|doesn'?t work|won'?t (start|boot|connect|load|mount)|can'?t (connect|reach|ssh|mount|log ?in|access)|refused|timed? ?out|denied|crash(ed|es|ing)?|broken|broke|hangs?|stuck|segfault|panic|degraded|offline|unreachable|fix|issue|issues|problem|problems|stopped \w+ing|not (responding|mounting|starting|booting|loading|connecting|syncing|running|showing)|keeps \w+ing|(wifi|wi-?fi|internet|connection|network|signal|bluetooth|vpn|tailscale|ssh|stream|audio|video)('s)?\s+(\w+\s+)?(drops|dropping|cuts out)|disconnects?|disconnecting|disconnected|buffering|lagging|didn'?t run|won'?t \w+)\b/i;

/** Classifier answer. `via` says who decided: the shared rules, the model, or nobody because the model was off or timed out. */
export interface ClassifyResult {
  kind: "task" | "note" | "reminder" | "log" | "fact" | "none";
  fields: Record<string, unknown>;
  via: "rules" | "model" | "unavailable";
}

export class Gateway {
  private backends: BackendSet;
  private api: ApiCall | null = null;
  readonly sessions: Sessions;
  readonly images: ImageStore;
  readonly hosts: HostActions;
  /**
   * Chats with a reply in progress, so any device that opens one shows that the assistant is still working, even
   * after leaving the screen or on another device. In memory only: a restart ends every turn anyway.
   */
  readonly working = new Map<string, { since: string; status: string | null; tool: string | null }>();
  /** When a chat or a warm-up last used the model (ms). */
  private lastModelUse = 0;

  /** The owner's name, put in place of `{{owner}}` in what the hub sends a model (profile.ts). */
  owner: () => string = () => this.cfg.ownerName;
  /** The owner's pet, for prompts written about `{{pet}}` (empty: no pet). */
  pet: () => string = () => "";
  /** Which modules are on (Settings, Modules): tools and guide lines of a module that is off are left out. */
  moduleOn: ModuleCheck = () => true;
  private names = () => ({ owner: this.owner(), pet: this.pet() });

  constructor(private cfg: Config, private store: Store, readonly chatDb: DB) {
    this.backends = personalBackends(buildBackends(cfg), () => this.names());
    this.sessions = new Sessions(chatDb);
    const tidied = this.sessions.tidyCaptureThreads();
    if (tidied) console.log(`[ai] ${tidied} capture chats now show the capture instead of the filing prompt`);
    this.images = new ImageStore(path.join(cfg.dataDir, "ai-images"));
    this.hosts = new HostActions(cfg, chatDb, store);
  }

  /** Give the assistant its tools: an in-process caller of the hub's own API (set by createApp). */
  setApi(api: ApiCall): void { this.api = api; }

  private toolsFor(mode: Mode, backend: Backend): boolean {
    return this.cfg.aiTools && !!this.api && !!backend.streamTools && mode !== "draft" && mode !== "classify";
  }

  /** Stream rounds with tools until the model answers without calling one. */
  private async toolLoop(backend: Backend, base: AiMessage[], ctx: ToolContext, onToken: (t: string) => void, onEvent: ((e: ChatEvent) => void) | undefined, actions: ToolAction[]): Promise<{ text: string; usage: Usage }> {
    const messages: AiMessage[] = base.map((m) => ({ ...m }));
    const tools = availableTools(this.cfg, undefined, ctx.moduleOn ?? this.moduleOn);
    const specs = toolSpecs(tools);
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
    const add = (u: Usage) => { usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0); usage.completion_tokens = (usage.completion_tokens ?? 0) + (u.completion_tokens ?? 0); };
    let checked = false;
    // A local model reads only its context: tool results that would push the request past it are cut to fit.
    const specTokens = estimateTokens(JSON.stringify(specs));
    const ctxLimit = (this.cfg.ollamaNumCtx > 0 ? this.cfg.ollamaNumCtx : 8192) - REPLY_RESERVE;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (!backend.cloud) fitToolResults(messages, specTokens, ctxLimit);
      const r = await backend.streamTools!(messages, specs, onToken);
      add(r.usage);
      if (!r.tool_calls?.length) {
        // A reply that says it saved or changed something when no tool call did: once, have it do it or say otherwise.
        // ("Logged. Soldering marked as ended." with no call, so the activity never ended.)
        if (!checked && CLAIMS_CHANGE.test(r.text) && !actions.some((a) => a.ok && a.writes)) {
          checked = true;
          messages.push({ role: "assistant", content: r.text }, { role: "user", content: "[Check from Aeneas, not typed by {{owner}}] Your reply says something was saved or changed, but no tool call in this reply did it. If {{owner}} asked for a change, make the tool call now; otherwise answer again without saying anything changed." });
          continue;
        }
        if (r.text.trim() || !actions.length) return { text: r.text, usage };
        // Some models stop silently after a tool call; make them say what happened.
        messages.push({ role: "assistant", content: "" }, { role: "user", content: "Tell {{owner}} in one or two sentences what you did and the result, including anything that failed." });
        if (!backend.cloud) fitToolResults(messages, 0, ctxLimit);
        const said = await backend.stream(messages, onToken);
        add(said.usage);
        return { text: said.text, usage };
      }
      messages.push({ role: "assistant", content: r.text, tool_calls: r.tool_calls });
      for (const tc of r.tool_calls) {
        const out = await runTool(this.api!, { name: tc.function.name, arguments: tc.function.arguments }, ctx, tools);
        const items = out.ok && out.writes ? touchedItems(tc.function.name, out.text) : [];
        actions.push({ tool: tc.function.name, ok: out.ok, writes: out.writes, ...(items.length ? { items } : {}) });
        onEvent?.({ type: "tool", tool: tc.function.name, ok: out.ok, writes: out.writes });
        messages.push({ role: "tool", tool_name: tc.function.name, content: out.text });
      }
      // Pictures a tool fetched (phone photos) go to the model as a message it can see.
      for (const m of ctx.drainModelImages?.() ?? []) messages.push({ role: "user", content: m.note, images: m.images });
    }
    // Out of rounds: answer from what was gathered, without offering tools again.
    messages.push({ role: "user", content: "Answer now from the tool results above. Do not call more tools." });
    if (!backend.cloud) fitToolResults(messages, 0, ctxLimit);
    const last = await backend.stream(messages, onToken);
    add(last.usage);
    return { text: last.text, usage };
  }

  /** Names of the backends this process can talk to, for /status. */
  configuredBackends(): string[] {
    const o = getBackendOverride();
    if (o) return [o.name];
    return (["ollama", "openai", "anthropic", "adapter"] as const).filter((n) => !!this.backends[n]);
  }

  /** Build the backends again after the owner chose a model in setup (setup.ts changed the config). */
  rebuildBackends(): void {
    this.backends = personalBackends(buildBackends(this.cfg), () => this.names());
  }

  /** What clients may offer. */
  private photoWaits = new Map<string, (photos: DevicePhoto[]) => void>();

  /** Ask the streaming iPhone for its newest photos and wait up to a minute for them. */
  private askPhotos(count: number, sinceDays: number | undefined, onEvent: (e: ChatEvent) => void): Promise<DevicePhoto[]> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.photoWaits.delete(id); reject(new Error("The iPhone did not send photos within a minute (is the app open with photo library access on?)")); }, 60_000);
      this.photoWaits.set(id, (photos) => { clearTimeout(timer); this.photoWaits.delete(id); resolve(photos); });
      onEvent({ type: "photos_request", id, count, ...(sinceDays ? { since_days: sinceDays } : {}) });
    });
  }

  /** The iPhone's answer to a photos_request. False when nothing is waiting for it (late or unknown). */
  deliverPhotos(id: string, photos: DevicePhoto[]): boolean {
    const w = this.photoWaits.get(id);
    if (!w) return false;
    w(photos);
    return true;
  }

  capabilities(): { cloud: boolean; tools: boolean; model: string | null; images: boolean; web: boolean; hosts: boolean; voice_model: boolean; synced_sessions: boolean } {
    const o = getBackendOverride();
    const local = o ?? this.backends.ollama;
    return {
      cloud: !o && this.hasCloud(), tools: this.cfg.aiTools && !!local?.streamTools, model: local?.model ?? null,
      images: !!local && this.moduleOn("images"), web: !!this.cfg.searxngUrl && webPrivate(this.cfg) && this.moduleOn("web"), hosts: this.cfg.hostActions && this.moduleOn("homelab"), voice_model: !!this.backends.adapter, synced_sessions: true,
    };
  }

  /** True when any chat backend exists. */
  available(): boolean {
    return !!(getBackendOverride() || this.backends.ollama || this.backends.ollamaFallback || this.backends.anthropic || this.backends.adapter || this.backends.openai);
  }

  /** A cloud model is set up: Anthropic, or an OpenAI-compatible server that is not on this network. */
  private hasCloud(): boolean { return !!this.backends.anthropic || !!this.backends.openai?.cloud; }
  /** A model on the owner's own machines is set up. */
  private hasLocal(): boolean { return !!(this.backends.ollama || this.backends.ollamaFallback || this.backends.adapter || (this.backends.openai && !this.backends.openai.cloud)); }

  /**
   * Whether this request may go to a cloud model. A request that says no (every background job: mail, note tags,
   * imports) never does. Otherwise the owner's choice, and yes when a cloud model is the only one they set up
   * (Welcome, "use a cloud model"), since that was the choice.
   */
  private cloudAllowed(req: { allow_cloud?: boolean }): boolean {
    if (!this.hasCloud()) return false;
    return req.allow_cloud ?? (this.cfg.allowCloudDefault || !this.hasLocal());
  }

  /** Backend order per task type. The first one that answers wins. */
  route(taskType: Mode | "auto", cloud: boolean): Backend[] {
    const o = getBackendOverride();
    // A stand-in model (tests, evals) gets the owner's name too, like every real one.
    if (o) return [this.guarded(personalBackend(o, this.names))];
    const b = this.backends;
    // Without cloud, a cloud backend is never in the chain, whatever its name (an OpenAI-compatible server can be one).
    const pick = (...xs: (Backend | null)[]) => xs.filter((x): x is Backend => !!x && (cloud || !x.cloud)).map((x) => this.guarded(x));
    switch (taskType) {
      // The OpenAI-compatible server comes after Ollama: it is the model when there is no Ollama, else the last resort.
      case "draft": return pick(b.adapter, b.ollama, b.ollamaFallback ?? null, b.openai ?? null);
      case "classify": return pick(b.ollama, b.ollamaFallback ?? null, b.openai ?? null);
      default: return cloud ? pick(b.anthropic, b.ollama, b.ollamaFallback ?? null, b.openai ?? null) : pick(b.ollama, b.ollamaFallback ?? null, b.openai ?? null);
    }
  }

  /** Rule patterns applied after generation, on top of the shared default style filter. */
  private filterRules(): { name: string; pattern: RegExp; replacement: string }[] {
    const out: { name: string; pattern: RegExp; replacement: string }[] = [];
    for (const r of this.store.list({ kind: "rule" })) {
      const f = r.fields as { text: string; enforce: string; pattern?: string; flags?: string; replacement?: string; active?: boolean };
      if (f.active === false || !f.pattern || (f.enforce !== "filter" && f.enforce !== "both")) continue;
      try {
        out.push({ name: `rule:${f.text.slice(0, 60)}`, pattern: new RegExp(f.pattern, f.flags ?? "g"), replacement: f.replacement ?? "" });
      } catch (e) {
        console.error(`[ai] rule ${r.id} has an invalid pattern and is skipped`);
      }
    }
    return out;
  }

  /** One wrapper per cloud backend, so a chain built twice holds the same object. */
  private guards = new WeakMap<Backend, Backend>();

  /**
   * A cloud backend whose every message is scrubbed on the way out: private fact values and work item titles are
   * taken out of whatever carries them (the turns, tool results, the context note, a summary, a draft or a resume
   * card). The tools and memory already leave work and private facts out for a cloud model; this is the one place
   * nothing can get past, so a path that forgets cannot send them.
   */
  private guarded(b: Backend): Backend {
    if (!b.cloud) return b;
    const known = this.guards.get(b);
    if (known) return known;
    const scrub = (ms: AiMessage[]): AiMessage[] => {
      const out = cloudScrubber(cloudSecrets(this.store));
      return ms.map((m) => ({ ...m, content: out(m.content) }));
    };
    const g: Backend = Object.assign(Object.create(b) as Backend, {
      chat: (ms: AiMessage[], o?: { json?: boolean; signal?: AbortSignal }) => b.chat(scrub(ms), o),
      stream: (ms: AiMessage[], on: (t: string) => void, o?: { signal?: AbortSignal }) => b.stream(scrub(ms), on, o),
      ...(b.streamTools ? { streamTools: (ms: AiMessage[], tools: unknown[], on: (t: string) => void, o?: { signal?: AbortSignal }) => b.streamTools!(scrub(ms), tools, on, o) } : {}),
    });
    this.guards.set(b, g);
    return g;
  }

  private privateLiterals(): string[] {
    return this.store.list({ kind: "fact" }).filter((f) => f.fields.private === true).map((f) => String(f.fields.value ?? "")).filter((v) => v.length >= 4);
  }

  private record(row: { session_id?: string; task_type?: string; backend: string; model: string; redactions: number; usage?: Usage; ms: number; ok: boolean; error?: string }): void {
    this.chatDb.prepare(
      "INSERT INTO ai_calls (at, session_id, task_type, backend, model, redactions, prompt_tokens, completion_tokens, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(nowIso(), row.session_id ?? null, row.task_type ?? null, row.backend, row.model, row.redactions, row.usage?.prompt_tokens ?? null, row.usage?.completion_tokens ?? null, row.ms, row.ok ? 1 : 0, row.error ?? null);
  }

  /** Session as stored (internal callers: session close, quiz). */
  getSession(id: string): { session_id: string; task_type: string; created_at: string; last_at: string; messages: StoredMessage[]; title: string; summary: string | null } | null {
    return this.sessions.get(id);
  }

  /**
   * Auto mode: troubleshooting when something is failing or the session already has a ledger. Naming a host alone
   * ("what GPU is in the server?") or asking about the record ("how often has the backup failed?") is a plain question:
   * troubleshooting would open a ledger and write fix notes for it.
   */
  private resolveMode(req: ChatInput, text: string): Mode {
    const t = req.task_type ?? "auto";
    if (t !== "auto") return t;
    if (this.store.list({ kind: "ledger", where: { session_id: req.session_id } }).some((l) => l.fields.open !== false)) return "troubleshoot";
    if (TROUBLE.test(text) && !RECORD_QUESTION.test(text)) return "troubleshoot";
    return "general";
  }

  /** Model-facing text of one stored turn: approvals carry the command output the model needs. */
  private turnText(m: StoredMessage): string {
    if (m.role === "user" && m.approval) {
      const a = this.hosts.get(m.approval.action_id);
      const out = a?.output ? `\n\`\`\`\n${a.output.slice(-6000)}\n\`\`\`` : "";
      return `${m.content}\n\n[Approved. The hub ran \`${m.approval.command}\` on ${m.approval.host}: ${a?.status ?? "unknown"}, exit ${a?.exit_code ?? "none"}.]${out}`;
    }
    if (m.role === "assistant" && m.approval && m.approval.status === "pending") {
      return `${m.content}\n\n[Waiting for {{owner}}'s approval: \`${m.approval.command}\` on ${m.approval.host}.]`;
    }
    return m.content;
  }

  /** Fold turns that no longer fit into the session summary. One model call, no tools; falls back to a plain list. */
  private async summarize(sessionId: string, backend: Backend, previous: string | null, turns: StoredMessage[], upto: number): Promise<string> {
    const t0 = Date.now();
    let summary: string;
    try {
      const literals = this.privateLiterals();
      const r = await backend.chat([{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: summaryPrompt(previous, turns.map((m) => ({ ...m, content: redact(this.turnText(m), literals).text }))) }]);
      this.record({ session_id: sessionId, task_type: "summary", backend: backend.name, model: backend.model, redactions: 0, usage: r.usage, ms: Date.now() - t0, ok: true });
      summary = r.text.trim() || fallbackSummary(previous, turns);
    } catch (e) {
      this.record({ session_id: sessionId, task_type: "summary", backend: backend.name, model: backend.model, redactions: 0, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 500) });
      summary = fallbackSummary(previous, turns);
    }
    this.sessions.setSummary(sessionId, summary, upto);
    return summary;
  }

  /** Draft in the owner's voice: the adapter when configured, else the local model with their rules and identity facts. */
  private async voiceDraft(sessionId: string, request: string, allowCloud: boolean): Promise<{ text: string; backend: string; model: string } | null> {
    const system = (cloud: boolean) => buildSystemPrompt(loadMemory(this.store, { cloud, allowWork: false }), "draft");
    // The chat's own choice: a chat sent with allow_cloud false never has its draft written by a cloud model.
    return this.draft(`${sessionId}:draft`, system, request, { allow_cloud: allowCloud });
  }

  /** Full pipeline. `onToken` receives raw tokens when the backend streams. */
  /** The turn in flight per stored chat: a second turn on the same chat waits for it (each saves the whole chat). */
  private turnLocks = new Map<string, Promise<void>>();

  async chat(req: ChatInput, onToken?: (t: string) => void, onEvent?: (e: ChatEvent) => void): Promise<ChatOutput> {
    if (req.task_type === "classify") return this.turn(req, onToken, onEvent);
    // Two turns on one chat at once (the Watch asking again, a second device) each saved the chat as it read it at
    // the start, so one turn and its answer were lost. They now run one after the other, the second reading the first.
    if (!req.messages?.length) {
      const before = this.turnLocks.get(req.session_id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const chained = before.then(() => mine);
      this.turnLocks.set(req.session_id, chained);
      await before;
      try { return await this.chatTurn(req, onToken, onEvent); }
      finally { release(); if (this.turnLocks.get(req.session_id) === chained) this.turnLocks.delete(req.session_id); }
    }
    return this.chatTurn(req, onToken, onEvent);
  }

  private async chatTurn(req: ChatInput, onToken?: (t: string) => void, onEvent?: (e: ChatEvent) => void): Promise<ChatOutput> {
    const w = { since: nowIso(), status: null as string | null, tool: null as string | null };
    this.working.set(req.session_id, w);
    this.lastModelUse = Date.now();
    // A chat goes first: background model work in flight (the mail filer) is stopped and tried again later.
    for (const c of this.background) c.abort(new Error("a chat started"));
    try {
      return await this.turn(req, onToken, (e) => {
        if (e.type === "status") w.status = e.text;
        if (e.type === "tool") { w.tool = e.tool; w.status = null; }
        onEvent?.(e);
      });
    } finally {
      if (this.working.get(req.session_id) === w) this.working.delete(req.session_id);
      this.lastModelUse = Date.now();
    }
  }

  /**
   * Read the start every chat shares (the system prompt and the tool list, about 13k tokens) into the local model
   * server's cache, so the first message after a break does not wait for it: about 10 s on a 24 GB card, which any other
   * program using that server, a model reload or a change to the facts or lists makes it pay again. Clients call this
   * when the Assistant opens. Skipped while a chat runs or soon after one, when the cache most likely holds it.
   */
  /** Background model calls in flight; a chat that starts stops them. */
  private readonly background = new Set<AbortController>();

  /**
   * One JSON answer from the local model for background work (the mail filer, the note linker). It gives way to the owner: a chat that
   * starts stops it, and the answer is then `{ stopped: true }` so the caller tries again later without counting a failure.
   */
  async backgroundJson(sessionId: string, system: string, user: string): Promise<{ text: string | null; stopped: boolean }> {
    // A game on the card the model would load into: background work waits (answered as stopped, so it is tried again
    // later without counting a failure), so a game never stutters for a note's links or a mail's filing.
    if (await this.gameRunning()) return { text: null, stopped: true };
    // The system prompt is the hub's own and is sent about the owner (personalBackend). The user prompt carries an
    // email or a note as written, so it goes as it is: a name in it is that person or pet.
    const ctl = new AbortController();
    this.background.add(ctl);
    // Another person's chat on a shared model gate stops it the same way one of the owner's own chats does.
    let gaveWay = false;
    try {
      const text = await withPriority("background", () => this.completeJson(sessionId, system, user, { allow_cloud: false, signal: ctl.signal, onGaveWay: () => { gaveWay = true; } }));
      const stopped = ctl.signal.aborted || gaveWay;
      return { text: stopped ? null : text, stopped };
    } finally {
      this.background.delete(ctl);
    }
  }

  private gameCheck: { at: number; busy: string | null } | null = null;
  /**
   * A game (or another 3D program) on this machine's graphics card, asked at most every 30 seconds (on Windows the
   * question takes about 2.5 s), and only when the model server in use is on this machine: a model server on another
   * computer has its own card. Null when the card is free for background work.
   */
  async gameRunning(now = Date.now()): Promise<string | null> {
    if (!this.cfg.ollamaUrl || !onThisMachine(this.cfg.ollamaUrl)) return null;
    if (this.gameCheck && now - this.gameCheck.at < 30_000) return this.gameCheck.busy;
    const busy = await gpuBusyNow(this.working.size > 0);
    if (busy !== (this.gameCheck?.busy ?? null)) console.log(busy ? `[ai] background model work waits: ${busy}` : "[ai] the graphics card is free again for background model work");
    this.gameCheck = { at: now, busy };
    return busy;
  }

  /** No chat is running and none ran for `ms`: background model work (mail, notes) waits for this, so it never slows a reply. */
  quiet(ms: number): boolean {
    return !this.working.size && Date.now() - this.lastModelUse >= ms;
  }

  async warm(): Promise<{ warmed: boolean; reason?: string; host?: string; read?: number; ms?: number }> {
    if (this.working.size) return { warmed: false, reason: "a chat is running" };
    if (Date.now() - this.lastModelUse < WARM_QUIET_MS) return { warmed: false, reason: "used recently" };
    this.lastModelUse = Date.now();
    for (const c of this.background) c.abort(new Error("the assistant opened"));
    const chain = await fastestFirst(this.route("general", false));
    const backend = chain.find((b) => b.warm && this.toolsFor("general", b));
    if (!backend) return { warmed: false, reason: "no local model with tools" };
    if (backend.probe && !(await backend.probe())) return { warmed: false, reason: `${backend.host ?? backend.name} is not answering` };
    // As chats load it: no client asks for work items in the assistant.
    const memory = loadMemory(this.store, { cloud: false, allowWork: false });
    const t0 = Date.now();
    try {
      const read = await withPriority("warm", () => backend.warm!([{ role: "system", content: this.sharedSystem(memory, "general", true) }, { role: "user", content: "." }], toolSpecs(availableTools(this.cfg, undefined, this.moduleOn))));
      return { warmed: true, host: backend.host, read, ms: Date.now() - t0 };
    } catch (e) {
      // The shared model gate turns a warm-up away while someone else is using the model: not a failure.
      if (/shared model|used the shared model/.test((e as Error).message)) return { warmed: false, reason: (e as Error).message.replace(/^\w+: /, "") };
      console.error(`[ai] warm-up on ${backend.host ? logHost(backend.host) : backend.name} failed: ${errCode(e)}`);
      return { warmed: false, reason: (e as Error).message.slice(0, 200) };
    } finally { this.lastModelUse = Date.now(); }
  }

  /** Snippets from the fix the owner just said worked: the changes run in this chat and the commands in the last reply. */
  private harvest(sessionId: string, topic: string, history: StoredMessage[]): Entity[] {
    const newest = history.map((m) => m.role).lastIndexOf("user");
    const previousReply = [...history.slice(0, Math.max(0, newest))].reverse().find((m) => m.role === "assistant")?.content ?? "";
    try {
      return harvestSnippets(this.store, { sessionId, topic, previousReply, actions: this.cfg.hostActions ? this.hosts.doneChanges(sessionId) : [], hosts: this.hosts.hosts(), privateLiterals: this.privateLiterals() });
    } catch (e) {
      console.error(`[ai] snippets from the fix skipped: ${errCode(e)}`);
      return [];
    }
  }

  /** The system prompt as every chat in a mode starts it; `warm` must send exactly this to be of use. */
  private sharedSystem(memory: Memory, mode: Mode, tools: boolean, on: ModuleCheck = this.moduleOn): string {
    return tools ? `${buildSystemPrompt(memory, mode)}\n\n${toolGuide(on)}` : buildSystemPrompt(memory, mode);
  }

  private async turn(req: ChatInput, onToken?: (t: string) => void, onEvent?: (e: ChatEvent) => void): Promise<ChatOutput> {
    const startedAt = nowIso();
    const stored = this.sessions.get(req.session_id);
    const clientSystem = (req.messages ?? []).filter((m) => m.role === "system").map((m) => m.content);
    let history: StoredMessage[];
    let imageIds: string[] = [];
    if (req.messages?.length) {
      history = req.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      // Pictures with a one-off request (a capture's photo when it is filed) go with its last user turn.
      if (req.images?.length) {
        imageIds = req.images.map((b64) => this.images.save(b64));
        const u = history.map((m) => m.role).lastIndexOf("user");
        if (u >= 0) history[u] = { ...history[u], images: imageIds };
      }
    } else {
      history = [...(stored?.messages ?? [])];
      imageIds = (req.images ?? []).map((b64) => this.images.save(b64));
      // Attached pictures also go to the gallery's Saved bin, so they can be reused as references.
      for (const id of imageIds) recordImage({ store: this.store, ai: { images: this.images } }, id, "attached", { session_id: req.session_id, title: (req.message ?? "").trim().split("\n")[0].slice(0, 80) || "Attached in a chat" });
      const turn: StoredMessage = { role: "user", content: (req.message ?? "").trim(), at: nowIso(), ...(imageIds.length ? { images: imageIds } : {}) };
      if (req.approve_action_id) {
        const a = this.hosts.get(req.approve_action_id);
        if (!a || a.session_id !== req.session_id) throw new StoreError(404, "no such action in this chat");
        // A change proposed before Homelab was switched off does not run after it.
        if (!this.moduleOn("homelab")) throw new StoreError(409, "Homelab is switched off, so commands on your machines do not run; switch it on in Settings, Modules");
        onEvent?.({ type: "status", text: `Running on ${a.host}` });
        try {
          const done = await this.hosts.approve(a.id);
          turn.approval = { action_id: a.id, host: a.host, command: a.command, status: done.action.status, exit_code: done.action.exit_code };
          onEvent?.({ type: "tool", tool: "run_command", ok: done.action.status === "done", writes: true });
        } catch (e) {
          turn.approval = { action_id: a.id, host: a.host, command: a.command, status: this.hosts.get(a.id)?.status ?? "failed", exit_code: null };
          turn.content = `${turn.content}${turn.content ? "\n" : ""}(Approval failed: ${(e as Error).message})`;
        }
        if (!turn.content) turn.content = "Yes, run it.";
        // The assistant turn that proposed it is no longer waiting.
        for (const m of history) if (m.approval?.action_id === a.id) m.approval = { ...m.approval, status: turn.approval.status };
      }
      history.push(turn);
    }
    // The chat as stored: the visible turn in place of an internal prompt.
    const kept = (h: StoredMessage[]): StoredMessage[] => {
      if (req.store_as === undefined) return h;
      const i = h.map((m) => m.role).lastIndexOf("user");
      return h.map((m, j) => (j === i ? { ...m, content: req.store_as! } : m));
    };
    const mode = req.task_type === "classify" ? "classify" : this.resolveMode(req, history.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join("\n"));
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    const topic = (history.find((m) => m.role === "user")?.content ?? "").split("\n")[0];
    const chain = await fastestFirst(this.route(mode, this.cloudAllowed(req)));
    if (!chain.length) throw new StoreError(500, "no AI backend is configured for this task type");
    // Store the user's turn now, so the chat is on every device (and in every list) while the reply is worked on.
    if (!req.messages?.length && mode !== "classify") this.sessions.save(req.session_id, mode, history);

    let ledger: Entity | null = null;
    if (mode === "troubleshoot") {
      ledger = openLedger(this.store, req.session_id, topic);
      // A message that says it worked is never also a failure, whatever else it says.
      if (!saysWorked(lastUser)) ledger = recordFailure(this.store, ledger, lastUser);
    }

    let summary = req.messages?.length ? null : stored?.summary ?? null;
    let summaryUpto = req.messages?.length ? 0 : stored?.summary_upto ?? 0;
    let pending: PendingApproval | undefined;
    // Images a tool made this turn (generate_image): shown under the reply on every device.
    const replyImages: string[] = [];
    const modelImages: { note: string; images: string[] }[] = [];
    let lastErr: Error | null = null;
    const turnOn: ModuleCheck = req.no_web ? (id) => id !== "web" && this.moduleOn(id) : this.moduleOn;
    // A model shared with other people's hubs (the model gate) may be answering someone else right now: say so, so a
    // slower start is explained. Who it is stays private.
    const first = chain.find((b) => b.waiting);
    if (first && onEvent && mode !== "classify" && (await first.waiting!()) > 0) onEvent({ type: "status", text: "Waiting for the shared model" });
    for (const backend of chain) {
      if (backend.probe && !(await backend.probe())) { lastErr = new Error(`${backend.host ?? backend.name} is not answering`); console.error(`[ai] skipped ${backend.host ? logHost(backend.host) : backend.name}: not answering`); continue; }
      const cloud = !!backend.cloud;
      const tools = this.toolsFor(mode, backend);
      const memory = loadMemory(this.store, { cloud, allowWork: req.allow_work === true }, req.session_id, history.map((m) => ({ role: m.role, content: m.content })));
      let system = this.sharedSystem(memory, mode, tools, turnOn);
      if (clientSystem.length) system += `\n\n${clientSystem.join("\n\n")}`;
      const toolTokens = tools ? estimateTokens(JSON.stringify(toolSpecs(availableTools(this.cfg, undefined, turnOn)))) : 0;
      const budget = Math.max(2000, (this.cfg.ollamaNumCtx > 0 ? this.cfg.ollamaNumCtx : 8192) - estimateTokens(system) - toolTokens - (summary ? estimateTokens(summary) : 0) - REPLY_RESERVE);
      // Counted as sent: an approved turn carries up to 6000 characters of command output (turnText).
      const plan = planWindow(history.map((m) => ({ ...m, content: this.turnText(m) })), summaryUpto, budget);
      if (plan.needsSummary) {
        onEvent?.({ type: "status", text: "Condensing earlier messages" });
        summary = await this.summarize(req.session_id, backend, summary, history.slice(summaryUpto, plan.start), plan.start);
        summaryUpto = plan.start;
      }
      const start = Math.max(plan.start, summaryUpto);
      if (summary && start > 0) system += `\n\nEarlier in this conversation (summary; the turns themselves are no longer shown):\n${summary}`;

      const literals = this.privateLiterals();
      const emails = req.space === "work";
      let redactions = 0;
      let imagesLeft = cloud ? 0 : MAX_IMAGES_SENT;
      const window = history.slice(start);
      const convo: AiMessage[] = [];
      for (let i = window.length - 1; i >= 0; i--) {
        const m = window[i];
        const r = redact(this.turnText(m), literals, { emails });
        redactions += r.count;
        const imgs: string[] = [];
        for (const id of m.images ?? []) {
          if (imagesLeft <= 0) continue;
          const b64 = this.images.base64(id);
          if (b64) { imgs.push(b64); imagesLeft--; }
        }
        const dropped = (m.images?.length ?? 0) - imgs.length;
        convo.unshift({ role: m.role, content: r.text + (dropped > 0 ? `\n[${dropped} earlier image(s) not shown again]` : ""), ...(imgs.length ? { images: imgs } : {}) });
      }
      // The clock, ledger and host memory go on the newest user turn, so the system prompt stays cacheable.
      const newest = convo.map((m) => m.role).lastIndexOf("user");
      if (newest >= 0) convo[newest] = { ...convo[newest], content: `${turnContext(memory, mode, new Date(), recentItems(history), req.session_id.startsWith("watch-") ? WATCH_NOTE : undefined)}\n\n${convo[newest].content}` };
      const messages: AiMessage[] = [{ role: "system", content: system }, ...convo];
      const ctx: ToolContext = {
        sessionId: req.session_id, lastUser, topic, store: this.store, cfg: this.cfg, owner: this.owner(), hosts: this.cfg.hostActions && this.moduleOn("homelab") ? this.hosts : null,
        moduleOn: turnOn,
        // Work items never reach a cloud model, through memory or through what a tool returns.
        cloud,
        draft: (request) => this.voiceDraft(req.session_id, request, this.cloudAllowed(req)),
        onApproval: (a) => { pending = a; onEvent?.({ type: "approval", action: a }); },
        addImage: (id) => { if (!replyImages.includes(id)) replyImages.push(id); },
        saveImage: (b64) => this.images.save(b64),
        showModel: (note, imgs) => { modelImages.push({ note, images: imgs }); },
        drainModelImages: () => modelImages.splice(0),
        // Only a streaming iPhone that said it has photo library access can be asked for photos.
        ...(req.device?.photos && onEvent ? { askDevicePhotos: (count: number, sinceDays?: number) => this.askPhotos(count, sinceDays, onEvent) } : {}),
        userImages: imageIds,
        onStatus: (text) => onEvent?.({ type: "status", text }),
      };
      const t0 = Date.now();
      const actions: ToolAction[] = [];
      try {
        const result = tools
          ? await this.toolLoop(backend, messages, ctx, onToken ?? (() => {}), onEvent, actions)
          : onToken ? await backend.stream(messages, onToken) : await backend.chat(messages);
        const ms = Date.now() - t0;
        const styled = applyStyle(result.text, [...this.filterRules(), ...(SLEEP_ASKED.test(lastUser) ? [] : [UNASKED_BEDTIME])]);
        this.record({ session_id: req.session_id, task_type: mode, backend: backend.name, model: backend.model, redactions, usage: result.usage, ms, ok: true });
        // Module 2 pre-flight: a destructive command gets its block and a planned journal entry, once per reply.
        const pf = insertPreflight(styled.text);
        const applied = [...styled.applied];
        if (pf.inserted && pf.match && !pending && this.moduleOn("homelab")) {
          const hosts = knownHosts(this.store);
          const host = hostsIn(pf.match.command, hosts)[0] ?? hostsIn(pf.text, hosts)[0] ?? hostsIn(history.map((m) => m.content).join("\n"), hosts)[0] ?? "unknown";
          recordPlanned(this.store, pf.match, host, req.session_id);
          applied.push(`preflight:${pf.match.rule.name}`);
        }
        let reply = pf.text;
        // Module 2: once the owner says it worked, the commands that fixed it go to Snippets on their own.
        const saved = !pending && this.moduleOn("homelab") && saysWorked(lastUser) ? this.harvest(req.session_id, topic, history) : [];
        if (saved.length) reply += `\n\nSaved to Snippets: ${saved.map((s) => String(s.fields.title)).join("; ")}.`;
        // The automatic "tried" line is for steps handed to the owner. Commands the hub ran itself, or one waiting for approval,
        // are not theirs to try; the model records those results with ledger_update.
        if (ledger && !pending && !actions.some((a) => a.tool === "run_command" || a.tool === "approve_command") && !req.approve_action_id && (/```/.test(reply) || countNumberedSteps(reply) >= 1)) ledger = appendPending(this.store, ledger, reply);
        if (mode !== "classify") {
          // Cancel tapped while this reply still streamed: the action says so, and the chat must too.
          const pendingStatus = pending ? (this.hosts.get(pending.id)?.status ?? "pending") : undefined;
          const answer: StoredMessage = { role: "assistant", content: reply, at: nowIso(), ...(replyImages.length ? { images: [...replyImages] } : {}), ...(actions.length ? { actions } : {}), ...(pending ? { approval: { action_id: pending.id, host: pending.host, command: pending.command, status: pendingStatus } } : {}) };
          this.sessions.save(req.session_id, mode, [...kept(history), answer], req.messages?.length ? {} : { startedAt });
        }
        // Module 5: a reply with three or more numbered steps is offered as a procedure (rules only, never a second model call).
        let procedureId: string | undefined;
        if ((mode === "troubleshoot" || mode === "plan") && !pending && countNumberedSteps(reply) >= 3) {
          try {
            const parsed = splitSteps(reply);
            if (parsed.steps.length >= 3) procedureId = createProcedure(this.store, parsed, { title: (topic.trim() || parsed.title).slice(0, 120), source_session: req.session_id }).id;
          } catch (e) { console.error(`[ai] procedure from reply skipped: ${errCode(e)}`); }
        }
        return {
          reply, model: backend.model, backend: backend.name, redactions, rules_applied: applied, session_id: req.session_id, mode,
          ...(ledger ? { ledger_id: ledger.id } : {}), ...(procedureId ? { procedure_id: procedureId } : {}), ...(actions.length ? { actions } : {}),
          ...(pending ? { pending_action: pending } : {}), ...(imageIds.length ? { images: imageIds } : {}),
          ...(replyImages.length ? { reply_images: [...replyImages] } : {}),
        };
      } catch (e) {
        lastErr = e as Error;
        this.record({ session_id: req.session_id, task_type: mode, backend: backend.name, model: backend.model, redactions, ms: Date.now() - t0, ok: false, error: lastErr.message.slice(0, 500) });
        console.error(`[ai] ${backend.name} failed: ${errCode(lastErr)}`);
        // Tools already changed things in this attempt (a note saved, a task made): running the whole turn again on
        // the next model would do them twice. The reply says what was done; the caller sees the actions.
        const wrote = actions.filter((a) => a.ok && a.writes);
        if (wrote.length) {
          const named = wrote.flatMap((a) => (a.items ?? []).map((i) => String(i.title ?? "")).filter(Boolean));
          const reply = `Done before the model stopped answering: ${(named.length ? named : wrote.map((a) => a.tool)).join(", ")}. The rest of the reply did not come; ask again for anything missing.`;
          if (mode !== "classify") this.sessions.save(req.session_id, mode, [...kept(history), { role: "assistant", content: reply, at: nowIso(), actions }]);
          return { reply, model: backend.model, backend: backend.name, redactions, rules_applied: [], session_id: req.session_id, mode, actions };
        }
      }
    }
    // Keep the user's turn even when no model answered, so it is not lost and shows on every device.
    if (!req.messages?.length && mode !== "classify") this.sessions.save(req.session_id, mode, history);
    const tried = chain.map((b) => b.name).join(", ");
    throw new StoreError(503, `The assistant could not get a reply: no model answered (tried ${tried}). Try again in a few minutes.`, lastErr?.message);
  }

  /** Classifier: shared rules first, then the local model with a strict JSON instruction. */
  async classify(text: string, timeoutMs = this.cfg.classifyTimeoutMs): Promise<ClassifyResult> {
    const ruled: ClassifyResult = { ...classifyCapture(text), via: "rules" };
    if (ruled.kind !== "none") return ruled;
    const chain = this.route("classify", false);
    if (!chain.length) return { ...ruled, via: "unavailable" };
    const backend = chain[0];
    const t0 = Date.now();
    const messages: AiMessage[] = [{ role: "system", content: CLASSIFY_SYSTEM }, { role: "user", content: redact(text, this.privateLiterals()).text }];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("classify timeout")), timeoutMs);
      let result;
      try { result = await backend.chat(messages, { json: true, signal: ctl.signal }); } finally { clearTimeout(timer); }
      this.record({ task_type: "classify", backend: backend.name, model: backend.model, redactions: 0, usage: result.usage, ms: Date.now() - t0, ok: true });
      const raw = result.text.replace(/```(?:json)?/g, "").trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < 0) return { ...ruled, via: "model" };
      const obj = JSON.parse(raw.slice(start, end + 1)) as { kind?: string; fields?: Record<string, unknown> };
      const kind = ["task", "note", "reminder", "log", "fact", "none"].includes(obj.kind ?? "") ? (obj.kind as any) : "none";
      return { kind, fields: obj.fields && typeof obj.fields === "object" ? obj.fields : {}, via: "model" };
    } catch (e) {
      this.record({ task_type: "classify", backend: backend.name, model: backend.model, redactions: 0, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 500) });
      return { ...ruled, via: "unavailable" };
    }
  }

  /**
   * One model call with a strict JSON instruction and no session side effects (used by the session close).
   * Returns the raw text, or null when no backend answered.
   */
  async completeJson(sessionId: string, system: string, user: string, opts: { allow_cloud?: boolean; signal?: AbortSignal; json?: boolean; onGaveWay?: () => void } = {}): Promise<string | null> {
    const chain = this.route("general", this.cloudAllowed(opts));
    const literals = this.privateLiterals();
    for (const backend of chain) {
      if (opts.signal?.aborted) return null;
      if (backend.probe && !(await backend.probe())) { console.error(`[ai] skipped ${backend.host ? logHost(backend.host) : backend.name}: not answering`); continue; }
      const messages: AiMessage[] = [{ role: "system", content: system }, { role: "user", content: redact(user, literals).text }];
      const t0 = Date.now();
      try {
        const result = await backend.chat(messages, { json: opts.json !== false, ...(opts.signal ? { signal: opts.signal } : {}) });
        this.record({ session_id: sessionId, task_type: "general", backend: backend.name, model: backend.model, redactions: 0, usage: result.usage, ms: Date.now() - t0, ok: true });
        return result.text;
      } catch (e) {
        // Background work stopped for a chat: a pause, not a failure, so neither the log nor the call stats count it.
        if (opts.signal?.aborted) return null;
        if (e instanceof GaveWayError) { opts.onGaveWay?.(); return null; }
        this.record({ session_id: sessionId, task_type: "general", backend: backend.name, model: backend.model, redactions: 0, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 500) });
        console.error(`[ai] ${backend.name} failed: ${errCode(e)}`);
      }
    }
    return null;
  }

  /**
   * One plain-text draft with no session side effects (Module 7 cover letters). Tries the `draft` route first
   * (the adapter, the user's own voice, then the local model), then the general route. `system` is built per
   * backend so the caller can drop private facts before a cloud call. The style filter runs on the result.
   * Returns null when no backend answered.
   */
  async draft(sessionId: string, system: (cloud: boolean) => string, user: string, opts: { allow_cloud?: boolean } = {}): Promise<{ text: string; backend: Backend["name"]; model: string } | null> {
    const chain: Backend[] = [];
    for (const b of [...this.route("draft", false), ...this.route("general", this.cloudAllowed(opts))]) if (!chain.includes(b)) chain.push(b);
    const literals = this.privateLiterals();
    for (const backend of chain) {
      if (backend.probe && !(await backend.probe())) { console.error(`[ai] skipped ${backend.host ? logHost(backend.host) : backend.name}: not answering`); continue; }
      const cloud = !!backend.cloud;
      const messages: AiMessage[] = [{ role: "system", content: system(cloud) }, { role: "user", content: redact(user, literals).text }];
      const t0 = Date.now();
      try {
        const result = await backend.chat(messages);
        this.record({ session_id: sessionId, task_type: "draft", backend: backend.name, model: backend.model, redactions: 0, usage: result.usage, ms: Date.now() - t0, ok: true });
        return { text: applyStyle(result.text, this.filterRules()).text, backend: backend.name, model: backend.model };
      } catch (e) {
        this.record({ session_id: sessionId, task_type: "draft", backend: backend.name, model: backend.model, redactions: 0, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 500) });
        console.error(`[ai] ${backend.name} failed: ${errCode(e)}`);
      }
    }
    return null;
  }

  /** Summarize a session into the project's resume card. */
  async resumeCard(projectId: string, sessionId: string, opts: { allow_cloud?: boolean } = {}): Promise<Entity> {
    const project = this.store.get(projectId);
    if (!project || project.kind !== "project") throw new StoreError(404, "project not found");
    const session = this.getSession(sessionId);
    if (!session) throw new StoreError(404, "session not found");
    const ledger = this.store.list({ kind: "ledger", where: { session_id: sessionId } })[0] ?? null;
    const transcript = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-12000);
    const ledgerText = ledger ? JSON.stringify({ tried: ledger.fields.tried, ruled_out: ledger.fields.ruled_out, confirmed: ledger.fields.confirmed }) : "none";
    const ask: AiMessage = {
      role: "user",
      content: `Summarize this work session on project "${project.fields.name}" into a resume card in under 200 words with exactly these three headings: "Where I left off", "What to do next", "Open questions". Plain markdown, no preamble.\n\nDefinition of done: ${project.fields.definition_of_done}\n\nLedger: ${ledgerText}\n\nTranscript:\n${transcript}`,
    };
    // One plain completion with no tools: as a chat it was offered every tool, and a card line like "Changed the fan
    // curve" set off the "you said you changed something, make the call" check, so the model made a task and the
    // card came out empty.
    const out = await this.completeJson(`${sessionId}:resume`, "You write short resume cards for {{owner}}'s projects. Plain markdown only.", ask.content, { allow_cloud: opts.allow_cloud, json: false });
    if (!out?.trim()) throw new StoreError(503, "no model answered for the resume card");
    return this.store.patch(projectId, { resume_card: applyStyle(out.trim(), this.filterRules()).text });
  }

  /** What /ai/memory returns: the rows that would be injected for the given policy. */
  memory(opts: { cloud?: boolean; allowWork?: boolean } = {}): { facts: Entity[]; rules: Entity[] } {
    const m = loadMemory(this.store, { cloud: opts.cloud === true, allowWork: opts.allowWork === true });
    return { facts: m.facts, rules: m.rules };
  }
}
