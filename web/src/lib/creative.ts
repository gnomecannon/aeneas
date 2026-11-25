/**
 * Module 5: creative and builds. Pure helpers shared by the views, the tests and the mock hub:
 * the music quick-line parser, procedure steps from pasted text, parts and inventory math,
 * the one-step procedure machine and the quiz state machine.
 */
import type { Entity } from "@everythingapp/shared";

export type ProjectStatus = "active" | "parked" | "done";
export type Part = { name: string; qty: number; have?: number; inventory_id?: string };
export type ProjectF = { name: string; status: ProjectStatus; definition_of_done: string; resume_card?: string; plan_doc_path?: string; repo?: string; parts?: Part[]; activity?: ProjectActivity; activity_at?: string; area?: "music" };
/** What a feed (Codex threads, the repo, a current-state doc) last reported for a project. */
export type ProjectActivity = {
  source?: string;
  received_at?: string;
  threads?: Array<{ title: string; updated_at: string; last_message?: string }>;
  repo?: { branch?: string; last_commit_at?: string | null; last_commit?: string; uncommitted?: number; last_edit_at?: string | null };
  doc?: { path?: string; updated_at?: string | null; sections?: Array<{ title: string; text: string }> };
};
export type InventoryCategory = "component" | "gear" | "material" | "tool" | "other";
export const INVENTORY_CATEGORIES: InventoryCategory[] = ["component", "gear", "material", "tool", "other"];
export type InventoryF = { name: string; category: InventoryCategory; qty?: number; unit?: string; location?: string; tags?: string[]; project_id?: string; notes?: string };
export type Step = { text: string; command?: string; host?: string; user?: string; done_at?: string };
export type ProcedureF = { title: string; steps: Step[]; current: number; started_at?: string; done_at?: string; source_session?: string; project_id?: string };
/** What the Song ideas screen holds. Reference sheets, templates and settings are notes in Music/Reference (the hub moves any it finds). */
export type MusicType = "riff" | "progression" | "lyric" | "song";
export const MUSIC_TYPES: MusicType[] = ["riff", "progression", "lyric", "song"];
export type MusicStatus = "idea" | "wip" | "done";
/** A note heard in a hum (hub hum.ts): MIDI pitch, start and length in seconds from the first note, velocity. */
export type HumNote = { p: number; s: number; d: number; v: number };
/** A hum's notes (hub hum.ts). Since 2026-11-17 it is heard both ways, `melody` and `rhythm`; `mode` and `notes` repeat one for older apps, and are all an older idea has. */
export type HumMidi = { source: "hum"; mode: "melody" | "rhythm"; state: "listening" | "done" | "failed"; error?: string; seconds?: number; notes: HumNote[]; melody?: HumNote[]; rhythm?: HumNote[] };
/** What the owner keeps of a hum. */
export type HumUse = "melody" | "rhythm" | "both";
export type MusicF = { title: string; type: MusicType; body?: string; key?: string; bpm?: number; time_sig?: string; tuning?: string; status: MusicStatus; tags?: string[]; project_id?: string; audio_ref?: string; midi?: HumMidi; hum_use?: HumUse };
/** A status in words: "wip" read as a code. */
export const MUSIC_STATUS_LABEL: Record<MusicStatus, string> = { idea: "idea", wip: "in progress", done: "done" };

/** A hummed take: its recording is kept on the hub (`audio_ref` hum:<id>). */
export const isHummed = (f: Pick<MusicF, "audio_ref">): boolean => typeof f.audio_ref === "string" && f.audio_ref.startsWith("hum:");

/** One card on the Projects page of Song ideas: a release in the making, its ideas and its hummed takes. */
export type MusicProjectCard = { project: Entity; ideas: Entity[]; takes: Entity[] };

const PROJECT_ORDER: Record<ProjectStatus, number> = { active: 0, parked: 1, done: 2 };
const newestFirst = (a: Entity, b: Entity) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0);

/**
 * The Projects page of Song ideas (gnomecannon/aeneas#13): every music project (an album, an EP or a single in the making), active
 * ones first, then parked, then done, the newest change first within each; with its ideas and its hummed takes, each
 * newest change first. The Apple apps sort the same way (EACore MusicProjects).
 */
export function musicProjectCards(projects: Entity[], ideas: Entity[]): MusicProjectCard[] {
  const live = (e: Entity) => !e.deleted_at;
  return projects
    .filter((p) => live(p) && (p.fields as ProjectF).area === "music")
    .sort((a, b) => (PROJECT_ORDER[(a.fields as ProjectF).status] ?? 0) - (PROJECT_ORDER[(b.fields as ProjectF).status] ?? 0) || newestFirst(a, b))
    .map((project) => {
      const mine = ideas.filter((m) => live(m) && (m.fields as MusicF).project_id === project.id).sort(newestFirst);
      return { project, ideas: mine.filter((m) => !isHummed(m.fields as MusicF)), takes: mine.filter((m) => isHummed(m.fields as MusicF)) };
    });
}

