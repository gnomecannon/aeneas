import type { Entity } from "@everythingapp/shared";
import { withPriority } from "./ai/backends.js";
import { findHost, loadHosts, type Host, type HostOs } from "./ai/hosts.js";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { sensorHosts } from "./hostsensors.js";
import { hostFacts, hostsSummary } from "./memory.js";
import { monitorOrThrow } from "./monitors.js";
import { backupWhere, parseBackupTarget } from "./backups.js";
import { diaryDay } from "./diary.js";
import { personalize } from "./profile.js";
import { errCode } from "./logsafe.js";
import { foldMachineInfo, readMachineInfo, type Category } from "./machineinfo.js";

/**
 * Tech (Module 4 and 6, since 2026-11-19): every check and reading belongs to one thing, so the apps show one card
 * and one page per thing instead of a screen for checks, one for machines and one for sensors.
 * - `machine`: a computer, gateway, NAS or VM: one the person added (Machines, hosts.json), the host of a ping or
 *   backup check, a host with fix notes, changes or snippets, or a name no dot makes a web address.
 * - `service`: a web address or name with no machine of the person's behind it (a site, a cloud API).
 * - `place`: where home sensor boards are (their `location`, e.g. Garage); boards with no location are Home.
 * A service on one of the person's machines (Ollama on the gaming PC) is a check on that machine, not a thing of its
 * own: when a machine stops answering the hub already makes one incident of it and its services.
 */

