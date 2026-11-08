import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { dayKey } from "./metrics.js";
import { activitySpans, caffeineCups, sleepMinutes, weightIn, weightUnit } from "./health.js";
import type { ModuleId } from "./modules.js";

/**
 * The general dashboard: any measure the hub holds as a series of local days (EA_TZ), with its newest value and the
 * change against the period before. Metrics are named by id:
 *
 *   log:weight  log:sleep  log:steps  log:caffeine  log:mood  log:med  log:activity  log:bp_systolic  log:bp_diastolic
 *   log:custom:<name>   sensor:<name>   tasks:done   captures:created   monitor:<id>
 *
 * Everything here reads; the only write is the tile choice in `<data>/dashboard.json`, one setting for every device.
 */

export const RANGES = [7, 30, 90, 365] as const;
export const CHARTS = ["line", "bar"] as const;
export const MAX_TILES = 24;
const MAX_DEFAULT_TILES = 8;

/** How a day's readings become one number. */
export type Agg = "mean" | "last" | "sum" | "count" | "pct";
export type Chart = (typeof CHARTS)[number];

const LOG_METRICS = ["weight", "sleep", "steps", "caffeine", "mood", "med", "activity", "bp_systolic", "bp_diastolic"] as const;
type LogMetric = (typeof LOG_METRICS)[number];

export type MetricRef =
  | { source: "log"; type: LogMetric }
  | { source: "custom"; name: string }
  | { source: "sensor"; name: string }
  | { source: "monitor"; id: string }
  | { source: "tasks_done" }
  | { source: "captures" };

/** What a metric is called and how it adds up. `chart` is the suggested look for a new tile. */
interface MetricDef { label: string; unit: string; group: string; agg: Agg; chart: Chart }

const LOG_DEFS: Record<LogMetric, MetricDef> = {
  weight: { label: "Weight", unit: "lb", group: "Body", agg: "mean", chart: "line" },
  sleep: { label: "Sleep", unit: "h", group: "Body", agg: "last", chart: "bar" },
  steps: { label: "Steps", unit: "steps", group: "Body", agg: "last", chart: "bar" },
  caffeine: { label: "Caffeine", unit: "cups", group: "Body", agg: "sum", chart: "bar" },
  mood: { label: "Mood", unit: "", group: "Body", agg: "mean", chart: "line" },
  med: { label: "Medications taken", unit: "doses", group: "Body", agg: "count", chart: "bar" },
  activity: { label: "Activity time", unit: "min", group: "Body", agg: "sum", chart: "bar" },
  bp_systolic: { label: "Blood pressure, systolic", unit: "mmHg", group: "Body", agg: "mean", chart: "line" },
  bp_diastolic: { label: "Blood pressure, diastolic", unit: "mmHg", group: "Body", agg: "mean", chart: "line" },
};

export function parseMetric(id: string): MetricRef | null {
  const s = id.trim();
  if (s === "tasks:done") return { source: "tasks_done" };
  if (s === "captures:created") return { source: "captures" };
  if (s.startsWith("log:custom:")) { const name = s.slice(11).trim(); return name ? { source: "custom", name } : null; }
  if (s.startsWith("log:")) { const t = s.slice(4); return (LOG_METRICS as readonly string[]).includes(t) ? { source: "log", type: t as LogMetric } : null; }
  if (s.startsWith("sensor:")) { const name = s.slice(7).trim(); return name ? { source: "sensor", name } : null; }
  if (s.startsWith("monitor:")) { const mid = s.slice(8).trim(); return mid ? { source: "monitor", id: mid } : null; }
  return null;
}

export function metricId(m: MetricRef): string {
  switch (m.source) {
    case "log": return `log:${m.type}`;
    case "custom": return `log:custom:${m.name}`;
    case "sensor": return `sensor:${m.name}`;
    case "monitor": return `monitor:${m.id}`;
    case "tasks_done": return "tasks:done";
    case "captures": return "captures:created";
  }
}

// ---------- reading the data ----------

const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const atOf = (l: Entity) => String(l.fields.at ?? l.created_at);
const isEnd = (l: Entity) => String(l.fields.note ?? "").trim().toLowerCase() === "end";
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a custom log measures: its `name`, else its unit. */
export function customName(l: Entity): string {
  const n = typeof l.fields.name === "string" ? l.fields.name.trim() : "";
  if (n) return n;
  const u = typeof l.fields.unit === "string" ? l.fields.unit.trim() : "";
  return u || "Custom";
}

