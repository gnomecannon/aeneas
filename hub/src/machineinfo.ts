import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";

/**
 * What the hub knows about each machine and device beyond its checks and readings (Tech, since 2026-11-20), kept in
 * `<data>/machines-info.json` by name. Everything here comes from the device itself; nothing is inferred from a name:
 * - `os`: what the machine says it runs, read with its readings every 10 minutes ("Ubuntu 26.04 LTS", "Windows 11
 *   Pro", "Proxmox VE 8.0.3", a UniFi or QNAP device's model and firmware). Only machines the hub signs in to.
 * - `vm_of`, `vm_state`: a virtual machine or container on a Proxmox host the hub signs in to, as that host lists it.
 * - `category`, `model`, `confidence`, `facts`, `services`: what kind of device it is (identify.ts), weighed from facts.
 * - `reported_by`, `reported_at`: a computer its own Aeneas app reports (hostsensors.ts, reportComputer).
 */

export const CATEGORIES = ["computer", "network", "printer", "camera", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export interface MachineInfo {
  os?: string;
  os_at?: string;
  vm_of?: string;
  vm_state?: string;
  /** What kind of device it is, only with decent confidence (identify.ts); null once asked and not sure. */
  category?: Category | null;
  /** The exact name it gives for itself where a service gives one plainly (a printer's make and model). */
  model?: string | null;
  confidence?: number;
  /** Short notes of what was seen ("port 445 (file sharing)"), for the assistant only; never shown in the apps. */
  facts?: string[];
  /** The well-known service ports that answered, when it was identified over the network. */
  services?: number[];
  ident_at?: string;
  /** The device whose Aeneas app reports this computer itself (PUT /devices/me/computer), and when it last did. */
  reported_by?: string;
  reported_at?: string;
}

const file = (hub: Hub) => path.join(hub.cfg.dataDir, "machines-info.json");

export function readMachineInfo(hub: Hub): Record<string, MachineInfo> {
  return readMachineInfoFile(hub.cfg.dataDir);
}

/** The same, by data folder (the assistant's tools have the config, not the hub). */
export function readMachineInfoFile(dataDir: string): Record<string, MachineInfo> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, "machines-info.json"), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, MachineInfo>) : {};
  } catch { return {}; }
}

function write(hub: Hub, all: Record<string, MachineInfo>): void {
  const p = file(hub);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

const key = (name: string) => name.trim().toLowerCase();

/**
 * Merge what was learned about one machine; written only when something changed, so the file is not rewritten every
 * 10 minutes. A field given as undefined is left as it was.
 */
export function updateMachineInfo(hub: Hub, name: string, patch: Partial<MachineInfo>): void {
  const all = readMachineInfo(hub);
  const k = key(name);
  const before = all[k] ?? {};
  const next: MachineInfo = { ...before };
  for (const [f, v] of Object.entries(patch) as [keyof MachineInfo, unknown][]) if (v !== undefined) (next as Record<string, unknown>)[f] = v;
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  all[k] = next;
  write(hub, all);
}

/** `from`'s entry folds into `to`'s: what `to` has stays, what it lacks comes from `from`, and `from`'s goes. */
export function foldMachineInfo(hub: Hub, from: string, to: string): boolean {
  const all = readMachineInfo(hub);
  const was = all[key(from)];
  if (!was || key(from) === key(to)) return false;
  all[key(to)] = { ...was, ...(all[key(to)] ?? {}) };
  delete all[key(from)];
  write(hub, all);
  return true;
}

/** The OS a machine reported; `os_at` moves only when the OS changed. */
export function setMachineOs(hub: Hub, name: string, os: string, at: string): void {
  if (readMachineInfo(hub)[key(name)]?.os === os) return;
  updateMachineInfo(hub, name, { os, os_at: at });
}
