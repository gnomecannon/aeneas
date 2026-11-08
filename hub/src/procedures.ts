import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Gateway } from "./ai/index.js";
import { Store, StoreError } from "./store.js";

/**
 * Module 5, procedures. Text becomes steps by rules (numbered or bulleted lines, fenced commands attached to the
 * step before them, `on <host> as <user>:` prefixes); a model may split prose instead, with the rules as the
 * fallback. The user advances one step at a time; steps are never reordered or skipped.
 */

export interface Step { text: string; command?: string; host?: string; user?: string; done_at?: string }
export interface ParsedProcedure { title: string; steps: Step[] }

const STEP_LINE = /^\s*(?:(\d{1,3})[.)]|step\s+\d{1,3}[.):]?|[-*+•])\s+(.*)$/i;
const NUMBERED_LINE = /^\s*(\d{1,3})[.)]\s+\S/;
const FENCE = /^\s*```/;
const HOST_PREFIX = /^on\s+([A-Za-z0-9_.-]+)(?:\s+as\s+([A-Za-z0-9_.@\\-]+))?\s*:\s*(.*)$/i;

/** Pull `on <host> as <user>:` off the front of a step. */
export function parseHostPrefix(text: string): { text: string; host?: string; user?: string } {
  const m = HOST_PREFIX.exec(text.trim());
  if (!m) return { text: text.trim() };
  return { text: (m[3] ?? "").trim() || text.trim(), host: m[1].toLowerCase(), ...(m[2] ? { user: m[2] } : {}) };
}

/** Number of lines that start a numbered step. Three or more makes a reply worth running as a procedure. */
export function countNumberedSteps(text: string): number {
  let n = 0;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (!fenced && NUMBERED_LINE.test(line)) n++;
  }
  return n;
}

/**
 * Rule-based split. Numbered or bulleted lines are steps; continuation lines join the step before them;
 * a fenced block becomes the previous step's `command` (or a step of its own when nothing precedes it).
 * The title is the given one, else the first heading or plain line before the first step.
 */
export function splitSteps(text: string, title?: string): ParsedProcedure {
  const steps: Step[] = [];
  const preamble: string[] = [];
  let fenced: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      if (fenced === null) { fenced = []; continue; }
      const command = fenced.join("\n").trim();
      fenced = null;
      if (!command) continue;
      const last = steps[steps.length - 1];
      if (last && !last.command) last.command = command;
      else steps.push({ text: command.split("\n")[0].slice(0, 200), command });
      continue;
    }
    if (fenced !== null) { fenced.push(raw); continue; }
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = STEP_LINE.exec(line);
    if (m) {
      const parsed = parseHostPrefix(m[2]);
      steps.push({ text: parsed.text, ...(parsed.host ? { host: parsed.host } : {}), ...(parsed.user ? { user: parsed.user } : {}) });
      continue;
    }
    if (steps.length) { const last = steps[steps.length - 1]; last.text = `${last.text} ${line.trim()}`.trim(); }
    else preamble.push(line.trim());
  }
  // A step without a fenced command but with one inline code span runs that span.
  for (const s of steps) {
    if (s.command) continue;
    const spans = [...s.text.matchAll(/`([^`\n]+)`/g)];
    if (spans.length === 1) s.command = spans[0][1].trim();
  }
  const heading = preamble.find((l) => /^#+\s+\S/.test(l))?.replace(/^#+\s+/, "") ?? preamble[0];
  const t = (title?.trim() || heading || "Procedure").replace(/[:.]\s*$/, "").slice(0, 120);
  return { title: t, steps };
}

export const PROCEDURE_SYSTEM = [
  "You split instructions into a procedure the user will follow one step at a time. Reply with strict JSON only, no prose, no code fence.",
  'Shape: {"title": string, "steps": [{"text": string, "command"?: string, "host"?: string, "user"?: string}]}.',
  "Keep the author's order. One action per step. Put a shell command in command, the machine it runs on in host, the account in user. Never invent steps.",
  "No dashes as punctuation, no emoji.",
].join(" ");