/** `"120/80"` → [120, 80]. */
function bpParts(v: unknown): [number, number] | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(String(v ?? ""));
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

/**
 * The day a night of sleep counts for: the day it ended. Apple Health's nightly totals carry the time the owner fell
 * asleep, and the iPhone names each night by its wake time plus 6 hours (`sleep:<day>`, so sleep ending before 6 PM
 * counts for that day); asleep time plus the minutes asleep is that wake time or a little before it. A log made in the
 * app is written after waking and counts for its own day. Nights used to count for the bedtime's day, so a night that
 * started after midnight and the next one, started before it, landed on one day and the day after stayed empty.
 */
function sleepDay(l: Entity, minutes: number): string {
  const at = new Date(atOf(l));
  if (l.fields.note !== "Apple Health") return dayKey(at);
  return dayKey(new Date(at.getTime() + minutes * 60_000 + 6 * 3600_000));
}

/** A raw sample: when, the number it contributes, and the day it counts for when that is not the day of `at`. */
interface Sample { at: string; value: number; day?: string }

/** Per request: logs and tasks are read once however many tiles want them. */
class Reader {
  private logs?: Entity[];
  private wUnit?: "kg" | "lb";
  constructor(readonly hub: Hub, readonly now: Date) {}

  allLogs(): Entity[] {
    return (this.logs ??= this.hub.store.list({ kind: "log", limit: 1_000_000 }).filter((l) => !Number.isNaN(new Date(atOf(l)).getTime())));
  }

  /** Weights are shown in the newest weight log's unit, every one converted to it. */
  weightUnit(): "kg" | "lb" {
    return (this.wUnit ??= weightUnit(this.allLogs().filter((l) => l.fields.type === "weight" && num(l.fields.value) !== null)));
  }

  logSamples(type: LogMetric): Sample[] {
    const out: Sample[] = [];
    if (type === "activity") return out; // minutes are spread over days, see activityMinutes
    const want = type.startsWith("bp_") ? "bp" : type;
    for (const l of this.allLogs()) {
      if (l.fields.type !== want || isEnd(l)) continue;
      let v: number | null;
      if (type === "bp_systolic" || type === "bp_diastolic") { const p = bpParts(l.fields.value); v = p ? p[type === "bp_systolic" ? 0 : 1] : null; }
      else if (type === "sleep") {
        const min = sleepMinutes(l);
        if (min !== null) out.push({ at: atOf(l), value: min / 60, day: sleepDay(l, min) });
        continue;
      }
      else if (type === "med") v = 1;
      else if (type === "caffeine") v = caffeineCups(l);
      else if (type === "weight") v = weightIn(l, this.weightUnit());
      else v = num(l.fields.value);
      if (v !== null) out.push({ at: atOf(l), value: v });
    }
    return out;
  }

  customSamples(name: string): Sample[] {
    const key = name.toLowerCase();
    const out: Sample[] = [];
    for (const l of this.allLogs()) {
      if (l.fields.type !== "custom" || customName(l).toLowerCase() !== key) continue;
      const v = num(l.fields.value);
      if (v !== null) out.push({ at: atOf(l), value: v });
    }
    return out;
  }

  /** Minutes of activity per local day: each session (`activitySpans`) until its end, an open one until now. */
  activityMinutes(): Map<string, number> {
    const perDay = new Map<string, number>();
    for (const a of activitySpans(this.allLogs())) {
      if (a.from > this.now.getTime()) continue;
      const stop = Math.min(a.to ?? this.now.getTime(), this.now.getTime());
      let t = a.from;
      while (t < stop) {
        const d = new Date(t);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const upto = Math.min(next, stop);
        const k = dayKey(d);
        perDay.set(k, (perDay.get(k) ?? 0) + (upto - t) / 60_000);
        t = upto;
      }
    }
    return perDay;
  }

