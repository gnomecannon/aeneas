import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { opsView, renotifyTick, runCheck, RENOTIFY_MS, type Checker } from "../src/monitors.js";
import type { NotifyEvent } from "../src/bus.js";
import type { Entity } from "@everythingapp/shared";

// On one owner's hub, a desktop going away opened one incident per monitor on it (two pings and Ollama), 13 in one
// afternoon: 34 incidents in three weeks were 20 outages. A machine that stops answering is now one incident.

const T0 = new Date("2026-11-13T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function lab(t: TestHub) {
  const down = new Set<string>();
  const fake: Checker = async ({ target }) => (down.has(target) ? { ok: false, error: "no reply within 2 s" } : { ok: true });
  t.hub.checkers = { ...t.hub.checkers, ping: fake, http: fake };
  const alerts: NotifyEvent[] = [];
  t.hub.bus.on("notify", (e) => { alerts.push(e); });
  const mk = (name: string, type: "ping" | "http", target: string, host: string, fails = 1) =>
    t.hub.store.create("monitor", { name, type, target, host, interval_s: 60, timeout_s: 2, fails_before_down: fails, enabled: true });
  return {
    down, alerts, mk,
    lan: mk("desk ping (LAN)", "ping", "desk-lan", "desk"),
    ts: mk("desk ping (Tailscale)", "ping", "desk-ts", "desk"),
    ollama: mk("Ollama", "http", "http://desk:11434/api/tags", "Desk"),
    nas: mk("storage ping", "ping", "storage", "storage"),
  };
}
const incidents = (t: TestHub) => t.hub.store.list({ kind: "incident" });
const fields = (t: TestHub, e: Entity) => t.hub.store.get(e.id)!.fields;

test("machine incident: a machine going away is one incident and one alert; its monitors come back quietly", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    for (const x of ["desk-lan", "desk-ts", "http://desk:11434/api/tags"]) l.down.add(x);
    await runCheck(t.hub, l.lan.id, at(0));
    await runCheck(t.hub, l.ts.id, at(1));
    await runCheck(t.hub, l.ollama.id, at(2));
    const [inc] = incidents(t);
    assert.equal(incidents(t).length, 1);
    assert.deepEqual(t.hub.store.get(inc.id)!.fields.also_down, ["desk ping (Tailscale)", "Ollama"]);
    assert.deepEqual(l.alerts.map((a) => [a.name, a.state]), [["desk ping (LAN)", "down"]]);
    for (const m of [l.ts, l.ollama]) assert.deepEqual([fields(t, m).state, fields(t, m).joined_incident], ["down", inc.id]);
    // Ops shows the machine's incident on each of them: one Acknowledge for all.
    const board = opsView(t.hub, at(3)).monitors as (Entity & { incident_open: Entity | null })[];
    assert.deepEqual(board.filter((m) => m.incident_open?.id === inc.id).map((m) => m.fields.name).sort(), ["Ollama", "desk ping (LAN)", "desk ping (Tailscale)"]);

    // The 6 hour reminder says what else is still down.
    renotifyTick(t.hub, new Date(T0.getTime() + RENOTIFY_MS + 1000));
    assert.equal(l.alerts.at(-1)!.title, "desk ping (LAN) still down since Nov 13, 7:00 AM (6 h): no reply within 2 s; also down: desk ping (Tailscale), Ollama");
    l.down.delete("http://desk:11434/api/tags");
    await runCheck(t.hub, l.ollama.id, at(370));
    renotifyTick(t.hub, new Date(T0.getTime() + 2 * RENOTIFY_MS + 2000));
    assert.equal(l.alerts.at(-1)!.title, "desk ping (LAN) still down since Nov 13, 7:00 AM (12 h): no reply within 2 s; also down: desk ping (Tailscale)");
    assert.deepEqual(t.hub.store.get(inc.id)!.fields.also_down, ["desk ping (Tailscale)", "Ollama"], "the incident keeps everything that went down with it");

    l.down.clear();
    await runCheck(t.hub, l.ollama.id, at(400));
    await runCheck(t.hub, l.ts.id, at(401));
    await runCheck(t.hub, l.lan.id, at(402));
    assert.deepEqual(l.alerts.map((a) => [a.name, a.state]), [["desk ping (LAN)", "down"], ["desk ping (LAN)", "down"], ["desk ping (LAN)", "down"], ["desk ping (LAN)", "up"]]);
    assert.ok(t.hub.store.get(inc.id)!.fields.closed_at);
    for (const m of [l.lan, l.ts, l.ollama]) assert.deepEqual([fields(t, m).state, fields(t, m).joined_incident], ["up", undefined]);
  } finally { t.cleanup(); }
});

