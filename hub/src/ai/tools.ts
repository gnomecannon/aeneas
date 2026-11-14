/**
 * Assistant tools: the modules the local model can read and change.
 *
 * Every tool is a call into the hub's own HTTP API, run in-process through the Hono app, so the
 * assistant gets exactly the validation, hooks and sync behaviour the apps get and no module
 * logic is duplicated here. Tools are offered only to the local backend (Ollama): work-space data
 * never leaves the tailnet. Results are compacted (no field_ts, no timestamps the model does not
 * need) and capped so one call cannot flood the context window.
 */

import { addressKey, factsAbout, findPeople, mergeList, resolvePerson } from "../people.js";
import { relatedItems } from "../related.js";
import { diaryDay, readDiary } from "../diary.js";
import type { Entity } from "@everythingapp/shared";
import { completeTaskPatch, FieldsByKind, nowIso } from "@everythingapp/shared";
import type { z } from "zod";
import type { Config } from "../config.js";
import type { Store } from "../store.js";
import { cloudScrubber } from "./backends.js";
import { listOf, matchList, sameOpenTask, taskLists, wordsOf } from "./lists.js";
import { ensureRunbook, factKey, upsertSection } from "../memory.js";
import { detectDestructive } from "../preflight.js";
import { openLedger } from "./ledger.js";
import { AFFIRMATION, isReadOnly, type HostActions } from "./hosts.js";
import { trimMiddle } from "./history.js";
import { NO_TOR, fetchPage, webPrivate, webSearch } from "./web.js";
import { cleanTag } from "../note-linker.js";
import { moduleDef, moduleOfKind, type ModuleCheck, type ModuleId } from "../modules.js";
import { dayKey } from "../metrics.js";

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

/** A host command waiting for the owner's yes. Sent to clients as an `approval` event. */
export interface PendingApproval { id: string; host: string; command: string; purpose: string; risk: "medium" | "high"; preflight?: { backup: string; verify: string; rollback: string } }

/** A proposed change as the approval card shows it: its risk and, for a destructive command, the pre-flight lines. */
export function approvalOf(a: { id: string; host: string; command: string; purpose: string }): PendingApproval {
  const d = detectDestructive(a.command);
  return { id: a.id, host: a.host, command: a.command, purpose: a.purpose, risk: d ? "high" : "medium", ...(d ? { preflight: { backup: d.rule.backup, verify: d.rule.verify, rollback: d.rule.rollback } } : {}) };
}

/**
 * One turn of a chat, shared by every model tried for it: when the owner's message arrived, the changes proposed in
 * this turn, and the commands approved and run in it (by the Run button or approve_command).
 */
export interface TurnState { startedAt: string; proposed: Set<string>; ran: string[] }

const fallbackTurns = new WeakMap<object, TurnState>();
/** The turn a tool call belongs to; a caller that gives none (a test) gets one that starts at its first call. */
export function turnOf(ctx: ToolContext): TurnState {
  if (ctx.turn) return ctx.turn;
  let t = fallbackTurns.get(ctx);
  if (!t) { t = { startedAt: nowIso(), proposed: new Set(), ran: [] }; fallbackTurns.set(ctx, t); }
  return t;
}

/** What a tool can reach besides the hub's HTTP API. */
export interface ToolContext {
  sessionId: string;
  /** The newest user message of this turn (the approval check reads it). */
  lastUser: string;
  /** This turn: approve_command runs only a change proposed before it began, and nothing is proposed after a change ran. */
  turn?: TurnState;
  /** First line of the conversation, for ledger topics. */
  topic: string;
  store: Store;
  cfg: Config;
  /** The owner's name (profile), for "my" in what they asked. */
  owner?: string;
  hosts: HostActions | null;
  /** Draft text in the owner's own voice (the ai-me adapter when configured, else the local model). */
  draft?: (request: string) => Promise<{ text: string; backend: string; model: string } | null>;
  /** Tell the client a command is waiting for approval. */
  onApproval?: (a: PendingApproval) => void;
  /** Show an image (a hub image id) under this reply. */
  addImage?: (id: string) => void;
  /** Hub image ids the owner attached to this turn. */
  userImages?: string[];
  /** Which modules are on (Settings, Modules); absent: all. */
  moduleOn?: ModuleCheck;
  /** The model is a cloud one: work items are cut from every tool result. */
  cloud?: boolean;
  /** A short progress line for the client ("Waiting: protecting gameplay"). */
  onStatus?: (text: string) => void;
  /** Ask the iPhone that sent this message for recent photos (only when it said it has photo library access). */
  askDevicePhotos?: (count: number, sinceDays?: number) => Promise<DevicePhoto[]>;
  /** Show images to the model with the next turn (a tool that fetched pictures). */
  showModel?: (note: string, base64Images: string[]) => void;
  /** Keep an image (base64) in the hub's image store; returns its id. */
  saveImage?: (b64: string) => string;
  /** Images waiting to be shown to the model (filled by showModel, emptied by the tool loop). */
  drainModelImages?: () => { note: string; images: string[] }[];
}

export interface DevicePhoto { b64: string; taken_at?: string; width?: number; height?: number }

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** True when the tool changes something; the reply must say what changed. */
  writes: boolean;
  /** Longest result the model gets from this tool (default 6000 characters). */
  maxChars?: number;
  /** A longer result loses its middle, not its end: command output, whose errors come last. */
  cutMiddle?: boolean;
  /** Hidden when this returns false (feature off or not configured). */
  available?(cfg: Config): boolean;
  /** Parameters that depend on the hub's settings (the image workers one may pick). */
  configure?(cfg: Config): ToolDef["parameters"];
  run(api: ApiCall, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolCall { name: string; arguments: Record<string, unknown> }
export interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: ToolDef["parameters"] } }

const MAX_RESULT_CHARS = 6000;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const q = (params: Record<string, unknown>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

/** Drop sync bookkeeping and flatten an entity to what a model needs. */
export function compactEntity(e: unknown): unknown {
  if (!e || typeof e !== "object") return e;
  const x = e as { id?: string; kind?: string; space?: string; deleted_at?: string | null; fields?: Record<string, unknown> };
  if (!x.fields || !x.id) return e;
  const f = compact({ ...x.fields }) as Record<string, unknown>;
  for (const k of ["field_ts", "fired", "snooze_log", "checkins", "links", "suggested_tags", "converted_to", "external_id", "reminder_id"]) delete f[k];
  if (typeof f.body === "string" && f.body.length > 1500) f.body = `${f.body.slice(0, 1500)} [cut, ${f.body.length} chars in full]`;
  return { id: x.id, kind: x.kind, ...(x.space === "work" ? { space: "work" } : {}), ...(x.deleted_at ? { deleted: true } : {}), ...f };
}

const UTC_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/;

/** An ISO time in local wall-clock time with its offset, e.g. 2026-10-27T09:00-04:00. Models misread UTC "Z" times as local. */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Weekday name of a YYYY-MM-DD local date. */
export function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

function compact(v: unknown): unknown {
  if (typeof v === "string" && UTC_ISO.test(v)) return localIso(new Date(v));
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("fields" in o && "id" in o && "kind" in o) return compactEntity(o);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = compact(val);
    return out;
  }
  return v;
}

/** JSON text for the model, capped: from the end, or with `middle` from the middle (the head and the end kept). */
export function renderResult(v: unknown, max = MAX_RESULT_CHARS, middle = false): string {
  const text = JSON.stringify(compact(v));
  if (text.length <= max) return text;
  return middle ? trimMiddle(text, max) : `${text.slice(0, max)} ... [cut; ask for something narrower]`;
}

