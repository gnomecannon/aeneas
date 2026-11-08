/**
 * In-memory stand-in for the hub, for exercising the web client without the real server.
 * Run: npx tsx scripts/mock-hub.ts   (listens on 8787, token "dev")
 * Implements: /health, /devices/register, /sync/changes, /sync/push, /live, /entities/:id,
 * /capture, /capture/:id/convert, /reminders/:id/snooze|ack, /reminders/due, /search, /dashboard, /log,
 * /ai/memory, /ai/chat, /ai/chat/stream, /status, /metrics/proof,
 * /planner/week, /planner/schedule (409 on overlap unless force), /planner/unschedule, /planner/today (with a digest),
 * /watches/:id/renewed, and the `watch` and `plan_rule` kinds (a watch write links its Renew reminder, as the hub does).
 * Module 2: /hosts, /runbooks, /snippets/:id/render, /ai/sessions/:id/close, /ledgers, the `journal` and `snippet` kinds,
 * and a troubleshoot reply with a Pre-flight block (which records a planned high-risk journal entry, as the hub does).
 * `device_id` on /sync/changes and /live refreshes that device's last_seen.
 * EA_MOCK_BACKUP_AGE_H=40 makes /status report a stale backup (for the Status view warning).
 * An `activity` notify is emitted EA_MOCK_ACTIVITY_DELAY_S (default 20) seconds after start for the open activity log,
 * then every 60 s once EA_FOCUS_CHECK_HOURS (default 3) have passed since the last check-in, like the hub.
 * On demand: GET /planner/today?digest=1 emits a `digest` notify, GET /planner/today?activity=1 emits an `activity` notify.
 * Module 4: /health/summary, /health/injection-day, /pets/:pet/summary, /sensors, /sensors/:name/readings (also `?token=`),
 * /sensors/:name/csv, /food/pick, /food/picked, the `pet_event`, `sensor` and `food_option` kinds (a pet event with a next_due
 * links its reminder). Readings are kept beside the store and never synced. GET /sensors?alert=1 emits a `sensor` notify.
 * Module 5: /projects/:id/summary, /projects/:id/plan, /procedures/from-text, /procedures/:id/advance, /procedures/:id/reset,
 * /music, /music/quick, /quiz/today, /quiz/:id/answer, the `inventory`, `procedure`, `music_idea` and `quiz` kinds (a project
 * write fills parts.have from inventory names), a troubleshoot reply with numbered steps and a `procedure_id`, and
 * `creative` on /status. GET /quiz/today?notify=1 emits a `quiz` notify.
 * Module 6: /ops, /monitors/:id/check, /monitors/:id/history, /incidents/:id/ack, the `monitor` and `incident` kinds, ten
 * seeded monitors (Ollama down with an open incident, mini-pc over Tailscale unknown) with 24 h of checks kept beside the
 * store, and `ops` on /status. Enabled monitors are checked every 60 s. GET /ops?down=1 takes server down (an incident and a
 * `monitor` notify); GET /ops?up=1 brings every down monitor back and closes its incident.
 * Module 7: /checklists/:id/instantiate, /checklists/:id/toggle, /applications/board, /applications/:id/cover-letter, /games/pick,
 * /games/:id/played, /calc/split|payoff|unit, /finance/subscriptions, the `checklist`, `application` and `game` kinds,
 * and `admin` on /status. Seeds the four packing templates, "US states visited" with a few states done, applications across
 * stages, eight games owned across four friends and a second subscription. Cover letters: job text containing "nomodel" answers
 * 503 `no model`, job text containing "guard" answers 422 with the invented employer names in `detail.names`.
 * Feel: GET and PUT /prefs/feel, kept in memory, with `effective` from the newest keyed music idea when following music.
 * Image shapes: POST /prefs/feel/images?name= (raw PNG or WebP, 512 KB at most; 413, 415 and 422 as the hub answers),
 * GET and DELETE /prefs/feel/images/:id. An older `{ theme: "custom", colors }` becomes the palette "My colors".
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { classifyCapture, effectiveAt, nextOccurrence } from "@everythingapp/shared";
import type { Entity, Patch } from "@everythingapp/shared";
import {
  addDays,
  atMinutes,
  blockOf,
  buildDigest,
  commitmentsFor,
  daySpan,
  hhmmToMinutes,
  weeksFromAnchor,
  findConflict,
  freeSlots,
  isDateOnly,
  localDate,
  mondayOf,
  overlaps,
  parseDue,
  parseLocalDate,
  reminderOnDate,
  spanOf,
  watchesDueSoon,
  type Block,
  type Conflict,
  type PlannerDay,
  type Span,
} from "../src/lib/planner";
import { deriveHosts, detectHost, renderSnippet, type SnippetF } from "../src/lib/memory";
import { advanceProcedure, parseMusicQuick, partRows, stepsFromText, type Part, type ProcedureF, type QuizF } from "../src/lib/creative";
import { uptimePct, type CheckRow, type IncidentF, type MonitorF } from "../src/lib/ops";
import { payoff as calcPayoff, split as calcSplit, subscriptions as calcSubs, unitPrices } from "../src/lib/calc";
import { ACTIVE_STAGES, STATES, groupBoard, instantiateFields, toggleItem, type ApplicationF, type ChecklistF, type GameF } from "../src/lib/admin";
import { KEYS, SCALES, SHAPES, SYNTHS, THEMES, parseKey } from "../src/feel/theory";
import { APP_THEMES, DEFAULT_FEEL, MAX_IMAGES, appThemeExists, cleanPatch, normalizeFeel, paletteExists, type Feel } from "../src/feel/prefs";
import { MODULES } from "../../hub/src/modules";

const mockModuleOn = new Map<string, boolean>();
function mockModules() {
  return MODULES.map((m) => ({ id: m.id, title: m.title, summary: m.summary, group: m.group, on: mockModuleOn.get(m.id) ?? m.default,
    ...(m.reads ? { reads: m.reads } : {}), ...(m.permissions ? { permissions: m.permissions } : {}), ...(m.setup ? { setup: m.setup } : {}) }));
}

const PORT = Number(process.env.EA_PORT ?? 8787);
const TOKEN = process.env.EA_TOKEN ?? "dev";
const ACTIVITY_DELAY_S = Number(process.env.EA_MOCK_ACTIVITY_DELAY_S ?? 20);
const FOCUS_CHECK_HOURS = Number(process.env.EA_FOCUS_CHECK_HOURS ?? 3);

const entities = new Map<string, Entity>();
const changes: Array<{ seq: number; entity: Entity }> = [];
let seq = 0;
const liveClients = new Set<http.ServerResponse>();
const STARTED_AT = new Date().toISOString();
const aiCalls: Array<{ at: string; backend: string; ms: number }> = [];
const closedTopics = new Map<string, string>(); // session id -> topic, so a second close hits the same runbook section
const lastSessionClose = new Map<string, string>(); // project id -> ISO of the last session close with that project

/** Refresh a device's last_seen without producing a change row (a change would make every client pull again). */
function touchDevice(id: string | null) {
  if (!id) return;
  const d = entities.get(id);
  if (!d || d.kind !== "device") return;
  d.fields.last_seen = now();
  d.field_ts.last_seen = d.fields.last_seen as string;
}

const now = () => new Date().toISOString();
const iso = (d: Date) => d.toISOString();
const hoursAgo = (h: number) => iso(new Date(Date.now() - h * 3600_000));
const hoursAhead = (h: number) => iso(new Date(Date.now() + h * 3600_000));

function record(e: Entity) {
  entities.set(e.id, e);
  seq++;
  changes.push({ seq, entity: structuredClone(e) });
  const msg = `event: change\ndata: ${JSON.stringify({ seq, id: e.id, kind: e.kind })}\n\n`;
  for (const c of liveClients) c.write(msg);
}

function create(kind: Entity["kind"], fields: Record<string, unknown>, space: Entity["space"] = "personal", at = now()): Entity {
  const field_ts: Record<string, string> = {};
  for (const k of Object.keys(fields)) field_ts[k] = at;
  const e: Entity = { id: randomUUID(), kind, space, created_at: at, updated_at: at, deleted_at: null, fields, field_ts };
  record(e);
  return e;
}

function applyPatch(p: Patch): { ok: boolean; reason?: string } {
  let e = entities.get(p.id);
  if (!e) {
    if (!p.create) return { ok: false, reason: "unknown id" };
    e = { id: p.id, kind: p.kind, space: p.space ?? "personal", created_at: p.ts, updated_at: p.ts, deleted_at: null, fields: {}, field_ts: {} };
  }
  if (e.kind !== p.kind) return { ok: false, reason: "kind mismatch" };
  let touched = false;
  for (const [k, v] of Object.entries(p.fields)) {
    if (!e.field_ts[k] || p.ts > e.field_ts[k]) {
      e.fields[k] = v;
      e.field_ts[k] = p.ts;
      touched = true;
      if (k === "deleted_at") e.deleted_at = (v as string | null) ?? null;
    }
  }
  if (touched && p.ts > e.updated_at) e.updated_at = p.ts;
  if (e.kind === "note") deriveLinks(e);
  if (e.kind === "project" && live(e) && "parts" in p.fields) matchParts(e);
  record(e);
  if (e.kind === "watch" && live(e)) ensureWatchReminder(e);
  if (e.kind === "pet_event" && live(e)) ensurePetReminder(e);
  return { ok: true };
}

// ---------- Module 5: creative and builds ----------
/** Fill parts.have and inventory_id by matching inventory names case-insensitively, as the hub does on every project write. */
function matchParts(project: Entity) {
  const parts = (project.fields.parts as Part[] | undefined) ?? [];
  const inventory = allLive().filter((e) => e.kind === "inventory");
  project.fields.parts = parts.map((p) => {
    const hit = inventory.find((e) => String(e.fields.name).trim().toLowerCase() === p.name.trim().toLowerCase());
    const out: Part = { name: p.name, qty: Number(p.qty) || 1 };
    if (hit) {
      out.have = Number(hit.fields.qty ?? 1) || 0;
      out.inventory_id = hit.id;
    }
    return out;
  });
}

const PLAN_HEADINGS = ["Goal", "Definition of done", "Current state", "Next", "Parts", "Log"] as const;
function planSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    if (m) {
      current = m[1].trim();
      out[current] = "";
      continue;
    }
    if (current) out[current] += (out[current] ? "\n" : "") + line;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}
