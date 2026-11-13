/**
 * Module 6 helpers: the traffic-light summary over monitors, the 24 h check strip and incident
 * durations. Pure, so the mock hub and the tests share them with the Ops view.
 */
import type { Entity } from "@everythingapp/shared";
import type { HostSummary } from "./memory";

export type MonitorType = "ping" | "tcp" | "http" | "tls" | "dns" | "backup";
export const MONITOR_TYPES: MonitorType[] = ["ping", "tcp", "http", "tls", "dns", "backup"];
export type MonitorState = "up" | "down" | "unknown";

export type BackupJob = "backup" | "verify" | "restore";
/** A backup machine's job as the hub last read it (the monitor's `jobs`). */
export type BackupJobState = {
  job: BackupJob;
  state: "ok" | "failed" | "stale" | "never" | "missing";
  running?: boolean;
  last_good?: string;
  last_run?: string;
  max_hours: number;
  error?: string;
};

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
  /** backup: one entry per job of the machine (backup, verification, restore test). */
  jobs?: BackupJobState[];
  /** The last check that reached the thing checked (a skipped check of a machine away does not). */
  last_reached?: string;
  /** Down with its machine: the machine's incident. */
  joined_incident?: string;
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
  /** A machine that stopped answering: its other monitors that went down with it. */
  also_down?: string[];
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
  /** The hub's own backups (a hub from before 2026-11-13 leaves it out). */
  hub_backup?: HubBackupLine[];
}

/** One line about the hub's own backups: the nightly copy, a second folder, the copy to storage, the live copy. */
export type HubBackupLine = { label: string; ok: boolean; at?: string | null; text: string };

/** "last 11 h ago; 30 kept, encrypted", "running". */
export function hubLineText(l: HubBackupLine, now: Date = new Date()): string {
  return [l.at ? `last ${agoWords(l.at, now)}` : "", l.text].filter(Boolean).join("; ") || (l.ok ? "fine" : "not fine");
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
 * The 24 h strip, cut by time: `min(maxCells, window / interval)` equal slices, so a slice holds about one check at the
 * monitor's interval. A slice is red when any check in it failed, green when every check passed and empty when nothing
 * was checked (a machine away, a monitor made today). One cell per check hid those gaps behind a full green day.
 */
export function uptimeStrip(history: CheckRow[], opts: { hours?: number; now?: Date; maxCells?: number; intervalS?: number } = {}): StripCell[] {
  const hours = opts.hours ?? 24;
  const end = (opts.now ?? new Date()).getTime();
  const start = end - hours * 3600_000;
  const byInterval = opts.intervalS && opts.intervalS > 0 ? Math.floor((hours * 3600) / opts.intervalS) : Infinity;
  const maxCells = Math.max(1, Math.min(opts.maxCells ?? STRIP_MAX_CELLS, byInterval));
  const rows = history
    .map((r) => ({ ...r, t: new Date(r.at).getTime() }))
    .filter((r) => Number.isFinite(r.t) && r.t >= start && r.t <= end)
    .sort((a, b) => a.t - b.t);
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

export const JOB_LABEL: Record<BackupJob, string> = { backup: "Backup", verify: "Verification", restore: "Restore test" };

/** "40 min ago", "10 h ago", "12 days ago": the same words the hub uses. */
export function agoWords(iso: string, now: Date = new Date()): string {
  const h = (now.getTime() - new Date(iso).getTime()) / 3600_000;
  if (!Number.isFinite(h)) return "";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  return h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
}

/** A backup job's line on its machine's card: the job, a tone, what to say, and the exact time it is about. */
export function jobLine(job: BackupJobState, now: Date = new Date()): { label: string; tone: Tone; text: string; at?: string } {
  // A machine away keeps its last read: a job fine then can be past its limit now.
  const over = job.state === "ok" && !!job.last_good && now.getTime() - Date.parse(job.last_good) > job.max_hours * 3600_000;
  const j: BackupJobState = over ? { ...job, state: "stale" } : job;
  const label = JOB_LABEL[j.job] ?? j.job;
  const good = j.last_good ? `last good ${agoWords(j.last_good, now)}` : "";
  const running = j.running ? "running now" : "";
  const join = (...xs: string[]) => xs.filter(Boolean).join("; ");
  switch (j.state) {
    case "missing":
      return { label, tone: "danger", text: "not set up on this machine" };
    case "never":
      return { label, tone: "danger", text: join(running, "no good run on record") };
    case "failed":
      return { label, tone: "danger", text: join(running, j.last_run ? `failed ${agoWords(j.last_run, now)}` : "failed", good), at: j.last_run };
    case "stale":
      return { label, tone: "danger", text: join(running, `${good}, over the ${j.max_hours} h limit`), at: j.last_good };
    default:
      return { label, tone: "ok", text: join(running, good), at: j.last_good };
  }
}

/** Backup machines apart from the other monitors: the Ops screen lists them under Backups. */
export const isBackup = (m: { fields: Record<string, unknown> }) => m.fields.type === "backup";