/** Parse the model's JSON without trusting it. Null when there is no usable step list. */
export function parseModelProcedure(raw: string): ParsedProcedure | null {
  try {
    const cleaned = raw.replace(/```(?:json)?/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const steps = (Array.isArray(obj.steps) ? obj.steps : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as any).text === "string" && String((s as any).text).trim() !== "")
      .map((s) => ({
        text: String(s.text).trim().slice(0, 1000),
        ...(typeof s.command === "string" && s.command.trim() ? { command: s.command.trim().slice(0, 4000) } : {}),
        ...(typeof s.host === "string" && s.host.trim() ? { host: s.host.trim().toLowerCase().slice(0, 100) } : {}),
        ...(typeof s.user === "string" && s.user.trim() ? { user: s.user.trim().slice(0, 100) } : {}),
      }));
    if (!steps.length) return null;
    const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 120) : "Procedure";
    return { title, steps };
  } catch {
    return null;
  }
}

export interface FromTextBody { text: string; title?: string; host?: string; project_id?: string; allow_cloud?: boolean }

/** POST /procedures/from-text: model when available, rules otherwise or when the model answers badly. */
export async function procedureFromText(store: Store, ai: Gateway, body: FromTextBody): Promise<{ procedure: Entity; via: "model" | "rules" }> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new StoreError(422, "text is required");
  if (body.project_id) {
    const p = store.get(body.project_id);
    if (!p || p.kind !== "project") throw new StoreError(404, "project not found");
  }
  let parsed: ParsedProcedure | null = null;
  let via: "model" | "rules" = "rules";
  if (ai.available()) {
    const raw = await ai.completeJson("procedure:from-text", PROCEDURE_SYSTEM, `${body.title ? `Title: ${body.title}\n` : ""}${body.host ? `Default host: ${body.host}\n` : ""}\n${text.slice(0, 12000)}`, { allow_cloud: body.allow_cloud });
    parsed = raw === null ? null : parseModelProcedure(raw);
    if (parsed) via = "model";
  }
  if (!parsed) parsed = splitSteps(text, body.title);
  if (!parsed.steps.length) throw new StoreError(422, "no steps found in text");
  return { procedure: createProcedure(store, parsed, body), via };
}

export function createProcedure(store: Store, parsed: ParsedProcedure, opts: { title?: string; host?: string; project_id?: string; source_session?: string } = {}): Entity {
  const host = opts.host?.trim().toLowerCase();
  const steps = parsed.steps.map((s) => ({ ...s, ...(host && !s.host ? { host } : {}) }));
  return store.create("procedure", {
    title: opts.title?.trim() || parsed.title, steps, current: 0,
    ...(opts.project_id ? { project_id: opts.project_id } : {}),
    ...(opts.source_session ? { source_session: opts.source_session } : {}),
  });
}

function getProcedure(store: Store, id: string): Entity {
  const p = store.get(id);
  if (!p || p.kind !== "procedure" || p.deleted_at) throw new StoreError(404, "procedure not found");
  return p;
}

/**
 * POST /procedures/:id/advance. `done` completes the step on screen; `back` returns to the one before it. `step` names
 * the step on screen (its index): when the procedure is no longer on it, the request was already carried out (a
 * retry after a lost reply) and nothing changes. Without it a resent "done" marked the next step done unseen.
 */
export function advanceProcedure(store: Store, id: string, body: { done?: boolean; back?: boolean; step?: unknown }): Entity {
  const p = getProcedure(store, id);
  const steps = (p.fields.steps as Step[]).map((s) => ({ ...s }));
  let current = Number(p.fields.current ?? 0);
  const now = nowIso();
  if (body.step !== undefined && body.step !== null) {
    const step = Number(body.step);
    if (!Number.isInteger(step) || step < 0 || step > steps.length) throw new StoreError(422, "step must be the index of the step on screen");
    if (step !== current) return p;
  }
  if (body.back) {
    if (current <= 0) return p;
    current -= 1;
    return store.patch(id, { current, done_at: null });
  }
  if (!body.done) throw new StoreError(422, "done or back is required");
  if (current >= steps.length) return p;
  steps[current] = { ...steps[current], done_at: now };
  current += 1;
  const fields: Record<string, unknown> = { steps, current, ...(p.fields.started_at ? {} : { started_at: now }) };
  if (current >= steps.length) fields.done_at = now;
  return store.patch(id, fields);
}

/** POST /procedures/:id/reset: every step undone, back to the first one. */
export function resetProcedure(store: Store, id: string): Entity {
  const p = getProcedure(store, id);
  const steps = (p.fields.steps as Step[]).map(({ done_at: _d, ...s }) => s);
  return store.patch(id, { steps, current: 0, done_at: null, started_at: null });
}

export function proceduresOpen(store: Store): number {
  return store.list({ kind: "procedure", limit: 100000 }).filter((p) => !p.fields.done_at).length;
}
