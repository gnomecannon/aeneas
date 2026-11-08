import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { dueMonitors, httpOutcome, monitorTick, pingArgs, parseHostPort, pruneChecks, renotifyTick, runCheck, tlsOutcome, uptime24h, type CheckOutcome, type Checker } from "../src/monitors.js";
import { runSeed } from "../src/seed.js";
import type { NotifyEvent } from "../src/bus.js";

const MIN = 60_000;
const HOUR = 3600_000;
// An hour ago on the hour, so counts over the last 7 days still include it whenever the tests run.
const T0 = new Date(Math.floor(Date.now() / 3600_000) * 3600_000 - 3600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A hub whose checks of every type answer from `script` (per target, a queue; the last answer repeats). Nothing leaves the process. */
function fakeHub(): TestHub & { script: Map<string, CheckOutcome[]>; calls: string[]; notifies: NotifyEvent[] } {
  const t = makeHub();
  const script = new Map<string, CheckOutcome[]>();
  const calls: string[] = [];
  const fake: Checker = async ({ target }) => {
    calls.push(target);
    const q = script.get(target) ?? [{ ok: true }];
    return q.length > 1 ? q.shift()! : q[0];
  };
  t.hub.checkers = { ping: fake, tcp: fake, http: fake, tls: fake, dns: fake, backup: fake };
  const notifies: NotifyEvent[] = [];
  t.hub.bus.on("notify", (e) => { if (e.kind === "monitor") notifies.push(e); });
  return Object.assign(t, { script, calls, notifies });
}

function addMonitor(t: TestHub, fields: Record<string, unknown>) {
  return t.hub.store.create("monitor", { type: "ping", interval_s: 60, timeout_s: 5, fails_before_down: 3, enabled: true, ...fields });
}

test("monitors: fails_before_down failures open one incident and notify down once", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "nas", host: "storage", target: "10.0.0.1" });
    t.script.set("10.0.0.1", [{ ok: true }, { ok: false, error: "timeout" }]);
    let cur = await runCheck(t.hub, m.id, at(0));
    assert.equal(cur.fields.state, "up");
    cur = await runCheck(t.hub, m.id, at(MIN));
    cur = await runCheck(t.hub, m.id, at(2 * MIN));
    assert.equal(cur.fields.state, "up", "two failures stay under the threshold");
    assert.equal(cur.fields.consecutive_fails, 2);
    assert.equal(t.notifies.length, 0);
    cur = await runCheck(t.hub, m.id, at(3 * MIN));
    assert.equal(cur.fields.state, "down");
    assert.equal(cur.fields.last_error, "timeout");
    await runCheck(t.hub, m.id, at(4 * MIN));
    await runCheck(t.hub, m.id, at(5 * MIN));
    const incidents = t.hub.store.list({ kind: "incident" });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].fields.name, "nas");
    assert.equal(incidents[0].fields.opened_at, at(3 * MIN).toISOString());
    assert.equal(incidents[0].fields.checks_failed, 5, "the incident counts every failure while open");
    assert.equal(t.notifies.length, 1);
    assert.deepEqual([t.notifies[0].name, t.notifies[0].state, t.notifies[0].error], ["nas", "down", "timeout"]);
  } finally { t.cleanup(); }
});

test("monitors: recovery closes the incident and notifies up; a later outage opens a new one", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "ollama", type: "http", target: "http://x/api", fails_before_down: 1 });
    t.script.set("http://x/api", [{ ok: false, error: "status 502" }, { ok: true }, { ok: false, error: "refused" }]);
    await runCheck(t.hub, m.id, at(0));
    assert.equal(t.hub.store.get(m.id)!.fields.state, "down");
    const back = await runCheck(t.hub, m.id, at(MIN));
    assert.equal(back.fields.state, "up");
    assert.equal(back.fields.consecutive_fails, 0);
    assert.equal(back.fields.last_error, undefined, "a success clears last_error");
    assert.equal(back.fields.last_ok, at(MIN).toISOString());
    const first = t.hub.store.list({ kind: "incident" })[0];
    assert.equal(first.fields.closed_at, at(MIN).toISOString());
    assert.deepEqual(t.notifies.map((n) => n.state), ["down", "up"]);
    await runCheck(t.hub, m.id, at(2 * MIN));
    assert.equal(t.hub.store.list({ kind: "incident" }).length, 2);
    const ops = await (await t.api("/ops")).json() as any;
    assert.equal(ops.incidents_open.length, 1);
    assert.equal(ops.monitors[0].incident_open.fields.last_error, "refused");
    assert.equal(ops.incidents_7d, 2);
  } finally { t.cleanup(); }
});