/** One line per field: name, type, ? when optional. Built from the shared schemas so it never drifts (zod 4's `_zod.def`). */
function zodType(t: z.ZodTypeAny): string {
  const def = (t as any)?._zod?.def;
  switch (def?.type) {
    case "optional": case "nullable": case "default": case "prefault": case "catch": case "readonly": case "nonoptional": return zodType(def.innerType);
    // preprocess is a pipe from a transform into the schema; a transform after a schema is a pipe out of it.
    case "pipe": return zodType(def.in?._zod?.def?.type === "transform" ? def.out : def.in);
    case "enum": return Object.values(def.entries as Record<string, string>).join("|");
    case "literal": return (def.values as unknown[]).map(String).join("|");
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "bool";
    case "array": return `[${zodType(def.element)}]`;
    case "union": return (def.options as z.ZodTypeAny[]).map(zodType).join("|");
    case "object": return `{${Object.entries(def.shape as Record<string, z.ZodTypeAny>).map(([k, v]) => `${k}${isOptional(v) ? "?" : ""}:${zodType(v)}`).join(",")}}`;
    case "record": return "object";
    default: return "any";
  }
}
function isOptional(t: z.ZodTypeAny): boolean {
  const n = (t as any)?._zod?.def?.type;
  return n === "optional" || n === "default" || n === "prefault" || n === "nullable";
}
export function kindFields(kind: string): string {
  const schema = (FieldsByKind as Record<string, z.ZodTypeAny>)[kind] as z.ZodObject<any> | undefined;
  if (!schema?.shape) return "";
  const skip = new Set(["field_ts", "reminder_id", "external_id", "checkins", "links", "suggested_tags", "converted_to", "fired", "snooze_log", "last_probe", "last_probe_error", "last_at", "last_value", "state", "last_check", "last_ok", "last_latency_ms", "last_error", "consecutive_fails", "times_picked", "last_picked", "letter_note_id", "journal_id"]);
  return Object.entries(schema.shape).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}${isOptional(v as z.ZodTypeAny) ? "?" : ""}:${zodType(v as z.ZodTypeAny)}`).join(", ");
}
/** Kinds the generic create/update tools handle. Others have their own tools or belong to the hub. */
export const ITEM_KINDS = ["task", "note", "event", "log", "fact", "rule", "runbook", "project", "watch", "plan_rule", "journal", "snippet",
  "pet_event", "sensor", "food_option", "inventory", "music_idea", "monitor", "checklist", "application", "game", "film"] as const;

type Row = { id?: string; fields: Record<string, any> };
type OpsData = { monitors?: Row[]; incidents_open?: Row[]; incidents_7d?: number; uptime_24h?: { name: string; pct: number }[]; watches_due_30d?: Row[]; journal_recent?: Row[] };

/**
 * `/ops` for the model: the whole picture in a few thousand characters. The raw route is about 25,000 characters
 * of sync bookkeeping, which the result cap cut after a handful of monitors, so the rest was guessed.
 */
/** Backup details read "2026-10-29 19:35 UTC"; the model converted those to local time inconsistently. */
const localTimes = (s: string) => s.replace(/(\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC/g, (_, d, hm) => localIso(new Date(`${d}T${hm}:00Z`)));

export function opsForModel(d: OpsData, filter?: string): unknown {
  const f = filter?.toLowerCase();
  const monitors = (d.monitors ?? []).map((m): Record<string, any> => ({ id: m.id, ...m.fields }))
    .filter((m) => !f || [m.name, m.type, m.host].some((v) => String(v ?? "").toLowerCase().includes(f)))
    .map((m) => ({
      id: m.id, name: m.name, type: m.type, state: m.enabled === false ? "disabled" : m.state ?? "unknown",
      ...(m.last_detail ? { detail: localTimes(String(m.last_detail)) } : {}),
      ...(m.last_error ? { [m.state === "down" ? "error" : "last_error"]: m.last_error } : {}),
      ...(m.last_latency_ms != null && m.type !== "backup" ? { latency_ms: m.last_latency_ms } : {}),
      last_check: m.last_check,
    }));
  return {
    monitors,
    incidents_open: (d.incidents_open ?? []).map((i): Record<string, any> => ({ id: i.id, ...i.fields })).map((i) => ({
      id: i.id, monitor: i.name, opened_at: i.opened_at, error: i.last_error, checks_failed: i.checks_failed,
      ...(i.acknowledged_at ? { acknowledged_at: i.acknowledged_at, owner_note: i.ack_note } : {}),
    })),
    incidents_last_7_days: d.incidents_7d ?? 0,
    uptime_below_100_today: (d.uptime_24h ?? []).filter((u) => u.pct < 100),
    renewals_due_30d: (d.watches_due_30d ?? []).map((w) => ({ name: w.fields.name ?? w.fields.title, due: w.fields.due ?? w.fields.renews_at })),
    // With the outcome: a planned or failed change read as done without it.
    recent_changes: (d.journal_recent ?? []).slice(0, 5).map((j) => ({ host: j.fields.host, at: j.fields.at, what: j.fields.what, outcome: j.fields.outcome ?? "done" })),
  };
}

type CheckRow = { at: string; ok: boolean; latency_ms: number | null; error?: string };

/** A monitor's check history as outages, not every five-minute row (a week is about 2,000 of them). */
export function historyForModel(rows: CheckRow[]): unknown {
  const outages: { from: string; to: string; checks_failed: number; error?: string; recovered_at?: string; ongoing?: boolean }[] = [];
  let cur: (typeof outages)[number] | null = null;
  for (const r of rows) {
    if (!r.ok) {
      if (!cur) cur = { from: r.at, to: r.at, checks_failed: 0, ...(r.error ? { error: r.error } : {}) };
      cur.to = r.at;
      cur.checks_failed++;
    } else if (cur) {
      outages.push({ ...cur, recovered_at: r.at });
      cur = null;
    }
  }
  if (cur) outages.push({ ...cur, ongoing: true });
  const failed = rows.filter((r) => !r.ok).length;
  return {
    checks: rows.length, failed, ok_pct: rows.length ? Math.round(((rows.length - failed) / rows.length) * 10000) / 100 : null,
    ...(rows.length ? { first_check: rows[0].at, last_check: rows[rows.length - 1].at } : {}),
    outages: outages.length, outage_list: outages.slice(-10),
  };
}

/** A metric id, or the metric whose name matches a plain word ("steps", "weight", "laptop backup"). */
export function resolveMetric(metrics: { id: string; label: string }[], want: string | undefined): string | undefined {
  const w = want?.trim().toLowerCase();
  if (!w) return undefined;
  const exact = metrics.find((m) => m.id.toLowerCase() === w || m.label.toLowerCase() === w);
  if (exact) return exact.id;
  return metrics.find((m) => m.label.toLowerCase().includes(w))?.id ?? (w.includes(":") ? want!.trim() : undefined);
}

/** A dashboard series for the model: day by day up to 90 days, by week beyond that (a year is 365 rows otherwise). */
export function seriesForModel(s: Record<string, any>): unknown {
  const pts = (s.points as { day: string; value: number | null }[]);
  const base = { metric: s.metric, name: s.label, unit: s.unit, from: s.from, to: s.to, latest: s.latest, period: s.period, this_period: s.current, previous_period: s.previous };
  if (pts.length <= 90) return { ...base, by_day: pts.filter((p) => p.value !== null).map((p) => [p.day, p.value]) };
  const weeks: [string, number][] = [];
  for (let i = 0; i < pts.length; i += 7) {
    const vals = pts.slice(i, i + 7).map((p) => p.value).filter((v): v is number => v !== null);
    if (!vals.length) continue;
    const v = s.period === "total" ? vals.reduce((x, y) => x + y, 0) : vals.reduce((x, y) => x + y, 0) / vals.length;
    weeks.push([pts[i].day, Math.round(v * 100) / 100]);
  }
  return { ...base, by_week_starting: weeks };
}

const SYNC_PATHS: Record<string, string> = { steam: "/connections/steam/sync", letterboxd: "/connections/letterboxd/sync", confluence: "/connections/atlassian/sync" };

/** The owner's pet's name, from the profile. */
async function petName(api: ApiCall): Promise<string> {
  const p = (await call(api, "GET", "/profile")) as { pet?: string };
  return p?.pet || "pet";
}

async function call(api: ApiCall, method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await api(method, path, body);
  if (r.status >= 400) {
    const err = (r.data as { error?: string; detail?: unknown } | null) ?? {};
    return { error: `${r.status} ${err.error ?? "request failed"}`, ...(err.detail ? { detail: err.detail } : {}) };
  }
  return r.data;
}

/** Map the words models actually send onto the allowed values; unknown stays as given so the route can reject it. */
function normalize(value: unknown, table: Record<string, string[]>): string | undefined {
  const v = str(value)?.toLowerCase();
  if (!v) return undefined;
  for (const [canon, words] of Object.entries(table)) if (v === canon || words.includes(v)) return canon;
  return v;
}
const PET_TYPES = { med: ["meds", "medication", "medicine", "pill", "dose", "heartworm", "flea", "tick", "dewormer"], vet: ["vet visit", "checkup", "appointment", "vaccine", "vaccination"], incident: ["injury", "sick", "accident", "vomit", "vomiting"], weight: ["weigh-in", "weighed"], food: ["fed", "feeding", "meal", "ate", "dinner", "breakfast"], note: ["walk", "walked", "other", "general"] };
const LOG_TYPES = { weight: ["weigh", "weighed", "body weight"], bp: ["blood pressure", "blood_pressure", "pressure"], caffeine: ["coffee", "energy drink"], med: ["meds", "medication", "medicine", "pill"], sleep: ["slept"], mood: ["feeling"], activity: ["exercise", "workout"] };

/** The owner asks to update the hub itself ("update the hub", "install the update", "upgrade yourself"); a question does not count. */
const UPDATE_ASK = /\b(update|upgrade)\b[^.?!]{0,40}\b(hub|yourself|server|aeneas|software|version)\b|\b(hub|yourself|server|aeneas)\b[^.?!]{0,40}\b(update|upgrade)\b|\binstall (it|the update|that|the new version)\b|^\s*(update|upgrade)( (it|now))?[\s.!]*$/i;

/**
 * The owner asks to add, change or remove a standing rule: "add a rule: never use dashes", "make it a rule", "new
 * rule: metric units", "delete the dash rule", "turn that rule off", "from now on, no emoji".
 */
const RULE_ASK = /\b(add|make|create|set|save|new|write|change|edit|update|reword|fix|remove|delete|drop|forget|disable|enable|turn|switch|pause|stop|deactivate|activate)\b[^.?!]{0,40}\brules?\b|\brules?\b[^.?!]{0,40}\b(remove|delete|drop|forget|change|edit|update|reword|disable|enable|off)\b|\brules?:|\b(from now on|going forward)\b/i;

/**
 * Whether the owner's latest message asks for a change to their standing rules, as update_hub checks for an update:
 * a sentence that asks for it (a question counts only as a request, "can you add a rule...?", not "should I add a
 * rule?"), or a plain yes to one the assistant offered.
 */
export function ruleChangeAsked(lastUser: string): boolean {
  if (AFFIRMATION.test(lastUser)) return true;
  return lastUser.split(/(?<=[.!?\n])/).some((s) => RULE_ASK.test(s) && (!/\?\s*$/.test(s) || /^\s*(please|can you|could you|would you|will you)\b/i.test(s)));
}

/** The owner's message says something worked or how a host is set up: the cue that a fix note is due. */
/** Settled: a statement (not a question) with a cue, and no "still not working" or "hasn't worked". */
const settled = (msg: string) => SETTLED.test(msg) && !/\?\s*$/.test(msg.trim()) && !/(\bnot|n't|\bnever|\bstill)[^.!?]{0,20}\bwork/i.test(msg);
const SETTLED = /\b(work(s|ed|ing)( now| again)?|fixed|solved|did (it|the trick)|all good|back (up|online)|is back|runs on|is (at|on) \d|lives on|set ?up|configured|installed|ip|port|path|mount(ed|s)? (at|on))\b/i;

/** A time written at local midnight (with or without seconds and offset). */
const midnight = (v: unknown) => /T00:00(:00(\.0+)?)?(Z|[+-]\d\d:?\d\d)?$/.test(String(v ?? ""));

const READ_KINDS = ["task", "note", "project", "watch", "checklist", "journal", "snippet", "runbook", "inventory", "procedure",
  "music_idea", "application", "game", "film", "food_option", "pet_event", "log", "event", "monitor", "incident", "fact", "plan_rule", "rule", "capture"] as const;

export const TOOLS: ToolDef[] = [
  // ---------- read ----------
  {
    name: "get_today", writes: false,
    description: "Today's plan: the task in progress (now), next tasks, scheduled blocks, calendar events including work meetings, fixed commitments such as the Work blackout, reminders due today, renewals due soon, free slots and the digest.",
    parameters: { type: "object", properties: {} },
    run: async (api) => {
      const t = await call(api, "GET", "/planner/today") as Record<string, unknown>;
      return typeof t?.date === "string" ? { weekday: weekdayOf(t.date), ...t } : t;
    },
  },
  {
    name: "get_week", writes: false,
    description: "The week planner: per day the blocks, events, commitments and free slots. Without start: this week from Monday through the next seven days. With start (YYYY-MM-DD): the seven days from that date.",
    parameters: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DD" } } },
    run: async (api, a) => {
      type Week = { days?: { date: string; blocks: unknown[]; events: unknown[]; commitments: unknown[]; free_slots: unknown[] }[] } & Record<string, unknown>;
      const w = await call(api, "GET", `/planner/week${q({ start: str(a.start) })}`) as Week;
      if (!w?.days) return w;
      // Without a date, the next seven days too: on a Sunday "this week" ended today and Tuesday's plan was not found.
      if (!str(a.start)) {
        const ahead = diaryDay(new Date(Date.now() + 7 * 86400000));
        const last = w.days[w.days.length - 1].date;
        const next = diaryDay(new Date(new Date(`${last}T12:00:00`).getTime() + 86400000));
        const after = next <= ahead ? await call(api, "GET", `/planner/week${q({ start: next })}`) as Week : { days: [] };
        w.days = [...w.days, ...(after?.days ?? []).filter((d) => !w.days!.some((x) => x.date === d.date))].filter((d) => d.date <= ahead);
      }
      return { ...w, days: w.days.map((d) => ({ date: d.date, weekday: weekdayOf(d.date), blocks: d.blocks, events: (d.events as { id: string; fields?: Record<string, unknown>; space?: string }[]).map((e) => ({ id: e.id, title: e.fields?.title, ...(e.fields?.all_day === true ? { all_day: true } : { start: e.fields?.start, end: e.fields?.end }), ...(e.fields?.location ? { location: e.fields.location } : {}), ...(e.space === "work" ? { work: true } : {}) })), commitments: d.commitments, free_slots: d.free_slots })) };
    },
  },
  {
    name: "search", writes: false,
    description: "Full-text search across notes, tasks, runbooks, journal, snippets, projects and other saved items. Use for any question about something {{owner}} wrote down before.",
    parameters: { type: "object", properties: { query: { type: "string" }, kinds: { type: "string", description: "optional comma-separated kinds, e.g. note,runbook" }, limit: { type: "number" } }, required: ["query"] },
    run: (api, a) => call(api, "GET", `/search${q({ q: str(a.query), kinds: str(a.kinds), limit: num(a.limit) ?? 15 })}`),
  },
  {
    name: "list_items", writes: false,
    description: `List saved items of one kind, newest first. Kinds: ${READ_KINDS.join(", ")}. Tasks can be filtered by status (inbox, next, scheduled, doing, done, parked) and by list (an Apple Reminders list by name, e.g. Groceries; "what's on my grocery list"). Notes can be filtered by tag and folder: ideas are notes tagged idea plus their form ("my skit ideas": tag idea and sketch; "movie ideas": idea and film), in folders like Writing/Sketches.`,
    parameters: { type: "object", properties: { kind: { type: "string", enum: [...READ_KINDS] }, status: { type: "string" }, list: { type: "string" }, tag: { type: "string", description: "notes: one or more tags, comma separated, all must match" }, folder: { type: "string", description: "notes: a folder and the folders inside it" }, limit: { type: "number" } }, required: ["kind"] },
    run: async (api, a, ctx) => {
      const kind = str(a.kind);
      if (!kind || !(READ_KINDS as readonly string[]).includes(kind)) return { error: `unknown kind; use one of ${READ_KINDS.join(", ")}` };
      const owner = moduleOfKind(kind);
      if (owner && ctx.moduleOn && !ctx.moduleOn(owner)) return { error: `${kind} belongs to ${moduleDef(owner).title}, which is switched off` };
      if (kind === "task" && str(a.list)) {
        const title = matchList(str(a.list)!, taskLists(ctx.store), ctx.owner);
        if (!title) return { error: `no Reminders list named ${str(a.list)}`, lists: taskLists(ctx.store) };
        const tasks = ctx.store.list({ kind: "task", limit: 100000 })
          .filter((t) => listOf(t) === title && (!str(a.status) || t.fields.status === str(a.status)))
          .map((t) => ({ id: t.id, title: t.fields.title, status: t.fields.status, ...(t.fields.due ? { due: t.fields.due } : {}), ...(t.fields.remind_at ? { remind_at: t.fields.remind_at } : {}), ...(t.space === "work" ? { work: true } : {}) }));
        return { list: title, open: tasks.filter((t) => t.status !== "done"), done: tasks.filter((t) => t.status === "done").length };
      }
      if (kind === "note" && (str(a.tag) || str(a.folder))) {
        const want = (str(a.tag) ?? "").split(",").map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
        const folder = (str(a.folder) ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();
        const notes = ctx.store.list({ kind: "note", space: "personal", limit: 100000 })
          .filter((n) => !n.deleted_at)
          .filter((n) => { const tags = ((n.fields.tags as string[] | undefined) ?? []).map((t) => t.toLowerCase()); return want.every((w) => tags.includes(w)); })
          .filter((n) => !folder || String(n.fields.path ?? "").toLowerCase().startsWith(`${folder}/`))
          .sort((x, y) => y.updated_at.localeCompare(x.updated_at))
          .slice(0, Math.min(num(a.limit) ?? 40, 100));
        return { notes: notes.map((n) => ({ id: n.id, title: n.fields.title, path: n.fields.path, tags: n.fields.tags, ...(Array.isArray(n.fields.related) && n.fields.related.length ? { related: n.fields.related } : {}), preview: String(n.fields.body ?? "").replace(/\s+/g, " ").slice(0, 160) })), count: notes.length };
      }
      return call(api, "GET", `/entities${q({ kind, status: str(a.status), limit: Math.min(num(a.limit) ?? 25, 100) })}`);
    },
  },
  {
    name: "wiki_search", writes: false,
    description: "Search the project wiki: the repository docs and Confluence spaces {{owner}} mirrored to the hub (designs, notes, plans, roadmaps, how-tos). Every word must appear. Returns page ids, titles and snippets.",
    parameters: { type: "object", properties: { query: { type: "string", description: "one to three key words, e.g. combat or save system" }, limit: { type: "number" } }, required: ["query"] },
    run: (api, a) => call(api, "GET", `/wiki/search${q({ q: str(a.query), limit: num(a.limit) ?? 8 })}`),
  },
  {
    name: "wiki_page", writes: false, maxChars: 30000,
    description: "Read one project wiki page in full by its id from wiki_search.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (api, a) => {
      const p = await call(api, "GET", `/wiki/page${q({ id: str(a.id) })}`) as { id?: string; title?: string; source_name?: string; crumbs?: string[]; url?: string | null; updated_at?: string; markdown?: string };
      if (!p || typeof p !== "object" || !p.markdown) return p;
      return { page_id: p.id, title: p.title, from: p.source_name, path: p.crumbs, url: p.url, updated_at: p.updated_at, markdown: p.markdown };
    },
  },
  {
    name: "get_item", writes: false, maxChars: 30000,
    description: "Read one saved item in full by its id (a note's whole body, a project, a checklist with its items).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (api, a, ctx) => {
      // Flattened here so the usual 1500 character cut on bodies does not apply: this is the full read.
      const e = await call(api, "GET", `/entities/${encodeURIComponent(str(a.id) ?? "")}`) as { id?: string; kind?: string; space?: string; fields?: Record<string, unknown> };
      if (!e || typeof e !== "object" || !e.fields) return e;
      const owner = e.kind ? moduleOfKind(e.kind) : null;
      if (owner && ctx.moduleOn && !ctx.moduleOn(owner)) return { error: `that item belongs to ${moduleDef(owner).title}, which is switched off` };
      // A deleted item is said to be deleted, not shown as if it were live.
      if ((e as { deleted_at?: string | null }).deleted_at) return { error: "that item was deleted", item_id: e.id, item_kind: e.kind };
      const f = { ...e.fields };
      for (const k of ["field_ts", "fired", "snooze_log", "checkins", "links", "suggested_tags", "converted_to", "external_id", "reminder_id"]) delete f[k];
      return { item_id: e.id, item_kind: e.kind, ...(e.space === "work" ? { space: "work" } : {}), ...f };
    },
  },
  {
    name: "reminders_due", writes: false,
    description: "Tasks whose reminder is due or overdue within the next N minutes (default 24 hours). Reminders are tasks with a reminder time.",
    parameters: { type: "object", properties: { within_minutes: { type: "number" } } },
    run: (api, a) => call(api, "GET", `/reminders/due${q({ within: Math.min(num(a.within_minutes) ?? 1440, 10080) })}`),
  },
  {
    name: "update_hub", writes: true,
    description: "The hub's own software: action=check says which version it runs, what is newer and how the last update went; action=install updates it to the newest version (it restarts in a minute or two and goes back by itself if the new version does not start). Install only when {{owner}}'s latest message asks to update the hub or says yes to updating it; otherwise check, say what is new, and ask.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["check", "install"] } }, required: ["action"] },
    run: async (api, a, ctx) => {
      const info = await call(api, "POST", "/hub-update/check") as Record<string, unknown> & { changes?: { title: string }[]; can_update?: boolean; reason?: string; behind?: number; last_run?: unknown; commit?: string | null; committed_at?: string | null };
      if (!info || "error" in info) return info;
      const view = {
        running: info.commit ? String(info.commit).slice(0, 7) : null, released: info.committed_at ?? null,
        newer_versions: info.behind ?? 0, whats_new: (info.changes ?? []).map((c) => c.title), can_update: !!info.can_update,
        ...(info.reason ? { why_not: info.reason } : {}), last_update: info.last_run ?? null,
      };
      if (normalize(a.action, { install: ["update", "upgrade", "apply", "start"] }) !== "install") return view;
      if (!info.can_update) return { ...view, error: info.reason ?? "already the newest version: nothing to install" };
      if (!(UPDATE_ASK.test(ctx.lastUser) && !/\?\s*$/.test(ctx.lastUser)) && !AFFIRMATION.test(ctx.lastUser)) return { ...view, error: "{{owner}}'s latest message does not ask to update; tell them what is new and ask" };
      const r = await call(api, "POST", "/hub-update");
      if (r && typeof r === "object" && "error" in r) return { ...view, ...(r as object) };
      return { ...view, status: "started", instruction: "Say the update has started, what is new in a few words, and that the hub restarts in a minute or two (the app reconnects by itself). Ask about it again later to see how it went." };
    },
  },
  {
    name: "ops_status", writes: false,
    description: "Homelab status: every monitor (hosts, services, backups and their verifications) with id, state, detail and last error; open incidents with id and {{owner}}'s notes; uptime below 100% today; renewals due within 30 days; recent changes. filter narrows the monitors by name, type or host (e.g. backup, nas). history_hours (up to 168) adds each matching monitor's outages over that window, for questions like how often or since when something failed.",
    parameters: { type: "object", properties: { filter: { type: "string" }, history_hours: { type: "number" } } },
    run: async (api, a) => {
      const d = await call(api, "GET", "/ops");
      if (!d || typeof d !== "object" || "error" in d) return d;
      const view = opsForModel(d as OpsData, str(a.filter)) as { monitors: { id?: string; history?: unknown }[] };
      const hours = num(a.history_hours);
      if (hours && hours > 0) {
        const h = Math.min(168, hours);
        if (view.monitors.length > 4) return { error: `history covers up to 4 monitors; ${view.monitors.length} match. Give a narrower filter.` };
        for (const m of view.monitors) {
          const rows = await call(api, "GET", `/monitors/${encodeURIComponent(m.id ?? "")}/history${q({ hours: h })}`);
          m.history = Array.isArray(rows) ? historyForModel(rows as CheckRow[]) : rows;
        }
      }
      return view;
    },
  },
  {
    name: "health_summary", writes: false,
    description: "Health over the last N days (default 30): weight, blood pressure, caffeine, mood, sleep, activity, today's medications and the next weekly injection when one is set.",
    parameters: { type: "object", properties: { days: { type: "number" } } },
    run: (api, a) => call(api, "GET", `/health/summary${q({ days: num(a.days) })}`),
  },
  {
    name: "metrics", writes: false,
    description: "Every tracked number over time, the same data as the Dashboard charts: body (weight, sleep, steps, blood pressure, mood), custom logs (pushups and the like), tasks done, captures, sensors, and each monitor's uptime. action=list names the metrics that have data; action=series gives one metric day by day for days (default 30, up to 365) with the period's total or average and the previous period's for comparison. metric is an id from list or a plain name (steps, weight).",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "series"] }, metric: { type: "string" }, days: { type: "number" } }, required: ["action"] },
    run: async (api, a) => {
      const listed = await call(api, "GET", "/dashboard/metrics") as { metrics?: { id: string; label: string; unit: string; group: string; count: number; last_at: string | null }[]; error?: string };
      if (!listed.metrics) return listed;
      if (str(a.action) !== "series") return { metrics: listed.metrics.map((m) => ({ id: m.id, name: m.label, unit: m.unit, group: m.group, readings: m.count, last: m.last_at })) };
      const metric = resolveMetric(listed.metrics, str(a.metric));
      if (!metric) return { error: `no metric matches ${str(a.metric) ?? "(none given)"}; known: ${listed.metrics.map((m) => m.label).join(", ")}` };
      const days = Math.min(365, Math.max(1, Math.round(num(a.days) ?? 30)));
      const s = await call(api, "GET", `/dashboard/series${q({ metric, days })}`) as Record<string, any>;
      return s && Array.isArray(s.points) ? seriesForModel(s) : s;
    },
  },
  {
    name: "dashboard", writes: true,
    description: "The Dashboard screen's chart tiles (the same on every device). action=show lists them; add puts a metric on it (metric id or name from metrics, range 7|30|90|365 days, chart line|bar); remove takes one off by metric; reset goes back to the defaults.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["show", "add", "remove", "reset"] }, metric: { type: "string" }, range: { type: "number" }, chart: { type: "string", enum: ["line", "bar"] } }, required: ["action"] },
    run: async (api, a) => {
      const action = str(a.action) ?? "show";
      if (action === "reset") return call(api, "DELETE", "/prefs/dashboard");
      const prefs = await call(api, "GET", "/prefs/dashboard") as { tiles?: { metric: string; range: number; chart: string }[]; error?: string };
      if (!prefs.tiles) return prefs;
      if (action === "show") return prefs;
      const listed = await call(api, "GET", "/dashboard/metrics") as { metrics?: { id: string; label: string; chart: string }[] };
      const metric = resolveMetric(listed.metrics ?? [], str(a.metric)) ?? str(a.metric);
      if (!metric) return { error: "metric is required" };
      if (action === "remove") {
        const tiles = prefs.tiles.filter((t) => t.metric !== metric);
        if (tiles.length === prefs.tiles.length) return { error: `${metric} is not on the dashboard; on it: ${prefs.tiles.map((t) => t.metric).join(", ")}` };
        return call(api, "PUT", "/prefs/dashboard", { tiles });
      }
      if (action === "add") {
        const range = [7, 30, 90, 365].includes(num(a.range) ?? 0) ? num(a.range)! : 30;
        const chart = str(a.chart) ?? listed.metrics?.find((m) => m.id === metric)?.chart ?? "line";
        const tiles = [...prefs.tiles.filter((t) => t.metric !== metric), { metric, range, chart }];
        return call(api, "PUT", "/prefs/dashboard", { tiles });
      }
      return { error: "action must be show, add, remove or reset" };
    },
  },
  {
    name: "set_injection_day", writes: true,
    description: "Set the weekly injection reminder: the medication name, the weekday (mon..sun) and the time (HH:MM, 24 hour). Moves the existing reminder for that medication instead of adding another.",
    parameters: { type: "object", properties: { name: { type: "string" }, weekday: { type: "string" }, time: { type: "string" } }, required: ["name", "weekday", "time"] },
    run: (api, a) => call(api, "POST", "/health/injection-day", { name: str(a.name), weekday: str(a.weekday), time: str(a.time) }),
  },
  {
    name: "diary", writes: false, maxChars: 12000,
    description: "{{owner}}'s days: every quick capture (timestamped diary lines), calendar events and logs, newest day first. Use it for recall: what did I do on a day or last week, when did I last..., how often.... Give from/to as YYYY-MM-DD (default the last 7 days; up to a year with a query, 31 days without). query keeps only lines, events and logs containing all its words (e.g. Luigi's, Jamie, gym).",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, query: { type: "string" } } },
    run: async (_api, a, ctx) => {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const to = str(a.to) && day.test(str(a.to)!) ? str(a.to)! : diaryDay(new Date());
      const back = (n: number) => diaryDay(new Date(new Date(`${to}T12:00:00`).getTime() - n * 86400000));
      const span = str(a.query) ? 365 : 31;
      let from = str(a.from) && day.test(str(a.from)!) ? str(a.from)! : back(str(a.query) ? 365 : 6);
      if (from < back(span)) from = back(span);
      // Each day with its weekday: the model worked them out itself and called a Saturday a Sunday.
      const days = readDiary(ctx.store, from, to, str(a.query)).map(({ day, ...rest }) => ({ day, weekday: weekdayOf(day), ...rest }));
      return days.length ? { from, to, days } : { from, to, days: [], note: "Nothing recorded in that range" };
    },
  },
  {
    name: "pet_summary", writes: false,
    description: "{{pet}} ({{owner}}'s pet): events in the last 30 days, upcoming vet and medication dates, and custody (whether the pet is with {{owner}} now and the next handoff).",
    parameters: { type: "object", properties: {} },
    run: (api) => call(api, "GET", "/pets/_/summary"),
  },
  {
    name: "project_summary", writes: false,
    description: "One project's resume card, open tasks, parts still missing and plan note. Find the id with list_items kind=project.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (api, a) => call(api, "GET", `/projects/${encodeURIComponent(str(a.id) ?? "")}/summary`),
  },
  {
    name: "pick_food", writes: false,
    description: "Pick one meal option that fits {{owner}}'s diet rules and budget, with the reason and a runner-up.",
    parameters: { type: "object", properties: { meal: { type: "string", enum: ["lunch", "dinner", "snack"] }, mode: { type: "string", enum: ["delivery", "restaurant", "grab", "home"] }, budget: { type: "number" } }, required: ["meal"] },
    run: (api, a) => call(api, "POST", "/food/pick", { meal: str(a.meal), mode: str(a.mode), budget: num(a.budget) }),
  },
  {
    name: "food_chosen", writes: true,
    description: "Record that {{owner}} chose a food option (by its id, from pick_food or list_items kind=food_option), so the picker rotates it out for a few days.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (api, a) => call(api, "POST", "/food/picked", { id: str(a.id) }),
  },
  {
    name: "library", writes: false,
    description: "Ranked lists of {{owner}}'s games (Steam library and games added by hand: hours played, last two weeks, last played), films (Letterboxd: rating, when watched, times watched, likes; watchlist=yes for the watchlist) job applications (stage, applied date) subscriptions (renewals in the subscription category with cost: monthly and yearly totals) and renewals (every renewal with a cost, any category: what they cost together a month and a year, by category, and any left out because they do not repeat). For \"how much do my renewals cost\", use what=renewals. Use for questions like most played games, films watched this year, best rated films, or open applications. For a written list, read here first, then save it with save_note or create_item kind=checklist.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["games", "films", "applications", "subscriptions", "renewals"] },
        sort: { type: "string", description: "games: playtime (default), two_weeks, recent, rating, name. films: recent (default), rating, rewatched, title, year." },
        limit: { type: "number" },
        query: { type: "string", description: "optional text to match in names, titles, tags, companies or roles" },
        year: { type: "number", description: "films only: watched in this year" },
        stage: { type: "string", description: "applications only: open, or one stage (saved, applied, screen, interview, offer, rejected, withdrawn, accepted)" },
        played: { type: "string", enum: ["yes", "no"], description: "games only: only played, or only never played" },
        watchlist: { type: "string", enum: ["yes"], description: "films only: the watchlist instead of watched films" },
      },
      required: ["what"],
    },
    run: async (api, a) => {
      const what = str(a.what);
      if (what === "games") return call(api, "GET", `/library/games${q({ sort: str(a.sort), limit: num(a.limit), q: str(a.query), played: str(a.played) })}`);
      if (what === "films") {
        const r = await call(api, "GET", `/library/films${q({ sort: str(a.sort), limit: num(a.limit), q: str(a.query), year: num(a.year), watchlist: str(a.watchlist) })}`) as { films?: { last_watched?: string }[] } & Record<string, unknown>;
        // The weekday with each date: the model worked them out itself and gave wrong dates.
        if (Array.isArray(r?.films)) r.films = r.films.map((f) => (typeof f.last_watched === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.last_watched) ? { ...f, last_watched: `${weekdayOf(f.last_watched)} ${f.last_watched}` } : f));
        return r;
      }
      if (what === "applications") return call(api, "GET", `/library/applications${q({ stage: str(a.stage), limit: num(a.limit), q: str(a.query) })}`);
      if (what === "subscriptions") return call(api, "GET", "/finance/subscriptions");
      if (what === "renewals") return call(api, "GET", "/finance/renewals");
      return Promise.resolve({ error: "what must be games, films, applications, subscriptions or renewals" });
    },
  },
  {
    name: "record_done", writes: true,
    description: "Record that something recurring happened: what=renewal marks a renewal (list_items kind=watch) as renewed and moves it to its next due date; what=game marks a game (library what=games or list_items kind=game) as played now. Give id, or name (the renewal's or game's title) when you do not have it.",
    parameters: { type: "object", properties: { what: { type: "string", enum: ["renewal", "game"] }, id: { type: "string" }, name: { type: "string" } }, required: ["what"] },
    run: async (api, a, ctx) => {
      let raw = str(a.id) ?? "";
      // The renewal's reminder task (found first by search) stands for its renewal: the model finished the reminder
      // and the renewal kept its old due date.
      const given = ctx.store.get(raw);
      if (str(a.what) === "renewal" && given?.kind === "task" && typeof given.fields.linked_id === "string" && ctx.store.get(given.fields.linked_id)?.kind === "watch") raw = given.fields.linked_id;
      // "I renewed the domain": by name, or the one renewal whose title has the words said. Anything else that is not a
      // renewal gets the list back, so the next try picks the right one instead of giving up.
      if (str(a.what) === "renewal" && ctx.store.get(raw)?.kind !== "watch") {
        const watches = ctx.store.list({ kind: "watch", space: "personal", limit: 1000 }).filter((w) => !w.deleted_at);
        const words = wordsOf(str(a.name) ?? (given ? String(given.fields.title ?? "") : raw));
        const hits = words.size ? watches.filter((w) => [...words].every((x) => wordsOf(String(w.fields.title ?? "")).has(x) || String(w.fields.category ?? "") === x)) : [];
        if (hits.length !== 1) return { error: hits.length ? "more than one renewal matches; give its id" : "that is not a renewal", renewals: (hits.length ? hits : watches).map((w) => ({ id: w.id, title: w.fields.title, due: w.fields.due, category: w.fields.category })) };
        raw = hits[0].id;
      }
      const id = encodeURIComponent(raw);
      if (str(a.what) === "game") return call(api, "POST", `/games/${id}/played`, {});
      if (str(a.what) === "renewal") return call(api, "POST", `/watches/${id}/renewed`, {});
      return { error: "what must be renewal or game" };
    },
  },
  {
    name: "app_status", writes: false,
    description: "Aeneas itself: each of {{owner}}'s devices and when it last synced, the Steam, Letterboxd, Confluence and Apple Health connections (last sync, errors, counts), the hub's own nightly backup, and how many captures wait in Unsorted Info. Use for questions like is my phone syncing, when did Steam last update, or is the app healthy. A device syncs whenever the app is open on it, and last_synced is the last time it reached the hub: hours or days ago usually means the app has not been opened there since, not a fault. Letterboxd and Confluence sync by themselves every hour, Steam every 6 hours.",
    parameters: { type: "object", properties: {} },
    run: async (api) => {
      const [st, conn, caps] = await Promise.all([call(api, "GET", "/status"), call(api, "GET", "/connections"), call(api, "GET", "/entities?kind=capture&limit=1000")]);
      const s = (st ?? {}) as Record<string, any>;
      if ("error" in s) return s;
      return {
        hub: { version: s.version, running_since: s.started_at, items: s.db?.entities_by_kind },
        devices: (s.devices ?? []).map((d: Record<string, any>) => ({ name: d.name, platform: d.platform, last_synced: d.last_seen })),
        connections: conn,
        hub_backup: s.backups ? { latest: s.backups.latest_at, kept: s.backups.count } : undefined,
        inbox_unsorted: Array.isArray(caps) ? caps.filter((e: { fields: Record<string, any> }) => !e.fields.processed).length : undefined,
      };
    },
  },
  {
    name: "sync_now", writes: true,
    description: "Pull fresh data now instead of waiting for the automatic sync: service steam (games and playtime), letterboxd (films) or confluence (the project wiki).",
    parameters: { type: "object", properties: { service: { type: "string", enum: ["steam", "letterboxd", "confluence"] } }, required: ["service"] },
    run: (api, a) => {
      const service = normalize(a.service, { steam: ["games"], letterboxd: ["films", "movies"], confluence: ["wiki", "atlassian"] });
      const path = service ? SYNC_PATHS[service] : undefined;
      return path ? call(api, "POST", path, {}) : Promise.resolve({ error: "service must be steam, letterboxd or confluence" });
    },
  },
  {
    name: "pick_game", writes: false,
    description: "Pick a game every listed player owns that fits the player count and time.",
    parameters: { type: "object", properties: { players: { type: "array", items: { type: "string" } }, hours: { type: "number" }, coop: { type: "boolean" } }, required: ["players"] },
    run: (api, a) => call(api, "POST", "/games/pick", { players: Array.isArray(a.players) ? a.players : [], hours: num(a.hours), coop: a.coop === true ? true : undefined }),
  },

  // ---------- write ----------
  {
    name: "create_task", writes: true,
    description: "Add a NEW task. status: next (do soon, default), inbox (unsorted), doing (now). list puts it in an Apple Reminders list by name (\"add milk to the grocery list\": list Groceries); the iPhone adds it there. Set work=true only for a work task. If {{owner}} names a task that may already exist (to schedule, finish or change it), look it up with list_items kind=task first and use its id instead of creating a duplicate.",
    parameters: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, status: { type: "string", enum: ["inbox", "next", "doing"] }, due: { type: "string", description: "ISO date or datetime: the day {{owner}} named for it (\"tomorrow morning\" is tomorrow's date), never left in notes" }, project_id: { type: "string" }, list: { type: "string", description: "an Apple Reminders list name" }, work: { type: "boolean" }, again: { type: "boolean", description: "true only when {{owner}} wants a second task like an open one" } }, required: ["title"] },
    run: (api, a, ctx) => {
      const space = a.work === true ? "work" : "personal";
      let list: string | null = null;
      if (str(a.list)) {
        list = matchList(str(a.list)!, taskLists(ctx.store, space), ctx.owner);
        if (!list) return Promise.resolve({ error: `no Reminders list named ${str(a.list)}`, lists: taskLists(ctx.store, space) });
      }
      const same = a.again === true ? null : sameOpenTask(ctx.store, str(a.title) ?? "", space);
      if (same) return Promise.resolve({ error: "already an open task for this", task: { id: same.id, title: same.fields.title, status: same.fields.status, ...(listOf(same) ? { list: listOf(same) } : {}) }, next: "Use this task (update_item to change its list or due date). Call create_task again with again=true only if {{owner}} wants a second one." });
      return call(api, "POST", "/entities", { kind: "task", space, fields: { title: str(a.title), status: str(a.status) ?? "next", order: 9999, ...(str(a.notes) ? { notes: str(a.notes) } : {}), ...(str(a.due) ? { due: str(a.due) } : {}), ...(str(a.project_id) ? { project_id: str(a.project_id) } : {}), ...(list ? { apple: { id: "", list: "", list_title: list } } : {}) } });
    },
  },
  {
    name: "update_task", writes: true,
    description: "Change a task: mark it done, start it (doing), park it with a reason, rename it, or set its due date. Find the id with get_today or list_items. A renewal's reminder (\"Renew: ...\") is finished with record_done what=renewal, which also moves the renewal to its next due date.",
    parameters: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["inbox", "next", "doing", "done", "parked"] }, title: { type: "string" }, due: { type: "string" }, parked_reason: { type: "string" } }, required: ["id"] },
    run: (api, a, ctx) => {
      const fields: Record<string, unknown> = {};
      const status = str(a.status);
      if (status) fields.status = status;
      if (status === "done") {
        // As finishing it anywhere else: a repeating task moves to its next time instead of ending for good.
        const cur = ctx.store.get(str(a.id) ?? "");
        const done = completeTaskPatch(cur && cur.kind === "task" ? cur.fields : {});
        if (done.status === undefined) delete fields.status;
        Object.assign(fields, done);
      }
      if (str(a.title)) fields.title = str(a.title);
      if (str(a.due)) fields.due = str(a.due);
      if (str(a.parked_reason)) fields.parked_reason = str(a.parked_reason);
      if (!Object.keys(fields).length) return Promise.resolve({ error: "nothing to change" });
      return call(api, "PATCH", `/entities/${encodeURIComponent(str(a.id) ?? "")}`, { fields });
    },
  },
  {
    name: "schedule_task", writes: true,
    description: "Put an existing task into a time block (default 3 hours); use it, not a new event, when {{owner}} blocks time for something that is already a task, with force=true when {{owner}} gave the time. Take task_id from list_items kind=task; create the task only if it does not exist. Pick start from the free_slots of get_today or get_week. Fails with the conflicting item when the time is taken.",
    parameters: { type: "object", properties: { task_id: { type: "string" }, start: { type: "string", description: "ISO datetime with offset" }, hours: { type: "number" }, force: { type: "boolean", description: "true when {{owner}} named this time themself: place it even over the Work blackout or another item" } }, required: ["task_id", "start"] },
    run: async (api, a) => {
      const r = await call(api, "POST", "/planner/schedule", { task_id: str(a.task_id), start: str(a.start), hours: num(a.hours) ?? 3, ...(a.force === true ? { force: true } : {}) }) as { error?: string };
      // The model told the owner it could force the block and asked, when they had named the time.
      return r?.error?.includes("conflict") ? { ...r, next: "If {{owner}} named this time, call schedule_task again now with force=true and tell them what it overlaps; do not ask. Otherwise pick a free slot." } : r;
    },
  },
  {
    name: "create_reminder", writes: true,
    description: "Set a reminder: a task that notifies at an exact time (ISO datetime with offset). due is an optional deadline. repeat is optional, e.g. 'every 1 days' or 'every 2 weeks on mon,thu'.",
    parameters: { type: "object", properties: { title: { type: "string" }, at: { type: "string" }, due: { type: "string" }, repeat: { type: "string" } }, required: ["title", "at"] },
    run: (api, a) => call(api, "POST", "/entities", { kind: "task", fields: { title: str(a.title), status: "scheduled", order: Date.now(), remind_at: str(a.at), friction: "none", ...(str(a.due) ? { due: str(a.due) } : {}), ...(str(a.repeat) ? { repeat: str(a.repeat) } : {}) } }),
  },
  {
    name: "snooze_or_finish_reminder", writes: true,
    description: "Finish a task's reminder (a repeating one moves to its next time), or snooze it until a time. id is the task id.",
    parameters: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["done", "snooze"] }, until: { type: "string", description: "ISO datetime, for snooze" } }, required: ["id", "action"] },
    run: (api, a) => str(a.action) === "snooze"
      ? call(api, "POST", `/reminders/${encodeURIComponent(str(a.id) ?? "")}/snooze`, { until: str(a.until), reason: "via assistant" })
      : call(api, "POST", `/reminders/${encodeURIComponent(str(a.id) ?? "")}/ack`, {}),
  },
  {
    name: "save_note", writes: true,
    description: "Save a new note. folder is optional (default Inbox); tags are lowercase words, without #.",
    parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, folder: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "body"] },
    run: (api, a) => {
      const title = str(a.title) ?? "Note";
      const safe = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Note";
      const folder = (str(a.folder) ?? "Inbox").replace(/^\/+|\/+$/g, "");
      const tags = [...new Set((Array.isArray(a.tags) ? a.tags : []).map((t: unknown) => cleanTag(String(t))).filter(Boolean))];
      return call(api, "POST", "/entities", { kind: "note", fields: { title, body: str(a.body) ?? "", tags, path: `${folder}/${safe}.md` } });
    },
  },
  {
    name: "note_tags", writes: true,
    description: "Tags for a saved note (id from search). action=suggest returns tags that fit, preferring ones {{owner}} already uses, plus the notes it links to; accept adds tags to the note (tags, or every suggestion when none are given).",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["suggest", "accept"] }, id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["action", "id"] },
    run: (api, a) => {
      const id = encodeURIComponent(str(a.id) ?? "");
      if (str(a.action) === "accept") return call(api, "POST", `/notes/${id}/accept`, Array.isArray(a.tags) ? { tags: a.tags.map(String) } : {});
      return call(api, "POST", `/notes/${id}/suggest`, {});
    },
  },
  {
    name: "capture", writes: true,
    description: "Drop a quick line into Aeneas and let the hub sort it (what it cannot sort waits in Unsorted Info) (task, reminder, log, note). Start with 'work:' for a work task.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (api, a) => call(api, "POST", "/capture", { text: str(a.text), source: "api", auto: true }),
  },
  {
    name: "inbox", writes: true,
    description: "Unsorted Info ({{owner}} calls it that; it used to be the Inbox): quick captures the hub could not sort by itself. action=list shows them with the hub's suggestion; sort files one (id) as kind task, note, reminder, log or fact; discard drops one (id). To sort everything, list first, then sort each by its suggestion unless the text clearly says otherwise.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "sort", "discard"] }, id: { type: "string" }, kind: { type: "string", enum: ["task", "note", "reminder", "log", "fact"] } }, required: ["action"] },
    run: async (api, a) => {
      const action = str(a.action) ?? "list";
      if (action === "list") {
        const d = await call(api, "GET", "/entities?kind=capture&limit=1000");
        if (!Array.isArray(d)) return d;
        const open = (d as { id: string; created_at: string; fields: Record<string, any> }[]).filter((e) => !e.fields.processed)
          .sort((x, y) => x.created_at.localeCompare(y.created_at))
          .map((e) => ({ id: e.id, text: e.fields.text, source: e.fields.source, captured_at: e.created_at, ...(e.fields.suggested_kind && e.fields.suggested_kind !== "none" ? { suggests: e.fields.suggested_kind } : {}) }));
        return { unsorted: open.length, captures: open.slice(0, 40) };
      }
      const id = str(a.id);
      if (!id) return { error: "id is required; take it from action=list" };
      if (action === "discard") {
        const out = await call(api, "PATCH", `/entities/${encodeURIComponent(id)}`, { fields: { processed: true, sorted_by: "manual" } });
        return out && typeof out === "object" && "error" in out ? out : { discarded: id };
      }
      if (action === "sort") {
        const kind = normalize(a.kind, { task: ["todo", "to-do", "to do"], reminder: ["remind", "alarm"], note: ["idea", "notes"], log: ["health", "entry"], fact: ["memory", "remember"] });
        if (!kind) return { error: "kind is required: task, note, reminder, log or fact" };
        return call(api, "POST", `/capture/${encodeURIComponent(id)}/convert`, { kind });
      }
      return { error: "action must be list, sort or discard" };
    },
  },
  {
    name: "log_health", writes: true,
    description: "Log a health value: weight (lb, or unit kg), bp ('120/80'), caffeine (cups of coffee; for milligrams give unit mg and the hub turns it into cups of 95 mg), med (the medication name), sleep (hours, or unit min), mood (-2..2), activity (name; note 'end' to stop it). Leave value out to repeat {{owner}}'s last log of that type (\"another coffee\", \"took it again\"); never log a placeholder.",
    parameters: { type: "object", properties: { type: { type: "string", enum: ["weight", "bp", "caffeine", "med", "sleep", "mood", "activity", "steps", "custom"] }, value: { type: ["number", "string"] }, unit: { type: "string" }, note: { type: "string", description: "only what {{owner}} said beyond the value (\"after the gym\"); never the time or date, which the log already has" } }, required: ["type"] },
    run: (api, a, ctx) => {
      const type = normalize(a.type, LOG_TYPES);
      let value: unknown = num(a.value) ?? str(a.value);
      let unit = str(a.unit);
      // "Another coffee": the same amount as the last one. The model logged 0 mg and asked for milligrams.
      // 0 is a placeholder for a coffee, a weight or a night's sleep; a mood or a custom count of 0 is real.
      if (value === undefined || value === "" || (value === 0 && ["caffeine", "weight", "sleep"].includes(String(type)))) {
        const last = ctx.store.list({ kind: "log", where: { type: type ?? "" }, limit: 100000 })
          .filter((l) => l.fields.note !== "end" && typeof l.fields.at === "string")
          .sort((x, y) => String(y.fields.at).localeCompare(String(x.fields.at)))[0];
        if (!last) return Promise.resolve({ error: `no earlier ${type} log to repeat; ask {{owner}} for the amount` });
        value = last.fields.value;
        unit = unit ?? (last.fields.unit as string | undefined);
      }
      // Sleep is kept in minutes, as Apple Health sends it. Hours were stored with no unit and read as minutes (7 h
      // showed as 7 minutes); a number without a minutes unit is hours.
      if (type === "sleep" && typeof value === "number") {
        if (!/^(m|min|mins|minutes?)$/i.test(unit ?? "")) value = Math.round(value * 60);
        unit = "min";
      }
      // Caffeine is kept in cups; more than 20 with no unit can only be milligrams (the hub turns mg into cups).
      if (type === "caffeine" && typeof value === "number" && !unit && value > 20) unit = "mg";
      // Only note "end" closes an activity; the model also wrote "ended", "stopped" or "done".
      const note = type === "activity" && /^\s*(end|ended|ending|stop|stopped|done|finished|over)\.?\s*$/i.test(str(a.note) ?? "") ? "end" : str(a.note);
      return call(api, "POST", "/log", { type, value, unit, note });
    },
  },
  {
    name: "log_pet", writes: true,
    description: "Record something about {{pet}}: vet, med, incident, weight, food or note, with an optional note, cost and next due date.",
    parameters: { type: "object", properties: { type: { type: "string", enum: ["vet", "med", "incident", "weight", "food", "note"] }, note: { type: "string" }, cost: { type: "number" }, next_due: { type: "string" } }, required: ["type"] },
    run: async (api, a) => call(api, "POST", "/entities", { kind: "pet_event", fields: { pet: await petName(api), type: normalize(a.type, PET_TYPES), at: new Date().toISOString(), ...(str(a.note) ? { note: str(a.note) } : {}), ...(num(a.cost) !== undefined ? { cost: num(a.cost) } : {}), ...(str(a.next_due) ? { next_due: str(a.next_due) } : {}) } }),
  },
  {
    name: "toggle_checklist_item", writes: true,
    description: "Tick or untick one item on a checklist by its 0-based index. Read the checklist first with get_item.",
    parameters: { type: "object", properties: { id: { type: "string" }, index: { type: "number" } }, required: ["id", "index"] },
    run: (api, a) => call(api, "POST", `/checklists/${encodeURIComponent(str(a.id) ?? "")}/toggle`, { index: num(a.index) }),
  },
  {
    name: "music_idea", writes: true,
    description: "Save a music idea from one line, e.g. 'Am F C G 6/8 112bpm drop D'. project: the music project it belongs to, by name (list_items kind=project shows them; music ones have area music).",
    parameters: { type: "object", properties: { text: { type: "string" }, project: { type: "string" } }, required: ["text"] },
    run: async (api, a, ctx) => {
      const name = str(a.project)?.trim().toLowerCase();
      let project_id: string | undefined;
      if (name) {
        const projects = ctx.store.list({ kind: "project", space: "personal", limit: 1000 }).filter((p) => !p.deleted_at);
        const music = projects.filter((p) => p.fields.area === "music");
        const hit = music.find((p) => String(p.fields.name).toLowerCase() === name) ?? music.find((p) => String(p.fields.name).toLowerCase().includes(name)) ?? projects.find((p) => String(p.fields.name).toLowerCase() === name);
        if (!hit) return { error: `no music project named ${str(a.project)}`, music_projects: music.map((p) => p.fields.name) };
        project_id = hit.id;
      }
      return call(api, "POST", "/music/quick", { text: str(a.text), ...(project_id ? { project_id } : {}) });
    },
  },
  // ---------- memory ----------
  {
    name: "remember", writes: true,
    description: "Save a fact about {{owner}} so it is never asked again: something they state about themself, their preferences, constraints, health, people, hosts, projects or gear. Use the same key to update an existing fact. Call it whenever {{owner}} tells you something lasting, or says 'remember'. category: identity|constraint|preference|health|relationship|host|project|gear|history. key is short (e.g. 'coffee', 'host:storage'). private=true keeps it off cloud models.",
    parameters: { type: "object", properties: { category: { type: "string", enum: ["identity", "constraint", "preference", "health", "relationship", "host", "project", "gear", "history"] }, key: { type: "string" }, value: { type: "string" }, private: { type: "boolean" }, person: { type: "string", description: "who the fact is about (a name or person id), when it is about someone else" } }, required: ["category", "key", "value"] },
    run: async (api, a, ctx) => {
      const key = str(a.key)?.slice(0, 80);
      const value = str(a.value);
      if (!key || !value) return { error: "key and value are required" };
      // About someone: linked to them in People when they are there, else kept with their name.
      const who = str(a.person);
      const p = who ? resolvePerson(ctx.store, who) : null;
      // The same key about the same subject is the same fact: Jamie's "likes" never overwrites Devon's or the owner's.
      const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
      const sameSubject = (f: Entity) => p ? f.fields.person_id === p.id || (!f.fields.person_id && lower(f.fields.person) === lower(p.fields.name))
        : who ? !f.fields.person_id && lower(f.fields.person) === lower(who)
        : !f.fields.person_id && !f.fields.person;
      // A key is one fact within its category (the contract): health "coffee" never overwrites preference "coffee".
      const existing = ctx.store.list({ kind: "fact", limit: 100000 }).find((f) => factKey(f.fields.key) === factKey(key) && String(f.fields.category ?? "") === String(str(a.category) ?? "") && sameSubject(f));
      const fields = { category: str(a.category), key, value, source: "assistant", ...(a.private === true ? { private: true } : {}), ...(p ? { person_id: p.id, person: String(p.fields.name) } : who ? { person: who } : {}) };
      return existing
        ? { updated: true, ...(await call(api, "PATCH", `/entities/${existing.id}`, { fields }) as object) }
        : { created: true, ...(await call(api, "POST", "/entities", { kind: "fact", fields }) as object) };
    },
  },
  {
    name: "people", writes: false, maxChars: 8000,
    description: "Look up people in {{owner}}'s contacts (synced both ways with Apple Contacts): phones, emails, addresses, birthday, anniversaries and other dates, company, how {{owner}} knows them, everything remembered about them, and (for one person) the plans, diary days and notes that mention them. Use it whenever {{owner}} mentions someone by name, before saving anything about them.",
    parameters: { type: "object", properties: { query: { type: "string", description: "a name, nickname, company or email; empty lists everyone" }, id: { type: "string" } } },
    run: async (_api, a, ctx) => {
      const list = str(a.id) ? [ctx.store.get(str(a.id)!)].filter((e): e is NonNullable<typeof e> => !!e && e.kind === "person" && !e.deleted_at) : findPeople(ctx.store, str(a.query) ?? "").slice(0, 25);
      // One person found: also the plans, diary days, notes and places that mention them, newest first.
      // A note (a diary day above all) comes with the lines that name them: "Priya is starting at Northwind" sat in a
      // diary day listed only by its date, and the model said nothing mentioned her job.
      const seen = (p: Entity) => list.length === 1 ? relatedItems(ctx.store, p.id, 15).filter((r) => r.why === "Mentions them" && r.kind !== "fact").map((r) => ({ id: r.id, kind: r.kind, title: r.title, updated: r.at.slice(0, 10), ...(r.lines ? { lines: r.lines } : {}) })) : undefined;
      return { people: list.map((p) => ({ id: p.id, ...p.fields, apple: undefined, known: factsAbout(ctx.store, p).map((f) => ({ id: f.id, key: f.fields.key, value: f.fields.value })), mentioned_in: seen(p) })) };
    },
  },
  {
    name: "merge_people", writes: true,
    description: "Merge duplicate contacts into one: keep is the person to keep (usually the one with the fuller name), merge the duplicates' ids from people. Their phones, emails, addresses, dates and facts move to the kept person, and the duplicates' Apple cards are removed once the kept card holds everything. Only for the same person or company, when {{owner}} asks or two entries are clearly the same.",
    parameters: { type: "object", properties: { keep: { type: "string" }, merge: { type: "array", items: { type: "string" } } }, required: ["keep", "merge"] },
    run: (api, a) => call(api, "POST", "/people/merge", { keep: str(a.keep), merge: Array.isArray(a.merge) ? a.merge.map(String) : [] }),
  },
  {
    name: "save_person", writes: true,
    description: "Add or change a contact (it reaches Apple Contacts). Give id to change someone found with people; without id it updates the one clear name match or adds a new person. phones, emails, addresses and dates ADD to what is there (same value, or for dates the same label, updates it); replace=true makes the phones, emails or addresses given take the place of the old ones, for a NEW number, email or address (\"his new number is...\"). Only save details {{owner}} actually gave. For likes, habits and other things about them use remember with person=.",
    parameters: { type: "object", properties: {
      id: { type: "string" }, name: { type: "string" }, given_name: { type: "string" }, family_name: { type: "string" }, nickname: { type: "string" },
      organization: { type: "string" }, job_title: { type: "string" }, birthday: { type: "string", description: "YYYY-MM-DD, or --MM-DD without a year" }, relationship: { type: "string" },
      phones: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
      emails: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
      addresses: { type: "array", items: { type: "object", properties: { label: { type: "string" }, street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } } },
      dates: { type: "array", description: "anniversaries and other dates to remember about them", items: { type: "object", properties: { label: { type: "string", description: "anniversary, or what the date is" }, date: { type: "string", description: "YYYY-MM-DD, or --MM-DD without a year" } }, required: ["date"] } },
      replace: { type: "boolean", description: "the phones, emails or addresses given replace the old ones (a new number, not another one)" },
    } },
    run: async (api, a, ctx) => {
      const current = str(a.id) ? ctx.store.get(str(a.id)!) : str(a.name) ? resolvePerson(ctx.store, str(a.name)!) : null;
      if (str(a.id) && (!current || current.kind !== "person")) return { error: "no person with that id" };
      const set: Record<string, unknown> = {};
      for (const k of ["name", "given_name", "family_name", "nickname", "organization", "job_title", "birthday", "relationship"]) if (str(a[k])) set[k] = str(a[k]);
      // A new number replaces the old one; another number is added beside it.
      const base = (k: string) => (a.replace === true ? undefined : current?.fields[k]);
      if (a.phones) set.phones = mergeList(base("phones"), a.phones, (x: any) => String(x.value).replace(/\D+/g, ""));
      if (a.emails) set.emails = mergeList(base("emails"), a.emails, (x: any) => String(x.value));
      if (a.addresses) set.addresses = mergeList(base("addresses"), a.addresses, addressKey);
      // The model often sends a birthday as a date labeled "birthday"; it belongs in the birthday field (Apple Contacts' birthday).
      const isBirthday = (x: any) => /^(birth ?day|bday|b-day|born)$/i.test(String(x?.label ?? "").trim());
      const given = Array.isArray(a.dates) ? (a.dates as any[]) : [];
      const bday = given.find(isBirthday);
      if (bday && !set.birthday && str(bday.date)) set.birthday = str(bday.date);
      const dates = given.filter((x) => !isBirthday(x));
      if (dates.length) set.dates = mergeList(current?.fields.dates, dates, (x: any) => String(x.label ?? x.date));
      if (current) {
        if (set.name && current.fields.name && current.fields.name !== set.name && !str(a.id)) delete set.name;
        return { updated: true, ...(await call(api, "PATCH", `/entities/${current.id}`, { fields: set }) as object) };
      }
      if (!set.name) set.name = [set.given_name, set.family_name].filter(Boolean).join(" ") || str(a.nickname);
      if (!set.name) return { error: "a new person needs a name" };
      return { created: true, ...(await call(api, "POST", "/entities", { kind: "person", fields: set }) as object) };
    },
  },
  {
    name: "forget", writes: true,
    description: "Delete a saved fact that is wrong or no longer true. Find its id with list_items kind=fact. Only when {{owner}} asks.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async (api, a, ctx) => {
      const f = ctx.store.get(str(a.id) ?? "");
      if (!f || f.kind !== "fact") return { error: "no fact with that id" };
      return call(api, "DELETE", `/entities/${f.id}`);
    },
  },
  {
    name: "ledger_update", writes: true,
    description: "Troubleshooting memory for this conversation. Record what was tried and its result, what is ruled out (never suggest it again), and what {{owner}} confirmed. Call it whenever {{owner}} reports a result.",
    parameters: { type: "object", properties: { tried: { type: "array", items: { type: "object", properties: { what: { type: "string" }, result: { type: "string" } }, required: ["what", "result"] } }, ruled_out: { type: "array", items: { type: "string" } }, confirmed: { type: "array", items: { type: "string" } } } },
    run: async (_api, a, ctx) => {
      const ledger = openLedger(ctx.store, ctx.sessionId, ctx.topic);
      const tried = Array.isArray(ledger.fields.tried) ? [...(ledger.fields.tried as { at: string; what: string; result: string }[])] : [];
      for (const t of Array.isArray(a.tried) ? a.tried as { what?: unknown; result?: unknown }[] : []) {
        const what = str(t?.what); if (!what) continue;
        const pending = tried.findIndex((x) => x.result === "pending" && x.what.toLowerCase() === what.toLowerCase());
        if (pending >= 0) tried[pending] = { ...tried[pending], result: str(t.result) ?? "unknown" };
        else tried.push({ at: nowIso(), what, result: str(t.result) ?? "unknown" });
      }
      const add = (prev: unknown, more: unknown) => [...new Set([...(Array.isArray(prev) ? prev as string[] : []), ...(Array.isArray(more) ? (more as unknown[]).map(str).filter((x): x is string => !!x) : [])])];
      const next = ctx.store.patch(ledger.id, { tried, ruled_out: add(ledger.fields.ruled_out, a.ruled_out), confirmed: add(ledger.fields.confirmed, a.confirmed) });
      return { ledger_id: next.id, tried: next.fields.tried, ruled_out: next.fields.ruled_out, confirmed: next.fields.confirmed };
    },
  },
  {
    name: "runbook_note", writes: true,
    description: "Write what was learned or changed on a host into its fix notes (kind runbook, created if missing): IPs, ports, paths, how something is set up, the fix that worked. Only facts: something {{owner}} stated, a command output showed, or a fix that worked. Never a problem still being worked on, a guess, or your own suggested steps (those go in ledger_update). Plain markdown with a short heading.",
    parameters: { type: "object", properties: { host: { type: "string" }, heading: { type: "string" }, body: { type: "string" } }, required: ["host", "heading", "body"] },
    run: async (_api, a, ctx) => {
      const host = str(a.host)?.toLowerCase();
      if (!host || !str(a.body)) return { error: "host and body are required" };
      // While troubleshooting is open, a fix note needs the owner's word that something worked or how a host is set up:
      // the model wrote notes about problems still being worked on, with its own guesses in them.
      const open = ctx.store.list({ kind: "ledger", where: { session_id: ctx.sessionId } }).some((l) => l.fields.open !== false);
      if (open && !settled(ctx.lastUser)) return { error: "the problem is still open: record what was tried and found with ledger_update; write fix notes once {{owner}} says the fix worked or tells you how the host is set up" };
      const { runbook, created } = ensureRunbook(ctx.store, host);
      const key = `${ctx.sessionId}:${(str(a.heading) ?? "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
      const section = `## ${dayKey(new Date())}: ${str(a.heading) ?? "Note"}\n\n${str(a.body)}`;
      const next = ctx.store.patch(runbook.id, { body: upsertSection(String(runbook.fields.body ?? ""), key, section) });
      return { runbook_id: next.id, host, created_runbook: created };
    },
  },
  {
    name: "journal_entry", writes: true,
    description: "Record a change {{owner}} made themself on a host (commands you ran are journaled automatically). risk: low|medium|high. outcome: done|failed|reverted|planned.",
    parameters: { type: "object", properties: { host: { type: "string" }, what: { type: "string" }, command: { type: "string" }, risk: { type: "string", enum: ["low", "medium", "high"] }, rollback: { type: "string" }, outcome: { type: "string", enum: ["done", "failed", "reverted", "planned"] } }, required: ["host", "what"] },
    run: (api, a, ctx) => call(api, "POST", "/entities", { kind: "journal", fields: { host: str(a.host)?.toLowerCase(), at: nowIso(), what: str(a.what), risk: str(a.risk) ?? "medium", outcome: str(a.outcome) ?? "done", session_id: ctx.sessionId, ...(str(a.command) ? { command: str(a.command) } : {}), ...(str(a.rollback) ? { rollback: str(a.rollback) } : {}) } }),
  },

  // ---------- any kind ----------
  {
    name: "create_item", writes: true,
    // The per-kind field list is long and sent on every model call, so it comes back only with a failed create.
    description: "Create any other kind of item when no specific tool fits. Give fields with their usual names (title, name, body, start, end; times ISO 8601 with offset). If the hub rejects them, the error lists that kind's fields: fix and try once more. work=true puts a task or event in the work space.",
    parameters: { type: "object", properties: { kind: { type: "string", enum: [...ITEM_KINDS] }, fields: { type: "object" }, work: { type: "boolean" } }, required: ["kind", "fields"] },
    run: (api, a, ctx) => {
      const kind = str(a.kind);
      if (!kind || !(ITEM_KINDS as readonly string[]).includes(kind)) return Promise.resolve({ error: `kind must be one of ${ITEM_KINDS.join(", ")}` });
      const owner = moduleOfKind(kind);
      if (owner && ctx.moduleOn && !ctx.moduleOn(owner)) return Promise.resolve({ error: `${moduleDef(owner).title} is switched off (Settings, Modules), so there is no ${kind} to make; save it as a note or a task instead, or tell {{owner}} it can be switched on` });
      const fields = a.fields && typeof a.fields === "object" ? a.fields as Record<string, unknown> : {};
      // Midnight to midnight is a whole day: the model sometimes leaves out all_day and makes a 24 hour timed event.
      if (kind === "event" && fields.all_day === undefined && midnight(fields.start) && midnight(fields.end) && String(fields.end) > String(fields.start)) fields.all_day = true;
      return call(api, "POST", "/entities", { kind, space: a.work === true ? "work" : "personal", fields }).then((r) =>
        r && typeof r === "object" && "error" in r ? { ...r, fields_for_kind: `${kind}: ${kindFields(kind)} (? = optional)` } : r);
    },
  },
  {
    name: "update_item", writes: true,
    description: "Change fields on any saved item by id (only the fields given change). Read it first with get_item when unsure of the current values.",
    parameters: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] },
    run: (api, a, ctx) => {
      const fields = a.fields && typeof a.fields === "object" ? a.fields as Record<string, unknown> : {};
      // A body read through a list (cut at 1500 characters) must not be saved back over the full text.
      if (typeof fields.body === "string" && /\[cut, \d+ chars in full\]/.test(fields.body)) return Promise.resolve({ error: "that body was cut short; read the item with get_item and send the full text" });
      const id = encodeURIComponent(str(a.id) ?? "");
      // A clock time on an all-day plan ("make it 7pm") makes it a timed event: the model sent start and end and
      // left all_day true, so the plan stayed all day.
      const timed = [fields.start, fields.end].some((v) => typeof v === "string" && /T\d\d:\d\d/.test(v) && !midnight(v));
      // all_day alone on a timed event (a retitled plan) would stretch its hours over the day: the times stay unless
      // new day dates come with it.
      if (fields.all_day === true && fields.start === undefined && fields.end === undefined) {
        const cur = ctx.store.get(str(a.id) ?? "");
        if (cur?.kind === "event" && cur.fields.all_day !== true && !(midnight(cur.fields.start) && midnight(cur.fields.end))) delete fields.all_day;
      }
      if (fields.all_day === undefined && timed) {
        return call(api, "GET", `/entities/${id}`).then((cur) => {
          const e = cur as { kind?: string; fields?: Record<string, unknown> } | null;
          if (!(e?.kind === "event" && e.fields?.all_day === true)) {
            // A new start alone on a timed event keeps its length ("move it to 5"): the old end stayed, so it ran 5 to 4.
            const s0 = Date.parse(String(e?.fields?.start ?? "")), e0 = Date.parse(String(e?.fields?.end ?? "")), s1 = Date.parse(String(fields.start ?? ""));
            const keep = e?.kind === "event" && fields.end === undefined && [s0, e0, s1].every(Number.isFinite) && e0 > s0 ? { end: new Date(s1 + (e0 - s0)).toISOString() } : {};
            return call(api, "PATCH", `/entities/${id}`, { fields: { ...fields, ...keep } });
          }
          // A start alone keeps the old next-midnight end: the plan became 7 PM to midnight, or ended before it began.
          const end = fields.end === undefined && typeof fields.start === "string" && !Number.isNaN(Date.parse(fields.start)) ? { end: new Date(Date.parse(fields.start) + 3600_000).toISOString() } : {};
          return call(api, "PATCH", `/entities/${id}`, { fields: { ...fields, ...end, all_day: false } });
        });
      }
      return call(api, "PATCH", `/entities/${id}`, { fields });
    },
  },
  {
    name: "delete_item", writes: true,
    description: "Delete a saved item by id. Only when {{owner}} explicitly asks to delete or remove it.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (api, a) => call(api, "DELETE", `/entities/${encodeURIComponent(str(a.id) ?? "")}`),
  },

  // ---------- module actions ----------
  {
    name: "procedure", writes: true,
    description: "Guided step-by-step procedures (one step at a time, waits for done). action=start turns instructions into a procedure (text = the steps); action=done|back|reset moves an existing one (id).",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["start", "done", "back", "reset"] }, text: { type: "string" }, title: { type: "string" }, host: { type: "string" }, id: { type: "string" } }, required: ["action"] },
    run: (api, a) => {
      const action = str(a.action);
      if (action === "start") return call(api, "POST", "/procedures/from-text", { text: str(a.text), title: str(a.title), host: str(a.host) });
      const id = encodeURIComponent(str(a.id) ?? "");
      if (action === "reset") return call(api, "POST", `/procedures/${id}/reset`, {});
      return call(api, "POST", `/procedures/${id}/advance`, action === "back" ? { back: true } : { done: true });
    },
  },
  {
    name: "quiz", writes: true,
    description: "Tonight's recall quiz. action=today returns it; action=answer records a result (right|wrong|revealed) for item index.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["today", "answer"] }, id: { type: "string" }, index: { type: "number" }, result: { type: "string", enum: ["right", "wrong", "revealed"] } }, required: ["action"] },
    run: (api, a) => str(a.action) === "answer"
      ? call(api, "POST", `/quiz/${encodeURIComponent(str(a.id) ?? "")}/answer`, { index: num(a.index), result: str(a.result) })
      : call(api, "GET", "/quiz/today"),
  },
  {
    name: "render_snippet", writes: false,
    description: "Fill a saved snippet's {{params}} and return the ready command. Find snippets with search or list_items kind=snippet.",
    parameters: { type: "object", properties: { id: { type: "string" }, params: { type: "object" } }, required: ["id"] },
    run: (api, a) => call(api, "POST", `/snippets/${encodeURIComponent(str(a.id) ?? "")}/render`, { params: a.params && typeof a.params === "object" ? a.params : {} }),
  },
  {
    name: "ops_action", writes: true,
    description: "Homelab monitor actions: ack acknowledges an open incident (id, optional note); check runs one monitor now (id) and returns the result. The hub already checks every monitor on its own interval (ops_status shows when), so check only to confirm a fix or when {{owner}} asks for a fresh check, not to answer what is down; fresh=true to confirm a fix just made.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["ack", "check"] }, id: { type: "string" }, note: { type: "string" }, fresh: { type: "boolean", description: "run it now even if it was checked moments ago (to confirm a fix)" } }, required: ["action", "id"] },
    run: (api, a, ctx) => {
      if (str(a.action) !== "check") return call(api, "POST", `/incidents/${encodeURIComponent(str(a.id) ?? "")}/ack`, { note: str(a.note) });
      // Checked within the last two minutes: that result is current. The model re-ran every monitor to say what was down.
      const m = ctx.store.get(str(a.id) ?? "");
      const age = m?.kind === "monitor" && typeof m.fields.last_check === "string" ? Date.now() - Date.parse(m.fields.last_check) : Infinity;
      if (m && age < 120_000 && a.fresh !== true) return Promise.resolve({ id: m.id, name: m.fields.name, state: m.fields.state, checked_seconds_ago: Math.round(age / 1000), ...(m.fields.last_error ? { last_error: m.fields.last_error } : {}), ...(m.fields.last_latency_ms !== undefined ? { latency_ms: m.fields.last_latency_ms } : {}), note: "checked moments ago; this is the current result" });
      return call(api, "POST", `/monitors/${encodeURIComponent(str(a.id) ?? "")}/check`, {});
    },
  },
  {
    name: "sensors", writes: false,
    description: "Home sensors (plants, temperature, water): latest value, thresholds and state for each.",
    parameters: { type: "object", properties: {} },
    run: (api) => call(api, "GET", "/sensors"),
  },
  {
    name: "project_plan", writes: true,
    description: "Update a project's living plan document. Give only the sections that change: goal, current (state now), next (next steps), parts, log_line (one dated line appended to the log).",
    parameters: { type: "object", properties: { id: { type: "string" }, goal: { type: "string" }, current: { type: "string" }, next: { type: "string" }, parts: { type: "string" }, log_line: { type: "string" } }, required: ["id"] },
    run: (api, a) => {
      const sections: Record<string, string> = {};
      for (const k of ["goal", "current", "next", "parts", "log_line"]) if (str(a[k])) sections[k] = str(a[k])!;
      return call(api, "POST", `/projects/${encodeURIComponent(str(a.id) ?? "")}/plan`, { sections });
    },
  },
  {
    name: "cover_letter", writes: true,
    description: "Draft a cover letter in {{owner}}'s voice for a saved job application (id from list_items kind=application). Saves it as a note.",
    parameters: { type: "object", properties: { application_id: { type: "string" } }, required: ["application_id"] },
    run: (api, a) => call(api, "POST", `/applications/${encodeURIComponent(str(a.application_id) ?? "")}/cover-letter`, {}),
  },
  {
    name: "calculate", writes: false,
    description: "Exact money math. type=split {subtotal, tax_pct?, tip_pct?, people, shares?}; payoff {balance, apr_pct, payment? or months?}; unit {items:[{name?, price, qty, unit?}]} for price per unit; takehome {salary, frequency? weekly|biweekly|semimonthly|monthly, filing? single|married|head, state_pct?, k401_pct? or k401_amount? per paycheck, health? per paycheck, bonus?} for pay after US taxes.",
    parameters: { type: "object", properties: { type: { type: "string", enum: ["split", "payoff", "unit", "takehome"] }, input: { type: "object" } }, required: ["type", "input"] },
    run: (api, a) => {
      const type = str(a.type) ?? "split";
      if (!["split", "payoff", "unit", "takehome"].includes(type)) return Promise.resolve({ error: "type must be split, payoff, unit or takehome" });
      return call(api, "POST", `/calc/${type}`, a.input && typeof a.input === "object" ? a.input : {});
    },
  },
  {
    name: "checklist_from_template", writes: true,
    description: "Start a fresh checklist from a template (packing lists and the like). id from list_items kind=checklist with template=true.",
    parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id"] },
    run: (api, a) => call(api, "POST", `/checklists/${encodeURIComponent(str(a.id) ?? "")}/instantiate`, str(a.title) ? { title: str(a.title) } : {}),
  },
  {
    name: "draft_in_my_voice", writes: false, maxChars: 12000,
    description: "Write something as {{owner}} would write it themself (message, email, post, review, lyric, letter). Returns the draft; show it to them as is.",
    parameters: { type: "object", properties: { request: { type: "string", description: "what to write, for whom, and the key points" } }, required: ["request"] },
    run: async (_api, a, ctx) => {
      if (!ctx.draft) return { error: "drafting is not available" };
      const out = await ctx.draft(str(a.request) ?? "");
      return out ? { draft: out.text, written_by: out.backend === "adapter" ? "{{owner}}'s voice model" : out.model } : { error: "no model answered" };
    },
  },

  // ---------- web ----------
  {
    name: "phone_photos", writes: false, maxChars: 3000,
    description: "Look at recent photos in {{owner}}'s iPhone photo library. Use it when {{owner}} asks about their photos, camera roll or pictures on the phone. It works only from the iPhone app with Full photo library access on (Settings, Images); otherwise say how to turn it on. You then see the photos themselves; describe what is actually in them and never invent details.",
    parameters: { type: "object", properties: { count: { type: "number", description: "how many of the newest photos, 1 to 6 (default 4)" }, since_days: { type: "number", description: "only photos from the last N days" } } },
    run: async (_api, a, ctx) => {
      // A cloud model never sees the photo library: photos stay between the phone, the hub and its own model.
      if (ctx.cloud) return { error: "Photos from the phone are shown only to the model on your own hub, never to a cloud model. Ask again with the local model, or attach the picture yourself." };
      if (!ctx.askDevicePhotos) return { error: "This device did not offer its photo library. On the iPhone, turn on Settings, Images, Full photo library access, then ask again from the iPhone app." };
      const count = Math.min(Math.max(Math.round(num(a.count) ?? 4), 1), 6);
      let photos: DevicePhoto[];
      try { photos = await ctx.askDevicePhotos(count, num(a.since_days)); } catch (e) { return { error: (e as Error).message }; }
      if (!photos.length) return { photos: 0, note: "The phone sent no photos (none in that range, or access was refused)." };
      const ids: string[] = [];
      for (const p of photos) {
        try { const id = ctx.saveImage?.(p.b64); if (id) { ids.push(id); ctx.addImage?.(id); } } catch { /* skip an unreadable photo */ }
      }
      const list = photos.map((p, i) => `${i + 1}. taken ${p.taken_at ?? "unknown"}${p.width ? `, ${p.width} x ${p.height}` : ""}`).join("; ");
      ctx.showModel?.(`The ${photos.length} newest photos from {{owner}}'s iPhone, in order: ${list}.`, photos.map((p) => p.b64));
      return { photos: photos.length, order: list, shown_under_reply: ids.length };
    },
  },
  {
    name: "generate_image", writes: true, maxChars: 3000,
    available: (cfg) => !!cfg.imageServiceUrl && !!cfg.imageServiceToken,
    description: "Make or edit an image on the local GPUs (the shared image service; never a cloud service). Pass {{owner}}'s words as prompt; keep counts, exclusions (\"no vegetation\") and layout in it. Only set width/height/aspect/realism/seamless/hardware when {{owner}} asked for them. To edit an image {{owner}} attached, use operation edit with reference \"attached\". It waits up to about two minutes; if it is still queued or running, say why (the status) and that it will appear in Images. If it fails or is refused, say exactly what the service said; never claim an image you did not get.",
    parameters: { type: "object", properties: {
      prompt: { type: "string" }, operation: { type: "string", enum: ["generate", "edit"] }, reference: { type: "string", description: "\"attached\" for the image in this message, or a hub image id" },
      width: { type: "number" }, height: { type: "number" }, aspect: { type: "string", description: "1:1, 4:3, 3:2, 16:9, 9:16 or W:H" },
      realism: { type: "number", description: "0 stylized, 50 naturalistic, 100 photographic; omit to follow the prompt" },
      seamless: { type: "string", enum: ["off", "x", "y", "xy"] }, transparent: { type: "boolean" }, count: { type: "number" },
      quality: { type: "string", enum: ["auto", "fast", "best"] }, hardware: { type: "string", enum: ["auto"] }, seed: { type: "number" },
    }, required: ["prompt"] },
    // The workers one may name come from EA_IMAGE_WORKERS; with none set, Auto is the only choice.
    configure: (cfg) => {
      const p = TOOLS.find((t) => t.name === "generate_image")!.parameters;
      return { ...p, properties: { ...p.properties, hardware: { type: "string", enum: ["auto", ...cfg.imageWorkers.map((w) => w.id)] } } };
    },
    run: async (api, a, ctx) => {
      const ref = str(a.reference);
      const refId = ref === "attached" ? ctx.userImages?.[0] : ref;
      if (ref && !refId) return { error: "no image is attached to this message" };
      const req: Record<string, unknown> = { prompt: str(a.prompt) ?? "", operation: str(a.operation) ?? (refId ? "edit" : "generate"), ...(refId ? { references: [refId] } : {}) };
      for (const k of ["width", "height", "realism", "count", "seed"]) if (num(a[k]) !== undefined) req[k] = Math.round(num(a[k])!);
      for (const k of ["aspect", "seamless", "quality", "hardware"]) if (str(a[k])) req[k] = str(a[k]);
      if (a.transparent === true) req.transparent = true;
      const made = await api("POST", "/images/jobs", req);
      if (made.status >= 300) return { error: (made.data as any)?.error ?? "refused", detail: (made.data as any)?.detail };
      let jobs = (made.data as any).jobs as any[];
      const deadline = Date.now() + 120_000;
      let last = "";
      while (Date.now() < deadline && jobs.some((j) => j.status === "queued" || j.status === "running" || (j.status === "succeeded" && !j.image_id))) {
        await new Promise((r) => setTimeout(r, 2000));
        jobs = await Promise.all(jobs.map(async (j) => (j.status === "failed" || j.status === "canceled" || j.image_id) ? j : (await api("GET", `/images/jobs/${j.id}`)).data as any));
        const label = jobs.map((j) => j.status_label).join("; ");
        if (label !== last) { ctx.onStatus?.(label); last = label; }
      }
      for (const j of jobs) if (j.image_id) ctx.addImage?.(j.image_id);
      const p = jobs[0]?.plan ?? {};
      return {
        jobs: jobs.map((j) => ({ id: j.id, status: j.status, status_label: j.status_label, error: j.error ?? undefined, image_shown: !!j.image_id,
          seconds: j.measured?.total_seconds, worker: j.measured?.worker })),
        workflow: p.workflow, size: p.output ? `${p.output.width} x ${p.output.height}` : undefined, notes: p.notes, routing: p.routing_reason,
        prompt_used: p.prompt_adapted ? p.prompt_expanded : undefined,
      };
    },
  },
  {
    name: "web_search", writes: false,
    available: (cfg) => !!cfg.searxngUrl && webPrivate(cfg),
    description: "Search the web through the hub's own SearXNG (the search engines it uses see the words, so search only for what {{owner}} asked about, never for their private details). Use it for anything current, version numbers, docs, prices, news, or anything you are not sure of. Then read_web_page the best result before answering, and name the source.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    run: async (_api, a, ctx) => {
      if (!webPrivate(ctx.cfg)) return { error: NO_TOR };
      try { return await webSearch(ctx.cfg.searxngUrl, str(a.query) ?? "", Math.min(num(a.limit) ?? 8, 15)); } catch (e) { return { error: (e as Error).message }; }
    },
  },
  {
    name: "read_web_page", writes: false, maxChars: 14000,
    available: (cfg) => cfg.webFetch && webPrivate(cfg),
    description: "Read a web page as plain text (docs, articles, release notes, forum threads). Use after web_search or when {{owner}} gives a link.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async (_api, a, ctx) => {
      try { return await fetchPage(str(a.url) ?? "", 12_000, 20_000, ctx.cfg.torSocks, ctx.cfg.webWithoutTor); } catch (e) { return { error: (e as Error).message }; }
    },
  },

  // ---------- hosts ----------
  {
    name: "list_hosts", writes: false,
    available: (cfg) => cfg.hostActions,
    description: "Machines you can run commands on, with their OS and how they are reached.",
    parameters: { type: "object", properties: {} },
    run: async (_api, _a, ctx) => ctx.hosts ? { hosts: ctx.hosts.hosts().map((h) => ({ name: h.name, os: h.os, via: h.via, aliases: h.aliases.filter((x) => x !== h.name) })) } : { error: "host commands are off" },
  },
  {
    name: "list_secrets", writes: false,
    available: (cfg) => cfg.hostActions,
    description: "Find password manager items you may use in run_command, by a word in their name (never their values). Use it before asking {{owner}} for a password.",
    parameters: { type: "object", properties: { query: { type: "string", description: "a word in the item's name, like router or ssh" } } },
    run: async (api, a) => {
      const pm = await call(api, "GET", "/connections/password-manager") as { linked?: boolean; access?: string; allowed?: string[] };
      if (!pm.linked) return { error: "no password manager is linked; {{owner}} links one in Settings, Connections" };
      const usage = "Write {{secret:Name}} (or {{secret:Folder/Name}} when two items share a name, and {{secret:Name/username}} for another field) in a run_command command where the value goes, without quotes. The hub fills it in, quoted, only when the command runs after {{owner}} approves it; you never see the value and it is cut from the output.";
      const query = typeof a.query === "string" ? a.query.trim() : "";
      if (pm.access === "chosen") {
        if (!pm.allowed?.length) return { secrets: [], note: "{{owner}} has not chosen any items yet (Settings, Connections, Password manager)" };
        return { secrets: pm.allowed.filter((n) => !query || n.toLowerCase().includes(query.toLowerCase())), usage };
      }
      if (!query) return { note: "Every item except the ones {{owner}} excluded may be used. Search with a word from its name (query).", usage };
      const r = await call(api, "GET", `/connections/password-manager/items?q=${encodeURIComponent(query)}`) as { items?: string[] };
      return { secrets: r.items ?? [], usage, ...(r.items?.length === 40 ? { note: "Only the first 40: search with a longer word." } : {}) };
    },
  },
  {
    name: "run_command", writes: true, maxChars: 9000, cutMiddle: true,
    available: (cfg) => cfg.hostActions,
    description: "Run a shell command on one of {{owner}}'s machines (list_hosts). Windows hosts take PowerShell. Read-only commands (status, logs, listing, df, ping, Get-*) run at once. Anything that changes the system is held for {{owner}}'s approval: after calling, show them the exact command and why, then stop and wait. Never use sudo unless they say it works without a password. Always give purpose, and rollback for a change.",
    parameters: { type: "object", properties: { host: { type: "string" }, command: { type: "string" }, purpose: { type: "string", description: "one line: why" }, rollback: { type: "string", description: "how to undo it, for changes" } }, required: ["host", "command", "purpose"] },
    run: async (_api, a, ctx) => {
      if (!ctx.hosts) return { error: "host commands are off" };
      const host = ctx.hosts.host(str(a.host) ?? "");
      if (!host) return { error: `unknown host; known: ${ctx.hosts.hosts().map((h) => h.name).join(", ")}` };
      const command = str(a.command);
      if (!command) return { error: "command is required" };
      const purpose = str(a.purpose) ?? "";
      if (isReadOnly(command, host.os)) {
        const r = await ctx.hosts.runRead(ctx.sessionId, host, command, purpose);
        return { host: host.name, exit_code: r.exit_code, timed_out: r.timed_out || undefined, output: r.output || "(no output)" };
      }
      // One approval runs one change: a new one proposed in the same reply would have its card come with the result,
      // and an "ok" to that result would approve it unseen. It is proposed in a later reply.
      const turn = turnOf(ctx);
      if (turn.ran.length) return { error: "a change already ran in this reply: tell {{owner}} its result first; propose the next change in a later reply, after they answer" };
      const action = ctx.hosts.propose(ctx.sessionId, host, command, purpose, str(a.rollback) ?? null);
      turn.proposed.add(action.id);
      const approval = approvalOf({ id: action.id, host: host.name, command, purpose });
      ctx.onApproval?.(approval);
      return { status: "waiting_for_approval", action_id: action.id, host: host.name, command, risk: approval.risk, ...(approval.preflight ? { preflight: approval.preflight } : {}), instruction: "Not run yet. Tell {{owner}} exactly what this will do, then stop. It runs only after they approve." };
    },
  },
  {
    name: "approve_command", writes: true, maxChars: 9000, cutMiddle: true,
    available: (cfg) => cfg.hostActions,
    description: "Run the command that is waiting for approval in this conversation, after {{owner}} has just said yes to it. Never call it unless their latest message approves it.",
    parameters: { type: "object", properties: {} },
    run: async (_api, _a, ctx) => {
      if (!ctx.hosts) return { error: "host commands are off" };
      const pending = ctx.hosts.pendingFor(ctx.sessionId);
      if (!pending) return { error: "nothing is waiting for approval" };
      // The yes must be to a change {{owner}} saw: one proposed before their message, not in this reply.
      const turn = turnOf(ctx);
      if (turn.proposed.has(pending.id) || pending.created_at >= turn.startedAt) return { error: "that change was proposed in this reply, so {{owner}} has not seen it: show them the exact command and stop; it runs after their next yes" };
      if (!AFFIRMATION.test(ctx.lastUser)) return { error: "{{owner}}'s latest message is not a clear yes; ask them to approve" };
      try {
        const out = await ctx.hosts.approve(pending.id);
        turn.ran.push(out.action.command);
        return { host: out.action.host, command: out.action.command, exit_code: out.result.exit_code, timed_out: out.result.timed_out || undefined, status: out.action.status, output: out.result.output || "(no output)", journaled: out.journal.id };
      } catch (e) { return { error: (e as Error).message }; }
    },
  },
];

