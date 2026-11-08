import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import { Store, StoreError } from "./store.js";
import type { Gateway } from "./ai/index.js";
import type { AiMessage } from "./ai/backends.js";
import type { Vault } from "./vault.js";
import { appendCloseToPlan } from "./projects.js";
import type { Hub } from "./hub.js";
import { isReadOnly } from "./ai/hosts.js";
import { errCode } from "./logsafe.js";

/**
 * Module 2: memory and runbooks. Hosts come from `fact` keys `host:<name>` and from runbooks; a runbook per host
 * carries dated sections, the journal records every change with its rollback, snippets keep commands with
 * `{{name}}` parameters. `closeSession` turns a finished AI session into all three.
 */

export const RUNBOOK_CHARS = 1500;
export const MEMORY_BUDGET = 6000;

/** A fact key as matched, whatever separators were used: "focus:2026-10" and "focus_2026_10" are the same key. */
export const factKey = (k: unknown) => String(k ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// ---------- hosts ----------

/** Host names with their fact values, from facts keyed `host:<name>`. */
export function hostFacts(store: Store): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of store.list({ kind: "fact", limit: 100000 })) {
    const key = String(f.fields.key ?? "");
    if (!key.startsWith("host:")) continue;
    const name = key.slice(5).trim().toLowerCase();
    if (name) out.set(name, String(f.fields.value ?? ""));
  }
  return out;
}

