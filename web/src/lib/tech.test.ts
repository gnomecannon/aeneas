import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import type { SensorRow } from "../sync/api";
import type { OpsMonitor } from "./ops";
import { checksLine, identityLine, machineBars, machineFromInput, machineSections, needsALook, readingLabel, readingValue, targetHost, techLight, thingStatus, type Thing } from "./tech";

const now = new Date("2026-11-19T21:00:00Z");
const ent = (id: string, kind: string, fields: Record<string, unknown>): Entity =>
  ({ id, kind, space: "personal", created_at: "", updated_at: "", deleted_at: null, fields, field_ts: {} }) as unknown as Entity;
const mon = (id: string, fields: Record<string, unknown>): OpsMonitor => ({ ...ent(id, "monitor", fields), incident_open: null }) as OpsMonitor;
const sensor = (name: string, f: Partial<SensorRow> = {}): SensorRow => ({ id: name, name, unit: "%", last_value: 50, last_at: "2026-11-19T20:55:00Z", state: "ok", series_24h: [], ...f });

const deskPc: Thing = { name: "desk-pc", label: "desk-pc", kind: "machine", monitors: ["p1", "o1", "b1"], sensors: ["desk-pc.cpu.used", "desk-pc.memory.used", "desk-pc.disk.c.used", "desk-pc.disk.p.used"], reachable: true, os: "windows" };
const pve2: Thing = { name: "pve2", label: "pve2", kind: "machine", monitors: ["x1"], sensors: [], reachable: false };
const garage: Thing = { name: "garage", label: "Garage", kind: "place", monitors: [], sensors: ["garage_freezer"], reachable: false };
const core: Thing = { name: "core", label: "core", kind: "machine", monitors: [], sensors: [], reachable: true, hub: true };

const monitors = [
  mon("p1", { name: "desk-pc ping", type: "ping", state: "up" }),
  mon("o1", { name: "Ollama", type: "http", state: "up" }),
  mon("b1", { name: "Desk-pc backup", type: "backup", state: "up" }),
  mon("x1", { name: "pve2 Proxmox", type: "tcp", state: "down", last_error: "no connection within 5 s" }),
];
const sensors = [
  sensor("desk-pc.cpu.used", { last_value: 54 }),
  sensor("desk-pc.memory.used", { last_value: 33.8 }),
  sensor("desk-pc.disk.c.used", { last_value: 89.3, max: 90 }),
  sensor("desk-pc.disk.p.used", { last_value: 90.3, max: 90, state: "high" }),
  sensor("garage_freezer", { unit: "°F", last_value: 2, max: 10 }),
];
const M = new Map(monitors.map((m) => [m.id, m]));
const S = new Map(sensors.map((s) => [s.name, s]));