test("monitors: history and uptime_24h come from the checks table", async () => {
  const t = fakeHub();
  try {
    const a = addMonitor(t, { name: "a", target: "a" });
    const b = addMonitor(t, { name: "b", target: "b" });
    addMonitor(t, { name: "c", target: "c" });
    t.script.set("a", [{ ok: true }, { ok: true }, { ok: false, error: "lost" }, { ok: true }]);
    const now = new Date();
    for (let i = 0; i < 4; i++) await runCheck(t.hub, a.id, new Date(now.getTime() - (3 - i) * HOUR));
    await runCheck(t.hub, b.id, new Date(now.getTime() - 30 * HOUR));
    const up = uptime24h(t.hub, now);
    assert.deepEqual(up, [{ name: "a", pct: 75 }, { name: "b", pct: null }, { name: "c", pct: null }]);

    const res = await t.api(`/monitors/${a.id}/history?hours=24`);
    assert.equal(res.status, 200);
    const rows = await res.json() as any[];
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.ok), [true, true, false, true]);
    assert.equal(rows[2].error, "lost");
    assert.equal("error" in rows[0], false);
    assert.equal(typeof rows[0].latency_ms, "number");
    assert.equal((await (await t.api(`/monitors/${a.id}/history?hours=2.5`)).json() as any[]).length, 3);
    assert.equal((await t.api(`/monitors/${a.id}/history?hours=0`)).status, 400);
    assert.equal((await t.api(`/monitors/nope/history`)).status, 404);
    assert.equal((await t.api(`/monitors/nope/check`, { method: "POST" })).status, 404);

    assert.equal(pruneChecks(t.hub, 7, new Date(now.getTime() + 7 * 24 * HOUR - 2 * HOUR)), 2, "the 30 h old row and the oldest of a fall past 7 days");
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM checks").get() as { n: number }).n, 3);
  } finally { t.cleanup(); }
});

test("monitors: ack with a note writes and links a journal entry on the monitor's host", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "desk-pc ping", host: "desk-pc", target: "g", fails_before_down: 1 });
    t.script.set("g", [{ ok: false, error: "unreachable" }]);
    await runCheck(t.hub, m.id, at(0));
    const inc = t.hub.store.list({ kind: "incident" })[0];
    const res = await t.api(`/incidents/${inc.id}/ack`, { method: "POST", json: { note: "power cut, UPS swapped" } });
    assert.equal(res.status, 200);
    const acked = await res.json() as any;
    assert.ok(acked.fields.acknowledged_at);
    assert.equal(acked.fields.ack_note, "power cut, UPS swapped");
    const j = t.hub.store.get(acked.fields.journal_id)!;
    assert.equal(j.kind, "journal");
    assert.equal(j.fields.host, "desk-pc");
    assert.equal(j.fields.risk, "low");
    assert.equal(j.fields.what, "Incident acknowledged: desk-pc ping: power cut, UPS swapped");
    assert.equal(j.fields.command, undefined);
    const ops = await (await t.api("/ops")).json() as any;
    assert.equal(ops.journal_recent[0].id, j.id);
    assert.ok(ops.hosts.some((h: any) => h.host === "desk-pc" && h.journal_entries === 1));
  } finally { t.cleanup(); }
});