/** A hum's two hearings; an idea heard before both were kept has one, under `mode` and `notes`. */
export function humLayers(m: HumMidi | undefined): { melody: HumNote[]; rhythm: HumNote[] } {
  if (!m) return { melody: [], rhythm: [] };
  if (m.melody || m.rhythm) return { melody: m.melody ?? [], rhythm: m.rhythm ?? [] };
  return m.mode === "rhythm" ? { melody: [], rhythm: m.notes ?? [] } : { melody: m.notes ?? [], rhythm: [] };
}

/**
 * The hits only repeat the melody (at least 70% of them start within 100 ms of a melody note): a hummed tune, whose
 * every note also starts with a jump in level. As the hub decides (hub/src/hum.ts).
 */
export function hitsEchoMelody(layers: { melody: HumNote[]; rhythm: HumNote[] }): boolean {
  const { melody, rhythm } = layers;
  if (!melody.length || !rhythm.length) return false;
  const near = rhythm.filter((h) => melody.some((n) => Math.abs(n.s - h.s) <= 0.1)).length;
  return near >= 0.7 * rhythm.length;
}

/**
 * What the owner keeps: their choice; else the melody when the hits only repeat its note starts, both when both have
 * notes of their own, else the one that has (as the hub decides).
 */
export function humUse(chosen: unknown, layers: { melody: HumNote[]; rhythm: HumNote[] }): HumUse {
  if (chosen === "melody" || chosen === "rhythm" || chosen === "both") return chosen;
  if (layers.melody.length && layers.rhythm.length) return hitsEchoMelody(layers) ? "melody" : "both";
  return layers.rhythm.length ? "rhythm" : "melody";
}
export type QuizResult = "right" | "wrong" | "revealed";
export type QuizItem = { q: string; a: string; hint: string; topic: string; asked_at?: string; result?: QuizResult };
export type QuizF = { date: string; items: QuizItem[]; source_sessions?: string[]; completed_at?: string };

export type PartRow = { name: string; qty: number; have: number; missing: number; inventory_id?: string };
export interface ProjectSummary {
  project: Entity;
  tasks: { next: Entity[]; doing: Entity[]; done_7d: Entity[] };
  notes: Entity[];
  plan_note: Entity | null;
  procedures: Entity[];
  music: Entity[];
  parts: PartRow[];
  last_session_close: string | null;
}

// ---------- parts and inventory ----------

/** have and missing per part. `inventory` (live inventory entities) fills `have` when the part has none. */
export function partRows(parts: Part[] | undefined, inventory: Entity[] = []): PartRow[] {
  return (parts ?? []).map((p) => {
    const qty = Number(p.qty) || 0;
    let have = p.have;
    let inventory_id = p.inventory_id;
    if (have == null) {
      const hit = inventory.find((e) => String(e.fields.name ?? "").trim().toLowerCase() === p.name.trim().toLowerCase());
      if (hit) {
        have = Number(hit.fields.qty ?? 1) || 0;
        inventory_id = hit.id;
      }
    }
    const h = Math.max(0, Number(have ?? 0) || 0);
    return { name: p.name, qty, have: h, missing: Math.max(0, qty - h), inventory_id };
  });
}

export function partTotals(rows: PartRow[]): { have: number; missing: number } {
  return { have: rows.filter((r) => r.missing === 0).length, missing: rows.filter((r) => r.missing > 0).length };
}

/** Task titles for the missing parts: one per part, with the count when more than one is short. */
export function missingPartTasks(rows: PartRow[]): string[] {
  return rows.filter((r) => r.missing > 0).map((r) => (r.missing > 1 ? `Get ${r.missing} x ${r.name}` : `Get ${r.name}`));
}

/** "qty x name" rows from a textarea, one part per line: "2 x 10k resistor", "10k resistor x2", "10k resistor". */
export function parsePartsText(text: string): Part[] {
  const out: Part[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^(\d+)\s*[x×]\s+(.+)$/i.exec(line);
    if (m) {
      out.push({ name: m[2].trim(), qty: Number(m[1]) });
      continue;
    }
    m = /^(.+?)\s*[x×]\s*(\d+)$/i.exec(line);
    if (m) {
      out.push({ name: m[1].trim(), qty: Number(m[2]) });
      continue;
    }
    out.push({ name: line, qty: 1 });
  }
  return out;
}