/** The module each tool belongs to (any one of a list); a tool not named here is part of the core. */
export const TOOL_MODULE: Record<string, ModuleId | ModuleId[]> = {
  dashboard: "dashboard",
  ops_status: "homelab", ops_action: "homelab", list_hosts: "homelab", run_command: "homelab", approve_command: "homelab",
  runbook_note: "homelab", journal_entry: "homelab", render_snippet: "homelab", list_secrets: "homelab",
  project_summary: "projects", project_plan: "projects", procedure: "projects",
  music_idea: "music", wiki_search: "wiki", wiki_page: "wiki", generate_image: "images", quiz: "quiz",
  health_summary: "health", set_injection_day: "health", pet_summary: "pet", log_pet: "pet",
  pick_food: "food", food_chosen: "food", sensors: "sensors", pick_game: "games", calculate: "calc", cover_letter: "jobs",
  library: ["games", "films", "jobs", "renewals"], web_search: "web", read_web_page: "web",
};

/** Whether a tool's module is on (a core tool always is). */
export function toolOn(name: string, on: ModuleCheck = () => true): boolean {
  const m = TOOL_MODULE[name];
  return !m || (Array.isArray(m) ? m.some(on) : on(m));
}

export function availableTools(cfg: Config | null, tools: ToolDef[] = TOOLS, on: ModuleCheck = () => true): ToolDef[] {
  return tools.filter((t) => (!t.available || (cfg ? t.available(cfg) : false)) && toolOn(t.name, on))
    .map((t) => (cfg && t.configure ? { ...t, parameters: t.configure(cfg) } : t));
}

