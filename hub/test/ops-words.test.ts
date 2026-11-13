import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { defaultCheckers, netWords, renotifyTick, runCheck, seconds, RENOTIFY_MS, type Checker } from "../src/monitors.js";
import { makeHub } from "./helpers.js";
import type { NotifyEvent } from "../src/bus.js";

// Alerts say what happened in words ("Ollama down: no answer within 5 s"), not Node's codes or "ping exit 1".

test("ops words: network codes become sentences, unknown errors keep their message", () => {
  assert.equal(seconds(5000), "5 s");
  assert.equal(seconds(1500), "1.5 s");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 100.64.0.7:11434"), { code: "ECONNREFUSED", port: 11434 }) });
  assert.equal(netWords(refused), "refused the connection on port 11434: nothing is listening there");
  assert.equal(netWords(Object.assign(new Error("connect EHOSTUNREACH 100.64.0.7:11434"), { code: "EHOSTUNREACH" })), "no route to the machine: it is off, asleep or off the network");
  assert.equal(netWords(Object.assign(new Error("getaddrinfo ENOTFOUND nas.lan"), { code: "ENOTFOUND", hostname: "nas.lan" })), "the name nas.lan was not found");
  assert.equal(netWords(new Error("certificate has expired")), "certificate has expired");
});

test("ops words: a port nobody listens on, and a web check that gets no answer", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const tcp = await defaultCheckers.tcp({ target: `127.0.0.1:${port}`, timeoutMs: 2000, now: new Date() });
  assert.deepEqual(tcp, { ok: false, error: `refused the connection on port ${port}: nothing is listening there` });

  // Accepts the connection and never answers.
  const silent = net.createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const http = await defaultCheckers.http({ target: `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/api/tags`, timeoutMs: 300, now: new Date() });
    assert.deepEqual(http, { ok: false, error: "no answer within 0.3 s" });
  } finally {
    silent.close();
  }
});

test("ops words: a down alert names its incident, on the first alert and on each re-notify, so it can be acknowledged", async () => {
  const t = makeHub();
  try {
    let ok = false;
    const fake: Checker = async () => (ok ? { ok: true } : { ok: false, error: "no reply within 2 s" });
    t.hub.checkers = { ...t.hub.checkers, ping: fake };
    const seen: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { seen.push(e); });
    const m = t.hub.store.create("monitor", { name: "nas ping", type: "ping", target: "nas", interval_s: 60, timeout_s: 2, fails_before_down: 1, enabled: true });
    const t0 = new Date("2026-11-13T12:00:00Z");
    await runCheck(t.hub, m.id, t0);
    const inc = t.hub.store.list({ kind: "incident" })[0];
    assert.equal(seen.length, 1);
    assert.deepEqual({ state: seen[0].state, incident_id: seen[0].incident_id, title: seen[0].title }, { state: "down", incident_id: inc.id, title: "nas ping down: no reply within 2 s" });
    renotifyTick(t.hub, new Date(t0.getTime() + RENOTIFY_MS + 1000));
    assert.equal(seen.at(-1)!.incident_id, inc.id);
    ok = true;
    await runCheck(t.hub, m.id, new Date(t0.getTime() + RENOTIFY_MS + 60_000));
    assert.deepEqual({ state: seen.at(-1)!.state, incident_id: seen.at(-1)!.incident_id }, { state: "up", incident_id: undefined });
  } finally {
    t.cleanup();
  }
});

test("ops words: smaller review fixes (Windows ping, journal window, long sensor names, overnight incidents in the digest)", async () => {
  const { pingArgs } = await import("../src/monitors.js");
  assert.deepEqual(pingArgs("nas", 2000, "win32"), ["-n", "1", "-w", "2000", "nas"]);
  assert.deepEqual(pingArgs("nas", 2000, "linux"), ["-c", "1", "-W", "2", "nas"]);
  const { journalDays, backupCommand, parseBackupTarget, backupHours } = await import("../src/backups.js");
  assert.equal(journalDays(28), 40);
  assert.equal(journalDays(1000), 44, "a restore test allowed 1000 h is read back far enough to be seen");
  const t = parseBackupTarget("linux:nas");
  assert.match(backupCommand(t, undefined, backupHours("28,restore=1000", t)).remote, /project-backup-restore-test\.service --since=-44d/);
  const { sensorName } = await import("../src/hostsensors.js");
  const long = `nas.disk.${"mnt-".repeat(30)}photos.used`;
  assert.equal(sensorName(long).length, 80);
  assert.ok(sensorName(long).startsWith("nas.disk.") && sensorName(long).endsWith("photos.used"));

  const { opsLine } = await import("../src/planner.js");
  const th = makeHub();
  try {
    th.hub.modules.set({ homelab: true });
    const now = new Date("2026-11-13T14:00:00Z");
    th.hub.store.create("incident", { monitor_id: "x", name: "nas ping", opened_at: "2026-11-13T03:00:00Z", closed_at: "2026-11-13T03:20:00Z", checks_failed: 3 });
    th.hub.store.create("incident", { monitor_id: "y", name: "Ollama", opened_at: "2026-11-11T03:00:00Z", closed_at: "2026-11-11T03:20:00Z", checks_failed: 3 });
    assert.equal(opsLine(th.hub, now), "Homelab: 1 incident came and went in the last 24 h");
  } finally { th.cleanup(); }
});
