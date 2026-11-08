/**
 * Module 6 helpers: the traffic-light summary over monitors, the 24 h check strip and incident
 * durations. Pure, so the mock hub and the tests share them with the Ops view.
 */
import type { Entity } from "@everythingapp/shared";
import type { HostSummary } from "./memory";

export type MonitorType = "ping" | "tcp" | "http" | "tls" | "dns" | "backup";
export const MONITOR_TYPES: MonitorType[] = ["ping", "tcp", "http", "tls", "dns", "backup"];
export type MonitorState = "up" | "down" | "unknown";

export type MonitorF = {
  name: string;
  host?: string;
  type: MonitorType;
  target: string;
  expect?: string;
  interval_s?: number;
  timeout_s?: number;
  fails_before_down?: number;
  enabled?: boolean;
  state?: MonitorState;
  last_check?: string;
  last_ok?: string;
  last_latency_ms?: number;
  last_error?: string;
  /** backup: when the last good run was, or that one is running. */
  last_detail?: string;
  consecutive_fails?: number;
};

export type IncidentF = {
  monitor_id: string;
  name: string;
  opened_at: string;
  closed_at?: string;
  acknowledged_at?: string;
  ack_note?: string;
  last_error?: string;
  checks_failed?: number;
  journal_id?: string;
};

/** One row of GET /monitors/:id/history. */
export type CheckRow = { at: string; ok: boolean; latency_ms?: number; error?: string };

/** GET /ops. Each monitor is the entity with its open incident attached. */
export type OpsMonitor = Entity & { incident_open: Entity | null };
export interface OpsData {
  monitors: OpsMonitor[];
  incidents_open: Entity[];
  incidents_7d: number;
  uptime_24h: Array<{ name: string; pct: number | null }>;
  watches_due_30d: Entity[];
  journal_recent: Entity[];
  hosts: HostSummary[];
}

export const monitorState = (f: Pick<MonitorF, "state">): MonitorState => (f.state === "up" || f.state === "down" ? f.state : "unknown");

export type Tone = "ok" | "danger" | "muted";

export interface TrafficLight {
  up: number;
  down: number;
  unknown: number;
  /** Enabled monitors only; disabled ones are neither up nor down. */
  total: number;
  tone: Tone;
  /** "All 10 up", "2 down", "1 unknown", "No monitors". */
  label: string;
  /** The rest of the story: "8 up, 1 unknown". Empty when the label says it all. */
  detail: string;
}

/** The traffic light over enabled monitors: red when anything is down, grey when anything is unknown, else green. */
export function trafficLight(monitors: Array<{ fields: Record<string, unknown> }>): TrafficLight {
  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const m of monitors) {
    const f = m.fields as Partial<MonitorF>;
    if (f.enabled === false) continue;
    const s = monitorState(f);
    if (s === "up") up++;
    else if (s === "down") down++;
    else unknown++;
  }
  const total = up + down + unknown;
  const parts = (...xs: Array<[number, string]>) => xs.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(", ");
  if (total === 0) return { up, down, unknown, total, tone: "muted", label: "No monitors", detail: "" };
  if (down > 0) return { up, down, unknown, total, tone: "danger", label: `${down} down`, detail: parts([up, "up"], [unknown, "unknown"]) };
  if (unknown > 0) return { up, down, unknown, total, tone: "muted", label: `${unknown} unknown`, detail: parts([up, "up"]) };
  return { up, down, unknown, total, tone: "ok", label: `All ${up} up`, detail: "" };
}

export type StripCell = { state: "ok" | "fail" | "none"; from: string; to: string; checks: number; fails: number };

export const STRIP_MAX_CELLS = 144;

/**
 * The 24 h strip. With `maxCells` or fewer checks in the window there is one cell per check, in time
 * order. With more, the window is cut into `maxCells` equal slices and a slice is red when any check
 * in it failed, green when every check passed and empty when nothing was checked.
 */