export type ThingKind = "machine" | "service" | "place";
export interface Thing {
  /** The key, lowercase: what pages and links use (`/hosts/<name>`). */
  name: string;
  /** As people wrote it (a place's "Garage"); the key otherwise. */
  label: string;
  kind: ThingKind;
  /** Monitor ids, by name. */
  monitors: string[];
  /** Sensor names, by name. */
  sensors: string[];
  /** One of the machines the person added: the hub reads its CPU, memory and disks and the assistant can run commands on it. */
  reachable: boolean;
  os?: HostOs;
  /** The machine the hub runs on. */
  hub?: boolean;
  /** What the machine itself says it runs (machineinfo.ts): machines the hub signs in to, and VMs with a guest agent. */
  os_name?: string;
  /** What kind of device it is, only with decent confidence (identify.ts); none: not identified. */
  category?: Category;
  /** The exact name it gives for itself (a printer's make and model), shown beside the kind. */
  model?: string;
  /** A virtual machine or container on this Proxmox host, and its state there. */
  vm_of?: string;
  vm_state?: string;
  /** What it is for, in the owner's words: its fact `host:<name>` in Memory, which the assistant reads too. */
  purpose?: string;
  /** A computer its own Aeneas app reports (PUT /devices/me/computer), which the hub does not sign in to. */
  reports_itself?: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const RANK: Record<ThingKind, number> = { machine: 0, service: 1, place: 2 };

/** The host a check is about when it names none: the machine or address in its target. */
export function targetHost(type: string, target: string): string {
  let t = String(target ?? "").trim();
  // A backup target is `<os>:<ssh destination>`, with `#job` after it.
  if (type === "backup") t = t.replace(/^(mac|macos|windows|linux):/i, "").replace(/#.*$/, "");
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").replace(/^[^@]*@/, "");
  const v6 = /^\[([^\]]+)\]/.exec(t);
  if (v6) return v6[1].toLowerCase();
  return t.replace(/:\d+$/, "").toLowerCase();
}

/** Every thing with its checks and readings, machines first. */
export function techThings(hub: Hub): Thing[] {
  const hosts = sensorHosts(loadHosts(hub.cfg));
  const things = new Map<string, Thing>();
  const known = (n: string): Host | null => findHost(hosts, n) ?? (n.endsWith("-wifi") ? findHost(hosts, n.slice(0, -5)) : null);
  /** A name as its thing's key: a machine's alias or full name (core.example.ts.net) is that machine. */
  const key = (raw: string): string => {
    const n = raw.trim().toLowerCase().replace(/\.local$/, "");
    if (!n) return "";
    const h = known(n) ?? (n.includes(".") && !IPV4.test(n) ? known(n.split(".")[0]) : null);
    if (h) return h.name;
    if (n.endsWith("-wifi") && things.has(n.slice(0, -5))) return n.slice(0, -5);
    return n;
  };
  const thing = (name: string, kind: ThingKind, label = name): Thing => {
    let t = things.get(name);
    if (!t) { t = { name, label, kind, monitors: [], sensors: [], reachable: false }; things.set(name, t); }
    // A machine stays a machine: a ping or a sensor of its own outranks a web check that named it first.
    else if (kind === "machine" && t.kind !== "machine") t.kind = "machine";
    return t;
  };
  for (const h of hosts) Object.assign(thing(h.name, "machine"), { reachable: true, os: h.os, ...(h.local ? { hub: true } : {}) });

  const monitors = hub.store.list({ kind: "monitor", limit: 100000 }).sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  for (const m of monitors) {
    const type = String(m.fields.type ?? "");
    const k = key(String(m.fields.host ?? "") || targetHost(type, String(m.fields.target ?? "")));
    if (!k) continue;
    const isMachine = !!known(k) || type === "ping" || type === "backup" || !k.includes(".") || IPV4.test(k) || k.includes(":");
    thing(k, isMachine ? "machine" : "service").monitors.push(m.id);
  }
  for (const r of hostsSummary(hub.store)) { const k = key(r.host); if (k) thing(k, "machine"); }

  const sensors = hub.store.list({ kind: "sensor", limit: 10000 }).sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  for (const s of sensors) {
    const name = String(s.fields.name ?? "");
    const loc = String(s.fields.location ?? "").trim();
    const k = loc ? key(loc) : "home";
    // A machine's own readings are named after it (core.disk.root.used); a board somewhere is a place.
    const own = !!loc && name.toLowerCase().startsWith(`${loc.toLowerCase()}.`);
    const t = things.get(k) ?? thing(k, own || known(k) ? "machine" : "place", loc || "Home");
    t.sensors.push(name);
  }
  const info = readMachineInfo(hub);
  // A computer its app reports is a machine even before its first reading (Sensors off shows it with its OS).
  for (const [n, i] of Object.entries(info)) if (i.reported_by && !things.has(n)) thing(n, "machine");
  const purposes = hostFacts(hub.store);
  for (const t of things.values()) {
    const i = info[t.name];
    if (i?.os) t.os_name = i.os;
    if (i?.category) t.category = i.category;
    if (i?.model) t.model = i.model;
    if (i?.vm_of) { t.vm_of = i.vm_of; if (i.vm_state) t.vm_state = i.vm_state; }
    const p = purposes.get(t.name);
    if (p) t.purpose = p;
    if (i?.reported_by && !t.reachable) t.reports_itself = true;
  }
  return [...things.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.name.localeCompare(b.name));
}

/**
 * The starter check "hub health" (deploy/seed/monitors.json) named its machine "hub" until 2026-11-25, so every hub
 * showed a machine called hub beside the machine it runs on, which it is. What was kept under "hub" moves to the hub's
 * own machine: its checks, changes, fix notes and snippets, its purpose in Memory (unless that machine has one) and what
 * kind of device it is, so the machine's history stays together. A check's own history and incidents go by the
 * check, and stay. Left alone when "hub" is another machine the hub knows, or the name of its own. Runs as the hub
 * starts; returns how many items moved.
 */
export function foldHubMachine(hub: Hub): number {
  const old = "hub";
  const hosts = loadHosts(hub.cfg);
  const own = hosts.find((h) => h.local);
  if (!own || own.name === old || own.aliases.includes(old)) return 0;
  if (hosts.some((h) => h.name === old || h.aliases.includes(old))) return 0;
  const to = own.name;
  const named = (v: unknown) => String(v ?? "").trim().toLowerCase();
  let moved = 0;
  for (const kind of ["monitor", "journal", "runbook", "snippet"] as const) {
    for (const e of hub.store.list({ kind, limit: 1_000_000 })) {
      if (named(e.fields.host) !== old) continue;
      const title = kind === "runbook" && named(e.fields.title) === `fix notes: ${old}` ? { title: `Fix notes: ${to}` } : {};
      hub.store.patch(e.id, { host: to, ...title });
      moved++;
    }
  }
  const facts = hub.store.list({ kind: "fact", limit: 100000 });
  const fact = facts.find((f) => named(f.fields.key) === `host:${old}`);
  if (fact && !facts.some((f) => named(f.fields.key) === `host:${to}`)) { hub.store.patch(fact.id, { key: `host:${to}` }); moved++; }
  if (foldMachineInfo(hub, old, to)) moved++;
  return moved;
}

const TYPE_WORDS: Record<string, string> = { ping: "ping", tcp: "port", http: "web address", tls: "certificate", dns: "name lookup", backup: "backup" };

/** For a backup check: what it reads on the machine (job names, status file, log), so a fix starts there. */
function backupPlaces(hub: Hub, type: string, target: string): string {
  if (type !== "backup") return "";
  try { return backupWhere(parseBackupTarget(target), hub.cfg.backupJobs); } catch { return ""; }
}
const at = (iso: unknown) => typeof iso === "string" && iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";

/**
 * Propose a fix for a check that is down, like a sensor alert (sensors.ts): the assistant looks into it with read-only
 * commands, on the check's machine when the hub can reach it, else from the hub's own machine, then asks to run one
 * change, which waits in the chat for the owner to approve (or to set aside by replying with something else). One chat per check and day.
 */
export function proposeMonitorFix(hub: Hub, id: string, now: Date = new Date()): { session_id: string; started: boolean } {
  const m = monitorOrThrow(hub.store, id);
  const f = m.fields;
  if (f.state !== "down") throw new StoreError(409, "this check is not failing");
  const sid = `alert-${m.id.slice(0, 8)}-down-${diaryDay(now).replace(/-/g, "")}`;
  if (hub.ai.sessions.get(sid)) return { session_id: sid, started: false };
  if (!hub.ai.available()) throw new StoreError(503, "no model is reachable");

  const name = String(f.name ?? "check");
  const type = String(f.type ?? "");
  const target = String(f.target ?? "");
  const hosts = loadHosts(hub.cfg);
  const hostName = String(f.host ?? "").trim() || targetHost(type, target);
  const machine = hostName ? findHost(hosts, hostName) : null;
  const self = hosts.find((h) => h.local) ?? null;
  const incidents = hub.store.list({ kind: "incident", limit: 100000 }).filter((i) => !i.fields.closed_at);
  const own = incidents.find((i) => i.fields.monitor_id === m.id) ?? null;
  const joined: Entity | null = typeof f.joined_incident === "string" ? incidents.find((i) => i.id === f.joined_incident) ?? null : null;
  const inc = own ?? joined;
  const error = String(f.last_error ?? inc?.fields.last_error ?? "it fails");
  const where = hostName ? ` on ${hostName}` : "";

  const lines = [
    `[Check down] ${name}: the ${TYPE_WORDS[type] ?? type} check of ${target}${where} fails${inc?.fields.opened_at ? ` since ${at(inc.fields.opened_at)}` : ""}: ${error}.`,
    joined ? `It is down with ${String(joined.fields.name)}: its machine stopped answering, so start with the machine.` : "",
    Array.isArray(inc?.fields.also_down) && inc!.fields.also_down.length ? `Also down with it: ${(inc!.fields.also_down as string[]).join(", ")}.` : "",
    inc?.fields.ack_note ? `{{owner}} noted: ${String(inc.fields.ack_note).slice(0, 300)}.` : "",
    backupPlaces(hub, type, target),
    machine
      ? `Find the cause first: run the read-only commands you need on ${machine.name}${self && self.name !== machine.name ? ` (and on ${self.name}, the hub's machine, to test the way the check goes)` : ""} yourself, in this reply. They run at once without asking, so never ask {{owner}} before one.`
      : `${hostName || "It"} is not one of the machines you can run commands on, so find the cause with read-only commands on ${self?.name ?? "the hub's machine"}, the hub's machine, run yourself in this reply: reach it the way the check does.`,
    "Then propose one fix with run_command: in two or three sentences say what you found and what the fix changes. It waits for {{owner}} to approve it; they approve with one gesture, or reply with something else instead. Never run anything that changes a machine before {{owner}} approves it.",
    "If no command can fix it (the machine is off or unplugged, a setting somewhere else, or the check itself is wrong), say what to do instead and propose no command.",
  ].filter(Boolean);
  hub.ai.sessions.save(sid, "troubleshoot", []);
  hub.ai.sessions.rename(sid, `Alert: ${name} down`);
  const profile = hub.profile.get();
  void withPriority("filing", () => hub.ai.chat({ session_id: sid, task_type: "troubleshoot", messages: [{ role: "user", content: personalize(lines.join(" "), profile.name, profile.pet) }], store_as: `${name}${where} is down: ${error}. Find the cause and propose a fix for me to approve.` }))
    .catch((e) => console.error(`[tech] fix for ${m.id}: ${errCode(e)}`));
  return { session_id: sid, started: true };
}