function planNoteOf(project: Entity): Entity | undefined {
  const path = `Projects/${project.fields.name}/Plan.md`;
  return allNotes().find((n) => n.fields.path === path);
}
/** Upsert Projects/<name>/Plan.md with the fixed headings; log lines are dated and appended, never replaced. */
function upsertPlan(project: Entity, sections: { goal?: string; current?: string; next?: string; parts?: string; log_line?: string }): Entity {
  const name = String(project.fields.name);
  const existing = planNoteOf(project);
  const cur = existing ? planSections(String(existing.fields.body ?? "")) : {};
  const next: Record<string, string> = {
    Goal: sections.goal ?? cur.Goal ?? "",
    "Definition of done": String(project.fields.definition_of_done ?? ""),
    "Current state": sections.current ?? cur["Current state"] ?? "",
    Next: sections.next ?? cur.Next ?? "",
    Parts: sections.parts ?? cur.Parts ?? partRows(project.fields.parts as Part[]).map((r) => `- ${r.name}: need ${r.qty}, have ${r.have}${r.missing ? `, missing ${r.missing}` : ""}`).join("\n"),
    Log: cur.Log ?? "",
  };
  if (sections.log_line) next.Log = `${next.Log ? `${next.Log}\n` : ""}- ${now().slice(0, 10)}: ${sections.log_line}`;
  const body = `# ${name} plan\n\n${PLAN_HEADINGS.map((h) => `## ${h}\n\n${next[h] || "(empty)"}`).join("\n\n")}\n`;
  if (existing) {
    patchFields(existing, { body });
    return entities.get(existing.id)!;
  }
  const n = create("note", { title: `${name} plan`, body, tags: ["project", "plan"], path: `Projects/${name}/Plan.md` });
  patchFields(project, { plan_doc_path: `Projects/${name}/Plan.md` });
  return entities.get(n.id)!;
}
function projectSummary(project: Entity) {
  const id = project.id;
  const name = String(project.fields.name);
  const tasks = allLive().filter((e) => e.kind === "task" && e.fields.project_id === id);
  const week = Date.now() - 7 * 86400_000;
  const byOrder = (a: Entity, b: Entity) => Number(a.fields.order) - Number(b.fields.order);
  const notes = allNotes().filter((n) => String(n.fields.path).startsWith(`Projects/${name}/`));
  return {
    project,
    tasks: {
      next: tasks.filter((t) => t.fields.status === "next").sort(byOrder),
      doing: tasks.filter((t) => t.fields.status === "doing").sort(byOrder),
      done_7d: tasks.filter((t) => t.fields.status === "done" && new Date(String(t.fields.done_at ?? t.updated_at)).getTime() >= week),
    },
    notes,
    plan_note: planNoteOf(project) ?? null,
    procedures: allLive().filter((e) => e.kind === "procedure" && e.fields.project_id === id),
    music: allLive().filter((e) => e.kind === "music_idea" && e.fields.project_id === id),
    parts: partRows(project.fields.parts as Part[]),
    last_session_close: lastSessionClose.get(id) ?? null,
  };
}
function procedureFromText(b: { text: string; title?: string; host?: string; project_id?: string; source_session?: string }): Entity {
  const steps = stepsFromText(b.text, b.host);
  if (!steps.length) throw new Error("no steps found");
  const fields: Record<string, unknown> = { title: b.title ?? steps[0].text.slice(0, 80), steps, current: 0 };
  if (b.project_id) fields.project_id = b.project_id;
  if (b.source_session) fields.source_session = b.source_session;
  return create("procedure", fields);
}
function quizToday(): Entity | undefined {
  const date = localDate(new Date());
  return allLive().find((e) => e.kind === "quiz" && e.fields.date === date);
}
/** Consecutive days with a completed quiz, ending today (if complete) or yesterday. */
function quizStreak(): number {
  const done = new Set(allLive().filter((e) => e.kind === "quiz" && e.fields.completed_at).map((e) => String(e.fields.date)));
  let d = new Date();
  if (!done.has(localDate(d))) d = addDays(d, -1);
  let n = 0;
  while (done.has(localDate(d))) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

function emitNotify(payload: Record<string, unknown>) {
  const msg = `event: notify\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of liveClients) c.write(msg);
  console.log(`notify ${JSON.stringify(payload)}`);
}

// ---------- watches ----------
/** Every live watch gets exactly one `Renew: <title>` reminder at due minus lead_days, friction reason. Idempotent. */
function ensureWatchReminder(w: Entity) {
  const f = w.fields as { title: string; due: string; lead_days?: number; reminder_id?: string; repeat?: string };
  if (!f.due) return;
  const due = parseDue(f.due);
  const at = addDays(due, -(f.lead_days ?? 7));
  if (isDateOnly(f.due)) at.setHours(9, 0, 0, 0);
  const atIso = at.toISOString();
  const title = `Renew: ${f.title}`;
  const existing = f.reminder_id ? entities.get(f.reminder_id) : undefined;
  if (existing && live(existing)) {
    const rf = existing.fields as { at: string; title: string; linked_id?: string };
    const patch: Record<string, unknown> = {};
    if (rf.at !== atIso) {
      patch.at = atIso;
      patch.acknowledged_at = null;
      patch.snoozed_until = null;
    }
    if (rf.title !== title) patch.title = title;
    if (rf.linked_id !== w.id) patch.linked_id = w.id;
    if (Object.keys(patch).length) patchFields(existing, patch);
    return;
  }
  const r = create("reminder", { title, at: atIso, friction: "reason", linked_id: w.id });
  patchFields(w, { reminder_id: r.id });
}

// ---------- Module 4: body, home and animals ----------
/** Readings live beside the entity store (the client never syncs them); GET /sensors and the CSV read them. */
const readings = new Map<string, Array<{ at: string; value: number; unit?: string }>>();

/** A pet event with a next_due gets one reminder a day before it, friction none. Idempotent, like watches. */
function ensurePetReminder(e: Entity) {
  const f = e.fields as { pet: string; type: string; note?: string; next_due?: string; reminder_id?: string };
  if (!f.next_due) return;
  const at = new Date(new Date(f.next_due).getTime() - 86400_000).toISOString();
  const title = `${f.pet}: ${f.type}${f.note ? `, ${f.note}` : ""}`;
  const existing = f.reminder_id ? entities.get(f.reminder_id) : undefined;
  if (existing && live(existing)) {
    const rf = existing.fields as { at: string; title: string };
    const patch: Record<string, unknown> = {};
    if (rf.at !== at) patch.at = at;
    if (rf.title !== title) patch.title = title;
    if (Object.keys(patch).length) patchFields(existing, patch);
    return;
  }
  const r = create("reminder", { title, at, friction: "none", linked_id: e.id });
  patchFields(e, { reminder_id: r.id });
}

function factValue(key: string): string {
  const f = allLive().find((e) => e.kind === "fact" && e.fields.key === key);
  return f ? String(f.fields.value ?? "") : "";
}

function numOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)/.exec(String(v ?? ""));
  return m ? parseFloat(m[1]) : null;
}

function healthSummary(days: number) {
  const logs = allLive().filter((e) => e.kind === "log");
  const byType = (t: string, since: number) =>
    logs
      .filter((e) => e.fields.type === t && new Date(String(e.fields.at)).getTime() >= since)
      .sort((a, b) => (String(a.fields.at) < String(b.fields.at) ? -1 : 1));
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const w = byType("weight", Date.now() - days * 86400_000);
  const series = w.map((e) => ({ at: String(e.fields.at), value: numOf(e.fields.value) ?? NaN })).filter((p) => Number.isFinite(p.value));
  const latest = series.length ? series[series.length - 1] : null;
  const delta = (back: number) => {
    if (!latest) return null;
    const target = new Date(latest.at).getTime() - back * 86400_000;
    let best: { at: string; value: number } | null = null;
    for (const p of series) if (!best || Math.abs(new Date(p.at).getTime() - target) < Math.abs(new Date(best.at).getTime() - target)) best = p;
    return best && best !== latest ? Math.round((latest.value - best.value) * 10) / 10 : null;
  };
  const bp = byType("bp", 0).pop();
  const week = Date.now() - 7 * 86400_000;
  const expected = factValue("health:medications")
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
  const injection = allLive()
    .filter((e) => e.kind === "reminder" && String(e.fields.title).startsWith("Injection:"))
    .sort((a, b) => (effectiveAt(a.fields as { at: string }) < effectiveAt(b.fields as { at: string }) ? -1 : 1))[0];
  return {
    weight: { latest: latest?.value ?? null, at: latest?.at ?? null, delta_7d: delta(7), delta_30d: delta(30), series },
    bp: { latest: bp ? String(bp.fields.value) : null, at: bp ? String(bp.fields.at) : null },
    caffeine_today: byType("caffeine", dayStart.getTime()).reduce((n, e) => n + (numOf(e.fields.value) ?? 1), 0),
    meds_today: byType("med", dayStart.getTime()).map((e) => String(e.fields.value)),
    meds_expected: expected,
    mood: { series_7d: byType("mood", week).map((e) => ({ at: String(e.fields.at), value: numOf(e.fields.value) ?? 0 })) },
    sleep: { series_7d: byType("sleep", week).map((e) => ({ at: String(e.fields.at), value: numOf(e.fields.value) ?? 0 })) },
    activity_hours_7d: byType("activity", week).filter((e) => e.fields.note !== "end").reduce((n, e) => n + (e.fields.unit === "min" ? (numOf(e.fields.value) ?? 60) / 60 : 1), 0),
    next_injection: injection ? { name: String(injection.fields.title).replace(/^Injection:\s*/, ""), at: effectiveAt(injection.fields as { at: string }) } : null,
  };
}

function setInjectionDay(name: string, weekday: string, time: string) {
  const idx = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekday);
  if (idx < 0 || !/^\d{2}:\d{2}$/.test(time)) return null;
  const title = `Injection: ${name}`;
  const today = new Date();
  const mon = mondayOf(today);
  let at = atMinutes(addDays(mon, idx), hhmmToMinutes(time));
  if (at.getTime() <= Date.now()) at = addDays(at, 7);
  const existing = allLive().find((e) => e.kind === "reminder" && e.fields.title === title);
  if (existing) {
    patchFields(existing, { at: at.toISOString(), repeat: "every 7 days", friction: "reason", acknowledged_at: null, snoozed_until: null });
    return entities.get(existing.id)!;
  }
  return create("reminder", { title, at: at.toISOString(), repeat: "every 7 days", friction: "reason" });
}

function petSummary(pet: string) {
  const cutoff = Date.now() - 30 * 86400_000;
  const events = allLive().filter((e) => e.kind === "pet_event" && e.fields.pet === pet);
  const events_30d = events.filter((e) => new Date(String(e.fields.at)).getTime() >= cutoff).sort((a, b) => (String(a.fields.at) > String(b.fields.at) ? -1 : 1));
  const next_due = events.filter((e) => e.fields.next_due && String(e.fields.next_due) >= now()).sort((a, b) => (String(a.fields.next_due) < String(b.fields.next_due) ? -1 : 1));
  const rule = allLive().find((e) => e.kind === "plan_rule" && e.fields.type === "info" && String(e.fields.title).toLowerCase() === `${pet.toLowerCase()} week` && e.fields.alternating_anchor);
  let custody: { with_me_now: boolean | null; next_handoff: string | null } = { with_me_now: null, next_handoff: null };
  if (rule) {
    const today = new Date();
    const withMe = weeksFromAnchor(String(rule.fields.alternating_anchor), today) % 2 === 0;
    custody = { with_me_now: withMe, next_handoff: localDate(addDays(mondayOf(today), 7)) };
  }
  return { pet, events_30d, next_due, custody };
}

function sensorState(s: Entity): "ok" | "low" | "high" | "stale" {
  const f = s.fields as { last_value?: number; last_at?: string; min?: number; max?: number; stale_minutes?: number };
  if (f.last_value == null || !f.last_at) return "stale";
  if ((Date.now() - new Date(f.last_at).getTime()) / 60_000 > (f.stale_minutes ?? 180)) return "stale";
  if (f.min != null && f.last_value < f.min) return "low";
  if (f.max != null && f.last_value > f.max) return "high";
  return "ok";
}

function sensorByName(name: string): Entity | undefined {
  return allLive().find((e) => e.kind === "sensor" && e.fields.name === name);
}

/** Store a reading, update the sensor, and emit one `sensor` notify per bound crossing (and on return inside). */
function postReading(name: string, value: number, at: string, unit?: string, quiet = false): { at: string; value: number; unit?: string } {
  let s = sensorByName(name);
  if (!s) s = create("sensor", { name, unit: unit ?? "", alert: true, stale_minutes: 180 });
  const f = s.fields as { unit: string; min?: number; max?: number; alert?: boolean; last_value?: number };
  const before = f.last_value == null ? "ok" : f.last_value < (f.min ?? -Infinity) ? "low" : f.last_value > (f.max ?? Infinity) ? "high" : "ok";
  const after = value < (f.min ?? -Infinity) ? "low" : value > (f.max ?? Infinity) ? "high" : "ok";
  const r = { at, value, unit: unit ?? f.unit };
  const list = readings.get(name) ?? [];
  list.push(r);
  list.sort((a, b) => (a.at < b.at ? -1 : 1));
  readings.set(name, list);
  if (quiet) {
    s.fields.last_value = value;
    s.fields.last_at = at;
    s.field_ts.last_value = at;
    s.field_ts.last_at = at;
  } else patchFields(s, { last_value: value, last_at: at, state: after });
  if (!quiet && f.alert !== false && before !== after) sensorAlert(s, value, after);
  return r;
}

function sensorAlert(s: Entity, value: number, state: string) {
  const f = s.fields as { name: string; unit: string; min?: number; max?: number };
  const title = state === "ok" ? `${f.name} back to ${value} ${f.unit}` : `${f.name} ${state}: ${value} ${f.unit} (${state === "low" ? `min ${f.min}` : `max ${f.max}`})`;
  emitNotify({ kind: "sensor", title, name: f.name, value, unit: f.unit, at: now() });
}

function sensorRows() {
  const cutoff = Date.now() - 24 * 3600_000;
  return allLive()
    .filter((e) => e.kind === "sensor")
    .map((s) => {
      const all = (readings.get(String(s.fields.name)) ?? []).filter((r) => new Date(r.at).getTime() >= cutoff);
      const step = Math.max(1, Math.ceil(all.length / 288));
      const series_24h = all.filter((_, i) => i % step === 0).map((r) => ({ at: r.at, value: r.value }));
      // Same shape as the real hub: the sensor entity (settings under `fields`) plus `series_24h`.
      return { ...s, fields: { ...s.fields, state: sensorState(s) }, series_24h };
    });
}

function foodPick(body: { meal?: string; mode?: string; budget?: number; exclude?: string[] }) {
  const textures = factValue("diet:textures").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const exclude = new Set(body.exclude ?? []);
  const recent = Date.now() - 3 * 86400_000;
  const constraints_used: string[] = ["no avoid"];
  if (textures.length) constraints_used.push(`no ${textures.join(", ")}`);
  constraints_used.push("prefer protein and plant", "penalize sweet-sauce, fried, tomato", "not picked in 3 days");
  if (body.mode) constraints_used.push(`mode ${body.mode}`);
  if (body.budget != null) constraints_used.push(`budget ${body.budget}`);
  const scored = allLive()
    .filter((e) => e.kind === "food_option" && !e.fields.avoid && !exclude.has(e.id))
    .map((e) => {
      const f = e.fields as { kind: string; tags?: string[]; rating?: number; cost?: number; last_picked?: string };
      const tags = (f.tags ?? []).map((t) => t.toLowerCase());
      if (tags.some((t) => textures.includes(t))) return null;
      if (body.mode && f.kind !== body.mode) return null;
      if (body.budget != null && f.cost != null && f.cost > body.budget) return null;
      let score = 0;
      const why: string[] = [];
      if (tags.includes("protein")) (score += 2), why.push("protein");
      if (tags.includes("plant")) (score += 1), why.push("plant");
      for (const bad of ["sweet-sauce", "fried", "tomato"]) if (tags.includes(bad)) (score -= 2), why.push(`${bad} counts against it`);
      if (f.last_picked && new Date(f.last_picked).getTime() > recent) (score -= 3), why.push("had it recently");
      score += (f.rating ?? 3) / 10;
      if (body.meal === "snack" && !tags.includes("cheap")) score -= 1;
      return { e, score, why };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { pick: null, why: "Nothing fits. Add an option with a protein tag, or clear the mode and budget.", runner_up: null, constraints_used };
  const top = scored[0];
  const why = `${top.why.length ? top.why.join(", ") : "fits the rules"}${top.e.fields.rating ? `, rated ${top.e.fields.rating}` : ""}.`;
  return { pick: top.e, why: why.charAt(0).toUpperCase() + why.slice(1), runner_up: scored[1]?.e ?? null, constraints_used };
}

// ---------- planner ----------
const allLive = () => [...entities.values()].filter(live);
const taskBlocks = (exceptTaskId?: string): Block[] =>
  allLive()
    .filter((e) => e.kind === "task" && e.id !== exceptTaskId && e.fields.status !== "done")
    .map(blockOf)
    .filter((b): b is Block => !!b);

function plannerDay(date: Date, minHours: number): PlannerDay {
  const d = daySpan(date);
  const all = allLive();
  const blocks = taskBlocks().filter((b) => overlaps(b, d)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const events = all.filter((e) => e.kind === "event" && overlaps(spanOf(e), d)).sort((a, b) => (String(a.fields.start) < String(b.fields.start) ? -1 : 1));
  const commitments = commitmentsFor(all.filter((e) => e.kind === "plan_rule"), date);
  const reminders = all.filter((e) => e.kind === "reminder" && reminderOnDate(e, date)).sort((a, b) => (effectiveAt(a.fields as { at: string }) < effectiveAt(b.fields as { at: string }) ? -1 : 1));
  const ds = localDate(date);
  const watches_due = all.filter((e) => e.kind === "watch" && localDate(parseDue(String(e.fields.due))) === ds);
  const busy: Span[] = [...blocks, ...events.map(spanOf), ...commitments.filter((c) => c.type !== "preference" && c.type !== "info")];
  return { date: ds, blocks, events, commitments, reminders, watches_due, free_slots: freeSlots(date, busy, minHours) };
}

/** What a block starting at `span` would collide with: another block, an event, a commitment or a blackout. */
function scheduleConflict(taskId: string, span: Span): Conflict | null {
  const dates: Date[] = [];
  for (let d = parseLocalDate(localDate(new Date(span.start))); d.toISOString() < span.end; d = addDays(d, 1)) dates.push(d);
  const all = allLive();
  const busy: Conflict[] = taskBlocks(taskId).map((b) => ({ kind: "block", title: b.title, start: b.start, end: b.end }));
  for (const e of all) if (e.kind === "event") busy.push({ kind: "event", title: String(e.fields.title), ...spanOf(e) });
  for (const d of dates)
    for (const c of commitmentsFor(all.filter((e) => e.kind === "plan_rule"), d))
      if (c.type !== "preference" && c.type !== "info") busy.push({ kind: c.type === "blackout" ? "blackout" : "commitment", title: c.title, start: c.start, end: c.end });
  return findConflict(span, busy.sort((a, b) => (a.start < b.start ? -1 : 1)));
}

function pickNow(): { now: Entity | null; next: Entity[] } {
  const tasks = allLive().filter((e) => e.kind === "task");
  const doing = tasks.find((t) => t.fields.status === "doing") ?? null;
  const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  return { now: doing ?? next[0] ?? null, next: doing ? next : next.slice(1) };
}

function plannerToday() {
  const at = new Date();
  const day = plannerDay(at, 3);
  const { now: nowTask, next } = pickNow();
  const base = {
    now: nowTask,
    blocks: day.blocks,
    commitments: day.commitments,
    reminders_due: day.reminders,
    watches_due_soon: watchesDueSoon(allLive().filter((e) => e.kind === "watch"), at),
    captures_unprocessed: allLive().filter((e) => e.kind === "capture" && !e.fields.processed).length,
    free_slots: day.free_slots,
  };
  return { date: day.date, next, ...base, digest: buildDigest(base, at) };
}

// ---------- activity check-in ----------
/** The newest activity log that has no closing `end` log for the same value. */
function openActivity(): Entity | null {
  const logs = allLive()
    .filter((e) => e.kind === "log" && e.fields.type === "activity")
    .sort((a, b) => (String(a.fields.at) > String(b.fields.at) ? -1 : 1));
  const newest = logs[0];
  if (!newest || newest.fields.note === "end") return null;
  return newest;
}

function activityCheck(force = false) {
  const l = openActivity();
  if (!l) return;
  const f = l.fields as { value: unknown; at: string; checkins?: string[] };
  const since = f.checkins?.length ? f.checkins[f.checkins.length - 1] : f.at;
  const hoursSince = (Date.now() - new Date(since).getTime()) / 3600_000;
  if (!force && hoursSince < FOCUS_CHECK_HOURS) return;
  const h = Math.max(1, Math.floor((Date.now() - new Date(f.at).getTime()) / 3600_000));
  emitNotify({ kind: "activity", title: `On ${String(f.value)} for ${h} h`, log_id: l.id, at: now() });
  patchFields(l, { checkins: [...(f.checkins ?? []), now()] });
}

// ---------- knowledge map ----------
function noteFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
}
function allNotes(): Entity[] {
  return [...entities.values()].filter((e) => live(e) && e.kind === "note");
}
/** links = explicit [[wikilinks]] plus any mention of another note's title in the body. */
function deriveLinks(e: Entity) {
  const body = String(e.fields.body ?? "");
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1].trim());
  const lower = body.toLowerCase();
  for (const other of allNotes()) {
    if (other.id === e.id) continue;
    const t = String(other.fields.title ?? "");
    if (t.length >= 4 && lower.includes(t.toLowerCase())) out.add(t);
  }
  e.fields.links = [...out];
  e.field_ts.links = e.updated_at;
}
function noteByTitle(title: string): Entity | undefined {
  const t = title.toLowerCase();
  return allNotes().find((n) => String(n.fields.title).toLowerCase() === t);
}
function related(e: Entity) {
  const rel = (n: Entity, why: string) => ({ id: n.id, title: String(n.fields.title), path: String(n.fields.path), why });
  const links = ((e.fields.links as string[]) ?? []).map((t) => noteByTitle(t)).filter((n): n is Entity => !!n && n.id !== e.id).map((n) => rel(n, "link"));
  const title = String(e.fields.title).toLowerCase();
  const backlinks = allNotes().filter((n) => n.id !== e.id && ((n.fields.links as string[]) ?? []).some((t) => t.toLowerCase() === title)).map((n) => rel(n, "backlink"));
  const mine = new Set(((e.fields.tags as string[]) ?? []).map((t) => t.toLowerCase()));
  const seen = new Set([...links, ...backlinks].map((r) => r.id));
  const similar = allNotes()
    .filter((n) => n.id !== e.id && !seen.has(n.id))
    .map((n) => {
      const shared = ((n.fields.tags as string[]) ?? []).filter((t) => mine.has(t.toLowerCase()));
      const sameFolder = noteFolder(String(n.fields.path)) === noteFolder(String(e.fields.path));
      return shared.length ? rel(n, `tags ${shared.join(", ")}`) : sameFolder ? rel(n, "same folder") : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 8);
  return { links, backlinks, similar };
}
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "very", "list", "notes", "note", "about", "procedure"]);
function suggestTags(e: Entity, ai: boolean): string[] {
  const have = new Set(((e.fields.tags as string[]) ?? []).map((t) => t.toLowerCase()));
  const out = new Set<string>();
  const folder = noteFolder(String(e.fields.path)).split("/").pop() ?? "";
  if (folder && folder !== "/") out.add(folder.toLowerCase().replace(/\s+/g, "-"));
  const text = `${e.fields.title} ${e.fields.body}`.toLowerCase();
  for (const w of ["homelab", "proxmox", "tailscale", "backup", "runbook", "idea", "humor", "health", "windows", "mac", "rust", "python"]) if (text.includes(w)) out.add(w);
  if (ai) {
    for (const w of String(e.fields.title).toLowerCase().split(/\W+/)) if (w.length > 3 && !STOP.has(w)) out.add(w);
  }
  return [...out].filter((t) => !have.has(t)).slice(0, 8);
}

function patchFields(e: Entity, fields: Record<string, unknown>) {
  // Strictly later than any existing field_ts, or a same-millisecond write would be dropped.
  const latest = Math.max(...Object.values(e.field_ts).map((t) => new Date(t).getTime()), 0);
  const ts = new Date(Math.max(Date.now(), latest + 1)).toISOString();
  applyPatch({ id: e.id, kind: e.kind, space: e.space, ts, fields });
}


// ---------- Module 6: homelab ops ----------
/** The check log lives beside the entity store, like the hub's `checks` table. Kept 7 days. */
const checkLog = new Map<string, CheckRow[]>();
/** Monitors the mock treats as broken: every check fails with this error until ?up=1. */
const broken = new Map<string, string>();
/** Seeded monitors the 60 s runner skips, so one stays unknown; Check now still runs them. */
const silent = new Set<string>();

const monitorsLive = () => allLive().filter((e) => e.kind === "monitor");
const openIncidentFor = (monitorId: string) => allLive().find((e) => e.kind === "incident" && e.fields.monitor_id === monitorId && !e.fields.closed_at);

function latencyFor(f: MonitorF, t: number): number {
  const base = f.type === "ping" ? (f.target.startsWith("100.") ? 18 : 1.2) : f.type === "http" ? 24 : f.type === "tls" ? 60 : 8;
  return Math.round((base + ((t / 60_000) % 7) * base * 0.08) * 10) / 10;
}

function logCheck(id: string, row: CheckRow) {
  const rows = checkLog.get(id) ?? [];
  rows.push(row);
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  while (rows.length && rows[0].at < cutoff) rows.shift();
  checkLog.set(id, rows);
}

/** One check, as the hub's runner would: state after fails_before_down, incidents and the up/down notify. */
function runCheck(m: Entity): Entity {
  const f = m.fields as MonitorF;
  const at = now();
  const error = broken.get(m.id);
  const ok = !error;
  const latency = ok ? latencyFor(f, Date.now()) : undefined;
  logCheck(m.id, { at, ok, latency_ms: latency, ...(error ? { error } : {}) });
  const patch: Record<string, unknown> = { last_check: at };
  if (ok) {
    patch.last_ok = at;
    patch.last_latency_ms = latency;
    patch.consecutive_fails = 0;
    patch.last_error = null;
    patch.state = "up";
    const inc = openIncidentFor(m.id);
    if (inc) {
      patchFields(inc, { closed_at: at });
      emitNotify({ kind: "monitor", name: f.name, state: "up", at });
    }
  } else {
    const fails = (f.consecutive_fails ?? 0) + 1;
    patch.consecutive_fails = fails;
    patch.last_error = error;
    const threshold = f.fails_before_down ?? 3;
    if (fails >= threshold) {
      patch.state = "down";
      const inc = openIncidentFor(m.id);
      if (inc) patchFields(inc, { checks_failed: Number(inc.fields.checks_failed ?? 0) + 1, last_error: error });
      else {
        create("incident", { monitor_id: m.id, name: f.name, opened_at: at, last_error: error, checks_failed: fails });
        emitNotify({ kind: "monitor", name: f.name, state: "down", error, at });
      }
    }
  }
  patchFields(m, patch);
  return entities.get(m.id)!;
}

function seedOps() {
  const mons: Array<Partial<MonitorF> & { name: string; type: MonitorF["type"]; target: string }> = [
    { name: "nas01 lan", host: "nas01", type: "ping", target: "192.168.1.20", interval_s: 120 },
    { name: "desktop lan", host: "desktop", type: "ping", target: "192.168.1.5", interval_s: 120 },
    { name: "mini-pc lan", host: "mini-pc", type: "ping", target: "192.168.1.2", interval_s: 120 },
    { name: "nas01 tailscale", host: "nas01", type: "ping", target: "100.64.10.4", interval_s: 120 },
    { name: "desktop tailscale", host: "desktop", type: "ping", target: "100.64.10.5", interval_s: 120 },
    { name: "mini-pc tailscale", host: "mini-pc", type: "ping", target: "100.64.10.6", interval_s: 120 },
    { name: "hub health", host: "server", type: "http", target: "http://127.0.0.1:8787/health", expect: "ok", interval_s: 60 },
    { name: "ollama", host: "desktop", type: "http", target: "http://100.64.10.5:11434/api/tags", interval_s: 60 },
    { name: "server tls", host: "server", type: "tls", target: "https://hub.your-tailnet.ts.net:8787", interval_s: 300 },
  ];
  const end = Date.now();
  const OLLAMA_ERR = "connect ECONNREFUSED 100.64.10.5:11434";
  const STORAGE_ERR = "ping timeout after 5 s";
  for (const def of mons) {
    const m = create("monitor", { timeout_s: 5, fails_before_down: 3, enabled: true, ...def, state: "unknown" }, "personal", hoursAgo(24 * 30));
    if (def.name === "mini-pc tailscale") {
      silent.add(m.id); // never answered: stays unknown with no history
      continue;
    }
    const step = (def.interval_s ?? 60) * 1000;
    let consecutive = 0;
    let last: CheckRow | null = null;
    let lastOk: string | undefined;
    for (let t = end - 24 * 3600_000 + step; t <= end - 30_000; t += step) {
      const minsAgo = (end - t) / 60_000;
      const at = iso(new Date(t));
      let error: string | undefined;
      if (def.name === "ollama" && minsAgo <= 38) error = OLLAMA_ERR;
      if (def.name === "nas01 lan" && minsAgo >= 540 && minsAgo < 550) error = STORAGE_ERR;
      if (def.name === "server tls") error = undefined;
      last = { at, ok: !error, ...(error ? { error } : { latency_ms: latencyFor(def as MonitorF, t) }) };
      logCheck(m.id, last);
      consecutive = error ? consecutive + 1 : 0;
      if (!error) lastOk = at;
    }
    const down = def.name === "ollama";
    patchFields(m, {
      state: down ? "down" : "up",
      last_check: last?.at,
      last_ok: lastOk,
      last_latency_ms: down ? undefined : last?.latency_ms,
      last_error: down ? OLLAMA_ERR : undefined,
      consecutive_fails: consecutive,
    });
    if (down) {
      broken.set(m.id, OLLAMA_ERR);
      create("incident", { monitor_id: m.id, name: def.name, opened_at: iso(new Date(end - 36 * 60_000)), last_error: OLLAMA_ERR, checks_failed: consecutive });
    }
    if (def.name === "nas01 lan") {
      create("incident", { monitor_id: m.id, name: def.name, opened_at: iso(new Date(end - 547 * 60_000)), closed_at: iso(new Date(end - 540 * 60_000)), last_error: STORAGE_ERR, checks_failed: 4 });
    }
    if (def.name === "hub health") {
      const j = create("journal", { host: "server", at: hoursAgo(70), what: "Incident acknowledged: hub health: restarted the hub after the node upgrade", risk: "low", outcome: "done" });
      create("incident", { monitor_id: m.id, name: def.name, opened_at: hoursAgo(71), closed_at: hoursAgo(70.6), acknowledged_at: hoursAgo(70), ack_note: "restarted the hub after the node upgrade", last_error: "connect ECONNREFUSED 127.0.0.1:8787", checks_failed: 22, journal_id: j.id });
    }
  }
}

function opsBoard() {
  const all = allLive();
  const incidents = all.filter((e) => e.kind === "incident");
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const monitors = monitorsLive();
  const soon = Date.now() + 30 * 86400_000;
  return {
    monitors: monitors.map((m) => ({ ...m, incident_open: openIncidentFor(m.id) ?? null })),
    incidents_open: incidents.filter((e) => !e.fields.closed_at),
    incidents_7d: incidents.filter((e) => String(e.fields.opened_at) >= weekAgo).length,
    uptime_24h: monitors.map((m) => ({ name: String(m.fields.name), pct: uptimePct((checkLog.get(m.id) ?? []).filter((r) => r.at >= dayAgo)) })),
    watches_due_30d: all
      .filter((e) => e.kind === "watch" && parseDue(String(e.fields.due)).getTime() <= soon)
      .sort((a, b) => parseDue(String(a.fields.due)).getTime() - parseDue(String(b.fields.due)).getTime()),
    journal_recent: all
      .filter((e) => e.kind === "journal")
      .sort((a, b) => (String(a.fields.at) < String(b.fields.at) ? 1 : -1))
      .slice(0, 10),
    hosts: deriveHosts(all),
  };
}

/** ?down=1: server goes down at once (as if fails_before_down had been reached). */
function takeDown(name = "server lan") {
  const m = monitorsLive().find((e) => e.fields.name === name);
  if (!m || m.fields.state === "down") return;
  const error = "ping timeout after 5 s";
  broken.set(m.id, error);
  patchFields(m, { consecutive_fails: Math.max(0, Number(m.fields.fails_before_down ?? 3) - 1) });
  runCheck(entities.get(m.id)!);
}

/** ?up=1: every broken monitor recovers on its next check, which runs now. */
function bringUp() {
  for (const id of [...broken.keys()]) {
    broken.delete(id);
    const m = entities.get(id);
    if (m && live(m)) runCheck(m);
  }
}

function opsStatus() {
  const monitors = monitorsLive();
  return {
    monitors: monitors.length,
    down: monitors.filter((m) => m.fields.state === "down").length,
    incidents_open: allLive().filter((e) => e.kind === "incident" && !e.fields.closed_at).length,
  };
}

// ---------- seed ----------
function seed() {
  create("task", { title: "Replace the UPS battery in the rack", notes: "APC 1500. Part number on the label. Order first, swap in a block.", status: "doing", order: 1, block: { start: hoursAgo(1), end: hoursAhead(2) } });
  create("task", { title: "Write the hub restore runbook", status: "next", order: 1, due: hoursAhead(30) });
  create("task", { title: "Move the notes export to nas01", status: "next", order: 2 });
  create("task", { title: "Cancel the unused domain renewal", status: "next", order: 3, due: hoursAhead(80) });
  create("task", { title: "Check Proxmox backup job output", status: "next", order: 4 });
  create("task", { title: "Sort the parts bin", status: "inbox", order: 5 });
  create("task", { title: "Rewrite the photo sorter in Go", status: "parked", order: 6, parked_reason: "Scope. Finish the import first." });
  create("task", { title: "Set up Tailscale on mini-pc", status: "done", order: 7, done_at: hoursAgo(20) });
  create("reminder", { title: "Take evening meds", at: hoursAhead(0.5), repeat: "every 1 days", friction: "reason" });
  create("reminder", { title: "Call the vet about Dog", at: hoursAhead(5), friction: "none" });
  create("reminder", { title: "Water the plants", at: hoursAgo(0.2), friction: "none" });
  create("note", { title: "Hub restore procedure", body: "# Restore\n\n1. Copy the SQLite file from nas01.\n2. Start the service.\n\nSee [[pve1 host notes]] and [[Tailscale setup]].", tags: ["runbook", "homelab"], path: "Homelab/Hub restore procedure.md" });
  create("note", { title: "pve1 host notes", body: "Proxmox host. 64 GB RAM. Boots from the NVMe.\n\n```\nssh root@pve1\n```", tags: ["homelab"], path: "Homelab/pve1 host notes.md" });
  create("note", { title: "Lamp timer", body: "A desk lamp that dims on a schedule. Related: [[Bench PSU wiring]].", tags: ["idea"], path: "Projects/Ideas/Lamp timer.md" });
  create("note", { title: "Packing tips", body: "- Roll the shirts\n- Chargers in one pouch\n- Keys in the same pocket every time", tags: ["travel"], path: "Misc/Packing tips.md" });
  create("capture", { text: "remind me to renew the car registration next week", source: "iphone", processed: false, suggested_kind: "reminder" });
  create("capture", { text: "weight 164", source: "watch", processed: false, suggested_kind: "log" });
  create("capture", { text: "Idea: a fortune page for board game nights", source: "mac", processed: false, suggested_kind: "note" });
  for (let d = 6; d >= 0; d--) {
    create("log", { type: "weight", value: 164 - (6 - d) * 0.3 + (d % 2) * 0.4, unit: "lb", at: hoursAgo(d * 24 + 8) });
    create("log", { type: "caffeine", value: 1, at: hoursAgo(d * 24 + 9) });
    if (d % 2 === 0) create("log", { type: "caffeine", value: 1, at: hoursAgo(d * 24 + 14) });
    create("log", { type: "mood", value: ((d * 7) % 5) - 2, at: hoursAgo(d * 24 + 20) });
    create("log", { type: "med", value: "Claritin", at: hoursAgo(d * 24 + 7) });
    if (d % 3 === 0) create("log", { type: "bp", value: `${118 + d}/${76 + (d % 3)}`, at: hoursAgo(d * 24 + 10) });
    if (d % 2 === 1) create("log", { type: "activity", value: "Walk", unit: "min", at: hoursAgo(d * 24 + 18) });
  }
  create("fact", { category: "constraint", key: "diet:no_cook", value: "Prefers meals that need no cooking on weeknights.", source: "seed", confidence: 0.95 });
  create("fact", { category: "host", key: "host:pve1", value: "Proxmox host, 64 GB RAM, NVMe boot", source: "seed", confidence: 0.9 });
  create("fact", { category: "preference", key: "work:blocks", value: "Prefers long focus blocks in the evening.", source: "seed", confidence: 0.9 });
  create("fact", { category: "relationship", key: "dog:name", value: "Dog", source: "user", confidence: 1, private: true });
  create("rule", { text: "Plain punctuation: no em or en dashes.", enforce: "both", pattern: "\\s*[\u2014\u2013]\\s*", flags: "g", replacement: ", ", active: true });
  create("rule", { text: "Keep answers short and concrete.", enforce: "prompt", active: true });
  create("rule", { text: "No closing small talk.", enforce: "both", active: true });
  create("project", { name: "EverythingApp", status: "active", definition_of_done: "Hub, web, Windows and Apple clients deployed and syncing." });

  // Module 1: scheduled blocks on other days this week, an event, plan rules, watches, an open activity.
  const today = new Date();
  const mon = mondayOf(today);
  const dayAt = (offset: number, h: number, m = 0) => atMinutes(addDays(mon, offset), h * 60 + m).toISOString();
  const otherDay = (today.getDay() + 6) % 7 === 1 ? 3 : 1; // a weekday that is not today
  create("task", { title: "Flash the new firmware on the bench PSU", status: "scheduled", order: 8, block: { start: dayAt(otherDay, 14), end: dayAt(otherDay, 17) } });
  create("task", { title: "Draft the lamp timer design note", status: "scheduled", order: 9, block: { start: dayAt(5, 10), end: dayAt(5, 13, 30) } });
  create("event", { title: "Dentist", start: dayAt(otherDay, 11), end: dayAt(otherDay, 12), source: "eventkit", location: "Main St" });
  create("event", { title: "Team sync", start: atMinutes(today, 16 * 60).toISOString(), end: atMinutes(today, 16 * 60 + 30).toISOString(), source: "m365" }, "work");
  create("plan_rule", { title: "Standup", type: "commitment", days: ["mon", "tue", "wed", "thu", "fri"], start: "09:30", end: "10:00", active: true });
  create("plan_rule", { title: "Choir rehearsal", type: "blackout", days: ["mon", "wed"], start: "17:00", end: "20:00", alternating_anchor: localDate(mon), note: "every other week", active: true });
  create("plan_rule", { title: "Guitar lesson", type: "commitment", days: ["thu"], start: "14:00", end: "15:00", active: true });
  create("plan_rule", { title: "Deep work", type: "preference", days: ["tue", "thu"], start: "10:00", end: "14:00", active: true });
  create("plan_rule", { title: "Band practice", type: "blackout", days: ["sat"], start: "19:00", end: "23:00", active: true });
  const dateIn = (days: number) => localDate(addDays(today, days));
  create("watch", { title: "hub.your-tailnet.ts.net cert", category: "cert", due: dateIn(12), lead_days: 7, probe_url: "https://hub.your-tailnet.ts.net", last_probe: hoursAgo(5) });
  create("watch", { title: "Proxmox web cert", category: "cert", due: dateIn(40), lead_days: 7, probe_url: "https://pve1.local:8006", last_probe: hoursAgo(5), last_probe_error: "connect ECONNREFUSED" });
  create("watch", { title: "Claritin refill", category: "prescription", due: dateIn(5), lead_days: 3, repeat: "every 1 months", cost: 30 });
  create("watch", { title: "robin-rivera.example domain", category: "domain", due: dateIn(75), lead_days: 14, repeat: "every 1 years", cost: 12, url: "https://domains.example/renew" });
  create("watch", { title: "Car insurance", category: "insurance", due: dateIn(-3), lead_days: 14, cost: 640, notes: "Compare quotes before renewing." });
  create("watch", { title: "Monitor RMA window", category: "rma", due: dateIn(22), lead_days: 5, url: "https://support.example/rma/1234" });
  create("watch", { title: "Music streaming", category: "subscription", due: dateIn(200), lead_days: 7, repeat: "every 1 years", cost: 110 });
  create("log", { type: "activity", value: "Soldering", at: hoursAgo(3.4), source: "watch" });

  // Module 2: hosts pve1, nas01, router (router has no runbook yet), journal entries, snippets, one open ledger.
  create("fact", { category: "host", key: "host:nas01", value: "TrueNAS box, 4 x 8 TB raidz1, pool tank", source: "user", confidence: 1 });
  create("fact", { category: "host", key: "host:router", value: "UniFi gateway and DNS, 10.0.0.1", source: "user", confidence: 1 });
  create("runbook", {
    host: "pve1",
    title: "Runbook: pve1",
    body: "# pve1\n\nProxmox 8 on NVMe. VMs on local-zfs, backups to nas01 nightly at 02:00.\n\n## 2026-10-12: VM 104 would not start\n\n**Symptoms** lock file left after a crash.\n\n**Root cause** qm was killed mid-migration.\n\n**Fix** removed the lock, started the VM.\n\n**Verification** `qm status 104` says running.",
    commands: [
      { label: "SSH in", host: "pve1", user: "root", command: "ssh root@pve1" },
      { label: "List VMs", host: "pve1", user: "root", command: "qm list" },
      { label: "Clear a VM lock", host: "pve1", user: "root", command: "qm unlock 104" },
      { label: "Backup job output", host: "pve1", user: "root", command: "journalctl -u pve-daily-update --since today" },
    ],
    last_verified: hoursAgo(36),
  }, "personal", hoursAgo(30));
  create("runbook", {
    host: "nas01",
    title: "Runbook: nas01",
    body: "# nas01\n\nTrueNAS. Pool `tank`, datasets media, backups, hub.\n\nScrub runs Sunday 03:00. Replication from pve1 lands in tank/backups.",
    commands: [
      { label: "Pool health", host: "nas01", user: "admin", command: "zpool status tank" },
      { label: "Snapshots", host: "nas01", user: "admin", command: "zfs list -t snapshot -r tank | tail -20" },
    ],
  }, "personal", hoursAgo(300));
  create("journal", { host: "pve1", at: hoursAgo(260), what: "Removed stale lock on VM 104 and started it", command: "qm unlock 104 && qm start 104", risk: "low", rollback: "qm stop 104", outcome: "done" });
  create("journal", { host: "pve1", at: hoursAgo(50), what: "Raised VM 101 memory from 4 GB to 8 GB", command: "qm set 101 --memory 8192", risk: "medium", rollback: "qm set 101 --memory 4096", outcome: "done" });
  create("journal", { host: "nas01", at: hoursAgo(120), what: "Replaced disk ada2 and resilvered", command: "zpool replace tank ada2 ada5", risk: "high", rollback: "none, the old disk is out", outcome: "done" });
  create("journal", { host: "nas01", at: hoursAgo(8), what: "Destroy the old tank/scratch dataset", command: "zfs destroy -r tank/scratch", risk: "high", rollback: "restore from tank/scratch@pre-destroy", outcome: "planned" });
  create("journal", { host: "router", at: hoursAgo(600), what: "Pinned DNS for nas01 to 10.0.0.20", command: "UniFi, Settings, Networks, DHCP reservation", risk: "low", outcome: "done" });
  create("journal", { host: "router", at: hoursAgo(14), what: "Tried a firmware update, rolled back after the WAN dropped", command: "UniFi, Devices, gateway, Update", risk: "medium", rollback: "restore the previous firmware from the device page", outcome: "reverted" });
  create("snippet", {
    title: "Snapshot before a destructive change",
    os: "linux",
    language: "bash",
    body: "zfs snapshot {{pool}}/{{dataset}}@{{tag}}\nzfs list -t snapshot {{pool}}/{{dataset}}",
    params: [{ name: "pool", default: "tank", description: "zpool name" }, { name: "dataset", description: "dataset under the pool" }, { name: "tag", default: "pre-change", description: "snapshot name" }],
    tags: ["zfs", "backup"],
    host: "nas01",
  });
  create("snippet", {
    title: "Proxmox VM memory",
    os: "linux",
    language: "bash",
    body: "qm set {{vmid}} --memory {{mb}}\nqm config {{vmid}} | grep memory",
    params: [{ name: "vmid", description: "VM id" }, { name: "mb", default: "8192", description: "memory in MB" }],
    tags: ["proxmox"],
    host: "pve1",
    last_used: hoursAgo(50),
  });
  create("snippet", {
    title: "Which process holds a port",
    os: "windows",
    language: "powershell",
    body: "Get-NetTCPConnection -LocalPort {{port}} | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Get-Process -Id $_ }",
    params: [{ name: "port", default: "443" }],
    tags: ["network", "debug"],
  });
  create("snippet", {
    title: "Rows per day",
    os: "any",
    language: "sql",
    body: "SELECT date(created_at) AS day, count(*) FROM {{table}} GROUP BY day ORDER BY day DESC LIMIT {{days}};",
    params: [{ name: "table" }, { name: "days", default: "14" }],
    tags: ["sqlite"],
  });
  create("ledger", {
    session_id: "seed-session-nas01-scrub",
    topic: "nas01 scrub stuck at 40 percent",
    tried: [{ at: hoursAgo(5), what: "zpool status, no errors listed", result: "scrub still at 40 percent" }, { at: hoursAgo(4), what: "checked SMART on all four disks", result: "ada3 has pending sectors" }],
    ruled_out: ["network between pve1 and nas01", "the replication job"],
    confirmed: ["pool tank is 4 x 8 TB raidz1", "last scrub finished clean two weeks ago"],
    open: true,
  });

  // Module 4: 30 days of body logs, meds and sleep, the injection reminder, Pepper, two sensors, ten food options.
  for (let d = 29; d >= 7; d--) {
    create("log", { type: "weight", value: Math.round((168 - (29 - d) * 0.17 + (d % 3) * 0.3) * 10) / 10, unit: "lb", at: hoursAgo(d * 24 + 8) });
    create("log", { type: "med", value: "Claritin", at: hoursAgo(d * 24 + 7) });
    if (d % 2 === 0) create("log", { type: "med", value: "Vitamin D", at: hoursAgo(d * 24 + 7) });
    create("log", { type: "mood", value: ((d * 3) % 5) - 2, at: hoursAgo(d * 24 + 20) });
    if (d % 3 === 0) create("log", { type: "bp", value: `${120 + (d % 4)}/${78 + (d % 3)}`, at: hoursAgo(d * 24 + 10) });
  }
  for (let d = 6; d >= 0; d--) {
    create("log", { type: "sleep", value: 5.5 + ((d * 2) % 4) * 0.5, unit: "h", at: hoursAgo(d * 24 + 7.5) });
    if (d % 2 === 0) create("log", { type: "med", value: "Vitamin D", at: hoursAgo(d * 24 + 7) });
  }
  create("log", { type: "med", value: "Lisinopril", at: hoursAgo(2) });
  create("fact", { category: "constraint", key: "health:medications", value: "Zyrtec 10mg, Lisinopril 10mg, Vitamin D 2000 IU, B12 1000mcg weekly", source: "user", confidence: 1 });
  create("fact", { category: "constraint", key: "diet:textures", value: "mushroom, olive", source: "seed", confidence: 0.95 });
  create("fact", { category: "constraint", key: "health:doctor_rules", value: "Low sodium. Protein first, plants second, go easy on fried food.", source: "user", confidence: 1 });
  setInjectionDay("B12", "fri", "09:00");
  create("pet_event", { pet: "Pepper", type: "vet", at: hoursAgo(26 * 24), note: "Annual visit, rabies booster", cost: 180, next_due: hoursAhead(339 * 24) });
  create("pet_event", { pet: "Pepper", type: "med", at: hoursAgo(20 * 24), note: "Heartworm chew", next_due: hoursAhead(10 * 24) });
  create("pet_event", { pet: "Pepper", type: "weight", at: hoursAgo(18 * 24), note: "24.6 lb" });
  create("pet_event", { pet: "Pepper", type: "incident", at: hoursAgo(9 * 24), note: "Ate a sock, passed it", cost: 0 });
  create("pet_event", { pet: "Pepper", type: "custody", at: hoursAgo(3 * 24), note: "Back from the sitter" });
  create("pet_event", { pet: "Pepper", type: "food", at: hoursAgo(26), note: "Fed" });
  create("pet_event", { pet: "Pepper", type: "note", at: hoursAgo(14), note: "Walked" });
  create("plan_rule", { title: "Pepper week", type: "info", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "24:00", alternating_anchor: localDate(mon), note: "shared care, alternating weeks", active: true });
  create("sensor", { name: "cabinet_temp", unit: "C", location: "parts cabinet", min: 15, max: 30, alert: true, stale_minutes: 180 });
  create("sensor", { name: "planter_moisture", unit: "%", location: "balcony, basil planter", min: 20, max: 60, alert: true, stale_minutes: 180 });
  for (let i = 96; i >= 0; i--) {
    const at = iso(new Date(Date.now() - i * 15 * 60_000));
    postReading("cabinet_temp", Math.round((22 + Math.sin(i / 8) * 2.5) * 10) / 10, at, "C", true);
    postReading("planter_moisture", Math.round(Math.max(16, 48 - (96 - i) * 0.31)), at, "%", true);
  }
  for (const s of allLive()) if (s.kind === "sensor") patchFields(s, { state: sensorState(s) });
  const food = (name: string, kind: string, items: string[], tags: string[], rating: number, cost: number, extra: Record<string, unknown> = {}) =>
    create("food_option", { name, kind, items, tags, avoid: false, rating, cost, ...extra });
  food("Sushi Go", "delivery", ["salmon nigiri x6", "tuna roll", "edamame"], ["sushi", "protein"], 5, 28);
  food("Thai Basil", "delivery", ["pad see ew chicken", "satay"], ["protein", "spicy"], 4, 22, { last_picked: hoursAgo(30), times_picked: 4 });
  food("Grill Bowl", "grab", ["grilled chicken bowl, extra greens"], ["protein", "plant", "cheap"], 4, 13);
  food("Steakhouse", "restaurant", ["sirloin, side salad"], ["protein"], 5, 48);
  food("Diner eggs", "restaurant", ["three eggs scrambled, bacon, fruit"], ["protein", "cheap"], 3, 14);
  food("Mediterranean", "delivery", ["chicken shawarma plate", "hummus"], ["protein", "plant"], 4, 19);
  food("General Tso's", "delivery", ["General Tso's chicken"], ["sweet-sauce", "fried"], 4, 17);
  food("Tikka masala", "delivery", ["chicken tikka masala"], ["tomato"], 3, 18, { avoid: true });
  food("Rotisserie chicken", "home", ["half a rotisserie chicken from the deli, bagged salad"], ["protein", "plant", "cheap"], 3, 11);
  food("Protein shake", "home", ["shake, handful of almonds"], ["protein", "cheap"], 2, 4);

  // Module 5: inventory, a build project with parts (one matches inventory), procedures, music ideas, quizzes.
  create("inventory", { name: "ESP32 DevKit", category: "component", qty: 3, unit: "pcs", location: "drawer A2", tags: ["mcu", "wifi"] });
  create("inventory", { name: "10k resistor", category: "component", qty: 40, unit: "pcs", location: "resistor book", tags: ["passive"] });
  create("inventory", { name: "SSD1306 OLED", category: "component", qty: 1, unit: "pcs", location: "drawer A3", tags: ["display", "i2c"] });
  create("inventory", { name: "Hakko FX-888D", category: "tool", qty: 1, location: "bench", tags: ["soldering"] });
  create("inventory", { name: "Focusrite 2i2", category: "gear", qty: 1, location: "desk", tags: ["audio", "interface"] });
  create("inventory", { name: "PLA black", category: "material", qty: 2, unit: "kg", location: "printer shelf", tags: ["filament"] });
  create("inventory", { name: "M3 x 8 screws", category: "material", qty: 60, unit: "pcs", location: "hardware bin", tags: ["hardware"] });
  const psu = create("project", {
    name: "Bench PSU rebuild",
    status: "active",
    definition_of_done: "0 to 30 V at 3 A on the front panel, with the OLED showing volts and amps, in the printed enclosure.",
    resume_card: "Last session (2026-10-21): the OLED works on the breadboard. Next: wire the current sense resistor and check the ADC reading against the meter. The enclosure print is queued.",
    repo: "robin/bench-psu",
    parts: [{ name: "ESP32 DevKit", qty: 1 }, { name: "SSD1306 OLED", qty: 2 }, { name: "10k resistor", qty: 6 }, { name: "INA219 current sensor", qty: 1 }, { name: "Panel binding posts", qty: 2 }],
  }, "personal", hoursAgo(400));
  matchParts(psu);
  record(psu);
  lastSessionClose.set(psu.id, hoursAgo(44));
  create("task", { title: "Wire the INA219 and read current", status: "doing", order: 10, project_id: psu.id });
  create("task", { title: "Calibrate the ADC against the meter", status: "next", order: 11, project_id: psu.id });
  create("task", { title: "Print the enclosure front plate", status: "next", order: 12, project_id: psu.id });
  create("task", { title: "Breadboard the OLED", status: "done", order: 13, project_id: psu.id, done_at: hoursAgo(44) });
  create("task", { title: "Pick the regulator topology", status: "done", order: 14, project_id: psu.id, done_at: hoursAgo(200) });
  upsertPlan(psu, { goal: "A bench supply I trust, with readable volts and amps, that fits on the shelf.", current: "OLED on the breadboard reads a fixed value. Regulator stage tested at 12 V.", next: "Current sense, then calibration, then the enclosure.", log_line: "Regulator stage tested, 12 V stable under 1 A load" });
  create("note", { title: "Bench PSU wiring", body: "# Wiring\n\nINA219 on I2C with the OLED, address 0x40.\n\n- SDA GPIO21\n- SCL GPIO22", tags: ["project", "electronics"], path: "Projects/Bench PSU rebuild/Wiring.md" });
  create("project", { name: "Game night fortune page", status: "parked", definition_of_done: "A page that prints one fortune per load for game nights, hosted on the tailnet.", resume_card: "Parked after the first draft of 40 lines. Next: pick a font and make the page." }, "personal", hoursAgo(900));
  create("procedure", {
    title: "Replace the UPS battery",
    steps: [
      { text: "Order the APC RBC7 battery", done_at: hoursAgo(60) },
      { text: "Put the hub in maintenance mode", command: "systemctl stop everythingapp", host: "server", user: "root", done_at: hoursAgo(1) },
      { text: "Shut down pve1 cleanly", command: "ssh root@pve1 'shutdown -h now'", host: "pve1", user: "root" },
      { text: "Switch the UPS off and unplug it from the wall" },
      { text: "Open the front panel and slide the old battery out" },
      { text: "Connect the new battery, slide it in, close the panel" },
      { text: "Plug the UPS in, switch it on, wait for the self test" },
      { text: "Start pve1 and the hub", command: "systemctl start everythingapp", host: "server", user: "root" },
      { text: "Check the runtime estimate", command: "apcaccess status | grep -i timeleft", host: "server", user: "root" },
    ],
    current: 2,
    started_at: hoursAgo(60),
  });
  create("procedure", {
    title: "Flash the ESP32 firmware",
    steps: [
      { text: "Build the firmware", command: "pio run", host: "mac" },
      { text: "Hold BOOT on the board, then plug it in" },
      { text: "Flash it", command: "pio run -t upload", host: "mac" },
      { text: "Open the monitor and check the boot banner", command: "pio device monitor -b 115200", host: "mac" },
    ],
    current: 0,
    project_id: psu.id,
  });
  create("music_idea", {
    title: "Gain staging cheat sheet",
    type: "reference",
    body: "# Gain staging\n\n- Record peaks around -18 dBFS, never above -6 dBFS.\n- Channel faders near 0 dB; make level with the clip gain, not the fader.\n- Mix bus peaks at -6 dBFS, master fader at 0.\n- Loudness: -14 LUFS integrated for streaming, -16 for a demo.\n\n## Mix-bus order\n\n1. Subtractive EQ\n2. Compressor, 2:1, slow attack\n3. Additive EQ\n4. Limiter last, ceiling -1 dBTP",
    status: "done",
    tags: ["mixing"],
  });
  create("music_idea", {
    title: "Session checklist",
    type: "reference",
    body: "# Before recording\n\n- Sample rate matches the interface (48 kHz)\n- Buffer 128 for tracking, 1024 for mixing\n- Start from the Band template\n- Name tracks before the first take\n- Bounce: 24 bit WAV, real time off, include the tail",
    status: "done",
    tags: ["daw"],
  });
  create("music_idea", { title: "Rainy intro", type: "progression", body: "Am F C G", key: "Am", bpm: 112, time_sig: "3/4", tuning: "open G", status: "wip", tags: ["ballad"] }, "personal", hoursAgo(30));
  create("music_idea", { title: "Low string slide", type: "riff", body: "e|----------\nB|----------\nG|----------\nD|--5/7-5---\nA|--------7-\nE|----------", key: "E", bpm: 140, time_sig: "4/4", tuning: "standard", status: "idea", tags: [] }, "personal", hoursAgo(100));
  create("music_idea", { title: "Last light", type: "lyric", body: "The last lamp on the last hill\ncounting the rain like coins", status: "idea", tags: ["draft"] }, "personal", hoursAgo(300));
  create("music_idea", { title: "Hollow Light", type: "song", body: "Intro: Rainy intro x2\nVerse: Am F C G\nChorus: F G Am Am\nBridge: Dm E", key: "Am", bpm: 112, time_sig: "3/4", tuning: "open G", status: "wip", tags: ["album"] }, "personal", hoursAgo(10));
  create("music_idea", { title: "Vocal chain", type: "setting", body: "SM7B, 2i2 gain 7, EQ HPF 80 Hz, comp 4:1 fast", status: "done", tags: ["vocals"] }, "personal", hoursAgo(500));
  const qday = (d: number) => localDate(addDays(new Date(), -d));
  for (const d of [3, 2, 1]) create("quiz", { date: qday(d), items: [{ q: "q", a: "a", hint: "h", topic: "zfs", result: "right", asked_at: hoursAgo(d * 24) }], source_sessions: [], completed_at: hoursAgo(d * 24) });
  create("quiz", {
    date: qday(0),
    items: [
      { q: "Which zfs command takes a snapshot before a destructive change?", a: "zfs snapshot pool/dataset@tag", hint: "Same verb as the thing you want.", topic: "zfs" },
      { q: "What does qm unlock do on Proxmox?", a: "Removes a stale lock left on a VM after a crash or killed migration.", hint: "The symptom was a VM that would not start.", topic: "proxmox" },
      { q: "Where should recording peaks sit in dBFS?", a: "Around -18 dBFS, never above -6.", hint: "Well below zero, with headroom for the mix bus.", topic: "mixing" },
      { q: "Which GPIO pins carry I2C on the ESP32 default bus?", a: "SDA on GPIO21, SCL on GPIO22.", hint: "Two consecutive numbers in the twenties.", topic: "esp32" },
      { q: "What sets a UniFi DHCP reservation for nas01?", a: "Settings, Networks, DHCP reservation on the gateway.", hint: "It is under Networks, not Devices.", topic: "unifi" },
    ],
    source_sessions: ["seed-session-nas01-scrub"],
  });
}
// ---------- Module 7: life admin ----------
function seedAdmin() {
  const t = (title: string, items: string[]) => create("checklist", { title, kind: "packing", items: items.map((text) => ({ text })), template: true, tags: ["packing"] });
  t("Camping weekend", ["Tent", "Sleeping bag", "Pad", "Headlamp", "Stove and fuel", "Lighter", "Water filter", "Rain shell", "First aid kit", "Food for 2 days", "Bug spray", "Trash bags"]);
  t("Overnight bag", ["Phone charger", "Meds", "Toothbrush", "Change of clothes", "Laptop and charger", "Headphones"]);
  t("Work trip", ["Laptop and charger", "Badge", "USB-C hub", "Console cable", "Meds", "Two shirts", "Chargers", "Receipts envelope"]);
  t("Day hike", ["Water, 2 L", "Snacks", "Map", "Sunscreen", "Layers", "First aid kit", "Phone, charged"]);
  const visited = new Set(["Oregon", "Washington", "California", "Nevada", "Arizona", "Colorado", "Texas", "Illinois", "New York", "Florida", "Georgia", "Utah"]);
  const day = hoursAgo(24 * 200);
  create("checklist", { title: "US states visited", kind: "states", items: STATES.map(([, name]) => (visited.has(name) ? { text: name, done_at: day } : { text: name })), template: false, tags: ["travel"] });
  create("checklist", { title: "Camping weekend, Oct", kind: "packing", items: ["Tent", "Sleeping bag", "Pad", "Headlamp", "Stove and fuel", "Water filter"].map((text, i) => (i < 3 ? { text, done_at: hoursAgo(5) } : { text })), template: false, tags: ["packing"] });

  const app = (fields: Record<string, unknown>) => create("application", fields);
  app({ company: "Northwind Health", role: "Systems Administrator", stage: "interview", applied_at: hoursAgo(24 * 12), next_step: "Panel interview", next_at: hoursAhead(50), remote: "hybrid", salary: "95-110k", url: "https://jobs.example/northwind/1" });
  app({ company: "Contoso Labs", role: "Infrastructure Engineer", stage: "screen", applied_at: hoursAgo(24 * 6), next_step: "Recruiter call", next_at: hoursAhead(26), remote: "remote" });
  app({ company: "Fabrikam", role: "Linux Admin", stage: "applied", applied_at: hoursAgo(24 * 3), next_step: "Follow up by email", next_at: hoursAhead(24 * 6), remote: "onsite" });
  app({ company: "Tailspin Toys", role: "IT Operations Lead", stage: "applied", applied_at: hoursAgo(24 * 9), remote: "hybrid" });
  app({ company: "Litware", role: "Homelab-friendly SRE", stage: "saved", remote: "remote", notes: "Asks for Proxmox and ZFS." });
  app({ company: "Adventure Works", role: "Network Engineer", stage: "offer", applied_at: hoursAgo(24 * 30), next_step: "Answer the offer", next_at: hoursAhead(24 * 3), salary: "105k", remote: "hybrid" });
  app({ company: "Wide World Importers", role: "Sysadmin II", stage: "rejected", applied_at: hoursAgo(24 * 40) });

  const g = (fields: Record<string, unknown>) => create("game", { coop: true, genres: [], ...fields });
  g({ name: "Deep Rock Galactic", min_players: 1, max_players: 4, genres: ["shooter", "co-op"], owned_by: ["Alex", "Rob", "Kim", "Dev"], session_hours: 2, rating: 5, last_played: hoursAgo(24 * 3) });
  g({ name: "Valheim", min_players: 1, max_players: 10, genres: ["survival"], owned_by: ["Alex", "Rob", "Kim"], session_hours: 4, rating: 4, last_played: hoursAgo(24 * 40) });
  g({ name: "Lethal Company", min_players: 1, max_players: 4, genres: ["horror"], owned_by: ["Alex", "Kim", "Dev"], session_hours: 2, rating: 4 });
  g({ name: "Satisfactory", min_players: 1, max_players: 4, genres: ["factory"], owned_by: ["Alex", "Dev"], session_hours: 6, rating: 5, last_played: hoursAgo(24 * 10) });
  g({ name: "It Takes Two", min_players: 2, max_players: 2, genres: ["platformer"], owned_by: ["Alex", "Rob"], session_hours: 2, rating: 4 });
  g({ name: "Helldivers 2", min_players: 1, max_players: 4, genres: ["shooter"], owned_by: ["Alex", "Rob", "Kim", "Dev"], session_hours: 2, rating: 4, last_played: hoursAgo(24 * 1) });
  g({ name: "Jackbox Party Pack 9", min_players: 3, max_players: 8, coop: false, genres: ["party"], owned_by: ["Alex"], session_hours: 2, rating: 3 });
  g({ name: "Civilization VI", min_players: 1, max_players: 6, coop: false, genres: ["strategy"], owned_by: ["Alex", "Rob", "Kim", "Dev"], session_hours: 6, rating: 4, last_played: hoursAgo(24 * 60) });

  create("watch", { title: "Cloud backup", category: "subscription", due: localDate(addDays(new Date(), 9)), lead_days: 3, repeat: "every 1 months", cost: 9 });
}

function gamePick(b: { players?: string[]; hours?: number; coop?: boolean; exclude?: string[] }) {
  const players = (b.players ?? []).map(String);
  const exclude = new Set(b.exclude ?? []);
  const all = allLive().filter((e) => e.kind === "game");
  const fits = all.filter((e) => {
    const f = e.fields as GameF;
    if (exclude.has(e.id)) return false;
    if (!players.every((p) => (f.owned_by ?? []).includes(p))) return false;
    if (players.length < (f.min_players ?? 1) || players.length > (f.max_players ?? 4)) return false;
    if (b.coop === true && f.coop === false) return false;
    if (b.coop === false && f.coop !== false) return false;
    if (b.hours != null && f.session_hours != null && f.session_hours > b.hours) return false;
    return true;
  });
  fits.sort((x, y) => {
    const a = String((x.fields as GameF).last_played ?? "");
    const c = String((y.fields as GameF).last_played ?? "");
    if (a !== c) return a < c ? -1 : 1;
    return ((y.fields as GameF).rating ?? 0) - ((x.fields as GameF).rating ?? 0);
  });
  const pick = fits[0] ?? null;
  const pf = pick?.fields as GameF | undefined;
  const why = !pick
    ? `Nothing ${players.length === 1 ? `${players[0]} owns` : "every player owns"} fits ${players.length} ${players.length === 1 ? "player" : "players"}${b.hours ? ` in ${b.hours} h` : ""}${b.coop ? ", co-op" : ""}.`
    : `Everyone owns it, fits ${players.length}${pf?.session_hours ? `, about ${pf.session_hours} h` : ""}, ${pf?.last_played ? `last played ${Math.round((Date.now() - new Date(pf.last_played).getTime()) / 86400_000)} days ago` : "never played"}${pf?.rating ? `, rated ${pf.rating}` : ""}.`;
  return { pick, why, runner_up: fits[1] ?? null, considered: fits.length };
}

const INVENTED = ["Initech", "Globex", "Umbrella Corp", "Hooli"];
function coverLetter(a: Entity, b: { job_text?: string; tone?: string }): { status: number; body: unknown } {
  const job = String(b.job_text ?? "");
  if (/nomodel/i.test(job)) return { status: 503, body: { error: "no model" } };
  if (/guard/i.test(job)) return { status: 422, body: { error: "draft mentions employers not in your facts or the job text", detail: { invented: INVENTED.slice(0, 2), backend: "adapter" } } };
  const f = a.fields as ApplicationF;
  const tone = b.tone ?? "plain";
  const open = tone === "warm" ? `I would love to bring my homelab and support experience to ${f.company}.` : tone === "direct" ? `I run infrastructure and want to run yours at ${f.company}.` : `I am applying for the ${f.role} role at ${f.company}.`;
  const body = `${open}\n\nI keep a Proxmox and ZFS homelab, write runbooks for everything I touch, and work in long focused blocks.\n\nThank you for your time.\n\nAlex`;
  const path = `Career/Cover letters/${f.company} - ${f.role}.md`.replace(/[\\:*?"<>|]/g, "-");
  const existing = allNotes().find((n) => n.fields.path === path);
  const note = existing ?? create("note", { title: `${f.company} - ${f.role}`, body, tags: ["career", "cover-letter"], path });
  if (existing) patchFields(existing, { body });
  patchFields(a, { letter_note_id: note.id });
  const backend = "adapter";
  aiCalls.push({ at: now(), backend, ms: 2400 });
  return { status: 200, body: { note: entities.get(note.id), backend } };
}

seed();
seedOps();
seedAdmin();
setInterval(() => {
  for (const m of monitorsLive()) if (m.fields.enabled !== false && !silent.has(m.id)) runCheck(m);
}, 60_000);
for (const w of allLive()) if (w.kind === "watch") ensureWatchReminder(w);
setTimeout(() => activityCheck(true), ACTIVITY_DELAY_S * 1000);
setInterval(() => activityCheck(false), 60_000);
for (const n of allNotes()) {
  deriveLinks(n);
  record(n);
}

// ---------- feel ----------
const { effective: _defaultEffective, ...feelDefaults } = DEFAULT_FEEL;
let feel: Feel = { ...feelDefaults };

/** GET /prefs/feel: the setting, plus the key actually played (the newest keyed music idea's when following music). */
function feelView() {
  let effective: { key: string; scale: string; from: { id: string; title: string; key: string } | null } = { key: feel.key, scale: feel.scale, from: null };
  if (feel.follow_music) {
    const idea = allLive()
      .filter((e) => e.kind === "music_idea" && typeof e.fields.key === "string" && parseKey(String(e.fields.key)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (idea) effective = { ...parseKey(String(idea.fields.key))!, from: { id: idea.id, title: String(idea.fields.title ?? ""), key: String(idea.fields.key) } };
  }
  const app_themes = [{ id: "classic", name: "Classic" }, ...APP_THEMES];
  return { ...feel, effective, options: { keys: KEYS, scales: Object.keys(SCALES), synths: SYNTHS, themes: THEMES, shapes: SHAPES, app_themes } };
}

/**
 * PUT /prefs/feel: merge, refusing the whole body when any field is unknown or invalid, as the hub does. Lists are
 * replaced whole and their ids must be unique; choosing a palette or app theme that does not exist is refused, while
 * deleting the one in use falls back to the default.
 */
function setFeel(body: Record<string, unknown>): string | null {
  const ok = cleanPatch(body) as Record<string, unknown>;
  const legacy = body.theme === "custom";
  const bad = Object.keys(body).filter((k) => {
    if (legacy && (k === "theme" || k === "colors")) return false;
    const v = body[k];
    const got = ok[k];
    if (got === undefined) return true;
    if (Array.isArray(v)) return !Array.isArray(got) || got.length !== v.length;
    return typeof v === "number" ? got !== v : false;
  });
  if (bad.length) return `invalid: ${bad.join(", ")}`;
  const next = normalizeFeel({ ...feel, ...ok } as Feel, body);
  for (const [k, v] of [["theme", body.theme], ["app_theme", body.app_theme]] as const) {
    if (typeof v === "string" && v !== "custom" && next[k] !== v) return `${k}: ${v} does not exist`;
  }
  if (!paletteExists(next, next.theme) || !appThemeExists(next, next.app_theme)) return "theme does not exist";
  feel = next;
  return null;
}

/** Image shapes' bytes, beside the setting. */
const feelImages = new Map<string, { bytes: Buffer; type: string }>();
const MAX_IMAGE_BYTES = 512 * 1024;

function addFeelImage(bytes: Buffer, type: string, name: string): { status: number; error?: string } {
  if (type !== "image/png" && type !== "image/webp") return { status: 415, error: "send a PNG or WebP image" };
  if (bytes.length > MAX_IMAGE_BYTES) return { status: 413, error: "images must be 512 KB or smaller; shrink it to about 256 px first" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (!(type === "image/png" ? png : webp)) return { status: 415, error: "the file is not the image type it claims to be" };
  if (feel.images.length >= MAX_IMAGES) return { status: 422, error: "24 images at most; remove one first" };
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  feelImages.set(id, { bytes, type });
  feel = { ...feel, images: [...feel.images, { id, name: name.trim().slice(0, 40) || "Image", enabled: true, type }] };
  return { status: 201 };
}

async function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ---------- http ----------
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors() });
  res.end(JSON.stringify(body));
}
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}
function live(e: Entity) {
  return !e.deleted_at;
}
function titleOf(e: Entity): string {
  const f = e.fields as Record<string, unknown>;
  return String(f.title ?? f.text ?? f.key ?? f.name ?? f.value ?? "");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    return res.end();
  }
  try {
    if (path === "/health") return json(res, 200, { ok: true, version: "mock-0.1.0", time: now(), db_seq: seq });
    const auth = req.headers.authorization ?? "";
    const tokenQuery = /^\/sensors\/[^/]+\/readings$/.test(path) && url.searchParams.get("token") === TOKEN;
    if (auth !== `Bearer ${TOKEN}` && !tokenQuery) return json(res, 401, { error: "unauthorized" });

    if (path === "/devices/register" && req.method === "POST") {
      const b = await readBody(req);
      const d = create("device", { name: b.name, platform: b.platform, last_seen: now() });
      return json(res, 200, { device_id: d.id });
    }
    if (path === "/sync/changes") {
      touchDevice(url.searchParams.get("device_id"));
      const since = Number(url.searchParams.get("since") ?? 0);
      const rows = changes.filter((c) => c.seq > since);
      const page = rows.slice(0, 500);
      return json(res, 200, { changes: page, seq: page.length ? page[page.length - 1].seq : seq, more: rows.length > 500 });
    }
    if (path === "/sync/push" && req.method === "POST") {
      const b = await readBody(req);
      const applied: Array<{ id: string; seq: number }> = [];
      const rejected: Array<{ id: string; reason: string }> = [];
      for (const p of (b.patches ?? []) as Patch[]) {
        const r = applyPatch(p);
        if (r.ok) applied.push({ id: p.id, seq });
        else rejected.push({ id: p.id, reason: r.reason ?? "rejected" });
      }
      return json(res, 200, { applied, rejected, seq });
    }
    if (path === "/live") {
      touchDevice(url.searchParams.get("device_id"));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors() });
      res.write(": connected\n\n");
      liveClients.add(res);
      const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        liveClients.delete(res);
      });
      return;
    }
    const ent = /^\/entities\/([^/]+)$/.exec(path);
    if (ent && req.method === "GET") {
      const e = entities.get(decodeURIComponent(ent[1]));
      return e ? json(res, 200, e) : json(res, 404, { error: "not found" });
    }
    if (path === "/prefs/feel" && req.method === "GET") return json(res, 200, feelView());
    // Modules: the hub's own list (hub/src/modules.ts), switched in memory, so the module picker renders as on a hub.
    if (path === "/modules" && req.method === "GET") return json(res, 200, { modules: mockModules() });
    if (path === "/modules" && req.method === "PUT") {
      for (const [id, v] of Object.entries(await readBody(req))) if (typeof v === "boolean") mockModuleOn.set(id, v);
      return json(res, 200, { modules: mockModules() });
    }
    if (path === "/prefs/feel" && req.method === "PUT") {
      const err = setFeel(await readBody(req));
      return err ? json(res, 422, { error: err }) : json(res, 200, feelView());
    }
    if (path === "/prefs/feel/images" && req.method === "POST") {
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const out = addFeelImage(await readRaw(req), type, url.searchParams.get("name") ?? "");
      return out.error ? json(res, out.status, { error: out.error }) : json(res, 201, feelView());
    }
    const feelImg = /^\/prefs\/feel\/images\/([^/]+)$/.exec(path);
    if (feelImg && req.method === "GET") {
      const id = decodeURIComponent(feelImg[1]);
      const img = feelImages.get(id);
      if (!img || !feel.images.some((i) => i.id === id)) return json(res, 404, { error: "image not found" });
      res.writeHead(200, { "Content-Type": img.type, "Cache-Control": "private, max-age=86400", ...cors() });
      return res.end(img.bytes);
    }
    if (feelImg && req.method === "DELETE") {
      const id = decodeURIComponent(feelImg[1]);
      if (!feel.images.some((i) => i.id === id)) return json(res, 404, { error: "image not found" });
      feelImages.delete(id);
      feel = { ...feel, images: feel.images.filter((i) => i.id !== id) };
      return json(res, 200, feelView());
    }
    if (path === "/entities" && req.method === "GET") {
      const kind = url.searchParams.get("kind");
      const status = url.searchParams.get("status");
      const list = [...entities.values()].filter((e) => live(e) && (!kind || e.kind === kind) && (!status || e.fields.status === status));
      return json(res, 200, list.slice(0, Number(url.searchParams.get("limit") ?? 100)));
    }
    if (path === "/entities" && req.method === "POST") {
      const b = await readBody(req);
      const e = create(b.kind, b.fields, b.space);
      if (e.kind === "project") {
        matchParts(e);
        record(e);
      }
      if (e.kind === "watch") ensureWatchReminder(e);
      if (e.kind === "pet_event") ensurePetReminder(e);
      return json(res, 200, entities.get(e.id));
    }
    const pat = /^\/entities\/([^/]+)$/.exec(path);
    if (pat && req.method === "PATCH") {
      const e = entities.get(decodeURIComponent(pat[1]));
      if (!e) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      patchFields(e, b.fields ?? {});
      return json(res, 200, entities.get(e.id));
    }
    if (path === "/planner/week") {
      const startParam = url.searchParams.get("start");
      const start = startParam ? mondayOf(parseLocalDate(startParam)) : mondayOf(new Date());
      if (isNaN(start.getTime())) return json(res, 400, { error: "start must be YYYY-MM-DD" });
      const minHours = Math.max(0.5, Number(url.searchParams.get("min_hours") ?? 3) || 3);
      const days = [];
      for (let i = 0; i < 7; i++) days.push(plannerDay(addDays(start, i), minHours));
      return json(res, 200, { start: localDate(start), days });
    }
    if (path === "/planner/schedule" && req.method === "POST") {
      const b = await readBody(req);
      const t = entities.get(String(b.task_id ?? ""));
      if (!t || t.kind !== "task" || !live(t)) return json(res, 404, { error: "task not found" });
      const startD = new Date(String(b.start ?? ""));
      if (isNaN(startD.getTime())) return json(res, 400, { error: "start must be an ISO datetime" });
      const hours = Number(b.hours ?? 3);
      if (!(hours > 0 && hours <= 24)) return json(res, 422, { error: "hours must be between 0 and 24" });
      const span = { start: startD.toISOString(), end: new Date(startD.getTime() + hours * 3600_000).toISOString() };
      const conflict = scheduleConflict(t.id, span);
      if (conflict && !b.force) return json(res, 409, { error: `conflicts with ${conflict.title}`, detail: conflict });
      patchFields(t, { block: span, status: t.fields.status === "doing" ? "doing" : "scheduled" });
      return json(res, 200, entities.get(t.id));
    }
    if (path === "/planner/unschedule" && req.method === "POST") {
      const b = await readBody(req);
      const t = entities.get(String(b.task_id ?? ""));
      if (!t || t.kind !== "task" || !live(t)) return json(res, 404, { error: "task not found" });
      const maxOrder = Math.max(0, ...allLive().filter((e) => e.kind === "task" && e.fields.status === "next").map((e) => Number(e.fields.order) || 0));
      patchFields(t, { block: null, status: "next", order: t.fields.status === "next" ? t.fields.order : maxOrder + 1 });
      return json(res, 200, entities.get(t.id));
    }
    if (path === "/planner/today") {
      const t = plannerToday();
      if (url.searchParams.get("digest") === "1") emitNotify({ kind: "digest", title: t.digest.split("\n")[0], at: now() });
      if (url.searchParams.get("activity") === "1") activityCheck(true);
      return json(res, 200, t);
    }
    const ren = /^\/watches\/([^/]+)\/renewed$/.exec(path);
    if (ren && req.method === "POST") {
      const w = entities.get(decodeURIComponent(ren[1]));
      if (!w || w.kind !== "watch" || !live(w)) return json(res, 404, { error: "not found" });
      const f = w.fields as { due: string; repeat?: string; reminder_id?: string };
      const patch: Record<string, unknown> = { renewed_at: now() };
      if (f.repeat) {
        const next = nextOccurrence(f.due, f.repeat, new Date(f.due));
        if (next) patch.due = isDateOnly(f.due) ? next.slice(0, 10) : next;
      } else if (f.reminder_id && entities.get(f.reminder_id)) {
        patchFields(entities.get(f.reminder_id)!, { acknowledged_at: now() });
      }
      patchFields(w, patch);
      return json(res, 200, entities.get(w.id));
    }
    if (path === "/capture" && req.method === "POST") {
      const b = await readBody(req);
      if (!b.text) return json(res, 400, { error: "text required" });
      const cls = classifyCapture(b.text);
      const cap = create("capture", { text: b.text, source: b.source ?? "api", processed: false, suggested_kind: cls.kind });
      const created: Entity[] = [];
      if (b.auto) {
        let kind = cls.kind;
        let fields: Record<string, unknown> = cls.fields;
        if (kind === "none") {
          kind = b.text.length > 140 ? "note" : "task";
          fields = kind === "note" ? { title: b.text.split("\n")[0].slice(0, 80), body: b.text } : { title: b.text, status: "inbox" };
        }
        created.push(create(kind, finishFields(kind, fields, b.text)));
        patchFields(cap, { processed: true, converted_to: created.map((c) => c.id) });
      }
      return json(res, 200, { capture: entities.get(cap.id), suggested_kind: cls.kind, created });
    }
    const conv = /^\/capture\/([^/]+)\/convert$/.exec(path);
    if (conv && req.method === "POST") {
      const cap = entities.get(decodeURIComponent(conv[1]));
      if (!cap) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      const text = String(cap.fields.text);
      const cls = classifyCapture(text);
      const base = cls.kind === b.kind ? cls.fields : {};
      const e = create(b.kind, finishFields(b.kind, { ...base, ...(b.fields ?? {}) }, text));
      patchFields(cap, { processed: true, converted_to: [...((cap.fields.converted_to as string[]) ?? []), e.id] });
      return json(res, 200, e);
    }
    if (path === "/reminders/due") {
      const within = Number(url.searchParams.get("within") ?? 60);
      const limit = Date.now() + within * 60_000;
      const reminders = [...entities.values()]
        .filter((e) => {
          if (!live(e) || e.kind !== "reminder") return false;
          const f = e.fields as { at: string; snoozed_until?: string; acknowledged_at?: string };
          if (f.acknowledged_at && f.acknowledged_at >= f.at) return false;
          return new Date(effectiveAt(f)).getTime() <= limit;
        })
        .sort((a, b) => (effectiveAt(a.fields as { at: string }) < effectiveAt(b.fields as { at: string }) ? -1 : 1));
      return json(res, 200, { reminders });
    }
    if (path === "/status") return json(res, 200, status());
    // The made-up owner: their name is on their own games (owned_by) and preselected as a player.
    if (path === "/profile" && req.method === "GET") return json(res, 200, { name: "Alex", pet: "Pepper", named: true });
    if (path === "/metrics/proof") return json(res, 200, proof(Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 14)))));
    const rem = /^\/reminders\/([^/]+)\/(snooze|ack)$/.exec(path);
    if (rem && req.method === "POST") {
      const r = entities.get(decodeURIComponent(rem[1]));
      if (!r || r.kind !== "reminder") return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      const f = r.fields as { at: string; friction: string; repeat?: string; snooze_log?: unknown[] };
      if (rem[2] === "snooze") {
        if (f.friction !== "none" && !String(b.reason ?? "").trim()) return json(res, 422, { error: "reason required to snooze this reminder" });
        if (!b.until) return json(res, 400, { error: "until required" });
        patchFields(r, { snoozed_until: b.until, snooze_log: [...(f.snooze_log ?? []), { at: now(), until: b.until, reason: b.reason ?? "" }] });
      } else {
        const next = f.repeat ? nextOccurrence(f.at, f.repeat, new Date()) : null;
        if (next) patchFields(r, { at: next, snoozed_until: null, acknowledged_at: null });
        else patchFields(r, { acknowledged_at: now() });
      }
      return json(res, 200, entities.get(r.id));
    }
    if (path === "/notes/graph") {
      const nodes = allNotes().map((n) => ({ id: n.id, title: String(n.fields.title), path: String(n.fields.path), tags: (n.fields.tags as string[]) ?? [], folder: noteFolder(String(n.fields.path)) }));
      const edges: Array<{ from: string; to: string }> = [];
      for (const n of allNotes()) for (const t of (n.fields.links as string[]) ?? []) {
        const to = noteByTitle(t);
        if (to && to.id !== n.id) edges.push({ from: n.id, to: to.id });
      }
      return json(res, 200, { nodes, edges });
    }
    const nm = /^\/notes\/([^/]+)\/(related|suggest|accept)$/.exec(path);
    if (nm) {
      const n = entities.get(decodeURIComponent(nm[1]));
      if (!n || n.kind !== "note" || !live(n)) return json(res, 404, { error: "not found" });
      if (nm[2] === "related") return json(res, 200, related(n));
      if (nm[2] === "suggest") {
        const ai = url.searchParams.get("ai") === "true";
        deriveLinks(n);
        const suggested_tags = suggestTags(n, ai);
        patchFields(n, { suggested_tags, links: n.fields.links });
        return json(res, 200, { id: n.id, suggested_tags, links: n.fields.links, ai_used: ai });
      }
      const b = await readBody(req);
      const sug = (n.fields.suggested_tags as string[]) ?? [];
      const accept: string[] = Array.isArray(b.tags) && b.tags.length ? b.tags : sug;
      const tags = [...new Set([...((n.fields.tags as string[]) ?? []), ...accept])];
      patchFields(n, { tags, suggested_tags: sug.filter((t) => !accept.includes(t)) });
      return json(res, 200, entities.get(n.id));
    }
    if (path === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const kinds = url.searchParams.get("kinds")?.split(",");
      const hits = [...entities.values()]
        .filter((e) => live(e) && (!kinds || kinds.includes(e.kind)) && e.kind !== "device")
        .map((e) => {
          const hay = JSON.stringify(e.fields).toLowerCase();
          const i = hay.indexOf(q);
          return i < 0 ? null : { id: e.id, kind: e.kind, title: titleOf(e).slice(0, 80), snippet: hay.slice(Math.max(0, i - 30), i + 60), score: titleOf(e).toLowerCase().includes(q) ? 2 : 1 };
        })
        .filter(Boolean)
        .slice(0, Number(url.searchParams.get("limit") ?? 50));
      return json(res, 200, { hits });
    }
    if (path === "/log" && req.method === "POST") {
      const b = await readBody(req);
      const fields: Record<string, unknown> = { type: b.type, value: b.value, at: b.at ?? now(), source: "api" };
      if (b.unit) fields.unit = b.unit;
      if (b.note) fields.note = b.note;
      return json(res, 200, create("log", fields));
    }
    if (path === "/dashboard") {
      const tasks = [...entities.values()].filter((e) => live(e) && e.kind === "task");
      const doing = tasks.find((t) => t.fields.status === "doing") ?? null;
      const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86400_000);
      const reminders_today = [...entities.values()].filter((e) => live(e) && e.kind === "reminder" && new Date(effectiveAt(e.fields as { at: string })) >= start && new Date(effectiveAt(e.fields as { at: string })) < end);
      const logs_7d: Record<string, Array<{ at: string; value: unknown }>> = {};
      const cutoff = Date.now() - 7 * 86400_000;
      for (const e of entities.values()) {
        if (!live(e) || e.kind !== "log" || new Date(e.fields.at as string).getTime() < cutoff) continue;
        (logs_7d[e.fields.type as string] ??= []).push({ at: e.fields.at as string, value: e.fields.value });
      }
      const captures_unprocessed = [...entities.values()].filter((e) => live(e) && e.kind === "capture" && !e.fields.processed).length;
      const projects_active = [...entities.values()].filter((e) => live(e) && e.kind === "project" && e.fields.status === "active");
      return json(res, 200, { now: doing ?? next[0] ?? null, next: doing ? next : next.slice(1), reminders_today, logs_7d, captures_unprocessed, projects_active });
    }
    if (path === "/ai/memory") {
      const facts = [...entities.values()].filter((e) => live(e) && e.kind === "fact");
      const rules = [...entities.values()].filter((e) => live(e) && e.kind === "rule" && e.fields.active !== false);
      return json(res, 200, { facts, rules });
    }
    if (path === "/ai/chat" || path === "/ai/chat/stream") {
      const b = await readBody(req);
      const last = b.messages?.[b.messages.length - 1]?.content ?? "";
      let reply = `Mock reply to: ${last}\n\n- backend is a stub\n- nothing was sent anywhere\n\n\`\`\`\necho ok\n\`\`\``;
      let ledger_id: string | undefined;
      let procedure_id: string | undefined;
      if (b.task_type === "troubleshoot") {
        // The hub inserts a Pre-flight block before a destructive command and records a planned journal entry.
        const text = (b.messages ?? []).map((m: { content: string }) => m.content).join("\n");
        const host = detectHost(text, deriveHosts(allLive()).map((h) => h.host)) ?? "nas01";
        reply = `Mock reply to: ${last}\n\nThe stale dataset can go once a snapshot exists.\n\nPre-flight: this destroys data on ${host}.\n- Back up: \`zfs snapshot tank/scratch@pre-destroy\`\n- Verify the target: \`zfs list -r tank/scratch\` shows only what you expect\n- Rollback: \`zfs rollback tank/scratch@pre-destroy\`\n\nSteps:\n\n1. Snapshot the dataset as root on ${host}\n\`\`\`\nzfs snapshot tank/scratch@pre-destroy\n\`\`\`\n2. Verify the snapshot exists\n\`\`\`\nzfs list -t snapshot -r tank/scratch\n\`\`\`\n3. Destroy the dataset\n\`\`\`\nzfs destroy -r tank/scratch\n\`\`\`\n4. Confirm it is gone with \`zfs list -r tank\``;
        const stepsText = reply.slice(reply.indexOf("Steps:") + 6);
        procedure_id = procedureFromText({ text: stepsText, title: `Destroy tank/scratch on ${host}`, host, source_session: b.session_id }).id;
        const planned = allLive().find((e) => e.kind === "journal" && e.fields.session_id === b.session_id && e.fields.outcome === "planned");
        if (!planned) create("journal", { host, at: now(), what: "Destroy tank/scratch (from the assistant)", command: "zfs destroy -r tank/scratch", risk: "high", rollback: "zfs rollback tank/scratch@pre-destroy", outcome: "planned", session_id: b.session_id });
        let l = [...entities.values()].find((e) => e.kind === "ledger" && e.fields.session_id === b.session_id);
        if (!l) l = create("ledger", { session_id: b.session_id, topic: last.slice(0, 60), tried: [], ruled_out: [], confirmed: [], open: true });
        patchFields(l, { tried: [...(l.fields.tried as unknown[]), { at: now(), what: last.slice(0, 80), result: "mock" }], ruled_out: [...(l.fields.ruled_out as string[]), "restarting it"] });
        ledger_id = l.id;
      }
      const out = { reply, model: "mock", backend: "ollama", redactions: /password|token/i.test(last) ? 1 : 0, rules_applied: [], ledger_id, procedure_id };
      aiCalls.push({ at: now(), backend: "ollama", ms: 40 * reply.split(/\s/).length });
      if (path === "/ai/chat") return json(res, 200, out);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors() });
      const words = reply.split(/(?<=\s)/);
      let i = 0;
      const t = setInterval(() => {
        if (i < words.length) res.write(`event: token\ndata: ${JSON.stringify({ token: words[i++] })}\n\n`);
        else {
          clearInterval(t);
          res.write(`event: done\ndata: ${JSON.stringify(out)}\n\n`);
          res.end();
        }
      }, 40);
      return;
    }
    // ---------- Module 4 ----------
    if (path === "/health/summary") return json(res, 200, healthSummary(Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30))));
    if (path === "/health/injection-day" && req.method === "POST") {
      const b = await readBody(req);
      const r = setInjectionDay(String(b.name ?? "B12"), String(b.weekday ?? ""), String(b.time ?? ""));
      return r ? json(res, 200, r) : json(res, 422, { error: "weekday must be mon..sun and time HH:MM" });
    }
    const ps = /^\/pets\/([^/]+)\/summary$/.exec(path);
    if (ps) return json(res, 200, petSummary(decodeURIComponent(ps[1])));
    if (path === "/sensors" && req.method === "GET") {
      if (url.searchParams.get("alert") === "1") {
        const s = sensorByName("planter_moisture") ?? allLive().find((e) => e.kind === "sensor");
        if (s) sensorAlert(s, Number(s.fields.last_value ?? 0), sensorState(s) === "ok" ? "low" : sensorState(s));
      }
      return json(res, 200, sensorRows());
    }
    const sx = /^\/sensors\/([^/]+)\/(readings|csv)$/.exec(path);
    if (sx && sx[2] === "readings" && req.method === "POST") {
      const b = await readBody(req);
      const value = Number(b.value);
      if (!Number.isFinite(value)) return json(res, 422, { error: "value must be a number" });
      return json(res, 200, postReading(decodeURIComponent(sx[1]), value, b.at ?? now(), b.unit));
    }
    if (sx && sx[2] === "csv") {
      const name = decodeURIComponent(sx[1]);
      if (!sensorByName(name)) return json(res, 404, { error: "not found" });
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
      const cutoff = Date.now() - days * 86400_000;
      const rows = (readings.get(name) ?? []).filter((r) => new Date(r.at).getTime() >= cutoff).map((r) => `${r.at},${r.value},${r.unit ?? ""}`);
      res.writeHead(200, { "Content-Type": "text/csv", ...cors() });
      return res.end(["at,value,unit", ...rows].join("\n") + "\n");
    }
    if (path === "/food/pick" && req.method === "POST") return json(res, 200, foodPick(await readBody(req)));
    if (path === "/food/picked" && req.method === "POST") {
      const b = await readBody(req);
      const o = entities.get(String(b.id ?? ""));
      if (!o || o.kind !== "food_option" || !live(o)) return json(res, 404, { error: "not found" });
      patchFields(o, { last_picked: now(), times_picked: (Number(o.fields.times_picked) || 0) + 1 });
      return json(res, 200, entities.get(o.id));
    }
    // ---------- Module 7 ----------
    const cl = /^\/checklists\/([^/]+)\/(instantiate|toggle)$/.exec(path);
    if (cl && req.method === "POST") {
      const c = entities.get(decodeURIComponent(cl[1]));
      if (!c || c.kind !== "checklist" || !live(c)) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      if (cl[2] === "instantiate") {
        if (!c.fields.template) return json(res, 422, { error: "not a template" });
        return json(res, 200, create("checklist", instantiateFields(c, b.title)));
      }
      const items = (c.fields as ChecklistF).items ?? [];
      const index = Number(b.index);
      if (!Number.isInteger(index) || index < 0 || index >= items.length) return json(res, 400, { error: "index out of range" });
      if (c.fields.template) return json(res, 422, { error: "templates are copied, never ticked" });
      patchFields(c, { items: toggleItem(items, index, now()) });
      return json(res, 200, entities.get(c.id));
    }
    if (path === "/applications/board" && req.method === "GET") {
      const apps = allLive().filter((e) => e.kind === "application");
      const board = groupBoard(apps);
      return json(res, 200, { stages: board.columns.map((c) => ({ stage: c.stage, count: c.count, applications: c.items })), total: apps.length, active: board.active, follow_ups: board.followUps });
    }
    const cv = /^\/applications\/([^/]+)\/cover-letter$/.exec(path);
    if (cv && req.method === "POST") {
      const a = entities.get(decodeURIComponent(cv[1]));
      if (!a || a.kind !== "application" || !live(a)) return json(res, 404, { error: "not found" });
      const out = coverLetter(a, await readBody(req));
      await new Promise((r) => setTimeout(r, 400));
      return json(res, out.status, out.body);
    }
    if (path === "/games/pick" && req.method === "POST") return json(res, 200, gamePick(await readBody(req)));
    const gp = /^\/games\/([^/]+)\/played$/.exec(path);
    if (gp && req.method === "POST") {
      const g = entities.get(decodeURIComponent(gp[1]));
      if (!g || g.kind !== "game" || !live(g)) return json(res, 404, { error: "not found" });
      patchFields(g, { last_played: now() });
      return json(res, 200, entities.get(g.id));
    }
    const calc = /^\/calc\/(split|payoff|change|unit)$/.exec(path);
    if (calc && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (calc[1] === "split") return json(res, 200, calcSplit(b));
        if (calc[1] === "payoff") {
          const r = calcPayoff(b);
          const mode = b.payment != null ? "payment" : "months";
          return json(res, 200, { mode, balance: b.balance, apr_pct: b.apr_pct, payment: r.payment, months: mode === "months" ? b.months : r.months, ...(mode === "months" ? { payoff_months: r.months } : {}), total_interest: r.total_interest, schedule: r.preview });
        }
        if (!Array.isArray(b.items) || !b.items.length) return json(res, 422, { error: "items must be a non-empty array" });
        const rows = unitPrices(b.items);
        return json(res, 200, { unit: rows[0]?.base, items: rows.map(({ base: _b, ...r }) => (void _b, r)), cheapest: rows[0]?.name });
      } catch (e) {
        return json(res, 422, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/finance/subscriptions" && req.method === "GET") {
      return json(res, 200, calcSubs(allLive().filter((e) => e.kind === "watch")));
    }
    // ---------- Module 5 ----------
    const pj = /^\/projects\/([^/]+)\/(summary|plan)$/.exec(path);
    if (pj) {
      const project = entities.get(decodeURIComponent(pj[1]));
      if (!project || project.kind !== "project" || !live(project)) return json(res, 404, { error: "not found" });
      if (pj[2] === "summary") return json(res, 200, projectSummary(project));
      if (req.method !== "POST") return json(res, 405, { error: "POST" });
      const b = await readBody(req);
      return json(res, 200, upsertPlan(project, b.sections ?? {}));
    }
    if (path === "/procedures/from-text" && req.method === "POST") {
      const b = await readBody(req);
      if (!String(b.text ?? "").trim()) return json(res, 400, { error: "text required" });
      try {
        return json(res, 200, procedureFromText(b));
      } catch (e) {
        return json(res, 422, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const pa = /^\/procedures\/([^/]+)\/(advance|reset)$/.exec(path);
    if (pa && req.method === "POST") {
      const pr = entities.get(decodeURIComponent(pa[1]));
      if (!pr || pr.kind !== "procedure" || !live(pr)) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      const action = pa[2] === "reset" ? "reset" : b.back ? "back" : "done";
      const patch = advanceProcedure(pr.fields as unknown as ProcedureF, action);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) fields[k] = v === undefined ? null : v;
      if (Object.keys(fields).length) patchFields(pr, fields);
      return json(res, 200, entities.get(pr.id));
    }
    if (path === "/music" && req.method === "GET") {
      const type = url.searchParams.get("type");
      const st = url.searchParams.get("status");
      return json(res, 200, allLive().filter((e) => e.kind === "music_idea" && (!type || e.fields.type === type) && (!st || e.fields.status === st)).sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1)));
    }
    if (path === "/music/quick" && req.method === "POST") {
      const b = await readBody(req);
      if (!String(b.text ?? "").trim()) return json(res, 400, { error: "text required" });
      const q = parseMusicQuick(String(b.text));
      const fields: Record<string, unknown> = { title: q.title, type: q.type, body: q.body, status: "idea", tags: [] };
      for (const k of ["key", "bpm", "time_sig", "tuning"] as const) if (q[k] != null) fields[k] = q[k];
      return json(res, 200, create("music_idea", fields));
    }
    if (path === "/quiz/today") {
      const q = quizToday() ?? null;
      if (q && url.searchParams.get("notify") === "1") emitNotify({ kind: "quiz", title: `Recall quiz: ${(q.fields.items as unknown[]).length} questions`, date: q.fields.date, at: now() });
      return json(res, 200, q);
    }
    const qa = /^\/quiz\/([^/]+)\/answer$/.exec(path);
    if (qa && req.method === "POST") {
      const q = entities.get(decodeURIComponent(qa[1]));
      if (!q || q.kind !== "quiz" || !live(q)) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      const f = q.fields as unknown as QuizF;
      const i = Number(b.index);
      if (!(i >= 0 && i < f.items.length)) return json(res, 422, { error: "index out of range" });
      if (!["right", "wrong", "revealed"].includes(b.result)) return json(res, 422, { error: "result must be right, wrong or revealed" });
      const items = f.items.map((it, j) => (j === i ? { ...it, result: b.result, asked_at: now() } : it));
      const patch: Record<string, unknown> = { items };
      if (items.every((it) => it.result)) patch.completed_at = now();
      patchFields(q, patch);
      return json(res, 200, entities.get(q.id));
    }
    // ---------- Module 6 ----------
    if (path === "/ops" && req.method === "GET") {
      if (url.searchParams.get("down") === "1") takeDown(url.searchParams.get("name") ?? undefined);
      if (url.searchParams.get("up") === "1") bringUp();
      return json(res, 200, opsBoard());
    }
    const mx = /^\/monitors\/([^/]+)\/(check|history)$/.exec(path);
    if (mx) {
      const m = entities.get(decodeURIComponent(mx[1]));
      if (!m || m.kind !== "monitor" || !live(m)) return json(res, 404, { error: "not found" });
      if (mx[2] === "check" && req.method === "POST") return json(res, 200, runCheck(m));
      if (mx[2] === "history" && req.method === "GET") {
        const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));
        const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
        return json(res, 200, (checkLog.get(m.id) ?? []).filter((r) => r.at >= cutoff));
      }
    }
    const ia = /^\/incidents\/([^/]+)\/ack$/.exec(path);
    if (ia && req.method === "POST") {
      const inc = entities.get(decodeURIComponent(ia[1]));
      if (!inc || inc.kind !== "incident" || !live(inc)) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      if (b.note != null && typeof b.note !== "string") return json(res, 422, { error: "note must be a string" });
      const note = typeof b.note === "string" ? b.note.trim() : "";
      const f = inc.fields as IncidentF;
      const patch: Record<string, unknown> = { acknowledged_at: now() };
      if (note) {
        const mon = entities.get(f.monitor_id);
        const host = String(mon?.fields.host ?? "unknown");
        const j = create("journal", { host, at: now(), what: `Incident acknowledged: ${f.name}: ${note}`, risk: "low", outcome: "done" });
        patch.ack_note = note;
        patch.journal_id = j.id;
      }
      patchFields(inc, patch);
      return json(res, 200, entities.get(inc.id));
    }
    // ---------- Module 2 ----------
    if (path === "/hosts") return json(res, 200, deriveHosts(allLive()));
    if (path === "/runbooks") {
      const host = url.searchParams.get("host");
      const list = allLive()
        .filter((e) => e.kind === "runbook" && (!host || e.fields.host === host))
        .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
      return json(res, 200, list);
    }
    if (path === "/ledgers") {
      const open = url.searchParams.get("open") === "true";
      const list = allLive()
        .filter((e) => e.kind === "ledger" && (!open || e.fields.open !== false))
        .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
      return json(res, 200, list);
    }
    const sr = /^\/snippets\/([^/]+)\/render$/.exec(path);
    if (sr && req.method === "POST") {
      const sn = entities.get(decodeURIComponent(sr[1]));
      if (!sn || sn.kind !== "snippet" || !live(sn)) return json(res, 404, { error: "not found" });
      const b = await readBody(req);
      try {
        const text = renderSnippet(sn.fields as unknown as SnippetF, (b.params ?? {}) as Record<string, string>);
        patchFields(sn, { last_used: now() });
        return json(res, 200, { text });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json(res, 422, { error: msg, detail: msg.replace(/^missing /, "").split(", ") });
      }
    }
    const sc = /^\/ai\/sessions\/([^/]+)\/close$/.exec(path);
    if (sc && req.method === "POST") {
      const sid = decodeURIComponent(sc[1]);
      const b = await readBody(req);
      if (!["fixed", "abandoned", "parked"].includes(b.outcome)) return json(res, 422, { error: "outcome must be fixed, abandoned or parked" });
      const ledger = allLive().find((e) => e.kind === "ledger" && e.fields.session_id === sid);
      const topic = closedTopics.get(sid) ?? String(ledger?.fields.topic ?? b.note ?? "session");
      closedTopics.set(sid, topic);
      const host = String(b.host || detectHost(topic, deriveHosts(allLive()).map((h) => h.host)) || "pve1");
      const date = now().slice(0, 10);
      const heading = `## ${date}: ${topic}`;
      const section = `${heading}\n\n**Outcome** ${b.outcome}${b.note ? `, ${b.note}` : ""}\n\n**Symptoms** ${topic}.\n\n**Tried** ${((ledger?.fields.tried as Array<{ what: string }>) ?? []).map((t) => t.what).join("; ") || "see the session"}.\n\n**Ruled out** ${((ledger?.fields.ruled_out as string[]) ?? []).join("; ") || "nothing"}.\n\n**Fix** ${b.outcome === "fixed" ? "snapshot, then destroy the stale dataset" : "not fixed yet"}.\n\n**Verification** \`zfs list -r tank\` shows the expected datasets.`;
      let rb = allLive().find((e) => e.kind === "runbook" && e.fields.host === host);
      if (!rb) rb = create("runbook", { host, title: `Runbook: ${host}`, body: `# ${host}\n\n${section}`, commands: [] });
      else {
        const body = String(rb.fields.body ?? "");
        const i = body.indexOf(heading);
        let next: string;
        if (i >= 0) {
          const rest = body.slice(i + heading.length);
          const j = rest.search(/\n## /);
          next = body.slice(0, i) + section + (j >= 0 ? rest.slice(j) : "");
        } else next = `${body.trimEnd()}\n\n${section}`;
        patchFields(rb, { body: next });
      }
      const prior = allLive().filter((e) => e.kind === "journal" && e.fields.session_id === sid && e.fields.runbook_id === rb!.id);
      const journal_ids = prior.map((e) => e.id);
      if (!prior.length) {
        journal_ids.push(create("journal", { host, at: now(), what: `Snapshot before the change (${topic})`, command: "zfs snapshot tank/scratch@pre-destroy", risk: "low", rollback: "zfs destroy tank/scratch@pre-destroy", outcome: "done", session_id: sid, runbook_id: rb.id }).id);
        journal_ids.push(create("journal", { host, at: now(), what: `Destroyed the stale dataset (${topic})`, command: "zfs destroy -r tank/scratch", risk: "high", rollback: "zfs rollback tank/scratch@pre-destroy", outcome: b.outcome === "fixed" ? "done" : "planned", session_id: sid, runbook_id: rb.id }).id);
      }
      for (const e of allLive()) if (e.kind === "journal" && e.fields.session_id === sid && e.fields.outcome === "planned" && !e.fields.runbook_id) patchFields(e, { runbook_id: rb.id });
      if (ledger && ledger.fields.open !== false) patchFields(ledger, { open: false });
      let resume_card_written = false;
      const project = b.project_id ? entities.get(String(b.project_id)) : undefined;
      if (project && project.kind === "project") {
        patchFields(project, { resume_card: `Last session (${date}): ${topic}, ${b.outcome}. Next: check the ${host} runbook section dated ${date}.` });
        resume_card_written = true;
        lastSessionClose.set(project.id, now());
        upsertPlan(project, { current: `${topic}: ${b.outcome}`, next: `Check the ${host} runbook section dated ${date}.`, log_line: `Session closed, ${b.outcome}: ${topic}` });
      }
      const summary = `${b.outcome}: ${topic} on ${host}. Runbook section ${heading.slice(3)} written, ${journal_ids.length} journal entries, ledger closed.${resume_card_written ? " Resume card written." : ""}`;
      return json(res, 200, { runbook_id: rb.id, journal_id: journal_ids[0], journal_ids, snippet_ids: [], resume_card_written, summary });
    }
    json(res, 404, { error: "not found", detail: path });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- status and proof run ----------
function status() {
  const all = [...entities.values()].filter(live);
  const entities_by_kind: Record<string, number> = {};
  for (const e of all) entities_by_kind[e.kind] = (entities_by_kind[e.kind] ?? 0) + 1;
  const bytes = Buffer.byteLength(JSON.stringify([...entities.values()])) + Buffer.byteLength(JSON.stringify(changes));
  const devices = all
    .filter((e) => e.kind === "device")
    .map((d) => ({ id: d.id, name: String(d.fields.name), platform: String(d.fields.platform), last_seen: String(d.fields.last_seen ?? d.updated_at) }));
  const dayAgo = Date.now() - 86400_000;
  const reminders = all.filter((e) => e.kind === "reminder");
  const pending = reminders
    .filter((r) => {
      const f = r.fields as { at: string; acknowledged_at?: string };
      return !(f.acknowledged_at && f.acknowledged_at >= f.at);
    })
    .map((r) => effectiveAt(r.fields as { at: string }))
    .sort();
  const fired_24h = reminders.reduce((n, r) => n + ((r.fields.fired as string[]) ?? []).filter((t) => new Date(t).getTime() > dayAgo).length, 0);
  const calls = aiCalls.filter((c) => new Date(c.at).getTime() > dayAgo);
  const backupAgeH = Number(process.env.EA_MOCK_BACKUP_AGE_H ?? 7);
  return {
    version: "mock-0.1.0",
    started_at: STARTED_AT,
    uptime_s: Math.round((Date.now() - new Date(STARTED_AT).getTime()) / 1000),
    db: { bytes, seq, entities_by_kind },
    devices,
    backups: { latest_file: "everythingapp-2026-10-21T03-00.sqlite", latest_at: hoursAgo(backupAgeH), count: 12 },
    ai: {
      backends_configured: ["ollama", "anthropic"],
      calls_24h: calls.length,
      last_call_at: aiCalls.length ? aiCalls[aiCalls.length - 1].at : null,
      last_backend: aiCalls.length ? aiCalls[aiCalls.length - 1].backend : null,
      avg_latency_ms_24h: calls.length ? Math.round(calls.reduce((n, c) => n + c.ms, 0) / calls.length) : null,
    },
    reminders: { due_next: pending[0] ?? null, fired_24h },
    captures_unprocessed: all.filter((e) => e.kind === "capture" && !e.fields.processed).length,
    creative: {
      projects_active: all.filter((e) => e.kind === "project" && e.fields.status === "active").length,
      procedures_open: all.filter((e) => e.kind === "procedure" && !e.fields.done_at).length,
      music_ideas: all.filter((e) => e.kind === "music_idea" && e.fields.type !== "reference").length,
      quiz_streak_days: quizStreak(),
    },
    ops: opsStatus(),
    admin: {
      checklists_open: all.filter((e) => e.kind === "checklist" && !e.fields.template && !e.fields.archived && ((e.fields as ChecklistF).items ?? []).some((i) => !i.done_at)).length,
      applications_active: all.filter((e) => e.kind === "application" && ACTIVE_STAGES.includes((e.fields as ApplicationF).stage)).length,
      games: all.filter((e) => e.kind === "game").length,
    },
  };
}

/** Deterministic per-day counts so screenshots are stable between runs. */
function proof(days: number) {
  const keys = ["captures", "captures_auto_sorted", "tasks_done", "reminders_fired", "reminders_acked", "reminders_snoozed", "logs", "notes_edited", "ai_calls"] as const;
  const rows = [];
  const totals: Record<string, number> = Object.fromEntries([...keys, "now_nonempty"].map((k) => [k, 0]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const seedN = d.getDate() * 7 + d.getMonth() * 3;
    const r = (k: number, max: number) => ((seedN * (k + 3) * 31) % (max + 1));
    const captures = r(1, 9);
    const row: Record<string, number | string | boolean> = {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      captures,
      captures_auto_sorted: Math.min(captures, r(2, 7)),
      tasks_done: r(3, 5),
      reminders_fired: r(4, 4),
      reminders_acked: Math.min(r(4, 4), r(5, 4)),
      reminders_snoozed: r(6, 2),
      logs: 3 + r(7, 6),
      notes_edited: r(8, 3),
      ai_calls: r(9, 6),
      now_nonempty: r(10, 6) !== 0,
    };
    if (i === 0) {
      row.logs = [...entities.values()].filter((e) => live(e) && e.kind === "log" && new Date(e.fields.at as string) >= d).length;
      row.ai_calls = aiCalls.filter((c) => new Date(c.at) >= d).length;
      row.now_nonempty = [...entities.values()].some((e) => live(e) && e.kind === "task" && (e.fields.status === "doing" || e.fields.status === "next"));
    }
    for (const k of keys) totals[k] += row[k] as number;
    if (row.now_nonempty) totals.now_nonempty += 1;
    rows.push(row);
  }
  const friction: Array<{ kind: string; id: string; title: string; detail: string }> = [];
  for (const e of entities.values()) {
    if (!live(e)) continue;
    if (e.kind === "reminder") {
      const f = e.fields as { title: string; at: string; snoozed_until?: string; acknowledged_at?: string; snooze_log?: unknown[] };
      const acked = !!f.acknowledged_at && f.acknowledged_at >= f.at;
      const overdueH = (Date.now() - new Date(effectiveAt(f)).getTime()) / 3600_000;
      if (!acked && overdueH > 0.1) friction.push({ kind: "reminder", id: e.id, title: f.title, detail: `overdue ${overdueH < 1 ? `${Math.round(overdueH * 60)}m` : `${Math.round(overdueH)}h`}${f.snooze_log?.length ? `, snoozed ${f.snooze_log.length} times` : ""}` });
    } else if (e.kind === "task" && e.fields.status === "inbox") {
      friction.push({ kind: "task", id: e.id, title: String(e.fields.title), detail: "still in inbox" });
    } else if (e.kind === "capture" && !e.fields.processed) {
      friction.push({ kind: "capture", id: e.id, title: String(e.fields.text).slice(0, 60), detail: `unsorted since ${e.created_at.slice(0, 10)}` });
    }
  }
  return { days: rows, totals, friction };
}

function finishFields(kind: string, fields: Record<string, unknown>, text: string): Record<string, unknown> {
  const first = text.split("\n")[0].slice(0, 120);
  const f = { ...fields };
  if (kind === "task") {
    f.title ??= first;
    f.status ??= "inbox";
    f.order ??= Date.now();
  } else if (kind === "note") {
    f.title ??= first.slice(0, 80);
    f.body ??= text;
    f.tags ??= [];
    f.path ??= `Inbox/${String(f.title).replace(/[\\/:*?"<>|]/g, "-")}.md`;
  } else if (kind === "reminder") {
    f.title ??= first;
    f.at ??= hoursAhead(1);
    f.friction ??= "none";
  } else if (kind === "log") {
    f.type ??= "custom";
    f.value ??= text;
    f.at ??= now();
  } else if (kind === "fact") {
    f.category ??= "preference";
    f.key ??= text.toLowerCase().slice(0, 40).replace(/\W+/g, "_");
    f.value ??= text;
  }
  return f;
}

server.listen(PORT, () => console.log(`mock hub on http://localhost:${PORT} token=${TOKEN} seq=${seq}`));