export function uptimeStrip(history: CheckRow[], opts: { hours?: number; now?: Date; maxCells?: number } = {}): StripCell[] {
  const hours = opts.hours ?? 24;
  const end = (opts.now ?? new Date()).getTime();
  const start = end - hours * 3600_000;
  const maxCells = opts.maxCells ?? STRIP_MAX_CELLS;
  const rows = history
    .map((r) => ({ ...r, t: new Date(r.at).getTime() }))
    .filter((r) => Number.isFinite(r.t) && r.t >= start && r.t <= end)
    .sort((a, b) => a.t - b.t);
  if (rows.length <= maxCells) {
    return rows.map((r) => ({ state: r.ok ? "ok" : "fail", from: r.at, to: r.at, checks: 1, fails: r.ok ? 0 : 1 }));
  }
  const width = (end - start) / maxCells;
  const cells: StripCell[] = [];
  for (let i = 0; i < maxCells; i++) {
    cells.push({ state: "none", from: new Date(start + i * width).toISOString(), to: new Date(start + (i + 1) * width).toISOString(), checks: 0, fails: 0 });
  }
  for (const r of rows) {
    const i = Math.min(maxCells - 1, Math.floor((r.t - start) / width));
    const c = cells[i];
    c.checks++;
    if (!r.ok) c.fails++;
    c.state = c.fails > 0 ? "fail" : "ok";
  }
  return cells;
}

/** Percent of checks that passed, one decimal; null without checks. */
export function uptimePct(history: CheckRow[]): number | null {
  if (!history.length) return null;
  const ok = history.filter((r) => r.ok).length;
  return Math.round((ok / history.length) * 1000) / 10;
}

/** Seconds an incident has been or was open. */
export function incidentSeconds(f: Pick<IncidentF, "opened_at" | "closed_at">, now = new Date()): number {
  const end = f.closed_at ? new Date(f.closed_at).getTime() : now.getTime();
  return Math.max(0, (end - new Date(f.opened_at).getTime()) / 1000);
}

/** The last failed checks, newest first, each error once. */
export function lastErrors(history: CheckRow[], limit = 5): CheckRow[] {
  const out: CheckRow[] = [];
  const seen = new Set<string>();
  for (const r of history.slice().sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (r.ok) continue;
    const key = r.error ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export type MonitorDraft = { name: string; host: string; type: MonitorType; target: string; expect: string; interval_s: string; timeout_s: string; fails_before_down: string; enabled: boolean };

export const EMPTY_MONITOR: MonitorDraft = { name: "", host: "", type: "ping", target: "", expect: "", interval_s: "60", timeout_s: "5", fails_before_down: "3", enabled: true };

export function monitorDraft(f: Partial<MonitorF>): MonitorDraft {
  return {
    name: f.name ?? "",
    host: f.host ?? "",
    type: f.type ?? "ping",
    target: f.target ?? "",
    expect: f.expect ?? "",
    interval_s: String(f.interval_s ?? 60),
    timeout_s: String(f.timeout_s ?? 5),
    fails_before_down: String(f.fails_before_down ?? 3),
    enabled: f.enabled !== false,
  };
}

/** The config fields of a monitor from the editor; throws on an empty name or target or a bad number. */
export function monitorFields(d: MonitorDraft): Record<string, unknown> {
  const name = d.name.trim();
  const target = d.target.trim();
  if (!name) throw new Error("Needs a name.");
  if (!target) throw new Error("Needs a target.");
  const int = (v: string, label: string, min: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${label} must be a whole number of at least ${min}.`);
    return n;
  };
  return {
    name,
    host: d.host.trim() || null,
    type: d.type,
    target,
    expect: d.expect.trim() || null,
    interval_s: int(d.interval_s, "Interval", 10),
    timeout_s: int(d.timeout_s, "Timeout", 1),
    fails_before_down: int(d.fails_before_down, "Fails before down", 1),
    enabled: d.enabled,
  };
}
