import { readingLabel, type Entity } from "@everythingapp/shared";
import type { SensorRow } from "../sync/api";
import { sensorState } from "./body";
import { monitorState, type HubBackupLine, type IncidentF, type MonitorF, type OpsMonitor } from "./ops";

/**
 * Tech (since 2026-11-19): one card and one page per thing. The hub groups every check and reading under the machine,
 * service or place it belongs to (GET /ops `things`, hub/src/tech.ts); this file says how each thing is doing and what
 * needs a look, from the checks and readings the screens already have.
 */

export type ThingKind = "machine" | "service" | "place";
export interface Thing {
  name: string;
  label: string;
  kind: ThingKind;
  monitors: string[];
  sensors: string[];
  /** One of the machines the person added: the hub reads it and the assistant can run commands on it. */
  reachable: boolean;
  os?: string;
  hub?: boolean;
  /** What the machine itself says it runs ("Ubuntu 26.04 LTS"): machines the hub signs in to, and VMs with a guest agent. */
  os_name?: string;
  /** What kind of device it is, only with decent confidence (the hub weighs what the device says); none: not identified. */
  category?: Category;
  /** The exact name it gives for itself (a printer's make and model). */
  model?: string;
  /** A virtual machine or container on this Proxmox host, and its state there. */
  vm_of?: string;
  vm_state?: string;
  /** What it is for, in the owner's words: its fact `host:<name>` in Memory, which the assistant reads. */
  purpose?: string;
  /** A computer its own Aeneas app reports: the hub reads it through the app and does not sign in to it. */
  reports_itself?: boolean;
}

export type Category = "computer" | "network" | "printer" | "camera" | "other";
/** The kinds of device in the Overview's order, with their section titles and names. */
export const CATEGORIES: { category: Category; section: string; one: string }[] = [
  { category: "computer", section: "Computers", one: "Computer" },
  { category: "network", section: "Network", one: "Network device" },
  { category: "printer", section: "Printers", one: "Printer" },
  { category: "camera", section: "Cameras", one: "Camera" },
  { category: "other", section: "Other devices", one: "Device" },
];

/**
 * The Overview's machine sections: one per kind of device, then the ones that did not say what they are (Not
 * identified). Empty sections are left out.
 */
export function machineSections(machines: Thing[]): { title: string; things: Thing[] }[] {
  const out = CATEGORIES.map((c) => ({ title: c.section, things: machines.filter((t) => t.category === c.category) }));
  out.push({ title: "Not identified", things: machines.filter((t) => !t.category) });
  return out.filter((x) => x.things.length);
}

/** One line about what the machine is: what it runs or its model, and the VM it is; empty when it gave neither. */
export function identityLine(t: Thing): string {
  // What it is, never how it is doing: a VM that is off is still a virtual machine (its status says the rest).
  const vm = t.vm_of ? `virtual machine on ${t.vm_of}` : "";
  return [t.os_name ?? t.model, vm].filter(Boolean).join(", ");
}

/** "Computer", "Printer"...; "Not identified" when the hub is not sure. */
export const kindName = (t: Thing) => CATEGORIES.find((c) => c.category === t.category)?.one ?? "Not identified";

/** Green when fine, yellow when only small things need a look, red when something is down, grey otherwise. */
export type Tone = "ok" | "warn" | "danger" | "muted";

/** The dot for a tone, in the theme's status colors (styles.css `.dot`). */
export const TONE_DOT: Record<Tone, string> = { ok: "up", warn: "warn", danger: "down", muted: "unknown" };

/** The host a check is about when it names none: the machine or address in its target (as the hub reads it). */
export function targetHost(type: string, target: string): string {
  let t = String(target ?? "").trim();
  if (type === "backup") t = t.replace(/^(mac|macos|windows|linux):/i, "").replace(/#.*$/, "");
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").replace(/^[^@]*@/, "");
  const v6 = /^\[([^\]]+)\]/.exec(t);
  if (v6) return v6[1].toLowerCase();
  return t.replace(/:\d+$/, "").toLowerCase();
}