export function partsToText(parts: Part[] | undefined): string {
  return (parts ?? []).map((p) => (p.qty && p.qty !== 1 ? `${p.qty} x ${p.name}` : p.name)).join("\n");
}

// ---------- procedures ----------

/**
 * Steps from pasted text: numbered or bulleted lines start a step; a fenced block or an indented line
 * under a step becomes its command; a single `inline command` on the step line is its command too.
 * Plain prose with no list markers becomes one step per non-empty line.
 */
export function stepsFromText(text: string, host?: string): Step[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const steps: Step[] = [];
  let fence: string[] | null = null;
  const attach = (cmd: string) => {
    const last = steps[steps.length - 1];
    if (!last) return;
    last.command = last.command ? `${last.command}\n${cmd}` : cmd;
  };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (fence) {
        attach(fence.join("\n"));
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/.exec(line);
    if (m) {
      steps.push(stepFromLine(m[1], host));
      continue;
    }
    if (/^(\s{2,}|\t)/.test(raw) && steps.length) {
      attach(line.trim());
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    steps.push(stepFromLine(line.trim(), host));
  }
  if (fence) attach((fence as string[]).join("\n"));
  return steps;
}

function stepFromLine(text: string, host?: string): Step {
  const s: Step = { text: text.trim() };
  const inline = /`([^`]+)`/.exec(text);
  if (inline) {
    s.command = inline[1];
    s.text = text.replace(/`[^`]+`/, "").replace(/\s{2,}/g, " ").replace(/[:,]\s*$/, "").trim() || inline[1];
  }
  const on = /\bon\s+([a-z0-9][a-z0-9.-]*)\b/i.exec(s.text);
  const h = host ?? on?.[1];
  if (h) s.host = h;
  const user = /\b(?:as|user)\s+([a-z_][a-z0-9_-]*)\b/i.exec(s.text);
  if (user) s.user = user[1];
  return s;
}

/** Progress for the runner. `done` once every step has done_at or the procedure has done_at. */
export function procedureProgress(f: ProcedureF): { current: number; total: number; done: boolean } {
  const total = f.steps.length;
  const done = !!f.done_at || f.current >= total;
  return { current: Math.min(f.current, Math.max(0, total - 1)), total, done };
}

/** The same transitions as POST /procedures/:id/advance and /reset, for the offline fallback. */
export function advanceProcedure(f: ProcedureF, action: "done" | "back" | "reset", at = new Date().toISOString()): Partial<ProcedureF> {
  const steps = f.steps.map((s) => ({ ...s }));
  if (action === "reset") return { steps: steps.map(({ done_at: _d, ...s }) => s), current: 0, done_at: undefined, started_at: undefined };
  if (action === "back") return { current: Math.max(0, Math.min(f.current, steps.length) - 1) };
  if (f.current >= steps.length) return {};
  steps[f.current].done_at = at;
  const current = f.current + 1;
  const out: Partial<ProcedureF> = { steps, current };
  if (!f.started_at) out.started_at = at;
  if (current >= steps.length) out.done_at = at;
  return out;
}

// ---------- music ----------

