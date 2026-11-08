import { execFile } from "node:child_process";
import dns from "node:dns";
import net from "node:net";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { StoreError } from "./store.js";
import { scheduleDaily } from "./schedule.js";
import { probeTls } from "./watches.js";
import { hostsSummary } from "./memory.js";
import { localDateOf } from "./planner.js";
import { backupChecker } from "./backups.js";
import { errCode } from "./logsafe.js";

/**
 * Module 6, homelab ops. Every enabled `monitor` is checked from the hub's own host at its interval: ping
 * (the system binary, one packet), tcp (socket connect), http (GET, status or body), tls (certificate not
 * expiring within 14 days), dns (resolve) and backup (a ProjectBackup job read over ssh, see backups.ts). After `fails_before_down` consecutive failures the state is
 * `down`, an `incident` opens and a `monitor` notify goes out; the first success afterwards closes it and
 * notifies `up`. Open incidents that nobody acknowledged re-notify every 6 hours. Every check lands in the
 * `checks` table (7 days), which feeds history and the 24 h uptime.
 */

export const TICK_MS = 15_000;
export const MAX_CONCURRENT = 8;
export const RENOTIFY_MS = 6 * 3600_000;
export const TLS_MIN_DAYS = 14;
export const CHECK_KEEP_DAYS = 7;
const DAY_MS = 24 * 3600_000;

export type MonitorType = "ping" | "tcp" | "http" | "tls" | "dns" | "backup";
export interface CheckInput { target: string; expect?: string; timeoutMs: number; now: Date }
/** `skip`: the check could not look (an unreachable machine), so it neither counts nor moves the state. `detail`: a line about the thing checked, shown with the monitor. */
export interface CheckOutcome { ok: boolean; error?: string; skip?: boolean; detail?: string }
export type Checker = (input: CheckInput) => Promise<CheckOutcome>;
export type Checkers = Record<MonitorType, Checker>;
export interface CheckRow { at: string; ok: boolean; latency_ms: number | null; error?: string }

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timeout after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** One ICMP packet through the system ping. Linux `-W` is seconds; macOS wants `-t` seconds (its `-W` is milliseconds). */
export function pingArgs(target: string, timeoutMs: number, platform: NodeJS.Platform = process.platform): string[] {
  const sec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return platform === "darwin" ? ["-c", "1", "-t", sec, target] : ["-c", "1", "-W", sec, target];
}

const pingCheck: Checker = ({ target, timeoutMs }) => new Promise((resolve) => {
  // A target starting with "-" would be read as a ping option.
  if (!/^[A-Za-z0-9[]/.test(target)) { resolve({ ok: false, error: "target must be a host name or address" }); return; }
  execFile("ping", pingArgs(target, timeoutMs), { timeout: timeoutMs + 1000 }, (err, _stdout, stderr) => {
    if (!err) { resolve({ ok: true }); return; }
    const text = String(stderr ?? "").trim().split("\n")[0];
    resolve({ ok: false, error: text || (err.killed ? `no reply within ${timeoutMs} ms` : `ping exit ${err.code ?? "?"}`) });
  });
});

/** `host:port`, with `[v6]:port` allowed. */
export function parseHostPort(target: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^(.+):(\d+)$/.exec(target);
  const port = m ? parseInt(m[2], 10) : NaN;
  if (!m || !(port > 0 && port < 65536)) throw new Error("tcp target must be host:port");
  return { host: m[1], port };
}

const tcpCheck: Checker = ({ target, timeoutMs }) => new Promise((resolve) => {
  let hp: { host: string; port: number };
  try { hp = parseHostPort(target); } catch (e) { resolve({ ok: false, error: message(e) }); return; }
  const socket = net.connect({ host: hp.host, port: hp.port });
  let done = false;
  const finish = (o: CheckOutcome) => { if (done) return; done = true; socket.destroy(); resolve(o); };
  socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `connect timeout after ${timeoutMs} ms` }));
  socket.once("connect", () => finish({ ok: true }));
  socket.once("error", (e) => finish({ ok: false, error: message(e) }));
});