const alerting = (s: SensorRow) => s.alert !== false && sensorState(s) !== "ok";
const on = (m: OpsMonitor) => (m.fields as MonitorF).enabled !== false;

/**
 * How a thing is doing: red with what is wrong, green when everything checked is fine, grey before anything is. The
 * hub's own machine counts its own backup (`hubBackup`): it read "up" beside a backup that was failing.
 */
export function thingStatus(t: Thing, monitors: Map<string, OpsMonitor>, sensors: Map<string, SensorRow>, hubBackup: HubBackupLine[] = []): { tone: Tone; label: string } {
  const ms = t.monitors.map((id) => monitors.get(id)).filter((m): m is OpsMonitor => !!m && on(m));
  const ss = t.sensors.map((n) => sensors.get(n)).filter((s): s is SensorRow => !!s);
  const down = ms.filter((m) => monitorState(m.fields as MonitorF) === "down").length;
  const alerts = ss.filter(alerting).length;
  const backup = !!t.hub && hubBackup.some((l) => !l.ok);
  if (down || alerts || backup) {
    const parts = [down ? `${down} down` : "", alerts ? `${alerts} alert${alerts === 1 ? "" : "s"}` : "", backup ? "backup needs a look" : ""].filter(Boolean);
    return { tone: "danger", label: parts.join(", ") };
  }
  if (!ms.length && !ss.length) return { tone: "muted", label: t.reachable ? "no readings yet" : "nothing checked" };
  const known = ms.some((m) => monitorState(m.fields as MonitorF) === "up") || ss.some((s) => s.last_value != null);
  return known ? { tone: "ok", label: t.kind === "place" ? "fine" : "up" } : { tone: "muted", label: "not checked yet" };
}

/** "3 checks up", "1 of 3 down", "backup ok": a card's one line about its checks. */
export function checksLine(t: Thing, monitors: Map<string, OpsMonitor>): string {
  const ms = t.monitors.map((id) => monitors.get(id)).filter((m): m is OpsMonitor => !!m && on(m));
  if (!ms.length) return "";
  const backups = ms.filter((m) => (m.fields as MonitorF).type === "backup");
  const checks = ms.filter((m) => (m.fields as MonitorF).type !== "backup");
  const parts: string[] = [];
  if (checks.length) {
    const down = checks.filter((m) => monitorState(m.fields as MonitorF) === "down").length;
    parts.push(down ? `${down} of ${checks.length} check${checks.length === 1 ? "" : "s"} down` : `${checks.length} check${checks.length === 1 ? "" : "s"}`);
  }
  if (backups.length) parts.push(backups.some((m) => monitorState(m.fields as MonitorF) === "down") ? "backup failing" : backups.every((m) => monitorState(m.fields as MonitorF) === "up") ? "backup ok" : "backup not checked yet");
  return parts.join(", ");
}

/** A reading as people say it ("Disk P:", "Garage freezer"): shared with the hub, which writes it into History. */
export { readingLabel };

/** A reading's value in words: a pool's health reads healthy or degraded, the rest "90.3 %". */
export function readingValue(s: Pick<SensorRow, "name" | "last_value" | "unit">): string {
  if (s.last_value == null) return "no reading";
  if (/\.healthy$/.test(s.name)) return s.last_value >= 1 ? "healthy" : "degraded";
  const v = Math.round(s.last_value * 10) / 10;
  return s.unit === "%" ? `${v}%` : `${v}${s.unit ? ` ${s.unit}` : ""}`;
}

export interface Bar { label: string; value: number; tone: Tone; text: string }