test("monitors: ack without a body or note writes no journal; bad bodies and unknown ids are rejected", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "x", target: "x", fails_before_down: 1 });
    t.script.set("x", [{ ok: false, error: "e" }]);
    await runCheck(t.hub, m.id, at(0));
    const inc = t.hub.store.list({ kind: "incident" })[0];
    const res = await t.api(`/incidents/${inc.id}/ack`, { method: "POST" });
    assert.equal(res.status, 200);
    const acked = await res.json() as any;
    assert.ok(acked.fields.acknowledged_at);
    assert.equal(acked.fields.journal_id, undefined);
    assert.equal(t.hub.store.list({ kind: "journal" }).length, 0);
    assert.equal((await t.api(`/incidents/${inc.id}/ack`, { method: "POST", body: "[1]", headers: { "content-type": "application/json" } })).status, 400);
    assert.equal((await t.api(`/incidents/${inc.id}/ack`, { method: "POST", body: "{", headers: { "content-type": "application/json" } })).status, 400);
    assert.equal((await t.api(`/incidents/${inc.id}/ack`, { method: "POST", json: { note: 5 } })).status, 422);
    assert.equal((await t.api(`/incidents/nope/ack`, { method: "POST", json: {} })).status, 404);
  } finally { t.cleanup(); }
});

test("monitors: an open incident re-notifies every 6 hours until acknowledged", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "nas", target: "n", fails_before_down: 1 });
    t.script.set("n", [{ ok: false, error: "down" }]);
    await runCheck(t.hub, m.id, at(0));
    assert.equal(t.notifies.length, 1);
    assert.deepEqual(renotifyTick(t.hub, at(6 * HOUR - MIN)), []);
    assert.equal(renotifyTick(t.hub, at(6 * HOUR)).length, 1);
    assert.deepEqual(renotifyTick(t.hub, at(6 * HOUR + 15_000)), [], "once per window");
    assert.deepEqual(renotifyTick(t.hub, at(11 * HOUR)), []);
    assert.equal(renotifyTick(t.hub, at(12 * HOUR)).length, 1);
    assert.equal(t.notifies.length, 3);
    assert.deepEqual([t.notifies[2].state, t.notifies[2].error], ["down", "down"]);
    const inc = t.hub.store.list({ kind: "incident" })[0];
    await t.api(`/incidents/${inc.id}/ack`, { method: "POST", json: {} });
    assert.deepEqual(renotifyTick(t.hub, at(30 * HOUR)), [], "acknowledged incidents stay quiet");
  } finally { t.cleanup(); }
});

test("monitors: http expect handling, numeric status and body text", () => {
  assert.deepEqual(httpOutcome(200, "", undefined), { ok: true });
  assert.deepEqual(httpOutcome(301, "", ""), { ok: true });
  assert.equal(httpOutcome(404, "", undefined).ok, false);
  assert.equal(httpOutcome(500, "", undefined).error, "status 500");
  assert.deepEqual(httpOutcome(401, "", "401"), { ok: true }, "a numeric expect accepts that exact status, even a 4xx");
  assert.equal(httpOutcome(200, "", "204").ok, false);
  assert.deepEqual(httpOutcome(200, '{"ok":true}', "ok"), { ok: true });
  assert.deepEqual(httpOutcome(503, "maintenance ok", "ok"), { ok: true }, "text expect looks at the body only");
  const miss = httpOutcome(200, '{"models":[]}', "llama");
  assert.equal(miss.ok, false);
  assert.match(miss.error!, /llama/);
});

