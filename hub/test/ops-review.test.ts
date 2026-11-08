import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHub, type TestHub } from "./helpers.js";
import { backupChecker, backupOutcome, parseBackupTarget, type SshRunner } from "../src/backups.js";
import { AWAY_LIMIT_MS, renotifyTick, runCheck, tlsOutcome, type CheckOutcome, type Checker } from "../src/monitors.js";
import { markMissing, MISSING_TICKS, storeHostValues } from "../src/hostsensors.js";
import { recordReading, sensorByName } from "../src/sensors.js";
import { opsLine, todayView } from "../src/planner.js";
import { probeTls } from "../src/watches.js";
import type { NotifyEvent } from "../src/bus.js";

// Each case below was a finding of the 2026-11-05 review of Ops monitors and sensors.

const HOUR = 3600_000;
const T0 = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
const at = (ms: number) => new Date(T0.getTime() + ms);

function scripted(t: TestHub): { script: Map<string, CheckOutcome[]>; notifies: NotifyEvent[] } {
  const script = new Map<string, CheckOutcome[]>();
  const fake: Checker = async ({ target }) => { const q = script.get(target) ?? [{ ok: true }]; return q.length > 1 ? q.shift()! : q[0]; };
  t.hub.checkers = { ...t.hub.checkers, ping: fake, tcp: fake, http: fake, dns: fake };
  const notifies: NotifyEvent[] = [];
  t.hub.bus.on("notify", (e) => { notifies.push(e); });
  return { script, notifies };
}

test("ops: an ssh login the machine refuses is a failure, not a machine away; away for three days is said too", async () => {
  const t = makeHub();
  try {
    let reply = { code: 255, stdout: "", stderr: "Host key verification failed.\n" };
    t.hub.checkers.backup = backupChecker((async () => reply) as SshRunner);
    const m = t.hub.store.create("monitor", { name: "Storage backup", type: "backup", target: "linux:storage", expect: "28", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true });
    let after = await runCheck(t.hub, m.id, at(0));
    assert.equal(after.fields.state, "down");
    assert.match(String(after.fields.last_error), /refused the hub's ssh login: Host key verification failed/);

    // Away (timed out) after a good check: skipped, and the "(2 h ago)" is no longer claimed.
    const m2 = t.hub.store.create("monitor", { name: "Laptop backup", type: "backup", target: "mac:laptop", expect: "28", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true, state: "up", last_ok: at(0).toISOString(), last_detail: "last good backup 2026-10-29 08:10 UTC (2 h ago)" });
    reply = { code: 255, stdout: "", stderr: "ssh: connect to host laptop port 22: Operation timed out\n" };
    after = await runCheck(t.hub, m2.id, at(HOUR));
    assert.equal(after.fields.state, "up");
    assert.equal(after.fields.last_detail, "last good backup 2026-10-29 08:10 UTC");
    after = await runCheck(t.hub, m2.id, at(AWAY_LIMIT_MS + HOUR));
    assert.equal(after.fields.state, "down", "three days with nothing checked");
    assert.match(String(after.fields.last_error), /unreachable.*nothing checked for 3 days/);
  } finally { t.cleanup(); }
});

test("ops: a retry still running after a failed run stays down instead of flapping up", () => {
  const now = new Date("2026-10-29T17:00:00Z");
  const ms = (s: string) => new Date(s).getTime();
  const t = parseBackupTarget("linux:storage");
  const r = { running: true, events: [
    { at: ms("2026-10-29T08:00:00Z"), kind: "ok" as const },
    { at: ms("2026-10-29T12:00:00Z"), kind: "start" as const },
    { at: ms("2026-10-29T12:30:00Z"), kind: "fail" as const, detail: "one or more sources failed" },
    { at: ms("2026-10-29T16:30:00Z"), kind: "start" as const },
  ] };
  const out = backupOutcome(t, r, 28, now);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /running since 2026-10-29 16:30 UTC; the backup at 2026-10-29 12:30 UTC failed: one or more sources failed/);
  // Running after a good run is still fine.
  assert.equal(backupOutcome(t, { running: true, events: [r.events[0], r.events[3]] }, 28, now).ok, true);
});

test("ops: deleting a down monitor ends its incident; a hand check of one that is off opens none", async () => {
  const t = makeHub();
  try {
    const { script, notifies } = scripted(t);
    const m = t.hub.store.create("monitor", { name: "oldbox ping", type: "ping", target: "old", interval_s: 60, timeout_s: 5, fails_before_down: 1, enabled: true });
    script.set("old", [{ ok: false, error: "no reply" }]);
    await runCheck(t.hub, m.id, at(0));
    assert.equal(t.hub.store.list({ kind: "incident" }).filter((i) => !i.fields.closed_at).length, 1);
    t.hub.store.patch(m.id, { deleted_at: at(HOUR).toISOString() });
    assert.equal(t.hub.store.list({ kind: "incident" }).filter((i) => !i.fields.closed_at).length, 0);
    const before = notifies.length;
    assert.deepEqual(renotifyTick(t.hub, at(7 * HOUR)), []);
    assert.equal(notifies.length, before);

    // An incident left open (acknowledged) from a monitor deleted before this fix is closed by the sweep.
    const gone = t.hub.store.create("incident", { monitor_id: "no-such-monitor", name: "core ping (LAN)", opened_at: at(0).toISOString(), acknowledged_at: at(HOUR).toISOString() });
    renotifyTick(t.hub, at(2 * HOUR));
    assert.ok(t.hub.store.get(gone.id)!.fields.closed_at);

    const off = t.hub.store.create("monitor", { name: "spare", type: "ping", target: "spare", interval_s: 60, timeout_s: 5, fails_before_down: 1, enabled: false });
    script.set("spare", [{ ok: false, error: "no reply" }]);
    const checked = await runCheck(t.hub, off.id, at(0));
    assert.equal(checked.fields.last_error, "no reply");
    assert.equal(t.hub.store.list({ kind: "incident", where: { monitor_id: off.id } }).length, 0);
  } finally { t.cleanup(); }
});

