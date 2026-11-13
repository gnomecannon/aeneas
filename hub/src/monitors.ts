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
import { backupChecker, backupHours, DEFAULT_HOURS, fmt as fmtLocal, parseBackupTarget, type BackupJob, type BackupJobState, type BackupTarget } from "./backups.js";
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
/**
 * `skip`: the check could not look (an unreachable machine), so it neither counts nor moves the state. `detail`: a line
 * about the thing checked, shown with the monitor. `jobs`: a backup machine's jobs, one line each (kept on the monitor).
 */
export interface CheckOutcome { ok: boolean; error?: string; skip?: boolean; detail?: string; jobs?: BackupJobState[] }
export type Checker = (input: CheckInput) => Promise<CheckOutcome>;
export type Checkers = Record<MonitorType, Checker>;
export interface CheckRow { at: string; ok: boolean; latency_ms: number | null; error?: string }

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** "5 s", "1.5 s": a timeout as people say it. */
export const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * A network failure in words for alerts ("Ollama down: refused the connection on port 11434") instead of Node's codes
 * ("connect ECONNREFUSED 100.64.0.7:11434"). Unknown errors keep their own message.
 */
export function netWords(e: unknown): string {
  const err = ((e as { cause?: unknown })?.cause ?? e) as NodeJS.ErrnoException & { port?: number; hostname?: string };
  const port = err?.port ?? /:(\d+)\s*$/.exec(String(err?.message ?? ""))?.[1];
  switch (err?.code) {
    case "ECONNREFUSED": return `refused the connection${port ? ` on port ${port}` : ""}: nothing is listening there`;
    case "EHOSTUNREACH":
    case "EHOSTDOWN": return "no route to the machine: it is off, asleep or off the network";
    case "ENETUNREACH": return "no route to that network from the hub";
    case "ETIMEDOUT": return "the connection timed out";
    case "ECONNRESET": return "the connection was cut off";
    case "ENOTFOUND": return `the name ${err.hostname ?? ""} was not found`.replace("  ", " ");
    case "EAI_AGAIN": return "the name could not be looked up: DNS did not answer";
    default: return message(err);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} within ${seconds(ms)}`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * One ICMP packet through the system ping. Linux `-W` is seconds; macOS wants `-t` seconds (its `-W` is milliseconds);
 * Windows counts with `-n` and waits `-w` milliseconds (its `-c` is a routing compartment).
 */
export function pingArgs(target: string, timeoutMs: number, platform: NodeJS.Platform = process.platform): string[] {
  const sec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  if (platform === "win32") return ["-n", "1", "-w", String(Math.max(1, Math.round(timeoutMs))), target];
  return platform === "darwin" ? ["-c", "1", "-t", sec, target] : ["-c", "1", "-W", sec, target];
}

const pingCheck: Checker = ({ target, timeoutMs }) => new Promise((resolve) => {
  // A target starting with "-" would be read as a ping option.
  if (!/^[A-Za-z0-9[]/.test(target)) { resolve({ ok: false, error: "target must be a host name or address" }); return; }
  execFile("ping", pingArgs(target, timeoutMs), { timeout: timeoutMs + 1000 }, (err, _stdout, stderr) => {
    if (!err) { resolve({ ok: true }); return; }
    // ping says nothing when no reply came (exit 1 on Linux, 2 on macOS); it writes why when it could not ping at all.
    const text = String(stderr ?? "").trim().split("\n")[0].replace(/^ping:\s*/, "");
    resolve({ ok: false, error: text || `no reply within ${seconds(timeoutMs)}` });
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
  socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `no connection within ${seconds(timeoutMs)}` }));
  socket.once("connect", () => finish({ ok: true }));
  socket.once("error", (e) => finish({ ok: false, error: netWords(e) }));
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
    return { ok: false, error: ac.signal.aborted ? `no answer within ${seconds(timeoutMs)}` : netWords(e) };
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
    const addrs = await withTimeout(dns.promises.lookup(target, { all: true }), timeoutMs, "no answer from DNS");
    const want = (expect ?? "").trim();
    if (!addrs.length) return { ok: false, error: "no address" };
    if (want && !addrs.some((a) => a.address === want)) return { ok: false, error: `resolved ${addrs.map((a) => a.address).join(", ")}, expected ${want}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: netWords(e) }; }
};