test("machine incident: a service failing on a machine that answers, or another machine, keeps its own incident", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    l.down.add("http://desk:11434/api/tags");
    await runCheck(t.hub, l.ollama.id, at(0));
    assert.equal(incidents(t).length, 1);
    assert.equal(fields(t, l.ollama).joined_incident, undefined);
    // The desktop then goes away: its ping opens the machine's incident; storage failing meanwhile is its own.
    l.down.add("desk-lan");
    l.down.add("storage");
    await runCheck(t.hub, l.lan.id, at(1));
    await runCheck(t.hub, l.nas.id, at(2));
    assert.equal(incidents(t).length, 3);
    assert.deepEqual(l.alerts.map((a) => a.name), ["Ollama", "desk ping (LAN)", "storage ping"]);
  } finally { t.cleanup(); }
});

test("machine incident: a monitor still failing after its machine is back opens its own incident then", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    for (const x of ["desk-lan", "desk-ts", "http://desk:11434/api/tags"]) l.down.add(x);
    await runCheck(t.hub, l.lan.id, at(0));
    await runCheck(t.hub, l.ts.id, at(0.5));
    await runCheck(t.hub, l.ollama.id, at(1));
    assert.equal(incidents(t).length, 1);
    l.down.delete("desk-lan");
    await runCheck(t.hub, l.lan.id, at(5));
    await runCheck(t.hub, l.ollama.id, at(6));
    const own = incidents(t).find((i) => i.fields.monitor_id === l.ollama.id && !i.fields.closed_at);
    assert.ok(own, "Ollama's own incident");
    assert.deepEqual(l.alerts.map((a) => [a.name, a.state, a.incident_id === own!.id]), [["desk ping (LAN)", "down", false], ["desk ping (LAN)", "up", false], ["Ollama", "down", true]]);
    assert.equal(fields(t, l.ollama).joined_incident, undefined);

    // Turned off while joined: nothing of the machine's incident stays on it.
    l.down.add("desk-lan");
    l.down.add("desk-ts");
    await runCheck(t.hub, l.lan.id, at(10));
    await runCheck(t.hub, l.ts.id, at(11));
    assert.ok(fields(t, l.ts).joined_incident);
    t.hub.store.patch(l.ts.id, { enabled: false });
    assert.deepEqual([fields(t, l.ts).state, fields(t, l.ts).joined_incident], ["unknown", undefined]);
  } finally { t.cleanup(); }
});

test("machine incident: a machine that still answers on its other address is not down; nothing joins an incident then", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    l.down.add("desk-lan");
    await runCheck(t.hub, l.lan.id, at(0));
    const [lanInc] = incidents(t);
    t.hub.store.patch(lanInc.id, { acknowledged_at: at(1).toISOString() });
    // A day later Ollama fails while the Tailscale ping answers: its own incident and alert, not a silent join.
    l.down.add("http://desk:11434/api/tags");
    await runCheck(t.hub, l.ts.id, at(1440));
    await runCheck(t.hub, l.ollama.id, at(1441));
    const own = incidents(t).find((i) => i.fields.monitor_id === l.ollama.id);
    assert.ok(own && !own.fields.closed_at);
    assert.equal(fields(t, l.ollama).joined_incident, undefined);
    assert.deepEqual(l.alerts.map((a) => a.name), ["desk ping (LAN)", "Ollama"]);
  } finally { t.cleanup(); }
});