/** A machine card's bars: CPU, memory and its fullest disk or pool, those it reports. */
export function machineBars(t: Thing, sensors: Map<string, SensorRow>): Bar[] {
  const rows = t.sensors.map((n) => sensors.get(n)).filter((s): s is SensorRow => !!s && s.last_value != null);
  const bar = (s: SensorRow, label?: string): Bar => ({ label: label ?? readingLabel(s.name, t.name), value: Math.max(0, Math.min(100, s.last_value!)), tone: alerting(s) ? "danger" : "ok", text: readingValue(s) });
  const out: Bar[] = [];
  const by = (re: RegExp) => rows.find((s) => re.test(s.name));
  const cpu = by(/\.cpu\.used$/);
  const mem = by(/\.memory\.used$/);
  if (cpu) out.push(bar(cpu));
  if (mem) out.push(bar(mem));
  const disks = rows.filter((s) => /\.disk\..+\.used$|\.zfs\..+\.pool$/.test(s.name)).sort((a, b) => b.last_value! - a.last_value!);
  if (disks[0]) out.push(bar(disks[0], disks.length > 1 ? `Fullest: ${readingLabel(disks[0].name, t.name)}` : readingLabel(disks[0].name, t.name)));
  return out;
}

/**
 * How much a look weighs: major for something that is down (a check, with or without its incident, and the hub's own
 * backup), minor for a reading out of bounds or silent. The light is red while a major one is not yet acknowledged,
 * yellow while only minor ones are.
 */
export type Severity = "major" | "minor";

export interface Look {
  key: string;
  /** The thing it is on, for its page. */
  thing: string;
  title: string;
  detail?: string;
  severity: Severity;
  /** A check that is down: Propose a fix asks about this monitor. */
  monitorId?: string;
  /** Its open incident, for Acknowledge. */
  incident?: Entity;
  /** A reading out of bounds or silent: Propose a fix asks about this sensor. */
  sensor?: string;
  acknowledged?: boolean;
}

/**
 * Everything that needs a look now, worst first: checks that are down (one row per incident: a machine that stopped
 * answering takes its services with it), readings out of bounds or silent, and the hub's own backup. A check that is
 * down and the hub's backup are major, a reading is minor.
 */
export function needsALook(
  things: Thing[],
  monitors: OpsMonitor[],
  incidents: Entity[],
  sensors: SensorRow[],
  hubBackup: HubBackupLine[] = [],
  now: Date = new Date(),
): Look[] {
  const thingOfMonitor = new Map(things.flatMap((t) => t.monitors.map((id) => [id, t] as const)));
  const thingOfSensor = new Map(things.flatMap((t) => t.sensors.map((n) => [n, t] as const)));
  const out: Look[] = [];
  const covered = new Set<string>();
  for (const inc of incidents) {
    const f = inc.fields as IncidentF;
    if (f.closed_at) continue;
    const t = thingOfMonitor.get(f.monitor_id);
    covered.add(f.monitor_id);
    for (const m of monitors) if (m.fields.joined_incident === inc.id) covered.add(m.id);
    out.push({
      key: `inc-${inc.id}`, thing: t?.name ?? "", title: `${f.name} down`,
      detail: [f.last_error, f.also_down?.length ? `also down with it: ${f.also_down.join(", ")}` : ""].filter(Boolean).join("; "),
      severity: "major", monitorId: f.monitor_id, incident: inc, acknowledged: !!f.acknowledged_at,
    });
  }
  for (const m of monitors) {
    const f = m.fields as MonitorF;
    if (covered.has(m.id) || !on(m) || monitorState(f) !== "down") continue;
    out.push({ key: `mon-${m.id}`, thing: thingOfMonitor.get(m.id)?.name ?? "", title: `${f.name} down`, detail: f.last_error, severity: "major", monitorId: m.id });
  }
  for (const s of sensors) {
    if (!alerting(s)) continue;
    const t = thingOfSensor.get(s.name);
    const label = t ? readingLabel(s.name, t.name) : readingLabel(s.name, "");
    const where = t && t.kind === "machine" ? ` on ${t.label}` : "";
    const state = sensorState(s);
    const title = state === "stale"
      ? `${label}${where}: ${s.last_at ? `no reading for ${Math.max(1, Math.round((now.getTime() - Date.parse(s.last_at)) / 3600_000))} h` : "no reading yet"}`
      : `${label}${where} at ${readingValue(s)}`;
    const bound = state === "high" && s.max != null ? `alerts above ${s.max}${s.unit === "%" ? "%" : ` ${s.unit}`}` : state === "low" && s.min != null ? `alerts below ${s.min}${s.unit === "%" ? "%" : ` ${s.unit}`}` : "";
    out.push({ key: `sensor-${s.name}`, thing: t?.name ?? "", title, detail: bound, severity: "minor", sensor: s.name });
  }
  const bad = hubBackup.filter((l) => !l.ok);
  if (bad.length) {
    const hubThing = things.find((t) => t.hub);
    out.push({ key: "hub-backup", thing: hubThing?.name ?? "", title: "This hub's backup needs a look", detail: bad.map((l) => `${l.label}: ${l.text}`).join("; "), severity: "major" });
  }
  // Not yet acknowledged first; the hub's order otherwise.
  return out.map((l, i) => ({ l, i })).sort((a, b) => Number(!!a.l.acknowledged) - Number(!!b.l.acknowledged) || a.i - b.i).map((x) => x.l);
}