/** Every host name the hub knows: facts first, then runbook hosts. */
export function knownHosts(store: Store): string[] {
  const names = new Set<string>(hostFacts(store).keys());
  for (const r of store.list({ kind: "runbook", limit: 100000 })) {
    const h = String(r.fields.host ?? "").trim().toLowerCase();
    if (h) names.add(h);
  }
  return [...names];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Known hosts mentioned in the text, in order of first appearance. Whole words only, case-insensitive. */
export function hostsIn(text: string, hosts: string[]): string[] {
  const found: { host: string; at: number }[] = [];
  for (const h of hosts) {
    if (h.length < 2) continue;
    const m = new RegExp(`(^|[^a-z0-9])${escapeRe(h)}(?![a-z0-9])`, "i").exec(text);
    if (m) found.push({ host: h, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.host);
}

export interface HostSummary { host: string; runbooks: number; journal_entries: number; last_change: string | null; snippets: number }

/** GET /hosts: one row per host derived from runbooks, journal, snippets and host facts. */
export function hostsSummary(store: Store): HostSummary[] {
  const rows = new Map<string, HostSummary>();
  const row = (host: string) => {
    const key = host.trim().toLowerCase();
    let r = rows.get(key);
    if (!r) { r = { host: key, runbooks: 0, journal_entries: 0, last_change: null, snippets: 0 }; rows.set(key, r); }
    return r;
  };
  for (const h of hostFacts(store).keys()) row(h);
  for (const r of store.list({ kind: "runbook", limit: 100000 })) if (r.fields.host) row(String(r.fields.host)).runbooks++;
  for (const j of store.list({ kind: "journal", limit: 100000 })) {
    if (!j.fields.host) continue;
    const r = row(String(j.fields.host));
    r.journal_entries++;
    const at = String(j.fields.at ?? "");
    if (at && (!r.last_change || at > r.last_change)) r.last_change = at;
  }
  for (const s of store.list({ kind: "snippet", limit: 100000 })) if (s.fields.host) row(String(s.fields.host)).snippets++;
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host));
}

// ---------- runbooks ----------

/** The newest runbook for a host, or null. */
export function runbookFor(store: Store, host: string): Entity | null {
  const key = host.trim().toLowerCase();
  return store.list({ kind: "runbook", limit: 100000 }).find((r) => String(r.fields.host ?? "").trim().toLowerCase() === key) ?? null;
}

/** Runbooks newest first, optionally for one host. */
export function listRunbooks(store: Store, host?: string): Entity[] {
  const all = store.list({ kind: "runbook", limit: 100000 });
  if (!host) return all;
  const key = host.trim().toLowerCase();
  return all.filter((r) => String(r.fields.host ?? "").trim().toLowerCase() === key);
}

/** Find or create `Fix notes: <host>` (kind `runbook`). A new one starts with the host fact under `## Facts` when there is one. */
export function ensureRunbook(store: Store, host: string): { runbook: Entity; created: boolean } {
  const key = host.trim().toLowerCase();
  const existing = runbookFor(store, key);
  if (existing) return { runbook: existing, created: false };
  const fact = hostFacts(store).get(key);
  const body = fact ? `## Facts\n\n${fact}\n` : "";
  return { runbook: store.create("runbook", { host: key, title: `Fix notes: ${key}`, body }), created: true };
}

/** Fix notes were called runbooks until 2026-10-28. Renames the old default titles once; every device gets the change. */
export function migrateRunbookTitles(store: Store): number {
  let n = 0;
  for (const r of store.list({ kind: "runbook", limit: 100000 })) {
    const m = /^Runbook: (.+)$/.exec(String(r.fields.title ?? ""));
    if (m) { store.patch(r.id, { title: `Fix notes: ${m[1]}` }); n++; }
  }
  return n;
}

/** At seed: a runbook for every host fact that has none. Idempotent; a runbook the user deleted stays deleted. */
export function seedRunbooks(store: Store): { created: number; kept: number } {
  const out = { created: 0, kept: 0 };
  const seen = new Set(store.list({ kind: "runbook", includeDeleted: true, limit: 100000 }).map((r) => String(r.fields.host ?? "").trim().toLowerCase()));
  for (const host of hostFacts(store).keys()) {
    if (seen.has(host)) { out.kept++; continue; }
    ensureRunbook(store, host);
    out.created++;
  }
  return out;
}

const sectionMarkers = (sessionId: string) => ({ open: `<!-- session:${sessionId} -->`, close: `<!-- /session:${sessionId} -->` });

/** Append a session's section to the runbook body, or replace the section a previous close wrote. */
export function upsertSection(body: string, sessionId: string, section: string): string {
  const { open, close } = sectionMarkers(sessionId);
  const wrapped = `${open}\n${section.trim()}\n${close}`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (start >= 0 && end > start) return body.slice(0, start) + wrapped + body.slice(end + close.length);
  const base = body.trimEnd();
  return base ? `${base}\n\n${wrapped}\n` : `${wrapped}\n`;
}

// ---------- snippets ----------

/** Replace `{{name}}` with the given params, then the defaults. 422 lists the names still missing. */
export function renderSnippet(store: Store, id: string, params: Record<string, unknown> = {}): { text: string; snippet: Entity } {
  const s = store.get(id);
  if (!s || s.kind !== "snippet") throw new StoreError(404, "snippet not found");
  const declared = (Array.isArray(s.fields.params) ? s.fields.params : []) as { name: string; default?: string }[];
  const values = new Map<string, string>();
  for (const p of declared) if (p.default !== undefined) values.set(p.name, String(p.default));
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) values.set(k, String(v));
  const body = String(s.fields.body ?? "");
  const names = new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]));
  const missing = [...names].filter((n) => !values.has(n));
  if (missing.length) throw new StoreError(422, "missing params", { missing });
  const text = body.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, n: string) => values.get(n) ?? "");
  const snippet = store.patch(s.id, { last_used: nowIso() });
  return { text, snippet };
}

/**
 * Run a snippet on a host to try it: rendered with its parameters, then run at once only when the result is read-only
 * (the same check the assistant's commands get, on the final text, so a parameter cannot slip a change in). A snippet
 * that changes something answers 409: the assistant runs it, after the owner approves it there.
 */