  /** Per-hour sums straight from SQL (readings are many), folded into local days. */
  sensorHours(name: string, since: Date): { day: string; sum: number; n: number }[] {
    const rows = this.hub.db.prepare(
      "SELECT substr(json_extract(fields, '$.at'), 1, 13) AS h, SUM(json_extract(fields, '$.value')) AS s, COUNT(*) AS n FROM entities WHERE kind = 'reading' AND deleted_at IS NULL AND json_extract(fields, '$.sensor') = ? AND json_extract(fields, '$.at') >= ? GROUP BY h",
    ).all(name, since.toISOString()) as { h: string; s: number; n: number }[];
    return rows.filter((r) => typeof r.h === "string" && Number.isFinite(Number(r.s))).map((r) => ({ day: dayKey(new Date(`${r.h}:00:00.000Z`)), sum: Number(r.s), n: r.n }));
  }

  monitorHours(id: string, since: Date): { day: string; sum: number; n: number }[] {
    const rows = this.hub.db.prepare("SELECT substr(at, 1, 13) AS h, SUM(ok) AS oks, COUNT(*) AS n FROM checks WHERE monitor_id = ? AND at >= ? GROUP BY h").all(id, since.toISOString()) as { h: string; oks: number; n: number }[];
    return rows.map((r) => ({ day: dayKey(new Date(`${r.h}:00:00.000Z`)), sum: r.oks, n: r.n }));
  }

  /** When each task was finished: `done_at` (a repeating task keeps the last one), else when it was marked done. */
  taskDoneTimes(): string[] {
    const out: string[] = [];
    for (const t of this.hub.store.list({ kind: "task", limit: 1_000_000 })) {
      const at = typeof t.fields.done_at === "string" ? t.fields.done_at : t.fields.status === "done" ? t.field_ts.status : undefined;
      if (at && !at.startsWith("1970")) out.push(at);
    }
    return out;
  }

  captureTimes(): string[] {
    return this.hub.store.list({ kind: "capture", limit: 1_000_000 }).map((c) => c.created_at);
  }

  sensor(name: string): Entity | null {
    return this.hub.store.list({ kind: "sensor", limit: 10000 }).find((s) => s.fields.name === name) ?? null;
  }

  monitor(id: string): Entity | null {
    const m = this.hub.store.get(id);
    return m && m.kind === "monitor" && !m.deleted_at ? m : null;
  }
}

// ---------- series ----------

export interface SeriesPoint { day: string; value: number | null }
export interface Series {
  metric: string;
  label: string;
  unit: string;
  group: string;
  agg: Agg;
  /** The suggested chart for this metric. */
  chart: Chart;
  days: number;
  from: string;
  to: string;
  /** One per local day, oldest first, today last. Counts are 0 on empty days; measured values are null. */
  points: SeriesPoint[];
  /** The newest value in the range: the last reading for measured values, the last day's number for counts. */
  latest: { day: string; value: number; at?: string } | null;
  /** `total` for counts and sums (added over the period), `average` for everything else. */
  period: "total" | "average";
  current: number | null;
  previous: number | null;
  change: number | null;
  /** Change as a percent of `previous`; null when `previous` is null or 0. */
  change_pct: number | null;
}

interface Bucket { sum: number; n: number; last: number; lastAt: string }

/** Local day keys from `days - 1` days ago through today, each with its start time. */
export function dayRange(days: number, endDay: Date): { day: string; start: Date }[] {
  const out: { day: string; start: Date }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() - i);
    out.push({ day: dayKey(start), start });
  }
  return out;
}

function dailyValue(b: Bucket | undefined, agg: Agg): number | null {
  if (agg === "count") return b ? b.n : 0;
  if (agg === "sum") return b ? round2(b.sum) : 0;
  if (!b || !b.n) return null;
  if (agg === "last") return round2(b.last);
  if (agg === "pct") return round2((b.sum / b.n) * 100);
  return round2(b.sum / b.n);
}