describe("Tech things", () => {
  it("names a machine typed as user@host after the host, keeping the SSH target as typed", () => {
    expect(machineFromInput(" robin@10.0.0.16 ")).toEqual({ name: "10.0.0.16", ssh: "robin@10.0.0.16" });
    expect(machineFromInput("NAS")).toEqual({ name: "nas", ssh: "NAS" });
    expect(machineFromInput("me@nas:2222")).toEqual({ name: "nas", ssh: "me@nas:2222" });
    expect(machineFromInput("")).toBeNull();
    expect(machineFromInput("me@")).toBeNull();
  });

  it("splits machines by the kind of device they said they are, the rest under Not identified", () => {
    const m = (name: string, category?: Thing["category"]): Thing => ({ name, label: name, kind: "machine", monitors: [], sensors: [], reachable: false, ...(category ? { category } : {}) });
    expect(machineSections([m("gw", "network"), m("pc", "computer"), m("x"), m("cam", "camera")]).map((x) => [x.title, x.things.map((t) => t.name)])).toEqual([
      ["Computers", ["pc"]],
      ["Network", ["gw"]],
      ["Cameras", ["cam"]],
      ["Not identified", ["x"]],
    ]);
    expect(identityLine({ ...m("dc1"), os_name: "Windows Server 2022 Standard", vm_of: "pve", vm_state: "running" })).toBe("Windows Server 2022 Standard, virtual machine on pve");
    expect(identityLine({ ...m("dc2"), vm_of: "pve", vm_state: "stopped" })).toBe("virtual machine on pve");
    expect(identityLine(m("x"))).toBe("");
    expect(identityLine({ ...m("p", "printer"), model: "HP LaserJet Pro M404" })).toBe("HP LaserJet Pro M404");
  });

  it("reads a check's host from its target, as the hub does", () => {
    expect(targetHost("tcp", "pve2:8006")).toBe("pve2");
    expect(targetHost("http", "http://127.0.0.1:8787/health")).toBe("127.0.0.1");
    expect(targetHost("backup", "linux:me@nas#verify")).toBe("nas");
    expect(targetHost("tcp", "[fd7a::1]:22")).toBe("fd7a::1");
  });

  it("names readings as people say them", () => {
    expect(readingLabel("core.disk.root.used", "core")).toBe("Disk /");
    expect(readingLabel("desk-pc.disk.p.used", "desk-pc")).toBe("Disk P:");
    expect(readingLabel("core.disk.mnt-b.used", "core")).toBe("Disk mnt-b");
    expect(readingLabel("core.cpu.used", "core")).toBe("CPU");
    expect(readingLabel("core.memory.used", "core")).toBe("Memory");
    expect(readingLabel("core.cpu.temp", "core")).toBe("CPU temperature");
    expect(readingLabel("storage.nvme0.temp", "storage")).toBe("NVMe 1 temperature");
    expect(readingLabel("core.gpu0.temp", "core")).toBe("GPU temperature");
    expect(readingLabel("core.gpu1.vram", "core")).toBe("GPU 2 memory");
    expect(readingLabel("storage.zfs.storage-pool.pool", "storage")).toBe("Pool storage-pool");
    expect(readingLabel("storage.zfs.storage-pool.healthy", "storage")).toBe("Pool storage-pool health");
    expect(readingLabel("garage_freezer", "garage")).toBe("Garage freezer");
    expect(readingValue({ name: "storage.zfs.tank.healthy", last_value: 0, unit: "" })).toBe("degraded");
    expect(readingValue({ name: "x", last_value: 90.34, unit: "%" })).toBe("90.3%");
    expect(readingValue({ name: "x", last_value: 2, unit: "°F" })).toBe("2 °F");
  });

  it("says how each thing is doing and what its checks are", () => {
    expect(thingStatus(deskPc, M, S)).toEqual({ tone: "danger", label: "1 alert" });
    expect(thingStatus(pve2, M, S)).toEqual({ tone: "danger", label: "1 down" });
    expect(thingStatus(garage, M, S)).toEqual({ tone: "ok", label: "fine" });
    expect(thingStatus(core, M, S)).toEqual({ tone: "muted", label: "no readings yet" });
    expect(thingStatus(core, M, S, [{ label: "Nightly copy", ok: false, text: "none made yet" }])).toEqual({ tone: "danger", label: "backup needs a look" });
    expect(thingStatus(deskPc, M, S, [{ label: "Nightly copy", ok: false, text: "none made yet" }]).label).toBe("1 alert");
    expect(checksLine(deskPc, M)).toBe("2 checks, backup ok");
    expect(checksLine(pve2, M)).toBe("1 of 1 check down");
  });

  it("shows CPU, memory and the fullest disk on a machine's card", () => {
    expect(machineBars(deskPc, S).map((b) => [b.label, b.text, b.tone])).toEqual([
      ["CPU", "54%", "ok"],
      ["Memory", "33.8%", "ok"],
      ["Fullest: Disk P:", "90.3%", "danger"],
    ]);
  });

  it("lists what needs a look: one row per incident, silent or out of bounds readings, the hub's backup", () => {
    const things = [core, deskPc, pve2, garage];
    const inc = ent("i1", "incident", { monitor_id: "x1", name: "pve2 Proxmox", opened_at: "2026-11-19T20:00:00Z", last_error: "no connection within 5 s" });
    const acked = ent("i2", "incident", { monitor_id: "o1", name: "Ollama", opened_at: "2026-11-19T19:00:00Z", acknowledged_at: "2026-11-19T19:30:00Z" });
    const stale = sensor("garage_freezer", { unit: "°F", state: "stale", last_at: "2026-11-19T15:00:00Z" });
    const looks = needsALook(things, monitors, [acked, inc], [...sensors.slice(0, 4), stale], [{ label: "Nightly copy", ok: false, text: "none in 30 h" }], now);
    expect(looks.map((l) => [l.thing, l.title, l.monitorId ?? l.sensor ?? null])).toEqual([
      ["pve2", "pve2 Proxmox down", "x1"],
      ["desk-pc", "Disk P: on desk-pc at 90.3%", "desk-pc.disk.p.used"],
      ["garage", "Garage freezer: no reading for 6 h", "garage_freezer"],
      ["core", "This hub's backup needs a look", null],
      ["desk-pc", "Ollama down", "o1"],
    ]);
    expect(looks[1].detail).toBe("alerts above 90%");
    expect(techLight(looks, things, monitors, sensors)).toEqual({ tone: "danger", label: "4 things need a look", detail: "1 acknowledged; 3 machines, 4 checks, 5 readings" });
    expect(techLight([], things, monitors, sensors)).toEqual({ tone: "ok", label: "All good", detail: "3 machines, 4 checks, 5 readings" });
  });
});