export async function runSnippet(hub: Hub, id: string, params: Record<string, unknown>, hostName?: string): Promise<{ host: string; command: string; exit_code: number | null; output: string }> {
  if (!hub.cfg.hostActions) throw new StoreError(409, "running commands is turned off on this hub");
  const s = hub.store.get(id);
  if (!s || s.kind !== "snippet") throw new StoreError(404, "snippet not found");
  if (!/^(bash|sh|shell|zsh|powershell|pwsh)$/i.test(String(s.fields.language ?? ""))) throw new StoreError(422, `a ${String(s.fields.language)} snippet is not a command to run`);
  const name = (hostName ?? String(s.fields.host ?? "")).trim();
  if (!name) throw new StoreError(422, "choose a host to run it on");
  const host = hub.ai.hosts.host(name);
  if (!host) throw new StoreError(404, `no host named ${name}`);
  const os = String(s.fields.os ?? "any");
  if (os !== "any" && os !== host.os) throw new StoreError(422, `this snippet is for ${os} and ${host.name} runs ${host.os}`);
  const { text } = renderSnippet(hub.store, id, params);
  if (!isReadOnly(text, host.os)) throw new StoreError(409, "this snippet changes something; ask the assistant to run it, and it waits for your approval");
  const r = await hub.ai.hosts.runRead(`snippet-${id}`, host, text, `Snippet: ${String(s.fields.title ?? "")}`);
  return { host: host.name, command: text, exit_code: r.exit_code, output: r.output };
}

// ---------- memory for the prompt ----------

export interface HostMemory { host: string; runbook: string; journal: { at: string; what: string; risk: string; outcome: string; rollback?: string }[] }

/** Runbook head and the last three journal entries for each host, trimmed to the budget (runbooks first). */
export function hostMemory(store: Store, hosts: string[], budget = MEMORY_BUDGET): HostMemory[] {
  const out: HostMemory[] = [];
  for (const host of hosts) {
    const rb = runbookFor(store, host);
    const journal = store.list({ kind: "journal", limit: 100000 })
      .filter((j) => String(j.fields.host ?? "").toLowerCase() === host.toLowerCase())
      .sort((a, b) => String(b.fields.at).localeCompare(String(a.fields.at)))
      .slice(0, 3)
      .map((j) => ({ at: String(j.fields.at), what: String(j.fields.what), risk: String(j.fields.risk), outcome: String(j.fields.outcome ?? "done"), ...(j.fields.rollback ? { rollback: String(j.fields.rollback) } : {}) }));
    if (!rb && !journal.length) continue;
    out.push({ host, runbook: rb ? String(rb.fields.body ?? "").slice(0, RUNBOOK_CHARS) : "", journal });
  }
  const journalChars = out.reduce((n, h) => n + JSON.stringify(h.journal).length, 0);
  let runbookChars = out.reduce((n, h) => n + h.runbook.length, 0);
  if (journalChars + runbookChars > budget && out.length) {
    const each = Math.max(0, Math.floor((budget - journalChars) / out.length));
    for (const h of out) h.runbook = h.runbook.slice(0, each);
    runbookChars = out.reduce((n, h) => n + h.runbook.length, 0);
  }
  return out;
}

export function renderHostMemory(mem: HostMemory[]): string {
  return mem.map((h) => {
    const parts = [`Host ${h.host}:`];
    if (h.runbook) parts.push(`Runbook:\n${h.runbook}`);
    if (h.journal.length) parts.push("Recent changes:\n" + h.journal.map((j) => `- ${j.at.slice(0, 10)} [${j.risk}, ${j.outcome}] ${j.what}${j.rollback ? ` (rollback: ${j.rollback})` : ""}`).join("\n"));
    return parts.join("\n");
  }).join("\n\n");
}

// ---------- close session ----------

export interface CloseBody { outcome: "fixed" | "abandoned" | "parked"; note?: string; host?: string; project_id?: string; allow_cloud?: boolean }
export interface CloseResult { runbook_id?: string; journal_id?: string; journal_ids: string[]; snippet_ids: string[]; resume_card_written: boolean; plan_note_id?: string; summary: string; host: string | null; via: "model" | "rules" }

interface ModelClose {
  runbook_section: string;
  journal: { what: string; command?: string; risk: "low" | "medium" | "high"; rollback?: string }[];
  snippets: { title: string; os: "linux" | "windows" | "macos" | "any"; language: string; body: string; params: { name: string; default?: string; description?: string }[] }[];
}