export function toolSpecs(tools: ToolDef[] = TOOLS): ToolSpec[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Run one call. Never throws: errors go back to the model as data so it can recover or explain. */
/**
 * A tool result for a cloud model: every work-space item and every private fact taken out (work never leaves the
 * owner's machines; a private fact is never sent to a cloud model). Their text is also scrubbed from every message
 * at the cloud boundary (`guarded` in ai/index.ts); this keeps whole items out where the structure shows them.
 */
export function withoutWork(v: unknown): unknown {
  const isWork = (x: unknown) => !!x && typeof x === "object" && ((x as { space?: unknown }).space === "work" || (x as { work?: unknown }).work === true);
  const isPrivate = (x: unknown) => !!x && typeof x === "object" && ((x as { private?: unknown }).private === true || (x as { fields?: { private?: unknown } }).fields?.private === true);
  if (isWork(v)) return { error: "that item is in the work space, which is never sent to a cloud model" };
  if (isPrivate(v)) return { error: "that fact is private, which is never sent to a cloud model" };
  const keep = (y: unknown) => !isWork(y) && !isPrivate(y);
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.filter(keep).map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => keep(y)).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v);
}

/**
 * A write a cloud model asks for on a work item (work=true, space work, or the id of one): refused before it is made,
 * so the reply never says it failed when it was done (the item came back hidden as an error after the write).
 */