test("monitors: tls days, ping flags and tcp targets", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  assert.deepEqual(tlsOutcome("2026-12-31T00:00:00Z", now), { ok: true });
  assert.deepEqual(tlsOutcome("2026-11-01T00:00:00Z", now), { ok: false, error: "certificate expires in 10 days" });
  assert.deepEqual(tlsOutcome("2026-10-20T00:00:00Z", now), { ok: false, error: "certificate expired 2 days ago" });
  assert.deepEqual(pingArgs("10.0.0.1", 5000, "linux"), ["-c", "1", "-W", "5", "10.0.0.1"]);
  assert.deepEqual(pingArgs("10.0.0.1", 1500, "darwin"), ["-c", "1", "-t", "2", "10.0.0.1"]);
  assert.deepEqual(parseHostPort("core:8787"), { host: "core", port: 8787 });
  assert.deepEqual(parseHostPort("[::1]:22"), { host: "::1", port: 22 });
  assert.throws(() => parseHostPort("core"), /host:port/);
  assert.throws(() => parseHostPort("core:70000"), /host:port/);
});

test("monitors: the scheduler respects interval_s and enabled", async () => {
  const t = fakeHub();
  try {
    const fast = addMonitor(t, { name: "fast", target: "fast", interval_s: 60 });
    addMonitor(t, { name: "slow", target: "slow", interval_s: 300 });
    addMonitor(t, { name: "off", target: "off", enabled: false });
    assert.deepEqual((await monitorTick(t.hub, at(0))).length, 2, "never checked: both enabled run");
    assert.deepEqual(t.calls.sort(), ["fast", "slow"]);
    t.calls.length = 0;
    assert.deepEqual(await monitorTick(t.hub, at(15_000)), []);
    assert.deepEqual(await monitorTick(t.hub, at(60_000)), [fast.id]);
    assert.deepEqual(t.calls, ["fast"]);
    assert.equal(dueMonitors(t.hub, at(300_000)).length, 2);
    await monitorTick(t.hub, at(300_000));
    assert.deepEqual(t.calls.sort(), ["fast", "fast", "slow"]);
    assert.equal(t.calls.includes("off"), false);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM checks").get() as { n: number }).n, 5);
  } finally { t.cleanup(); }
});

test("monitors: at most 8 checks run at once", async () => {
  const t = fakeHub();
  try {
    let live = 0, peak = 0;
    t.hub.checkers.tcp = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { ok: true }; };
    for (let i = 0; i < 20; i++) addMonitor(t, { name: `m${i}`, type: "tcp", target: `h${i}:22` });
    assert.equal((await monitorTick(t.hub, at(0))).length, 20);
    assert.equal(peak, 8);
  } finally { t.cleanup(); }
});

test("monitors: POST /monitors/:id/check runs now; /status.ops and proof rows count incidents", async () => {
  const t = fakeHub();
  try {
    const m = addMonitor(t, { name: "hub", type: "http", target: "http://127.0.0.1:1/health", fails_before_down: 1 });
    t.script.set("http://127.0.0.1:1/health", [{ ok: false, error: "refused" }]);
    const res = await t.api(`/monitors/${m.id}/check`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.fields.state, "down");
    assert.ok(body.fields.last_check);
    const status = await (await t.api("/status")).json() as any;
    assert.deepEqual(status.ops, { monitors: 1, down: 1, incidents_open: 1 });
    const proof = await (await t.api("/metrics/proof?days=2")).json() as any;
    assert.equal(proof.rows[1].incidents_opened, 1);
    assert.equal(proof.rows[0].incidents_opened, 0);
    assert.equal(proof.totals.incidents_opened, 1);
  } finally { t.cleanup(); }
});