test("ops: the re-notify time survives a restart", async () => {
  const t = makeHub();
  try {
    const { script } = scripted(t);
    const m = t.hub.store.create("monitor", { name: "nas", type: "ping", target: "n", interval_s: 60, timeout_s: 5, fails_before_down: 1, enabled: true });
    script.set("n", [{ ok: false, error: "down" }]);
    await runCheck(t.hub, m.id, at(0));
    assert.equal(renotifyTick(t.hub, at(6 * HOUR)).length, 1);
    const inc = t.hub.store.list({ kind: "incident" })[0];
    assert.equal(t.hub.store.get(inc.id)!.fields.renotified_at, at(6 * HOUR).toISOString());
  } finally { t.cleanup(); }
  // A fresh process: the in-memory map is empty, the incident's renotified_at is what counts.
  const t2 = makeHub();
  try {
    const m = t2.hub.store.create("monitor", { name: "nas", type: "ping", target: "n", interval_s: 60, timeout_s: 5, fails_before_down: 1, enabled: true, state: "down" });
    t2.hub.store.create("incident", { monitor_id: m.id, name: "nas", opened_at: at(0).toISOString(), renotified_at: at(6 * HOUR).toISOString() });
    assert.deepEqual(renotifyTick(t2.hub, at(6 * HOUR + 60_000)), [], "not again a minute after the last one");
    assert.equal(renotifyTick(t2.hub, at(12 * HOUR)).length, 1);
  } finally { t2.cleanup(); }
});

test("ops: a first reading already out of range notifies; a value a machine stops reporting goes stale", () => {
  const t = makeHub();
  try {
    const notes: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { if (e.kind === "sensor") notes.push(e); });
    const now = new Date();
    storeHostValues(t.hub, "storage", [{ name: "storage.zfs.tank.healthy", value: 0, unit: "" }, { name: "storage.disk.root.used", value: 40, unit: "%" }], now);
    assert.deepEqual(notes.map((n) => n.title), ["storage.zfs.tank.healthy low: 0"]);
    // A first reading that is fine says nothing.
    recordReading(t.hub, "garage.temp", { value: 18 }, now);
    assert.equal(notes.length, 1);

    // The pool vanishes from a machine that still reports its disk.
    const disk = [{ name: "storage.disk.root.used", value: 41, unit: "%" }];
    for (let i = 1; i < MISSING_TICKS; i++) assert.deepEqual(markMissing(t.hub, "storage", disk, now), []);
    assert.deepEqual(markMissing(t.hub, "storage", disk, now), ["storage.zfs.tank.healthy"]);
    assert.equal(sensorByName(t.hub, "storage.zfs.tank.healthy")!.fields.state, "stale");
    assert.match(notes.at(-1)!.title, /storage\.zfs\.tank\.healthy stale: storage no longer reports it/);
    assert.equal(sensorByName(t.hub, "storage.disk.root.used")!.fields.state, "ok");
  } finally { t.cleanup(); }
});

test("ops: the morning digest names what is down and the sensors out of range", () => {
  const t = makeHub();
  try {
    assert.equal(opsLine(t.hub), null);
    t.hub.store.create("monitor", { name: "Storage backup", type: "backup", target: "linux:storage", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true, state: "down" });
    t.hub.store.create("monitor", { name: "spare", type: "ping", target: "s", interval_s: 60, timeout_s: 5, fails_before_down: 1, enabled: false, state: "down" });
    t.hub.store.create("sensor", { name: "core.disk.mnt-b.used", unit: "%", state: "high", alert: true });
    t.hub.store.create("sensor", { name: "garage.temp", unit: "C", state: "stale", alert: false });
    assert.equal(opsLine(t.hub), "Homelab: down Storage backup; sensors core.disk.mnt-b.used high");
    assert.match(todayView(t.hub).digest, /Homelab: down Storage backup/);
  } finally { t.cleanup(); }
});

test("ops: a certificate browsers refuse is down even with a far expiry; self-signed on purpose is allowed", async () => {
  const far = new Date(Date.now() + 200 * 24 * HOUR).toISOString();
  assert.deepEqual(tlsOutcome(far, new Date(), { trusted: false, trust_error: "DEPTH_ZERO_SELF_SIGNED_CERT" }), { ok: false, error: "certificate not trusted: DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.deepEqual(tlsOutcome(far, new Date(), { trusted: false, trust_error: "x", allowUntrusted: true }), { ok: true });
  assert.deepEqual(tlsOutcome(far, new Date(), { trusted: true }), { ok: true });

  // A real handshake: a self-signed certificate for another name, served on 127.0.0.1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "200", "-subj", "/CN=wrong.example"], { stdio: "ignore" });
  } catch { fs.rmSync(dir, { recursive: true, force: true }); return; } // no openssl here: the unit checks above stand
  const server = tls.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await probeTls(`https://localhost:${port}/`, 5000);
    assert.equal(r.trusted, false);
    assert.ok(r.trust_error);
    assert.ok(new Date(r.valid_to).getTime() > Date.now());
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