export const defaultCheckers: Checkers = { ping: pingCheck, tcp: tcpCheck, http: httpCheck, tls: tlsCheck, dns: dnsCheck, backup: backupChecker() };

// ---------- state ----------

function openIncident(store: Store, monitorId: string): Entity | null {
  return store.list({ kind: "incident", limit: 100000, where: { monitor_id: monitorId } }).find((i) => !i.fields.closed_at) ?? null;
}

const hostKey = (h: unknown) => (typeof h === "string" ? h.trim().toLowerCase() : "");
const openIncidents = (store: Store) => store.list({ kind: "incident", limit: 100000 }).filter((i) => !i.fields.closed_at && !i.deleted_at);
const pingsOn = (store: Store, host: string) =>
  store.list({ kind: "monitor", limit: 100000 }).filter((p) => p.fields.type === "ping" && p.fields.enabled !== false && !p.deleted_at && hostKey(p.fields.host) === host);

/**
 * The machine stopped answering: every ping monitor on it is down (`failing` counts as down, the ping being checked
 * now). A machine with no ping monitor never counts, and one that still answers on another address is reachable.
 */
function machineDown(store: Store, host: string, failing: string): boolean {
  const pings = pingsOn(store, host);
  return pings.length > 0 && pings.every((p) => p.id === failing || p.fields.state === "down");
}

/** The open incident a ping monitor on this machine opened (not `except`'s own): the machine's incident. */
function machineIncident(store: Store, host: string, except: string): Entity | null {
  const pings = new Set(pingsOn(store, host).map((p) => p.id));
  return openIncidents(store).find((i) => String(i.fields.monitor_id) !== except && pings.has(String(i.fields.monitor_id))) ?? null;
}

/** Note on the machine's incident that this monitor is down with it (`also_down`, by name). */
function joinIncident(hub: Hub, m: Entity, incId: string): void {
  const inc = hub.store.get(incId);
  if (!inc) return;
  const also = Array.isArray(inc.fields.also_down) ? inc.fields.also_down.map(String) : [];
  const name = String(m.fields.name);
  if (!also.includes(name)) hub.store.patch(inc.id, { also_down: [...also, name] });
}

/** Services that went down shortly before their machine stopped answering are part of the machine's outage. */
export const FOLD_MS = 15 * 60_000;

/**
 * The machine just stopped answering: incidents of other monitors on it, opened in the last FOLD_MS and not
 * acknowledged, close into the machine's incident (`merged_into`), and those monitors join it. A service that checks
 * more often than the pings (Ollama every minute, pings every 2) goes down first, so the machine's incident came second.
 */
function foldIntoMachine(hub: Hub, machine: Entity, host: string, now: Date): void {
  for (const inc of openIncidents(hub.store)) {
    if (inc.id === machine.id || inc.fields.acknowledged_at) continue;
    const owner = hub.store.get(String(inc.fields.monitor_id));
    if (!owner || owner.deleted_at || owner.fields.type === "ping" || hostKey(owner.fields.host) !== host) continue;
    if (now.getTime() - Date.parse(String(inc.fields.opened_at)) > FOLD_MS) continue;
    hub.store.patch(inc.id, { closed_at: now.toISOString(), merged_into: machine.id });
    mapFor(notifiedAt, hub).delete(inc.id);
    hub.store.patch(owner.id, { joined_incident: machine.id });
    joinIncident(hub, owner, machine.id);
  }
}

/** For a re-notify: the monitors still down under this machine's incident (`also_down` keeps every one that joined). */
function alsoDown(store: Store, inc: Entity): string {
  const names = store.list({ kind: "monitor", limit: 100000 }).filter((m) => m.fields.joined_incident === inc.id && m.fields.state === "down").map((m) => String(m.fields.name)).sort((a, b) => a.localeCompare(b));
  return names.length ? `; also down: ${names.join(", ")}` : "";
}