test("monitors: seed creates the contract list once, by name, and leaves edits and deletions alone", () => {
  const t = makeHub();
  try {
    const first = runSeed(t.hub.store, t.hub.cfg.seedDir).monitors;
    assert.equal(first.created, 23, "18 at home and 5 at the other site");
    const all = t.hub.store.list({ kind: "monitor" });
    assert.equal(all.filter((m) => m.fields.type === "ping").length, 6);
    assert.equal(all.filter((m) => m.fields.type === "backup").length, 7);
    assert.ok(all.filter((m) => m.fields.type === "ping").every((m) => m.fields.interval_s === 120));
    const hubMon = all.find((m) => m.fields.target === "http://127.0.0.1:8787/health")!;
    assert.deepEqual([hubMon.fields.expect, hubMon.fields.interval_s], ["ok", 60]);
    assert.equal(all.find((m) => m.fields.target === "http://100.90.0.5:11434/api/tags")!.fields.interval_s, 60);
    // The hub runs on server, so server is not pinged and its own TLS endpoint is not probed (it cannot reach it).
    assert.ok(!all.some((m) => m.fields.host === "server" && (m.fields.type === "ping" || m.fields.type === "tls")));
    for (const ip of ["192.168.50.16", "192.168.50.5", "192.168.50.2", "100.90.0.16", "100.90.0.5", "100.90.0.2"]) assert.ok(all.some((m) => m.fields.target === ip), ip);
    for (const t of ["10.20.0.1:443", "10.20.0.9:8006", "10.20.0.8:8006", "10.20.0.10:389", "10.20.0.12:389"]) assert.ok(all.some((m) => m.fields.target === t && m.fields.type === "tcp"), t);

    t.hub.store.patch(hubMon.id, { interval_s: 30 });
    t.hub.store.patch(all.find((m) => m.fields.target === "192.168.50.2")!.id, { deleted_at: new Date().toISOString() });
    assert.deepEqual(runSeed(t.hub.store, t.hub.cfg.seedDir).monitors, { created: 0, kept: 23 });
    assert.equal(t.hub.store.get(hubMon.id)!.fields.interval_s, 30);
    assert.equal(t.hub.store.list({ kind: "monitor" }).length, 22);
  } finally { t.cleanup(); }
});

test("disabling a down monitor closes its incident and stops counting it as down", async () => {
  const { makeHub } = await import("./helpers.ts");
  const t = makeHub();
  try {
    const m = t.hub.store.create("monitor", { name: "flaky", type: "http", target: "http://x", enabled: true, fails_before_down: 1 });
    t.hub.checkers.http = async () => ({ ok: false, error: "boom" });
    const { runCheck, opsStatus } = await import("../src/monitors.ts");
    await runCheck(t.hub, m.id);
    assert.equal(opsStatus(t.hub).down, 1);
    assert.equal(opsStatus(t.hub).incidents_open, 1);
    t.hub.store.patch(m.id, { enabled: false });
    assert.equal(t.hub.store.get(m.id)!.fields.state, "unknown");
    assert.equal(opsStatus(t.hub).down, 0);
    assert.equal(opsStatus(t.hub).incidents_open, 0);
  } finally { t.cleanup(); }
});

test("steady-state checks do not write to the sync feed; transitions do", async () => {
  const { makeHub } = await import("./helpers.ts");
  const t = makeHub();
  try {
    const { runCheck } = await import("../src/monitors.ts");
    const m = t.hub.store.create("monitor", { name: "steady", type: "http", target: "http://x", enabled: true, fails_before_down: 2 });
    let ok = true;
    t.hub.checkers.http = async () => (ok ? { ok: true } : { ok: false, error: "boom" });
    await runCheck(t.hub, m.id); // unknown -> up: one change
    const afterFirst = t.hub.store.seq();
    for (let i = 0; i < 5; i++) await runCheck(t.hub, m.id); // steady up: silent
    assert.equal(t.hub.store.seq(), afterFirst, "steady up checks must not add change rows");
    assert.ok(t.hub.store.get(m.id)!.fields.last_check, "bookkeeping still stored");
    ok = false;
    await runCheck(t.hub, m.id); // first failure: silent
    assert.equal(t.hub.store.seq(), afterFirst);
    await runCheck(t.hub, m.id); // down: monitor change plus incident create
    const afterDown = t.hub.store.seq();
    assert.ok(afterDown > afterFirst);
    for (let i = 0; i < 4; i++) await runCheck(t.hub, m.id); // still down: silent, incident counter grows
    assert.equal(t.hub.store.seq(), afterDown, "repeated failures while down must not add change rows");
  } finally { t.cleanup(); }
});