const CHORD = /^[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus[24]?|add\d+|M|\+|°)?(?:\d+)?(?:\/[A-G](?:#|b)?)?$/;
const NOTE = /^[A-G](?:#|b)?$/i;

export interface MusicQuick {
  title: string;
  type: MusicType;
  body: string;
  key?: string;
  bpm?: number;
  time_sig?: string;
  tuning?: string;
}

/** One line such as "Am F C G 6/8 112bpm drop D": chords, time signature, bpm and tuning recognized, the rest is the title. */
export function parseMusicQuick(text: string): MusicQuick {
  // Punctuation stays off the tokens: "112," is a tempo.
  const tokens = text.trim().split(/\s+/).map((t) => t.replace(/^[,;]+|[,;.]+$/g, "")).filter(Boolean);
  const chords: string[] = [];
  const words: string[] = [];
  let bpm: number | undefined;
  let time_sig: string | undefined;
  let tuning: string | undefined;
  let key: string | undefined;
  let type: MusicType | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    let m: RegExpExecArray | null;
    if ((m = /^(\d{2,3})bpm$/i.exec(t))) {
      bpm = Number(m[1]);
      continue;
    }
    if (/^\d{2,3}$/.test(t) && tokens[i + 1]?.toLowerCase() === "bpm") {
      bpm = Number(t);
      i++;
      continue;
    }
    // "at 112", "@112" or "tempo 112", as said out loud.
    if (bpm === undefined && ((m = /^@(\d{2,3})$/.exec(t)) || (/^\d{2,3}$/.test(t) && /^(at|@|tempo)$/i.test(tokens[i - 1] ?? "")))) {
      const n = Number(m ? m[1] : t);
      if (n >= 30 && n <= 300) {
        bpm = n;
        continue;
      }
    }
    if (/^\d{1,2}\/\d{1,2}$/.test(t)) {
      time_sig = t;
      continue;
    }
    if ((lower === "drop" || lower === "open") && tokens[i + 1] && NOTE.test(tokens[i + 1])) {
      tuning = `${lower} ${tokens[i + 1][0].toUpperCase()}${tokens[i + 1].slice(1)}`;
      i++;
      continue;
    }
    if (lower === "standard" || lower === "dadgad" || /^[a-g#]{6,7}$/i.test(t) && /^[A-G]/.test(t) && t.toUpperCase() === t) {
      tuning = lower === "dadgad" ? "DADGAD" : lower === "standard" ? "standard" : t;
      continue;
    }
    if (lower === "half" && tokens[i + 1]?.toLowerCase() === "step" && tokens[i + 2]?.toLowerCase() === "down") {
      tuning = "half step down";
      i += 2;
      continue;
    }
    if ((lower === "key" || lower === "in") && tokens[i + 1] && CHORD.test(tokens[i + 1])) {
      key = tokens[i + 1];
      i++;
      continue;
    }
    // An explicit type only as "lyric:" or as the first word, so "garden song" stays a title.
    if (/^(riff|progression|lyric|song):$/.test(lower) || (i === 0 && /^(riff|progression|lyric|song)$/.test(lower))) {
      type = lower.replace(":", "") as MusicType;
      continue;
    }
    if (CHORD.test(t)) {
      chords.push(t);
      continue;
    }
    words.push(t);
  }
  if (!key && chords.length) key = chords[0];
  const body = chords.join(" ");
  // Joining words and an "idea:" label left between the parsed parts are not a title.
  const title = words.filter((w) => !/^(in|at|@|with|and|tempo|idea:?)$/i.test(w)).join(" ").trim() || body || "Untitled";
  return { title, type: type ?? (chords.length >= 2 ? "progression" : "riff"), body, key, bpm, time_sig, tuning };
}

/** A short line for a list row: key, bpm, time signature, tuning. */
export function musicMeta(f: Pick<MusicF, "key" | "bpm" | "time_sig" | "tuning">): string[] {
  const out: string[] = [];
  if (f.key) out.push(f.key);
  if (f.bpm) out.push(`${f.bpm} bpm`);
  if (f.time_sig) out.push(f.time_sig);
  if (f.tuning) out.push(f.tuning);
  return out;
}

// ---------- quiz ----------

export type QuizPhase = "ask" | "hint" | "done";
export interface QuizState {
  index: number;
  phase: QuizPhase;
  results: Array<QuizResult | undefined>;
}
export type QuizAction = "know" | "unsure" | "reveal" | "wrong";

function firstOpen(results: Array<QuizResult | undefined>, from = 0): number {
  for (let i = from; i < results.length; i++) if (!results[i]) return i;
  for (let i = 0; i < from; i++) if (!results[i]) return i;
  return -1;
}

/** Starts at the first unanswered item; `done` straight away when every item has a result. */
export function initialQuiz(items: QuizItem[]): QuizState {
  const results = items.map((it) => it.result);
  const index = firstOpen(results);
  return index < 0 ? { index: Math.max(0, items.length - 1), phase: "done", results } : { index, phase: "ask", results };
}

/**
 * The runner: "know" marks right; "unsure" shows the hint once, then "know", "reveal" (marks revealed)
 * or "wrong" settle it. Returns the record to send to POST /quiz/:id/answer, if any.
 */
export function quizStep(state: QuizState, action: QuizAction): { state: QuizState; record?: { index: number; result: QuizResult } } {
  if (state.phase === "done") return { state };
  if (action === "unsure") return state.phase === "ask" ? { state: { ...state, phase: "hint" } } : { state };
  if (action === "reveal" && state.phase !== "hint") return { state };
  const result: QuizResult = action === "know" ? "right" : action === "reveal" ? "revealed" : "wrong";
  const results = state.results.slice();
  results[state.index] = result;
  const next = firstOpen(results, state.index + 1);
  const out: QuizState = next < 0 ? { index: state.index, phase: "done", results } : { index: next, phase: "ask", results };
  return { state: out, record: { index: state.index, result } };
}

export function quizCounts(results: Array<QuizResult | undefined>): { right: number; wrong: number; revealed: number; answered: number; total: number } {
  const c = { right: 0, wrong: 0, revealed: 0, answered: 0, total: results.length };
  for (const r of results) {
    if (!r) continue;
    c[r]++;
    c.answered++;
  }
  return c;
}