/** GET. No `expect`: 2xx or 3xx. Numeric `expect`: that status. Text `expect`: the body contains it. */
export function httpOutcome(status: number, body: string, expect: string | undefined): CheckOutcome {
  const want = (expect ?? "").trim();
  if (!want) return status >= 200 && status < 400 ? { ok: true } : { ok: false, error: `status ${status}` };
  if (/^\d{3}$/.test(want)) return status === parseInt(want, 10) ? { ok: true } : { ok: false, error: `status ${status}, expected ${want}` };
  return body.includes(want) ? { ok: true } : { ok: false, error: `status ${status}, body without "${want.slice(0, 40)}"` };
}

const httpCheck: Checker = async ({ target, expect, timeoutMs }) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: "GET", signal: ac.signal, headers: { "user-agent": "everythingapp-hub-monitor" } });
    const needBody = !!(expect ?? "").trim() && !/^\d{3}$/.test((expect ?? "").trim());
    const body = needBody ? (await res.text()).slice(0, 256 * 1024) : "";
    return httpOutcome(res.status, body, expect);
  } catch (e) {
    return { ok: false, error: ac.signal.aborted ? `timeout after ${timeoutMs} ms` : message((e as Error)?.cause ?? e) };
  } finally { clearTimeout(timer); }
};

/** Certificate expiry through the watch prober; fails inside TLS_MIN_DAYS of expiry with the days left as the error. */
export function tlsOutcome(validTo: string, now: Date, trust?: { trusted?: boolean; trust_error?: string; allowUntrusted?: boolean }): CheckOutcome {
  // A certificate every browser refuses (a proxy fallen back to self-signed, the wrong name) is down whatever its date;
  // `expect: "self-signed"` is for a machine that has only its own certificate on purpose.
  if (trust?.trusted === false && !trust.allowUntrusted) return { ok: false, error: `certificate not trusted: ${trust.trust_error ?? "unknown"}` };
  const days = Math.floor((new Date(validTo).getTime() - now.getTime()) / DAY_MS);
  if (!Number.isFinite(days)) return { ok: false, error: "no certificate expiry" };
  return days >= TLS_MIN_DAYS ? { ok: true } : { ok: false, error: days < 0 ? `certificate expired ${-days} days ago` : `certificate expires in ${days} days` };
}

const tlsCheck: Checker = async ({ target, expect, timeoutMs, now }) => {
  try {
    const r = await probeTls(target, timeoutMs);
    return tlsOutcome(r.valid_to, now, { ...r, allowUntrusted: /^\s*self-signed\s*$/i.test(expect ?? "") });
  } catch (e) { return { ok: false, error: message(e) }; }
};