test("machine incident: a service that went down just before its machine folds into the machine's incident", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    // Ollama is checked every minute and pings every 2, so Ollama goes down first.
    for (const x of ["desk-lan", "desk-ts", "http://desk:11434/api/tags"]) l.down.add(x);
    await runCheck(t.hub, l.ollama.id, at(0));
    await runCheck(t.hub, l.lan.id, at(2));
    await runCheck(t.hub, l.ts.id, at(3));
    const open = incidents(t).filter((i) => !i.fields.closed_at);
    assert.equal(open.length, 1, "one open incident: the machine's");
    const machine = open[0];
    assert.equal(machine.fields.monitor_id, l.lan.id);
    const folded = incidents(t).find((i) => i.fields.monitor_id === l.ollama.id)!;
    assert.deepEqual([!!folded.fields.closed_at, folded.fields.merged_into], [true, machine.id]);
    assert.deepEqual(t.hub.store.get(machine.id)!.fields.also_down, ["desk ping (Tailscale)", "Ollama"]);
    // Back: only the machine says so.
    l.down.clear();
    for (const [m, min] of [[l.ollama, 30], [l.ts, 31], [l.lan, 32]] as const) await runCheck(t.hub, m.id, at(min));
    assert.deepEqual(l.alerts.map((a) => [a.name, a.state]), [["Ollama", "down"], ["desk ping (LAN)", "down"], ["desk ping (LAN)", "up"]]);
  } finally { t.cleanup(); }
});

test("machine incident: a service slow to start after its machine answers gets its full count of failures first", async () => {
  const t = makeHub();
  try {
    const l = lab(t);
    const slow = l.mk("Media server", "http", "http://desk:8096/health", "desk", 3);
    for (const x of ["desk-lan", "desk-ts", "http://desk:8096/health"]) l.down.add(x);
    await runCheck(t.hub, l.lan.id, at(0));
    await runCheck(t.hub, l.ts.id, at(1));
    for (const min of [2, 3, 4]) await runCheck(t.hub, slow.id, at(min));
    assert.equal(fields(t, slow).joined_incident, incidents(t)[0].id);
    l.down.delete("desk-lan");
    l.down.delete("desk-ts");
    await runCheck(t.hub, l.lan.id, at(10));
    await runCheck(t.hub, slow.id, at(11));
    await runCheck(t.hub, slow.id, at(12));
    assert.equal(incidents(t).filter((i) => i.fields.monitor_id === slow.id).length, 0, "two failures after the machine came back: still waiting");
    l.down.delete("http://desk:8096/health");
    await runCheck(t.hub, slow.id, at(13));
    assert.deepEqual(l.alerts.map((a) => [a.name, a.state]), [["desk ping (LAN)", "down"], ["desk ping (LAN)", "up"]]);
  } finally { t.cleanup(); }
});

test("machine incident: a hand check while the loop checks the same monitor is one check, one alert", async () => {
  const t = makeHub();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    t.hub.checkers = { ...t.hub.checkers, ping: async () => { calls++; await gate; return { ok: false, error: "no reply within 2 s" }; } };
    const alerts: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { alerts.push(e); });
    const m = t.hub.store.create("monitor", { name: "nas ping", type: "ping", target: "nas", host: "nas", interval_s: 60, timeout_s: 2, fails_before_down: 1, enabled: true });
    const a = runCheck(t.hub, m.id, at(0));
    const b = runCheck(t.hub, m.id, at(0));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(ra.id, rb.id);
    assert.equal(alerts.length, 1);
    // Turned off while its check ran: the result opens nothing.
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    const m2 = t.hub.store.create("monitor", { name: "printer ping", type: "ping", target: "printer", interval_s: 60, timeout_s: 2, fails_before_down: 1, enabled: true });
    t.hub.checkers = { ...t.hub.checkers, ping: async () => { await gate2; return { ok: false, error: "no reply within 2 s" }; } };
    const c = runCheck(t.hub, m2.id, at(1));
    t.hub.store.patch(m2.id, { enabled: false });
    release2();
    await c;
    assert.equal(incidents(t).filter((i) => i.fields.monitor_id === m2.id).length, 0);
  } finally { t.cleanup(); }
});
