import { execFile } from "node:child_process";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { loadHosts, type Host } from "./ai/hosts.js";
import { sshRunner, type SshRunner } from "./backups.js";
import { recordReading, sensorByName, stateFor } from "./sensors.js";
import { feedStdin } from "./child.js";
import { errCode } from "./logsafe.js";

/**
 * Module 4 and 6: the homelab machines are sensors too, with nothing to set up. Every 10 minutes the hub reads disk
 * use, CPU, NVMe and GPU temperatures, GPU memory and ZFS pool health from the machines the person added (Machines,
 * hosts.json, reached over ssh; the hub machine itself directly), with one fixed read-only script per OS. A sensor is
 * made the first time a value comes in, with thresholds that alert (a disk past 90%, a degraded pool). A reading is
 * stored only when the value moved, the state changed or an hour passed, so a year stays small. A machine that is
 * asleep or away is skipped: its ping monitor already says so, and its sensors do not go stale for a week.
 */

const TICK_MS = 10 * 60_000;
const KEEP_MS = 60 * 60_000;
const STALE_MINUTES = 7 * 24 * 60;
const TIMEOUT_MS = 20_000;

export interface HostValue { name: string; value: number; unit: string }
interface Spec { unit: string; min?: number; max?: number; band: number }

/** Thresholds and the change worth a reading, by what the value is (the last part of the sensor name). */
function specFor(name: string): Spec {
  if (name.endsWith(".used")) return { unit: "%", max: 90, band: 1 };
  if (name.endsWith(".pool")) return { unit: "%", max: 80, band: 1 };
  if (name.endsWith(".healthy")) return { unit: "", min: 1, band: 0 };
  if (name.endsWith(".vram")) return { unit: "%", band: 5 };
  if (/(^|\.)gpu\d+\.temp$/.test(name)) return { unit: "°C", max: 85, band: 3 };
  if (/(^|\.)nvme\d+\.temp$/.test(name)) return { unit: "°C", max: 70, band: 3 };
  return { unit: "°C", max: 90, band: 3 };
}

const LINUX = [
  // Disks, without pseudo and ZFS file systems (the pool line covers those) or boot partitions.
  `df -PT 2>/dev/null | awk 'NR>1 && $2 !~ /^(tmpfs|devtmpfs|overlay|squashfs|efivarfs|vfat|zfs|fuse.*|nfs.*|cifs)$/ && $7 !~ /^\\/(boot|snap|run|dev|sys|proc)/ {gsub("%","",$6); print "disk", $7, $6}'`,
  `for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); case "$n" in coretemp|k10temp|zenpower|cpu_thermal|nvme) t=$(cat "$h/temp1_input" 2>/dev/null) && echo "temp $n $t";; esac; done`,
  `command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu /'`,
  `command -v zpool >/dev/null 2>&1 && zpool list -H -o name,cap,health 2>/dev/null | sed 's/^/pool /'`,
  "true",
].join("\n");

const MACOS = [
  `df -P /System/Volumes/Data 2>/dev/null | awk 'NR>1 {gsub("%","",$5); print "disk / " $5}'`,
  "true",
].join("\n");

const WINDOWS = [
  `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { if ($_.Size -gt 0) { 'disk {0} {1}' -f $_.DeviceID.TrimEnd(':'), [math]::Round(100 * ($_.Size - $_.FreeSpace) / $_.Size, 1) } }`,
  `if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=index,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits | ForEach-Object { 'gpu ' + $_ } }`,
  "",
].join("\n");

/** The script for a host and how it runs: remote command plus the script on stdin. */
export function hostScript(os: Host["os"]): { remote: string; stdin: string } {
  if (os === "windows") return { remote: "powershell -NoProfile -NonInteractive -Command -", stdin: WINDOWS };
  return { remote: "sh -s", stdin: os === "macos" ? MACOS : LINUX };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

/** Values from a script's output, named `<host>.<thing>`. Lines it does not know are ignored. */
export function parseHostOutput(host: string, out: string): HostValue[] {
  const values: HostValue[] = [];
  const add = (name: string, value: number) => { if (Number.isFinite(value)) values.push({ name: `${host}.${name}`, value, unit: specFor(name).unit }); };
  const counts = new Map<string, number>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const [tag, ...rest] = line.split(/\s+/);
    if (tag === "disk" && rest.length >= 2) {
      const mount = rest.slice(0, -1).join(" ");
      add(`disk.${mount === "/" ? "root" : slug(mount)}.used`, parseFloat(rest.at(-1)!));
    } else if (tag === "temp" && rest.length === 2) {
      const kind = rest[0] === "nvme" ? "nvme" : "cpu";
      const n = counts.get(kind) ?? 0;
      counts.set(kind, n + 1);
      add(kind === "nvme" ? `nvme${n}.temp` : n ? `cpu${n}.temp` : "cpu.temp", Math.round(parseFloat(rest[1]) / 100) / 10);
    } else if (tag === "gpu") {
      const [index, temp, used, total] = line.slice(4).split(",").map((x) => parseFloat(x.trim()));
      if (!Number.isFinite(index)) continue;
      add(`gpu${index}.temp`, temp);
      if (total > 0) add(`gpu${index}.vram`, Math.round((1000 * used) / total) / 10);
    } else if (tag === "pool" && rest.length >= 3) {
      const name = slug(rest[0]);
      add(`zfs.${name}.pool`, parseFloat(rest[1]));
      add(`zfs.${name}.healthy`, rest[2] === "ONLINE" ? 1 : 0);
    }
  }
  return values;
}