/** What never reaches a cloud model as text: private fact values and the titles of work tasks and meetings. */
export function cloudSecrets(store: Store): string[] {
  const priv = store.list({ kind: "fact", limit: 100000 }).filter((f) => f.fields.private === true).map((f) => String(f.fields.value ?? ""));
  const work = ["task", "event"].flatMap((kind) => store.list({ kind, space: "work", limit: 100000 })).map((e) => String(e.fields.title ?? ""));
  return [...priv, ...work].map((x) => x.trim()).filter((x) => x.length >= 4);
}

/**
 * A write to an item that was deleted: the hub keeps the tombstone (for sync), so the change went in and the item
 * stayed deleted while the reply said it moved. Refused, so the model says so or makes a new one.
 */
function deletedTarget(name: string, args: Record<string, unknown>, ctx: ToolContext): string | null {
  for (const k of ["id", "task_id", "item_id", "event_id"]) {
    const id = args[k];
    if (typeof id !== "string") continue;
    const e = ctx.store.get(id);
    if (e?.deleted_at) return name === "delete_item" ? "that item was already deleted" : "that item was deleted, so it cannot be changed; make a new one if {{owner}} wants it back";
  }
  return null;
}

/**
 * A write that adds, changes or deletes one of the owner's standing rules, when their latest message did not ask for
 * that. Rules marked prompt ride in every system prompt and filter patterns run on every reply, so a web page, wiki
 * page, mail or invite that steers the model must not be able to plant one: only the owner changes them.
 */