/** The period's one number: a total for counts and sums, else the reading-weighted mean (mean of days for `last`). */
export function periodValue(buckets: (Bucket | undefined)[], agg: Agg): number | null {
  if (agg === "count" || agg === "sum") return round2(buckets.reduce((s, b) => s + (dailyValue(b, agg) ?? 0), 0));
  if (agg === "last") {
    const vs = buckets.map((b) => dailyValue(b, agg)).filter((v): v is number => v !== null);
    return vs.length ? round2(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
  }
  let sum = 0;
  let n = 0;
  for (const b of buckets) if (b) { sum += b.sum; n += b.n; }
  if (!n) return null;
  return round2(agg === "pct" ? (sum / n) * 100 : sum / n);
}

function describe(m: MetricRef, r: Reader): MetricDef {
  switch (m.source) {
    case "log": {
      const def = { ...LOG_DEFS[m.type] };
      // Weight is shown in the unit of its newest log, every reading converted to it; caffeine is always cups. The unit
      // of the newest log used to be shown over values added up as they were logged (mg and cups, kg and lb).
      if (m.type === "weight") def.unit = r.weightUnit();
      return def;
    }
    case "custom": {
      const last = r.allLogs().filter((l) => l.fields.type === "custom" && customName(l).toLowerCase() === m.name.toLowerCase()).sort((a, b) => atOf(b).localeCompare(atOf(a)))[0];
      const unit = last && typeof last.fields.unit === "string" && last.fields.unit.trim() !== customName(last) ? last.fields.unit.trim() : "";
      return { label: last ? customName(last) : m.name, unit, group: "Logs", agg: "sum", chart: "bar" };
    }
    case "sensor": {
      const s = r.sensor(m.name);
      const loc = s && typeof s.fields.location === "string" && s.fields.location.trim() ? `, ${s.fields.location.trim()}` : "";
      return { label: `${m.name}${loc}`, unit: String(s?.fields.unit ?? ""), group: "Home", agg: "mean", chart: "line" };
    }
    case "monitor": {
      const mon = r.monitor(m.id);
      return { label: `${mon ? String(mon.fields.name) : "Monitor"} uptime`, unit: "%", group: "Homelab", agg: "pct", chart: "bar" };
    }
    case "tasks_done": return { label: "Tasks done", unit: "tasks", group: "Plan", agg: "count", chart: "bar" };
    case "captures": return { label: "Captures", unit: "captures", group: "Plan", agg: "count", chart: "bar" };
  }
}

function seriesWith(r: Reader, m: MetricRef, days: number): Series {
  const def = describe(m, r);
  const all = dayRange(days * 2, r.now);
  const prev = all.slice(0, days);
  const cur = all.slice(days);
  const since = all[0].start;
  const buckets = new Map<string, Bucket>();
  const add = (day: string, value: number, at = "", n = 1) => {
    const b = buckets.get(day);
    if (!b) { buckets.set(day, { sum: value, n, last: value, lastAt: at }); return; }
    b.sum += value; b.n += n;
    if (at >= b.lastAt) { b.last = value; b.lastAt = at; }
  };
  const today = all[all.length - 1].day;
  const addSamples = (samples: Sample[]) => {
    for (const s of samples) {
      const d = new Date(s.at);
      if (d > r.now) continue;
      if (s.day ? s.day >= all[0].day && s.day <= today : d >= since) add(s.day ?? dayKey(d), s.value, s.at);
    }
  };
  const addTimes = (times: string[]) => addSamples(times.map((at) => ({ at, value: 1 })));

  let latestRaw: { value: number; at: string } | null = null;
  switch (m.source) {
    case "log":
      if (m.type === "activity") { for (const [day, mins] of r.activityMinutes()) if (day >= all[0].day) add(day, mins); }
      else addSamples(r.logSamples(m.type));
      break;
    case "custom": addSamples(r.customSamples(m.name)); break;
    case "sensor": {
      for (const h of r.sensorHours(m.name, since)) add(h.day, h.sum, "", h.n);
      const s = r.sensor(m.name);
      const v = num(s?.fields.last_value);
      if (s && v !== null && typeof s.fields.last_at === "string" && new Date(s.fields.last_at) >= cur[0].start) latestRaw = { value: v, at: s.fields.last_at };
      break;
    }
    case "monitor": for (const h of r.monitorHours(m.id, since)) add(h.day, h.sum, "", h.n); break;
    case "tasks_done": addTimes(r.taskDoneTimes()); break;
    case "captures": addTimes(r.captureTimes()); break;
  }

  const points = cur.map((d) => ({ day: d.day, value: dailyValue(buckets.get(d.day), def.agg) }));
  // Counts and sums: today's number, even when it is 0. Measured values: the newest reading in the range.
  let latest: Series["latest"] = null;
  if (def.agg === "count" || def.agg === "sum") latest = { day: cur[cur.length - 1].day, value: points[points.length - 1].value ?? 0 };
  else for (let i = cur.length - 1; i >= 0 && !latest; i--) {
    const b = buckets.get(cur[i].day);
    if (!b || points[i].value === null) continue;
    latest = b.lastAt ? { day: cur[i].day, value: round2(b.last), at: b.lastAt } : { day: cur[i].day, value: points[i].value! };
  }
  if (latestRaw) latest = { day: dayKey(new Date(latestRaw.at)), value: round2(latestRaw.value), at: latestRaw.at };

  const current = periodValue(cur.map((d) => buckets.get(d.day)), def.agg);
  const previous = periodValue(prev.map((d) => buckets.get(d.day)), def.agg);
  // A count over a previous period with nothing in it at all is "no data", not a real zero to compare against.
  const prevEmpty = prev.every((d) => !buckets.has(d.day));
  const prevV = prevEmpty ? null : previous;
  const change = current !== null && prevV !== null ? round2(current - prevV) : null;
  return {
    metric: metricId(m),
    ...def,
    days,
    from: cur[0].day,
    to: cur[cur.length - 1].day,
    points,
    latest,
    period: def.agg === "count" || def.agg === "sum" ? "total" : "average",
    current,
    previous: prevV,
    change,
    change_pct: change !== null && prevV ? round2((change / Math.abs(prevV)) * 100) : null,
  };
}

/** One metric over `days` local days ending today. 400 for an id that names no kind of metric. */
export function metricSeries(hub: Hub, metric: string, days: number, now: Date = new Date()): Series {
  const m = parseMetric(metric);
  if (!m) throw new StoreError(400, `unknown metric ${metric}`);
  return seriesWith(new Reader(hub, now), m, days);
}

// ---------- what has data ----------

export interface MetricInfo { id: string; label: string; unit: string; group: string; agg: Agg; chart: Chart; count: number; last_at: string | null }

/** Every metric with at least one reading, grouped (Body, Logs, Plan, Home, Homelab) and named. */
/** The module a metric belongs to: body logs to Health, sensors to Sensors, monitor uptime to Homelab; else the core. */
export function metricModule(m: MetricRef): ModuleId | null {
  if (m.source === "log") return m.type === "activity" ? null : "health";
  if (m.source === "sensor") return "sensors";
  if (m.source === "monitor") return "homelab";
  return null;
}

/** Whether a metric's module is on (Settings, Modules). */
function metricOn(hub: Hub, m: MetricRef | null): boolean {
  const owner = m ? metricModule(m) : null;
  return !owner || hub.modules.on(owner);
}

export function availableMetrics(hub: Hub, now: Date = new Date()): MetricInfo[] {
  const r = new Reader(hub, now);
  const out: MetricInfo[] = [];
  const push = (m: MetricRef, count: number, last: string | null) => { if (count > 0 && metricOn(hub, m)) out.push({ id: metricId(m), ...describe(m, r), count, last_at: last }); };
  const newest = (xs: string[]) => xs.reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

  for (const t of LOG_METRICS) {
    if (t === "activity") {
      const acts = r.allLogs().filter((l) => l.fields.type === "activity" && !isEnd(l));
      push({ source: "log", type: t }, acts.length, newest(acts.map(atOf)));
      continue;
    }
    const s = r.logSamples(t);
    push({ source: "log", type: t }, s.length, newest(s.map((x) => x.at)));
  }
  const customs = new Map<string, Entity[]>();
  for (const l of r.allLogs()) {
    if (l.fields.type !== "custom" || num(l.fields.value) === null) continue;
    const k = customName(l);
    const hit = [...customs.keys()].find((x) => x.toLowerCase() === k.toLowerCase()) ?? k;
    customs.set(hit, [...(customs.get(hit) ?? []), l]);
  }
  for (const [name, ls] of [...customs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) push({ source: "custom", name }, ls.length, newest(ls.map(atOf)));

  const done = r.taskDoneTimes();
  push({ source: "tasks_done" }, done.length, newest(done));
  const caps = r.captureTimes();
  push({ source: "captures" }, caps.length, newest(caps));

  const readings = new Map((hub.db.prepare("SELECT json_extract(fields, '$.sensor') AS name, COUNT(*) AS n, MAX(json_extract(fields, '$.at')) AS last FROM entities WHERE kind = 'reading' AND deleted_at IS NULL GROUP BY name").all() as { name: string; n: number; last: string }[]).map((x) => [x.name, x]));
  const sensors = hub.store.list({ kind: "sensor", limit: 10000 }).map((s) => String(s.fields.name)).sort();
  for (const name of sensors) { const x = readings.get(name); push({ source: "sensor", name }, x?.n ?? 0, x?.last ?? null); }

  const checks = hub.db.prepare("SELECT monitor_id, COUNT(*) AS n, MAX(at) AS last FROM checks GROUP BY monitor_id").all() as { monitor_id: string; n: number; last: string }[];
  const monitors = hub.store.list({ kind: "monitor", limit: 10000 }).sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  for (const mon of monitors) { const x = checks.find((c) => c.monitor_id === mon.id); push({ source: "monitor", id: mon.id }, x?.n ?? 0, x?.last ?? null); }
  return out;
}

// ---------- tiles ----------

export const Tile = z.object({
  metric: z.string().trim().min(3).max(200),
  range: z.number().int().refine((n) => (RANGES as readonly number[]).includes(n), { message: `range must be one of ${RANGES.join(", ")}` }),
  chart: z.enum(CHARTS),
});
export type Tile = z.infer<typeof Tile>;

/** Tiles for a board nobody has arranged yet: the usual measures first, only those with data, at most eight. */
export function defaultTiles(metrics: MetricInfo[]): Tile[] {
  const have = new Map(metrics.map((m) => [m.id, m]));
  const order: Array<[string, number]> = [
    ["log:weight", 30], ["log:steps", 30], ["log:sleep", 30], ["tasks:done", 30], ["captures:created", 30],
    ["log:activity", 30], ["log:mood", 30], ["log:caffeine", 30], ["log:bp_systolic", 90],
  ];
  const out: Tile[] = [];
  for (const [id, range] of order) { const m = have.get(id); if (m) out.push({ metric: id, range, chart: m.chart }); }
  for (const m of metrics.filter((x) => x.id.startsWith("sensor:")).slice(0, 3)) out.push({ metric: m.id, range: 7, chart: m.chart });
  for (const m of metrics.filter((x) => x.id.startsWith("monitor:")).slice(0, 2)) out.push({ metric: m.id, range: 7, chart: m.chart });
  return out.slice(0, MAX_DEFAULT_TILES);
}

export class DashboardStore {
  constructor(private file: string) {}

  /** The saved tiles, or null when nothing has been saved (or the file is unreadable). */
  saved(): Tile[] | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { tiles?: unknown };
      const tiles = z.array(z.unknown()).parse(raw.tiles);
      // A tile that no longer parses is dropped rather than losing the whole board.
      return tiles.map((t) => Tile.safeParse(t)).filter((p) => p.success && parseMetric(p.data.metric)).map((p) => p.data!);
    } catch {
      return null;
    }
  }

  /** Replace the board. Anything invalid refuses the whole body. */
  set(body: Record<string, unknown>): Tile[] {
    const parsed = z.object({ tiles: z.array(Tile).max(MAX_TILES) }).safeParse(body);
    if (!parsed.success) throw new StoreError(422, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    for (const t of parsed.data.tiles) if (!parseMetric(t.metric)) throw new StoreError(422, `unknown metric ${t.metric}`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ tiles: parsed.data.tiles }), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    return parsed.data.tiles;
  }

  reset(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export interface DashboardPrefs { tiles: Tile[]; saved: boolean; options: { ranges: readonly number[]; charts: readonly string[]; max_tiles: number } }

export function dashboardPrefs(hub: Hub, now: Date = new Date()): DashboardPrefs {
  const saved = hub.dashboard.saved();
  return { tiles: saved ?? defaultTiles(availableMetrics(hub, now)), saved: saved !== null, options: { ranges: RANGES, charts: CHARTS, max_tiles: MAX_TILES } };
}

/** The whole board in one read: every tile with its series. */
export function dashboardBoard(hub: Hub, now: Date = new Date()): { tiles: (Tile & { series: Series })[]; saved: boolean } {
  const prefs = dashboardPrefs(hub, now);
  const r = new Reader(hub, now);
  // A saved tile of a module that is off is left out until it is on again (the saved board is not changed).
  return { tiles: prefs.tiles.filter((t) => metricOn(hub, parseMetric(t.metric))).map((t) => ({ ...t, series: seriesWith(r, parseMetric(t.metric)!, t.range) })), saved: prefs.saved };
}