export function monitorOrThrow(store: Store, id: string): Entity {
  const m = store.get(id);
  if (!m || m.kind !== "monitor" || m.deleted_at) throw new StoreError(404, "monitor not found");
  return m;
}

/** A monitor's alert. A down alert carries its incident, so a notification can acknowledge it without opening Ops. */
function emitMonitor(hub: Hub, m: Entity, state: "up" | "down", error: string | undefined, at: string, incidentId?: string, title?: string): void {
  const name = String(m.fields.name);
  hub.bus.emit("notify", { id: `monitor:${m.id}:${state}:${at}`, kind: "monitor", title: title ?? `${name} ${state}${error ? `: ${error}` : ""}`, at, name, state, ...(error ? { error } : {}), ...(incidentId ? { incident_id: incidentId } : {}) });
}

/** Each running check by monitor id: a hand check of a monitor the loop is checking waits for that check. */
const inFlight = new WeakMap<Hub, Map<string, Promise<Entity>>>();
/** Last re-notify per open incident, also kept on the incident (`renotified_at`) so a restart does not send them all again. */
const notifiedAt = new WeakMap<Hub, Map<string, number>>();
/** A machine away this long stops being a skip: no backup check for three days is worth saying, wherever it is. */
export const AWAY_LIMIT_MS = 72 * 3600_000;
const mapFor = <K, V>(wm: WeakMap<Hub, Map<K, V>>, hub: Hub): Map<K, V> => { let m = wm.get(hub); if (!m) { m = new Map(); wm.set(hub, m); } return m; };
const AGO = / \((\d+ (min|h|days) ago)\)/g;

type MonitorFieldsT = { type: MonitorType; target: string; host?: string; expect?: string; timeout_s?: number; fails_before_down?: number; state?: string; consecutive_fails?: number; enabled?: boolean; last_ok?: string; last_reached?: string; last_detail?: string; joined_incident?: string };

/**
 * Run one monitor now, log the check and move the state. Transitions: `fails_before_down` consecutive failures
 * from anything but `down` opens one incident and notifies `down` (or joins its machine's incident, see
 * machineIncident); the first success from `down` closes it and notifies `up`. A check of a monitor already being
 * checked returns that check. Returns the updated monitor. Never throws on a failing check, only on an unknown monitor.
 */