function ruleWrite(name: string, args: Record<string, unknown>, ctx: ToolContext): string | null {
  const isRule = (name === "create_item" && str(args.kind)?.toLowerCase() === "rule")
    || ["id", "task_id", "item_id", "event_id"].some((k) => typeof args[k] === "string" && ctx.store.get(args[k] as string)?.kind === "rule");
  if (!isRule || ruleChangeAsked(ctx.lastUser)) return null;
  return "{{owner}}'s latest message does not ask to add, change or remove a standing rule, and only {{owner}} changes those. Nothing was saved; say what rule you would make or change and ask them";
}

function cloudWorkWrite(args: Record<string, unknown>, ctx: ToolContext): string | null {
  if (args.work === true || args.space === "work") return "work items are made and changed only by the local model; ask again with the cloud off";
  for (const k of ["id", "task_id", "item_id", "event_id"]) {
    const id = args[k];
    if (typeof id === "string" && ctx.store.get(id)?.space === "work") return "that item is in the work space, which a cloud model never changes";
  }
  return null;
}

export async function runTool(api: ApiCall, call: ToolCall, ctx: ToolContext, tools: ToolDef[] = TOOLS): Promise<{ text: string; ok: boolean; writes: boolean }> {
  const t = tools.find((x) => x.name === call.name);
  if (!t) return { text: JSON.stringify({ error: `no tool named ${call.name}; available: ${tools.map((x) => x.name).join(", ")}` }), ok: false, writes: false };
  let args = call.arguments as unknown;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  try {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const refused = t.writes ? deletedTarget(t.name, a, ctx) ?? ruleWrite(t.name, a, ctx) ?? (ctx.cloud ? cloudWorkWrite(a, ctx) : null) : null;
    if (refused) return { text: JSON.stringify({ error: refused }), ok: false, writes: false };
    const raw = await t.run(api, a, ctx);
    const out = ctx.cloud ? withoutWork(raw) : raw;
    const ok = !(out && typeof out === "object" && "error" in (out as object));
    const waiting = !!(out && typeof out === "object" && (out as { status?: string }).status === "waiting_for_approval");
    // Text that carries them with no mark on it (the digest's "Calendar:" line, a person's notes) is scrubbed too.
    const text = renderResult(out, t.maxChars, t.cutMiddle);
    return { text: ctx.cloud ? cloudScrubber(cloudSecrets(ctx.store))(text) : text, ok, writes: t.writes && !waiting };
  } catch (e) {
    return { text: JSON.stringify({ error: (e as Error).message }), ok: false, writes: t.writes };
  }
}