const dnsCheck: Checker = async ({ target, expect, timeoutMs }) => {
  try {
    const addrs = await withTimeout(dns.promises.lookup(target, { all: true }), timeoutMs, "lookup");
    const want = (expect ?? "").trim();
    if (!addrs.length) return { ok: false, error: "no address" };
    if (want && !addrs.some((a) => a.address === want)) return { ok: false, error: `resolved ${addrs.map((a) => a.address).join(", ")}, expected ${want}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: message(e) }; }
};

export const defaultCheckers: Checkers = { ping: pingCheck, tcp: tcpCheck, http: httpCheck, tls: tlsCheck, dns: dnsCheck, backup: backupChecker() };

// ---------- state ----------

function openIncident(store: Store, monitorId: string): Entity | null {
  return store.list({ kind: "incident", limit: 100000, where: { monitor_id: monitorId } }).find((i) => !i.fields.closed_at) ?? null;
}

export function monitorOrThrow(store: Store, id: string): Entity {
  const m = store.get(id);
  if (!m || m.kind !== "monitor" || m.deleted_at) throw new StoreError(404, "monitor not found");
  return m;
}

function emitMonitor(hub: Hub, m: Entity, state: "up" | "down", error: string | undefined, at: string): void {
  const name = String(m.fields.name);
  hub.bus.emit("notify", { id: `monitor:${m.id}:${state}:${at}`, kind: "monitor", title: `${name} ${state}${error ? `: ${error}` : ""}`, at, name, state, ...(error ? { error } : {}) });
}

const inFlight = new WeakMap<Hub, Set<string>>();
/** Last re-notify per open incident, also kept on the incident (`renotified_at`) so a restart does not send them all again. */
const notifiedAt = new WeakMap<Hub, Map<string, number>>();
/** A machine away this long stops being a skip: no backup check for three days is worth saying, wherever it is. */
export const AWAY_LIMIT_MS = 72 * 3600_000;
const mapFor = <K, V>(wm: WeakMap<Hub, Map<K, V>>, hub: Hub): Map<K, V> => { let m = wm.get(hub); if (!m) { m = new Map(); wm.set(hub, m); } return m; };

/**
 * Run one monitor now, log the check and move the state. Transitions: `fails_before_down` consecutive failures
 * from anything but `down` opens one incident and notifies `down`; the first success from `down` closes it and
 * notifies `up`. Returns the updated monitor. Never throws on a failing check, only on an unknown monitor.
 */
export async function runCheck(hub: Hub, id: string, now: Date = new Date()): Promise<Entity> {
  const m = monitorOrThrow(hub.store, id);
  const f = m.fields as { type: MonitorType; target: string; expect?: string; timeout_s?: number; fails_before_down?: number; state?: string; consecutive_fails?: number; enabled?: boolean; last_ok?: string; last_detail?: string };
  const timeoutMs = Math.max(1, Number(f.timeout_s) || 5) * 1000;
  const checker = hub.checkers[f.type];
  const t0 = Date.now();
  let out: CheckOutcome;
  try { out = checker ? await checker({ target: String(f.target), expect: f.expect, timeoutMs, now }) : { ok: false, error: `unknown check type ${f.type}` }; } catch (e) { out = { ok: false, error: message(e) }; }
  const latency = Date.now() - t0;
  const at = now.toISOString();
  let error = out.ok ? undefined : (out.error ?? "failed").slice(0, 300);
  if (out.skip) {
    // Away: nothing is known, so nothing changes, except that "(2 h ago)" in the last detail stops being true.
    const lastOk = typeof f.last_ok === "string" ? new Date(f.last_ok).getTime() : NaN;
    const awayFor = Number.isFinite(lastOk) ? now.getTime() - lastOk : 0;
    if (awayFor < AWAY_LIMIT_MS) {
      const detail = typeof f.last_detail === "string" ? f.last_detail.replace(/ \((\d+ (min|h|days) ago)\)/g, "") : undefined;
      hub.store.patchSilent(id, { last_check: at, last_error: error ?? null, ...(detail !== undefined && detail !== f.last_detail ? { last_detail: detail } : {}) });
      return hub.store.get(id)!;
    }
    error = `${error ?? "away"}; nothing checked for ${Math.floor(awayFor / DAY_MS)} days`.slice(0, 300);
  }
  hub.db.prepare("INSERT INTO checks (monitor_id, at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)").run(id, at, out.ok ? 1 : 0, latency, error ?? null);

  // A monitor that is off can still be checked by hand: the result is shown, but it opens and closes nothing.
  if (f.enabled === false) {
    hub.store.patchSilent(id, { last_check: at, last_latency_ms: latency, last_error: error ?? null, ...(out.ok ? { last_ok: at } : {}), ...(out.detail !== undefined ? { last_detail: out.detail } : {}) });
    return hub.store.get(id)!;
  }
  const prev = f.state ?? "unknown";
  const threshold = Math.max(1, Number(f.fails_before_down) || 3);
  const fails = out.ok ? 0 : (Number(f.consecutive_fails) || 0) + 1;
  const diff: Record<string, unknown> = { last_check: at, last_latency_ms: latency, consecutive_fails: fails, last_error: error ?? null };
  if (out.detail !== undefined || f.type === "backup") diff.last_detail = out.detail ?? null;
  // Only state transitions go through the sync feed. Per-check bookkeeping (last_check, latency, failure counts)
  // is written silently: at one check a minute per monitor it would otherwise flood every client's sync.
  if (out.ok) {
    diff.last_ok = at;
    if (prev !== "up") { diff.state = "up"; hub.store.patch(id, diff); } else hub.store.patchSilent(id, diff);
    // Any open incident ends with a success, also one left from before the monitor was turned off and on again.
    const inc = openIncident(hub.store, id);
    if (inc) { hub.store.patch(inc.id, { closed_at: at }); mapFor(notifiedAt, hub).delete(inc.id); }
    if (prev === "down" || inc) emitMonitor(hub, m, "up", undefined, at);
  } else if (prev !== "down" && fails >= threshold) {
    diff.state = "down";
    hub.store.patch(id, diff);
    if (!openIncident(hub.store, id)) {
      const inc = hub.store.create("incident", { monitor_id: id, name: String(m.fields.name), opened_at: at, last_error: error, checks_failed: fails });
      mapFor(notifiedAt, hub).set(inc.id, now.getTime());
    }
    emitMonitor(hub, m, "down", error, at);
  } else {
    hub.store.patchSilent(id, diff);
    if (prev === "down") {
      const inc = openIncident(hub.store, id);
      if (inc) hub.store.patchSilent(inc.id, { last_error: error, checks_failed: (Number(inc.fields.checks_failed) || 0) + 1 });
    }
  }
  return hub.store.get(id)!;
}

/** Monitors due now: enabled, not in flight, and `last_check` missing or older than `interval_s`. */
export function dueMonitors(hub: Hub, now: Date = new Date()): Entity[] {
  const busy = inFlight.get(hub) ?? new Set<string>();
  return hub.store.list({ kind: "monitor", limit: 100000 }).filter((m) => {
    if (m.fields.enabled === false || busy.has(m.id)) return false;
    const interval = Math.max(1, Number(m.fields.interval_s) || 60) * 1000;
    const last = typeof m.fields.last_check === "string" ? new Date(m.fields.last_check).getTime() : NaN;
    return !Number.isFinite(last) || now.getTime() - last >= interval;
  });
}

/** One scheduler pass: the due monitors, at most MAX_CONCURRENT at a time, then the re-notify sweep. Returns the ids checked. */
export async function monitorTick(hub: Hub, now: Date = new Date()): Promise<string[]> {
  const queue = dueMonitors(hub, now);
  let busy = inFlight.get(hub);
  if (!busy) { busy = new Set(); inFlight.set(hub, busy); }
  const ran: string[] = [];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      busy.add(m.id);
      try { await runCheck(hub, m.id, now); ran.push(m.id); } catch (e) { console.error(`[monitors] ${m.id}: ${errCode(e)}`); } finally { busy.delete(m.id); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker));
  renotifyTick(hub, now);
  return ran;
}

/** Open, unacknowledged incidents re-notify every RENOTIFY_MS from the open or the last re-notify. Returns the ids notified. */
export function renotifyTick(hub: Hub, now: Date = new Date()): string[] {
  const last = mapFor(notifiedAt, hub);
  const out: string[] = [];
  for (const inc of hub.store.list({ kind: "incident", limit: 100000 })) {
    if (inc.fields.closed_at) { last.delete(inc.id); continue; }
    // The monitor is gone or off (deleted while down, a hand check of one that is off): the incident ends quietly,
    // acknowledged or not (one left open from a deleted monitor kept Ops saying an incident was open).
    const m = hub.store.get(String(inc.fields.monitor_id));
    if (!m || m.deleted_at || m.fields.enabled === false) {
      hub.store.patch(inc.id, { closed_at: now.toISOString() });
      last.delete(inc.id);
      continue;
    }
    if (inc.fields.acknowledged_at) { last.delete(inc.id); continue; }
    const kept = typeof inc.fields.renotified_at === "string" ? new Date(inc.fields.renotified_at).getTime() : NaN;
    const since = last.get(inc.id) ?? (Number.isFinite(kept) ? kept : new Date(String(inc.fields.opened_at)).getTime());
    if (!Number.isFinite(since) || now.getTime() - since < RENOTIFY_MS) continue;
    emitMonitor(hub, m, "down", typeof inc.fields.last_error === "string" ? inc.fields.last_error : undefined, now.toISOString());
    last.set(inc.id, now.getTime());
    hub.store.patchSilent(inc.id, { renotified_at: now.toISOString() });
    out.push(inc.id);
  }
  return out;
}

/** The 15 s loop. Overlapping passes are skipped; errors are logged and the loop keeps going. */
export function startMonitorLoop(hub: Hub, intervalMs = TICK_MS): () => void {
  let running = false;
  const tick = () => {
    if (running || !hub.modules.on("homelab")) return;
    running = true;
    monitorTick(hub).catch((e) => console.error(`[monitors] tick failed: ${errCode(e)}`)).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}

// ---------- incidents ----------

/** Acknowledge an open incident. A note also writes a `journal` entry on the monitor's host and links it. */
export function ackIncident(hub: Hub, id: string, body: { note?: unknown }, now: Date = new Date()): Entity {
  const inc = hub.store.get(id);
  if (!inc || inc.kind !== "incident" || inc.deleted_at) throw new StoreError(404, "incident not found");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new StoreError(422, "note must be a string");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const at = now.toISOString();
  const diff: Record<string, unknown> = { acknowledged_at: at };
  if (note) {
    const m = hub.store.get(String(inc.fields.monitor_id));
    const host = m && typeof m.fields.host === "string" && m.fields.host.trim() ? m.fields.host.trim() : "unknown";
    const j = hub.store.create("journal", { host, at, what: `Incident acknowledged: ${String(inc.fields.name)}: ${note}`.slice(0, 1000), risk: "low", outcome: "done" });
    diff.ack_note = note;
    diff.journal_id = j.id;
  }
  hub.store.patch(id, diff);
  mapFor(notifiedAt, hub).delete(id);
  return hub.store.get(id)!;
}

// ---------- checks table ----------

export function history(hub: Hub, id: string, hours: number, now: Date = new Date()): CheckRow[] {
  monitorOrThrow(hub.store, id);
  const since = new Date(now.getTime() - hours * 3600_000).toISOString();
  const rows = hub.db.prepare("SELECT at, ok, latency_ms, error FROM checks WHERE monitor_id = ? AND at >= ? ORDER BY at ASC, id ASC").all(id, since) as { at: string; ok: number; latency_ms: number | null; error: string | null }[];
  return rows.map((r) => ({ at: r.at, ok: r.ok === 1, latency_ms: r.latency_ms, ...(r.error ? { error: r.error } : {}) }));
}

/** Percent of ok checks in the last 24 h per monitor, null with no checks. Two decimals. */
export function uptime24h(hub: Hub, now: Date = new Date()): { name: string; pct: number | null }[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = hub.db.prepare("SELECT monitor_id, COUNT(*) AS n, SUM(ok) AS oks FROM checks WHERE at >= ? GROUP BY monitor_id").all(since) as { monitor_id: string; n: number; oks: number }[];
  const byId = new Map(rows.map((r) => [r.monitor_id, r]));
  return hub.store.list({ kind: "monitor", limit: 100000 })
    .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)))
    .map((m) => { const r = byId.get(m.id); return { name: String(m.fields.name), pct: r && r.n ? Math.round((r.oks / r.n) * 10000) / 100 : null }; });
}

export function pruneChecks(hub: Hub, keepDays = CHECK_KEEP_DAYS, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - Math.max(1, keepDays) * DAY_MS).toISOString();
  const n = hub.db.prepare("DELETE FROM checks WHERE at < ?").run(cutoff).changes;
  if (n) console.log(`[monitors] pruned ${n} checks older than ${keepDays} days`);
  return n;
}

/** Once a night at 03:30 local. */
export function startCheckPruneJob(hub: Hub): () => void {
  return scheduleDaily("checks", 3, 30, () => { pruneChecks(hub); });
}

// ---------- views ----------

export function opsView(hub: Hub, now: Date = new Date()): Record<string, unknown> {
  const incidents = hub.store.list({ kind: "incident", limit: 100000 });
  const open = incidents.filter((i) => !i.fields.closed_at).sort((a, b) => String(b.fields.opened_at).localeCompare(String(a.fields.opened_at)));
  const openByMonitor = new Map(open.map((i) => [String(i.fields.monitor_id), i]));
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const limit30 = now.getTime() + 30 * DAY_MS;
  const monitors = hub.store.list({ kind: "monitor", limit: 100000 })
    .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)))
    .map((m) => ({ ...m, incident_open: openByMonitor.get(m.id) ?? null }));
  // Renewals that are off stay out of Ops and the ops_status tool.
  const watches = (hub.modules.on("renewals") ? hub.store.list({ kind: "watch", limit: 100000 }) : [])
    .filter((w) => { const due = localDateOf(w.fields.due).getTime(); return Number.isFinite(due) && due <= limit30; })
    .sort((a, b) => localDateOf(a.fields.due).getTime() - localDateOf(b.fields.due).getTime());
  const journal = hub.store.list({ kind: "journal", limit: 100000 }).sort((a, b) => String(b.fields.at ?? "").localeCompare(String(a.fields.at ?? ""))).slice(0, 10);
  return {
    monitors,
    incidents_open: open,
    incidents_7d: incidents.filter((i) => String(i.fields.opened_at) >= since7).length,
    uptime_24h: uptime24h(hub, now),
    watches_due_30d: watches,
    journal_recent: journal,
    hosts: hostsSummary(hub.store),
  };
}

/**
 * Disabling a monitor takes it out of the picture: its state becomes `unknown` and any open incident is closed,
 * so a monitor that is off never shows as down or keeps re-notifying.
 */
export function installMonitorHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    // Off or deleted: its incident closes (a deleted monitor that was down re-notified every 6 hours for good).
    if (entity.kind !== "monitor" || (!entity.deleted_at && entity.fields.enabled !== false)) return;
    const at = new Date().toISOString();
    const inc = openIncident(hub.store, entity.id);
    if (inc) { hub.store.patch(inc.id, { closed_at: at }); mapFor(notifiedAt, hub).delete(inc.id); }
    if (entity.deleted_at) return;
    if (entity.fields.state !== "unknown" || entity.fields.consecutive_fails) hub.store.patch(entity.id, { state: "unknown", consecutive_fails: 0 });
  });
}

export function opsStatus(hub: Hub): { monitors: number; down: number; incidents_open: number } {
  const monitors = hub.store.list({ kind: "monitor", limit: 100000 });
  return {
    monitors: monitors.length,
    down: monitors.filter((m) => m.fields.enabled !== false && m.fields.state === "down").length,
    incidents_open: hub.store.list({ kind: "incident", limit: 100000 }).filter((i) => !i.fields.closed_at).length,
  };
}

/** Seed monitors from `monitors.json`, matched by name and created only when missing. */
export function seedMonitors(store: Store, rows: Record<string, unknown>[]): { created: number; kept: number } {
  const out = { created: 0, kept: 0 };
  const existing = store.list({ kind: "monitor", includeDeleted: true });
  for (const raw of rows) {
    const name = String(raw.name ?? "").trim();
    if (!name) continue;
    if (existing.some((m) => String(m.fields.name).toLowerCase() === name.toLowerCase())) { out.kept++; continue; }
    store.create("monitor", { enabled: true, ...raw, name });
    out.created++;
  }
  return out;
}