export function runCheck(hub: Hub, id: string, now: Date = new Date()): Promise<Entity> {
  const running = mapFor(inFlight, hub);
  const cur = running.get(id);
  if (cur) return cur;
  const p = checkOnce(hub, id, now).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

async function checkOnce(hub: Hub, id: string, now: Date): Promise<Entity> {
  const before = monitorOrThrow(hub.store, id);
  const f0 = before.fields as MonitorFieldsT;
  const timeoutMs = Math.max(1, Number(f0.timeout_s) || 5) * 1000;
  const checker = hub.checkers[f0.type];
  const t0 = Date.now();
  let out: CheckOutcome;
  try { out = checker ? await checker({ target: String(f0.target), expect: f0.expect, timeoutMs, now }) : { ok: false, error: `unknown check type ${f0.type}` }; } catch (e) { out = { ok: false, error: message(e) }; }
  const latency = Date.now() - t0;
  // Read again: the monitor may have been turned off, edited or deleted while it was being checked.
  const m = hub.store.get(id);
  if (!m || m.deleted_at) return before;
  const f = m.fields as MonitorFieldsT;
  const at = now.toISOString();
  let error = out.ok ? undefined : (out.error ?? "failed").slice(0, 300);
  let awayLimit = false;
  if (out.skip) {
    // Away: nothing is known, so nothing changes, except that "(2 h ago)" stops being true. Counted from the last time
    // the machine answered at all, else from when the monitor was made (a name typed wrong stayed unknown for good).
    const since = Date.parse(f.last_reached ?? f.last_ok ?? m.created_at);
    const awayFor = Number.isFinite(since) ? now.getTime() - since : 0;
    if (awayFor < AWAY_LIMIT_MS) {
      const detail = typeof f.last_detail === "string" ? f.last_detail.replace(AGO, "") : undefined;
      hub.store.patchSilent(id, { last_check: at, last_error: error ?? null, ...(detail !== undefined && detail !== f.last_detail ? { last_detail: detail } : {}) });
      // An open incident's error too: every 6 hour reminder repeated "(33 h ago)".
      const inc = openIncident(hub.store, id);
      if (inc && typeof inc.fields.last_error === "string" && AGO.test(inc.fields.last_error)) hub.store.patchSilent(inc.id, { last_error: inc.fields.last_error.replace(AGO, "") });
      AGO.lastIndex = 0;
      return hub.store.get(id)!;
    }
    error = `${error ?? "away"}; nothing checked for ${Math.floor(awayFor / DAY_MS)} days`.slice(0, 300);
    awayLimit = true;
  }
  hub.db.prepare("INSERT INTO checks (monitor_id, at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)").run(id, at, out.ok ? 1 : 0, latency, error ?? null);
  const reached = awayLimit ? {} : { last_reached: at };

  // A monitor that is off can still be checked by hand: the result is shown, but it opens and closes nothing.
  if (f.enabled === false) {
    hub.store.patchSilent(id, { last_check: at, last_latency_ms: latency, last_error: error ?? null, ...reached, ...(out.ok ? { last_ok: at } : {}), ...(out.detail !== undefined ? { last_detail: out.detail } : {}), ...(out.jobs ? { jobs: out.jobs } : {}) });
    return hub.store.get(id)!;
  }
  const prev = f.state ?? "unknown";
  const threshold = Math.max(1, Number(f.fails_before_down) || 3);
  const fails = out.ok ? 0 : (Number(f.consecutive_fails) || 0) + 1;
  const host = hostKey(f.host);
  const isPing = f.type === "ping";
  const diff: Record<string, unknown> = { last_check: at, last_latency_ms: latency, consecutive_fails: fails, last_error: error ?? null, ...reached };
  if (out.detail !== undefined || f.type === "backup") diff.last_detail = out.detail ?? null;
  if (out.jobs) diff.jobs = out.jobs;
  const ownIncident = (): Entity => {
    const inc = hub.store.create("incident", { monitor_id: id, name: String(m.fields.name), opened_at: at, last_error: error, checks_failed: fails });
    mapFor(notifiedAt, hub).set(inc.id, now.getTime());
    emitMonitor(hub, m, "down", error, at, inc.id);
    return inc;
  };
  /** Down while its machine does not answer: the machine's incident to join, if it has one. */
  const machine = (): Entity | null => (host && machineDown(hub.store, host, id) ? machineIncident(hub.store, host, id) : null);
  // Only state transitions go through the sync feed. Per-check bookkeeping (last_check, latency, failure counts)
  // is written silently: at one check a minute per monitor it would otherwise flood every client's sync.
  if (out.ok) {
    diff.last_ok = at;
    if (f.joined_incident) diff.joined_incident = null;
    if (prev !== "up") { diff.state = "up"; hub.store.patch(id, diff); } else hub.store.patchSilent(id, diff);
    // Any open incident ends with a success, also one left from before the monitor was turned off and on again.
    const inc = openIncident(hub.store, id);
    if (inc) {
      hub.store.patch(inc.id, { closed_at: at });
      mapFor(notifiedAt, hub).delete(inc.id);
      // The machine answers again: what went down with it gets its full count of failures before it is a problem of
      // its own (a service starting a minute after its machine woke sent a down and an up alert).
      for (const j of hub.store.list({ kind: "monitor", limit: 100000 })) if (j.fields.joined_incident === inc.id && j.fields.state === "down") hub.store.patchSilent(j.id, { consecutive_fails: 0 });
    }
    // A monitor that was down only as part of its machine's incident comes back quietly: the machine's alert says so.
    if (inc || (prev === "down" && !f.joined_incident)) emitMonitor(hub, m, "up", undefined, at);
  } else if (prev !== "down" && fails >= threshold) {
    diff.state = "down";
    const own = openIncident(hub.store, id);
    const shared = own ? null : machine();
    if (shared) {
      diff.joined_incident = shared.id;
      hub.store.patch(id, diff);
      joinIncident(hub, m, shared.id);
      if (isPing) foldIntoMachine(hub, shared, host, now);
    } else {
      hub.store.patch(id, diff);
      if (own) emitMonitor(hub, m, "down", error, at, own.id);
      const inc = own ?? ownIncident();
      // The last ping of the machine to go down: its incident is the machine's.
      if (isPing && host && machineDown(hub.store, host, id)) foldIntoMachine(hub, inc, host, now);
    }
  } else {
    hub.store.patchSilent(id, diff);
    if (prev === "down") {
      const inc = openIncident(hub.store, id);
      // Three days away after a failure: the failure stays the reason given.
      if (inc) hub.store.patchSilent(inc.id, { ...(awayLimit ? {} : { last_error: error }), checks_failed: (Number(inc.fields.checks_failed) || 0) + 1 });
      else if (f.joined_incident) {
        const was = hub.store.get(f.joined_incident);
        const open = !!was && !was.deleted_at && !was.fields.closed_at;
        if (!open && fails >= threshold) {
          // Its machine answers again but this monitor still fails: now it is a problem of its own.
          const shared = machine();
          if (shared) { hub.store.patch(id, { joined_incident: shared.id }); joinIncident(hub, m, shared.id); }
          else { hub.store.patch(id, { joined_incident: null }); ownIncident(); }
        }
      }
    }
  }
  return hub.store.get(id)!;
}

/** Monitors due now: enabled, not in flight, and `last_check` missing or older than `interval_s`. */
export function dueMonitors(hub: Hub, now: Date = new Date()): Entity[] {
  const busy = inFlight.get(hub) ?? new Map<string, Promise<Entity>>();
  return hub.store.list({ kind: "monitor", limit: 100000 }).filter((m) => {
    if (m.fields.enabled === false || busy.has(m.id)) return false;
    const interval = Math.max(1, Number(m.fields.interval_s) || 60) * 1000;
    const last = typeof m.fields.last_check === "string" ? new Date(m.fields.last_check).getTime() : NaN;
    return !Number.isFinite(last) || now.getTime() - last >= interval;
  });
}

/** One scheduler pass that waits for its checks: the due monitors, at most MAX_CONCURRENT at a time, then the re-notify sweep. Returns the ids checked. */
export async function monitorTick(hub: Hub, now: Date = new Date()): Promise<string[]> {
  const queue = dueMonitors(hub, now);
  const ran: string[] = [];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try { await runCheck(hub, m.id, now); ran.push(m.id); } catch (e) { console.error(`[monitors] ${m.id}: ${errCode(e)}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker));
  renotifyTick(hub, now);
  return ran;
}

/** "since Nov 13, 9:14 PM (6 h)": how long an incident has been open, for its reminders. */
function openFor(inc: Entity, now: Date): string {
  const opened = Date.parse(String(inc.fields.opened_at));
  if (!Number.isFinite(opened)) return "";
  const h = (now.getTime() - opened) / 3600_000;
  return ` since ${fmtLocal(opened)} (${h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`})`;
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
    const error = `${typeof inc.fields.last_error === "string" ? inc.fields.last_error : "no reason recorded"}${alsoDown(hub.store, inc)}`;
    emitMonitor(hub, m, "down", error, now.toISOString(), inc.id, `${String(m.fields.name)} still down${openFor(inc, now)}: ${error}`);
    last.set(inc.id, now.getTime());
    hub.store.patchSilent(inc.id, { renotified_at: now.toISOString() });
    out.push(inc.id);
  }
  return out;
}

/**
 * The 15 s loop: starts each due check on its own, at most MAX_CONCURRENT at a time, without waiting for them (one
 * slow ssh read held up every ping and web check behind it), then the re-notify sweep. Errors are logged.
 */
export function startMonitorLoop(hub: Hub, intervalMs = TICK_MS): () => void {
  const tick = () => {
    if (!hub.modules.on("homelab")) return;
    try {
      const running = mapFor(inFlight, hub);
      for (const m of dueMonitors(hub)) {
        if (running.size >= MAX_CONCURRENT) break;
        runCheck(hub, m.id).catch((e) => console.error(`[monitors] ${m.id}: ${errCode(e)}`));
      }
      renotifyTick(hub);
    } catch (e) { console.error(`[monitors] tick failed: ${errCode(e)}`); }
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
  const openById = new Map(open.map((i) => [i.id, i]));
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const limit30 = now.getTime() + 30 * DAY_MS;
  const monitors = hub.store.list({ kind: "monitor", limit: 100000 })
    .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)))
    // A monitor down with its machine shows the machine's incident (one Acknowledge for all of them).
    .map((m) => ({ ...m, incident_open: openByMonitor.get(m.id) ?? (typeof m.fields.joined_incident === "string" ? openById.get(m.fields.joined_incident) : undefined) ?? null }));
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
    if (entity.fields.state !== "unknown" || entity.fields.consecutive_fails || entity.fields.joined_incident) hub.store.patch(entity.id, { state: "unknown", consecutive_fails: 0, joined_incident: null });
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

/**
 * Since 2026-11-13 one backup monitor reads every job of its machine (backups.ts). Monitors made before that for one
 * job (`#verify`, `#restore`) beside the machine's backup monitor are folded into it: their hours go into its `expect`
 * when they differ from the defaults, its timeout becomes the longest of them, and they are deleted (their incidents
 * close with them). Only a machine monitor never checked as a whole (no `jobs` yet) takes them in, so a job monitor
 * added again later on purpose is left alone. Returns how many were folded in.
 */
export function mergeBackupMonitors(store: Store): number {
  const parsed = store.list({ kind: "monitor", limit: 100000 })
    .filter((m) => m.fields.type === "backup")
    .map((m) => { try { return { m, t: parseBackupTarget(String(m.fields.target ?? "")) }; } catch { return null; } })
    .filter((x): x is { m: Entity; t: BackupTarget } => !!x);
  const machine = (t: BackupTarget) => `${t.os}:${t.dest}`.toLowerCase();
  let folded = 0;
  for (const { m, t } of parsed) {
    if (t.single || Array.isArray(m.fields.jobs)) continue;
    // Only monitors that are on or off together: folding a verification that is on into a machine monitor that is off
    // stopped checking it, and one that is off came back on.
    const parts = parsed.filter((p) => p.m.id !== m.id && p.t.single && p.t.jobs[0] !== "backup" && machine(p.t) === machine(t) && (p.m.fields.enabled !== false) === (m.fields.enabled !== false));
    if (!parts.length) continue;
    const hours = backupHours(typeof m.fields.expect === "string" ? m.fields.expect : undefined, t);
    for (const p of parts) {
      const job: BackupJob = p.t.jobs[0];
      hours[job] = backupHours(typeof p.m.fields.expect === "string" ? p.m.fields.expect : undefined, p.t)[job];
    }
    const expect = [String(hours.backup), ...(["verify", "restore"] as const).filter((j) => hours[j] !== DEFAULT_HOURS[j]).map((j) => `${j}=${hours[j]}`)].join(",");
    const timeout = Math.max(...[m, ...parts.map((p) => p.m)].map((x) => Number(x.fields.timeout_s) || 5));
    store.patch(m.id, { expect, timeout_s: timeout });
    const now = new Date().toISOString();
    for (const p of parts) {
      // An open incident moves to the machine's monitor, acknowledged or not, instead of closing and coming back as a
      // new alert at its next check; the machine monitor's own open incident, if it has one, already covers it.
      const inc = openIncident(store, p.m.id);
      if (inc) {
        if (openIncident(store, m.id)) store.patch(inc.id, { closed_at: now, merged_into: openIncident(store, m.id)!.id });
        else { store.patch(inc.id, { monitor_id: m.id, name: String(m.fields.name) }); store.patch(m.id, { state: "down", consecutive_fails: Math.max(1, Number(p.m.fields.consecutive_fails) || 1) }); }
      }
      store.patch(p.m.id, { deleted_at: now });
    }
    folded += parts.length;
    console.log(`[monitors] backup monitor ${m.id.slice(0, 8)} now reads its machine's other jobs too; ${parts.length} one-job monitor(s) removed`);
  }
  return folded;
}
