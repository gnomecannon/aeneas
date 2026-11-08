import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { parseHostOutput, sensorHosts, storeHostValues, worthKeeping } from "../src/hostsensors.js";
import { readingsSince, sensorByName } from "../src/sensors.js";
import type { Host } from "../src/ai/hosts.js";

const LINUX_OUT = [
  "disk / 88",
  "disk /mnt/b 97",
  "temp coretemp 33000",
  "temp nvme 27850",
  "temp nvme 36900",
  "gpu 0, 26, 19682, 24576",
  "pool storage-pool\t24%\tDEGRADED",
  "some other line",
].join("\n");

test("a host's script output becomes named values with units", () => {
  const v = Object.fromEntries(parseHostOutput("core", LINUX_OUT).map((x) => [x.name, `${x.value}${x.unit}`]));
  assert.deepEqual(v, {
    "core.disk.root.used": "88%", "core.disk.mnt-b.used": "97%", "core.cpu.temp": "33°C", "core.nvme0.temp": "27.9°C", "core.nvme1.temp": "36.9°C",
    "core.gpu0.temp": "26°C", "core.gpu0.vram": "80.1%", "core.zfs.storage-pool.pool": "24%", "core.zfs.storage-pool.healthy": "0",
  });
  const win = parseHostOutput("desk-pc", "disk C 67.9\r\ndisk D 89.8\r\ngpu 0, 34, 3720, 24564\r\n");
  assert.deepEqual(win.map((x) => x.name), ["desk-pc.disk.c.used", "desk-pc.disk.d.used", "desk-pc.gpu0.temp", "desk-pc.gpu0.vram"]);
  assert.deepEqual(parseHostOutput("laptop", "disk / 90\n").map((x) => [x.name, x.value]), [["laptop.disk.root.used", 90]]);
  assert.deepEqual(parseHostOutput("pi3", ""), []);
});

test("a -wifi alias of a known host is not read twice", () => {
  const h = (name: string): Host => ({ name, aliases: [name], target: name, os: "linux", local: false, via: "" });
  assert.deepEqual(sensorHosts([h("core"), h("core-wifi"), h("pi3-wifi"), h("storage")]).map((x) => x.name), ["core", "pi3-wifi", "storage"]);
});

test("host values make sensors with thresholds, alert on a full disk or a degraded pool, and keep few readings", () => {
  const t = makeHub();
  try {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 5, min));
    storeHostValues(t.hub, "core", parseHostOutput("core", LINUX_OUT), at(0));
    const disk = sensorByName(t.hub, "core.disk.mnt-b.used")!;
    assert.equal(disk.fields.max, 90);
    assert.equal(disk.fields.location, "core");
    assert.equal(disk.fields.state, "high");
    assert.equal(sensorByName(t.hub, "core.zfs.storage-pool.healthy")!.fields.state, "low");
    assert.equal(sensorByName(t.hub, "core.gpu0.vram")!.fields.max, undefined, "GPU memory is shown, never alerted on");

    // The owner's own threshold stays; a small move within the hour is not stored, a big one or a new state is.
    t.hub.store.patch(disk.id, { max: 98 });
    const value = (n: number) => ({ name: "core.disk.mnt-b.used", value: n, unit: "%" });
    assert.equal(worthKeeping(sensorByName(t.hub, "core.disk.mnt-b.used"), value(97.5), at(10)), true, "the state changes to ok under the owner's 98");
    storeHostValues(t.hub, "core", [value(97.5)], at(10));
    assert.equal(sensorByName(t.hub, "core.disk.mnt-b.used")!.fields.max, 98);
    assert.equal(storeHostValues(t.hub, "core", [value(97.8)], at(20)), 0);
    assert.equal(storeHostValues(t.hub, "core", [value(99)], at(30)), 1);
    assert.equal(storeHostValues(t.hub, "core", [value(99.2)], at(95)), 1, "an hour after the last reading");
    assert.deepEqual(readingsSince(t.hub, "core.disk.mnt-b.used", at(-1)).map((p) => p.value), [97, 97.5, 99, 99.2]);
  } finally { t.cleanup(); }
});