export const CLOSE_SYSTEM = [
  "You turn a finished troubleshooting session into memory. Reply with strict JSON only, no prose, no code fence.",
  'Shape: {"runbook_section": string, "journal": [{"what": string, "command"?: string, "risk": "low|medium|high", "rollback"?: string}], "snippets": [{"title": string, "os": "linux|windows|macos|any", "language": string, "body": string, "params": [{"name": string, "default"?: string, "description"?: string}]}]}.',
  "runbook_section is markdown that starts with '## YYYY-MM-DD: <problem>' and has short Symptoms, Root cause, Fix and Verification parts.",
  "journal has one entry per change that was actually made to the host, with its risk and how to undo it. Empty when nothing was changed.",
  "snippets holds at most two commands worth keeping; parameters appear as {{name}} in body and are listed in params.",
  "No platitudes, no dashes as punctuation, no emoji.",
].join(" ");

/** Parse the model's JSON without trusting it. Returns null when there is no usable section. */
export function parseModelClose(raw: string): ModelClose | null {
  try {
    const cleaned = raw.replace(/```(?:json)?/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const section = typeof obj.runbook_section === "string" ? obj.runbook_section.trim() : "";
    if (!section) return null;
    const risks = new Set(["low", "medium", "high"]);
    const oses = new Set(["linux", "windows", "macos", "any"]);
    const journal = (Array.isArray(obj.journal) ? obj.journal : [])
      .filter((j): j is Record<string, unknown> => !!j && typeof j === "object" && typeof (j as any).what === "string" && String((j as any).what).trim() !== "")
      .map((j) => ({
        what: String(j.what).trim().slice(0, 300),
        ...(typeof j.command === "string" && j.command.trim() ? { command: j.command.trim().slice(0, 2000) } : {}),
        risk: (risks.has(String(j.risk)) ? String(j.risk) : "medium") as "low" | "medium" | "high",
        ...(typeof j.rollback === "string" && j.rollback.trim() ? { rollback: j.rollback.trim().slice(0, 1000) } : {}),
      }));
    const snippets = (Array.isArray(obj.snippets) ? obj.snippets : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as any).title === "string" && typeof (s as any).body === "string" && String((s as any).body).trim() !== "")
      .slice(0, 2)
      .map((s) => ({
        title: String(s.title).trim().slice(0, 120) || "Snippet",
        os: (oses.has(String(s.os)) ? String(s.os) : "any") as "linux" | "windows" | "macos" | "any",
        language: typeof s.language === "string" && s.language.trim() ? s.language.trim().toLowerCase() : "bash",
        body: String(s.body),
        params: (Array.isArray(s.params) ? s.params : [])
          .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as any).name === "string")
          .map((p) => ({ name: String(p.name), ...(typeof p.default === "string" ? { default: p.default } : {}), ...(typeof p.description === "string" ? { description: p.description } : {}) })),
      }));
    return { runbook_section: section, journal, snippets };
  } catch {
    return null;
  }
}

const today = () => nowIso().slice(0, 10);

/** The rule-based summary: last three user messages, the ledger, and the outcome note. */
export function ruleBasedClose(messages: AiMessage[], ledger: Entity | null, body: CloseBody): ModelClose {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content.trim()).filter(Boolean);
  const topic = String(ledger?.fields.topic ?? users[0]?.split("\n")[0] ?? "session").slice(0, 120);
  const l = (ledger?.fields ?? {}) as { tried?: { at: string; what: string; result: string }[]; ruled_out?: string[]; confirmed?: string[] };
  const lines: string[] = [`## ${today()}: ${topic}`, "", `Outcome: ${body.outcome}${body.note ? `. ${body.note.trim()}` : ""}`];
  if (users[0]) lines.push("", "Symptoms:", users[0].split("\n")[0].slice(0, 300));
  if (l.tried?.length) lines.push("", "Tried:", ...l.tried.map((t) => `- ${t.what} (${t.result})`));
  if (l.ruled_out?.length) lines.push("", "Ruled out:", ...l.ruled_out.map((s) => `- ${s}`));
  if (l.confirmed?.length) lines.push("", "Confirmed:", ...l.confirmed.map((s) => `- ${s}`));
  const last = users.slice(-3);
  if (last.length) lines.push("", "Last messages:", ...last.map((u) => `- ${u.replace(/\s+/g, " ").slice(0, 200)}`));
  const outcomeWord = body.outcome === "fixed" ? "fixed" : body.outcome === "parked" ? "parked" : "abandoned";
  return {
    runbook_section: lines.join("\n"),
    journal: [{ what: `Session ${outcomeWord}: ${topic}`.slice(0, 300), risk: "low" }],
    snippets: [],
  };
}

const PROJECT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * POST /ai/sessions/:id/close. Writes the runbook section (tagged by session so a second close replaces it),
 * the journal entries (replaced per session), up to two snippets, closes the ledger and writes the project's
 * resume card when a project is given or mentioned. With a vault, the project's plan note gets a dated log line
 * and fresh Current state and Next (Module 5).
 */
export async function closeSession(store: Store, ai: Gateway, sessionId: string, body: CloseBody, vault?: Vault): Promise<CloseResult> {
  if (!["fixed", "abandoned", "parked"].includes(body.outcome)) throw new StoreError(422, "outcome must be fixed, abandoned or parked");
  const session = ai.getSession(sessionId);
  if (!session) throw new StoreError(404, "session not found");
  const messages = session.messages;
  const transcriptText = messages.map((m) => m.content).join("\n");
  const ledger = store.list({ kind: "ledger", where: { session_id: sessionId } })[0] ?? null;

  const host = body.host?.trim().toLowerCase() || hostsIn(transcriptText, knownHosts(store))[0] || null;

  // Project: given, or the first project id mentioned in the session.
  let project: Entity | null = null;
  if (body.project_id) {
    project = store.get(body.project_id);
    if (!project || project.kind !== "project") throw new StoreError(404, "project not found");
  } else {
    for (const id of new Set((transcriptText.match(PROJECT_ID) ?? []).map((s) => s.toLowerCase()))) {
      const e = store.get(id);
      if (e && e.kind === "project") { project = e; break; }
    }
  }

  // Model first, rules when it is off or answers badly.
  let plan: ModelClose | null = null;
  let via: CloseResult["via"] = "rules";
  if (ai.available()) {
    const ledgerText = ledger ? JSON.stringify({ topic: ledger.fields.topic, tried: ledger.fields.tried, ruled_out: ledger.fields.ruled_out, confirmed: ledger.fields.confirmed }) : "none";
    const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-12000);
    const user = `Outcome: ${body.outcome}${body.note ? `\nNote: ${body.note}` : ""}\nHost: ${host ?? "unknown"}\nDate: ${today()}\n\nLedger: ${ledgerText}\n\nTranscript:\n${transcript}`;
    const raw = await ai.completeJson(`${sessionId}:close`, CLOSE_SYSTEM, user, { allow_cloud: body.allow_cloud });
    plan = raw === null ? null : parseModelClose(raw);
    if (plan) via = "model";
  }
  if (!plan) plan = ruleBasedClose(messages, ledger, body);
  if (!/^##\s/.test(plan.runbook_section)) {
    const topic = String(ledger?.fields.topic ?? messages.find((m) => m.role === "user")?.content.split("\n")[0] ?? "session").slice(0, 120);
    plan.runbook_section = `## ${today()}: ${topic}\n\n${plan.runbook_section}`;
  }

  // Fix notes, the change journal and snippets belong to Homelab: with it off, a close keeps only the ledger and the
  // project's resume card.
  const homelab = ai.moduleOn("homelab");

  // Runbook.
  let runbookId: string | undefined;
  if (host && homelab) {
    const { runbook } = ensureRunbook(store, host);
    const bodyText = upsertSection(String(runbook.fields.body ?? ""), sessionId, plan.runbook_section);
    runbookId = store.patch(runbook.id, { body: bodyText, last_verified: nowIso() }).id;
  }

  // Journal: entries from a previous close of this session go away; `planned` is reserved for pre-flight rows, which stay.
  // Model entries describe changes that were made, so they are `done`; the rule-based summary row is `failed` for an abandoned session.
  const now = nowIso();
  // The entries the hub wrote itself for commands it ran stay too: they hold the exact command, whether it failed and
  // its rollback, and a close had replaced a failed one with model entries that all said done.
  const ran = ai.hosts.journalIds(sessionId);
  if (homelab) for (const j of store.list({ kind: "journal", where: { session_id: sessionId } })) {
    if (j.fields.outcome !== "planned" && !ran.has(j.id)) store.patch(j.id, { deleted_at: now });
  }
  const outcome = via === "rules" && body.outcome === "abandoned" ? "failed" : "done";
  // A command the hub ran already has its own entry, with its real outcome: the close does not add a second one.
  const ranCommands = new Set([...ran].map((id) => String(store.get(id)?.fields.command ?? "").trim()).filter(Boolean));
  const journalIds = (homelab ? plan.journal : []).filter((j) => !(j.command && ranCommands.has(j.command.trim()))).map((j) => store.create("journal", {
    host: host ?? "unknown", at: now, what: j.what, ...(j.command ? { command: j.command } : {}), risk: j.risk,
    ...(j.rollback ? { rollback: j.rollback } : {}), outcome, session_id: sessionId, ...(runbookId ? { runbook_id: runbookId } : {}),
  }).id);

  // Snippets: matched by title within the session, extra old ones removed.
  const old = store.list({ kind: "snippet", where: { source_session: sessionId } });
  const snippetIds: string[] = [];
  for (const s of homelab ? plan.snippets : []) {
    const fields = { title: s.title, os: s.os, language: s.language, body: s.body, params: s.params, tags: host ? [host] : [], ...(host ? { host } : {}), source_session: sessionId };
    const match = old.find((o) => o.fields.title === s.title && !snippetIds.includes(o.id));
    snippetIds.push(match ? store.patch(match.id, fields).id : store.create("snippet", fields).id);
  }
  // Snippets saved when the owner said the fix worked ("Saved to Snippets: ...", tagged from-chat) are theirs now: only
  // ones a previous close wrote are replaced.
  if (homelab) for (const o of old) if (!snippetIds.includes(o.id) && !(Array.isArray(o.fields.tags) && o.fields.tags.includes("from-chat"))) store.patch(o.id, { deleted_at: now });

  // Ledger.
  if (ledger && ledger.fields.open !== false) store.patch(ledger.id, { open: false });

  // Resume card.
  let resumeCardWritten = false;
  if (project) {
    try {
      if (!ai.available()) throw new Error("no backend");
      await ai.resumeCard(project.id, sessionId, { allow_cloud: body.allow_cloud });
      resumeCardWritten = true;
    } catch {
      const card = [
        "Where I left off", plan.runbook_section.split("\n").slice(0, 6).join("\n"), "",
        "What to do next", body.outcome === "fixed" ? "Nothing open from this session." : body.note?.trim() || `Pick the ${body.outcome} session back up.`, "",
        "Open questions", body.outcome === "fixed" ? "None." : "See the runbook section above.",
      ].join("\n");
      store.patch(project.id, { resume_card: card });
      resumeCardWritten = true;
    }
  }

  const summary = plan.runbook_section.split("\n")[0].replace(/^##\s*/, "");

  // Plan note: a dated log line, Current state and Next from this close.
  let planNoteId: string | undefined;
  if (project && vault) {
    try { planNoteId = appendCloseToPlan(store, vault, project, { outcome: body.outcome, summary, note: body.note }).id; }
    catch (e) { console.error(`[close] plan note not updated: ${errCode(e)}`); }
  }
  return { ...(runbookId ? { runbook_id: runbookId } : {}), ...(journalIds[0] ? { journal_id: journalIds[0] } : {}), journal_ids: journalIds, snippet_ids: snippetIds, resume_card_written: resumeCardWritten, ...(planNoteId ? { plan_note_id: planNoteId } : {}), summary, host, via };
}