/** Whether a new value is worth a reading: it moved past its band, changes the state, or an hour passed. */
export function worthKeeping(sensor: Entity | null, v: HostValue, now: Date): boolean {
  if (!sensor || typeof sensor.fields.last_value !== "number" || typeof sensor.fields.last_at !== "string") return true;
  if (stateFor(sensor, v.value) !== sensor.fields.state) return true;
  if (Math.abs(v.value - sensor.fields.last_value) > specFor(v.name).band) return true;
  return now.getTime() - new Date(sensor.fields.last_at).getTime() >= KEEP_MS;
}

/** Store what a host reported: new sensors get their thresholds; existing ones keep any the owner changed. */
/** Sensor names are at most 80 characters: a long mount path keeps its start and end, joined by "..". */
export function sensorName(name: string): string {
  return name.length <= 80 ? name : `${name.slice(0, 50)}..${name.slice(-28)}`;
}

export function storeHostValues(hub: Hub, host: string, values: HostValue[], now: Date = new Date()): number {
  let kept = 0;
  for (const raw of values) {
    // One value that cannot be stored no longer stops the rest of the machine's values (and its missing-value check).
    try {
      const v = { ...raw, name: sensorName(raw.name) };
      let sensor = sensorByName(hub, v.name);
      if (!sensor) {
        const s = specFor(v.name);
        sensor = hub.store.create("sensor", { name: v.name, unit: s.unit, location: host, alert: true, stale_minutes: STALE_MINUTES, ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}) });
      }
      if (!worthKeeping(sensor, v, now)) continue;
      recordReading(hub, v.name, { value: v.value, unit: v.unit || undefined, at: now.toISOString() }, now);
      kept++;
    } catch (e) {
      console.error(`[hostsensors] a value from one machine was not stored: ${errCode(e)}`);
    }
  }
  return kept;
}

const localRunner: SshRunner = (_dest, remote, stdin, timeoutMs) => new Promise((resolve) => {
  // The same command line ssh would run on that machine: through cmd.exe on a Windows hub, sh elsewhere.
  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", remote]] : ["sh", ["-c", remote]];
  const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
  feedStdin(child, stdin);
});

/** The machines to read: every known host, once (a `-wifi` alias of a host is the same machine). */
export function sensorHosts(hosts: Host[]): Host[] {
  const names = new Set(hosts.map((h) => h.name));
  return hosts.filter((h) => !(h.name.endsWith("-wifi") && names.has(h.name.slice(0, -5))));
}

/** Ticks in a row a sensor was missing from its machine's report while the machine reported the rest. */
const missing = new WeakMap<Hub, Map<string, number>>();
/** Three ticks (30 minutes): one failed `nvidia-smi` is not a missing GPU. */
export const MISSING_TICKS = 3;

/**
 * A machine that answers but no longer reports one of its values (a pool not imported after a reboot, a data disk
 * that did not mount, the GPU driver gone) makes that sensor stale after MISSING_TICKS, with its notify. The week
 * of `stale_minutes` is for a machine that is away, not for one value missing from a machine that is here.
 */
export function markMissing(hub: Hub, host: string, values: HostValue[], now: Date = new Date()): string[] {
  let m = missing.get(hub);
  if (!m) { m = new Map(); missing.set(hub, m); }
  const present = new Set(values.map((v) => sensorName(v.name)));
  const out: string[] = [];
  for (const s of hub.store.list({ kind: "sensor", limit: 10000 })) {
    const name = String(s.fields.name);
    if (s.fields.location !== host || !name.startsWith(`${host}.`)) continue;
    if (present.has(name)) { m.delete(name); continue; }
    if (s.fields.state === "stale" || typeof s.fields.last_at !== "string") continue;
    const n = (m.get(name) ?? 0) + 1;
    m.set(name, n);
    if (n < MISSING_TICKS) continue;
    hub.store.patch(s.id, { state: "stale" });
    if (s.fields.alert !== false) hub.bus.emit("notify", { id: `sensor:${name}:stale:${now.toISOString()}`, kind: "sensor", title: `${name} stale: ${host} no longer reports it`, at: now.toISOString(), name, value: null, unit: String(s.fields.unit ?? ""), state: "stale" });
    m.delete(name);
    out.push(name);
  }
  return out;
}

export async function hostSensorTick(hub: Hub, run: SshRunner = sshRunner, now: Date = new Date()): Promise<{ host: string; values: number; kept: number; error?: string }[]> {
  return Promise.all(sensorHosts(loadHosts(hub.cfg)).map(async (h) => {
    const { remote, stdin } = hostScript(h.os);
    const r = await (h.local ? localRunner : run)(h.target, remote, stdin, TIMEOUT_MS);
    const values = parseHostOutput(h.name, r.stdout);
    if (!values.length) return { host: h.name, values: 0, kept: 0, error: (r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`).slice(0, 200) };
    const kept = storeHostValues(hub, h.name, values, now);
    markMissing(hub, h.name, values, now);
    return { host: h.name, values: values.length, kept };
  }));
}

/** Every 10 minutes, first a minute after start. Off with EA_HOST_SENSORS=false. */
export function startHostSensorLoop(hub: Hub, intervalMs = TICK_MS): () => void {
  if (!hub.cfg.hostSensors) return () => {};
  let running = false;
  const tick = () => {
    if (running || !hub.modules.on("sensors")) return;
    running = true;
    hostSensorTick(hub)
      .then((rs) => { const kept = rs.reduce((n, r) => n + r.kept, 0); if (kept) console.log(`[hostsensors] ${kept} readings from ${rs.filter((r) => r.values).length} host(s)`); })
      .catch((e) => console.error(`[hostsensors] tick failed: ${errCode(e)}`))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 60_000).unref();
  return () => clearInterval(timer);
}