/** A look's own color: red when major, yellow when minor, grey once acknowledged. */
export const lookTone = (l: Look): Tone => (l.acknowledged ? "muted" : l.severity === "major" ? "danger" : "warn");

/** What is watched, in one line: "3 machines, 4 checks, 5 readings"; empty when nothing is. */
export function watchedLine(things: Thing[], monitors: OpsMonitor[], sensors: SensorRow[]): string {
  const machines = things.filter((t) => t.kind === "machine").length;
  const checks = monitors.filter(on).length;
  return [
    machines ? `${machines} machine${machines === 1 ? "" : "s"}` : "",
    checks ? `${checks} check${checks === 1 ? "" : "s"}` : "",
    sensors.length ? `${sensors.length} reading${sensors.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");
}

/**
 * The light at the top of Tech, and Today's Tech line: red while a major look (something down) is not yet
 * acknowledged, yellow while only minor ones are (readings), grey once every look is acknowledged, green when there
 * is none, with how much is watched.
 */
export function techLight(looks: Look[], things: Thing[], monitors: OpsMonitor[], sensors: SensorRow[]): { tone: Tone; label: string; detail: string } {
  const open = looks.filter((l) => !l.acknowledged);
  const watched = watchedLine(things, monitors, sensors);
  if (looks.length) {
    const acked = looks.length - open.length;
    if (!open.length) return { tone: "muted", label: `${acked} acknowledged`, detail: watched };
    return {
      tone: open.some((l) => l.severity === "major") ? "danger" : "warn",
      label: `${open.length} thing${open.length === 1 ? "" : "s"} need${open.length === 1 ? "s" : ""} a look`,
      detail: [acked ? `${acked} acknowledged` : "", watched].filter(Boolean).join("; "),
    };
  }
  if (!monitors.some(on) && !sensors.length) return { tone: "muted", label: "Nothing watched yet", detail: "" };
  return { tone: "ok", label: "All good", detail: watched };
}

/**
 * A machine typed into Add machine: an SSH alias ("nas") or user@host ("robin@10.0.0.16"), kept as typed for ssh, and
 * named after the host, since a machine's name has no "@" (the hub refuses one: user@host failed to save).
 */
export function machineFromInput(text: string): { name: string; ssh: string } | null {
  const ssh = text.trim();
  const host = ssh.slice(ssh.lastIndexOf("@") + 1).replace(/:\d+$/, "").toLowerCase();
  return ssh && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(host) ? { name: host, ssh } : null;
}