/** Appended to the system prompt when tools are offered. Gives the model the clock and the rules of use. */
export function toolGuide(on: ModuleCheck = () => true): string {
  // Only what is switched on (Settings, Modules) is named, so the model never reaches for a module that is off.
  const areas = ["today, the week, tasks, reminders, notes", on("health") && "health", on("pet") && "{{pet}}", on("projects") && "projects", on("music") && "music", "lists", on("jobs") && "job applications", on("games") && "games", on("films") && "films", on("homelab") && "the homelab"].filter(Boolean).join(", ");
  const ranked = [on("games") && "games", on("films") && "films", on("jobs") && "job applications"].filter(Boolean).join(", ");
  return [
    "The date and time are in the context note at the top of {{owner}}'s newest message. Every time in tool results is already local time with its offset; say times as {{owner}}'s local time (for example 9:00 AM). Write every time you pass to a tool as ISO 8601 with that offset. Never work out a weekday yourself: use the weekdays given in tool results and the context note, and write a date without one when none is given.",
    "You are {{owner}}'s assistant for everything: their own data and modules, their machines, the web, and general questions. You have tools; use them instead of guessing or telling them to do things themself.",
    `Their data: for anything about ${areas}, call the matching tool first (${ranked ? `library for ranked ${ranked}; ` : ""}inbox for Unsorted Info, the captures waiting to be sorted; app_status for the app itself, its devices and connections; metrics for trends and charts over time). When they ask you to add, log, remind, schedule, finish, save or change something, do it with the tool, then say in one short sentence what changed. Do not ask for confirmation for these. When they say a plan was cancelled or is off, delete that event with delete_item and say so; \"delete that\" or \"never mind\" about something just made deletes it with delete_item (not park or done). A time that has already passed today (\"8 tonight\" said at 11 PM) goes to the same time tomorrow; say so. When they say they are starting or stopping something they do for a while (\"starting on soldering the ESP32\", \"done with guitar\"), log it with log_health type=activity and a short name (\"soldering\"), and to stop it the same name with note=end; say so in one sentence and give no advice unless they ask. When they ask what to do or work on next, lead with the task in progress or first in line (get_today's now), then anything due soon. When they say they did something that matches an open task (\"picked up the HDMI cable\", \"called the vet\"), find it (list_items kind=task, or search) and mark it done with update_task, then say so; ask only when two open tasks could be meant.`,
    "Diary: every quick capture {{owner}} makes is a timestamped line in a daily note at Diary/YYYY-MM-DD.md (what they did, ate, planned, thought); a capture before 4 AM goes to the day before. For recall questions (when did I last..., what did I do on..., how often...) use the diary tool (with a query for a word, a person or a place); quote the date and time you found. The diary is the record of when {{owner}} wrote each line: never change a diary note's path or title and never move or reword its lines. When {{owner}} says something happened on another day, put it on that day's calendar (an all-day event) instead.",
    "People: {{owner}}'s contacts are in People (two-way with Apple Contacts). When someone is named, look them up with people. Contact details {{owner}} gives (address, phone, email, birthday, anniversary or another date to remember, where they work) go to save_person; likes, habits, history and anything else about them go to remember with person=their name, so they show on that person.",
    "Plans: when {{owner}} mentions a plan on a day (going somewhere, seeing someone, an appointment), put it on their calendar with create_item kind=event right away, then say so in one sentence; they can tell you to drop it. Name who they are with in the title. Block time only when {{owner}} gave it: a clock time or range is a timed event (a start time alone gets one hour, and say so); a block they ask for (\"block the evening\") is that block. A plan with only a day or a part of the day (tonight, Saturday, this afternoon) is an all-day event on that date (all_day true, start that day at 00:00, end the next day at 00:00, both with the local offset) with the part of the day in the title (\"Tonight: dinner at Luigi's with Jamie\"); it marks the day without blocking any time. Never invent a time. Something {{owner}} already did on a day (an outing, seeing people) goes on the calendar the same way, as an all-day event on the day it happened. When that day already has the same plan or outing (get_week shows it), change that event's title with update_item (keeping its times) instead of adding a second one.",
    "Memory: when {{owner}} tells you something lasting about themself, their gear, their hosts or their preferences, save it with remember without being asked, then confirm in a few words what you saved; do not start a conversation about it. In troubleshooting, record each result with ledger_update and never suggest anything listed as ruled out." + (on("homelab") ? " When a troubleshooting fix works, or {{owner}} tells you how a host is set up, write it with runbook_note; never for something you only looked up to answer a question. {{owner}} calls these fix notes (the Machines screen), so say fix notes, not runbook." : ""),
    on("web") && "Facts you do not know: search the web (web_search, then read_web_page on the best result) instead of answering from memory when it is about versions, releases, docs, prices, news, or anything you are unsure of. Name the source. If you still do not know, say so.",
    on("homelab") && "Machines: you can run commands on {{owner}}'s hosts with run_command (list_hosts names them). Check before advising: look at status, logs and config yourself rather than asking them to paste it. Read-only commands run at once. A change waits for their approval: show the exact command and why, then stop. When their next message says yes, call approve_command. Changes are journaled automatically.",
    "The hub's own software: when {{owner}} asks about updates or to update the hub (you, the app's server), use update_hub.",
    "Images {{owner}} sends are attached to their message; read them directly (screenshots, error dialogs, photos of hardware or wiring).",
    on("wiki") && "Project wiki (the repository docs and Confluence spaces {{owner}} mirrored to the hub): for anything about those projects, wiki_search with one to three key words, then wiki_page on the best hits. Answer from the pages and name them.",
    "Writing as {{owner}} (messages, emails, reviews, posts): use draft_in_my_voice and give the draft alone, with no offer to tweak it.",
    "Only say you saved, changed or deleted something when a tool call in this reply did it, and describe it as saved (the exact times and title the tool returned). Never invent ids: take them from a tool result or from the items listed in the context note. If a tool returns an error, fix the arguments and try once more, or say plainly what failed.",
    "Items marked work are {{owner}}'s work calendar or work tasks. Mention them only when the question is about the schedule or work.",
  ].filter(Boolean).join("\n");
}
