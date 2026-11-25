import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { foldHubMachine, techThings } from "../src/tech.js";
import { hubMachineName, writeMachines } from "../src/ai/hosts.js";
import { readMachineInfo, updateMachineInfo } from "../src/machineinfo.js";
import { runSeeds } from "../src/seed.js";

// The starter check "hub health" named its machine "hub" until 2026-11-25: every hub showed a machine called hub
// beside the one it runs on. It is the hub's own machine.
const STARTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "seed");

test("a new hub's own check is on the machine it runs on, with no machine called hub", () => {
  const t = makeHub({ seedDir: STARTER });
  try {
    runSeeds(t.hub.store, t.hub.cfg);
    const own = hubMachineName(t.hub.cfg);
    const check = t.hub.store.list({ kind: "monitor" }).find((m) => m.fields.name === "hub health")!;
    assert.equal(check.fields.host, own);
    const machines = techThings(t.hub).filter((m) => m.kind === "machine");
    assert.equal(machines.some((m) => m.name === "hub"), false);
    const mine = machines.find((m) => m.name === own)!;
    assert.equal(mine.hub, true);
    assert.deepEqual(mine.monitors, [check.id]);
  } finally {
    t.cleanup();
  }
});

test("a hub from before folds its machine called hub into its own machine, history and all, once", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const own = hubMachineName(t.hub.cfg);
    const check = s.create("monitor", { name: "hub health", host: "hub", type: "http", target: "http://127.0.0.1:8787/health", expect: "ok", interval_s: 60, enabled: true });
    t.hub.db.prepare("INSERT INTO checks (monitor_id, at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)").run(check.id, "2026-11-24T10:00:00.000Z", 0, 5, "timeout");
    const incident = s.create("incident", { monitor_id: check.id, name: "hub health", opened_at: "2026-11-24T10:00:00.000Z", closed_at: "2026-11-24T10:05:00.000Z" });
    const change = s.create("journal", { host: "hub", at: "2026-11-23T20:00:00.000Z", what: "Gave the hub more memory", risk: "low", outcome: "done" });
    const notes = s.create("runbook", { host: "hub", title: "Fix notes: hub", body: "## Facts\n\nRuns Aeneas\n" });
    const snippet = s.create("snippet", { host: "Hub", title: "Restart the hub", os: "linux", body: "systemctl --user restart aeneas", language: "bash" });
    const purpose = s.create("fact", { category: "host", key: "host:hub", value: "Runs Aeneas" });
    updateMachineInfo(t.hub, "hub", { category: "computer", confidence: 0.94, facts: ["port 445 (file sharing)"] });
    assert.ok(techThings(t.hub).some((m) => m.name === "hub"), "before, a machine of its own");

    assert.equal(foldHubMachine(t.hub), 6);
    for (const e of [check, change, notes, snippet]) assert.equal(s.get(e.id)!.fields.host, own, e.kind);
    assert.equal(s.get(notes.id)!.fields.title, `Fix notes: ${own}`);
    assert.equal(s.get(purpose.id)!.fields.key, `host:${own}`);
    const info = readMachineInfo(t.hub);
    assert.equal(info.hub, undefined);
    assert.equal(info[own]?.category, "computer");

    const machines = techThings(t.hub).filter((m) => m.kind === "machine");
    assert.deepEqual(machines.map((m) => m.name), [own]);
    assert.deepEqual(machines[0].monitors, [check.id]);
    assert.equal(machines[0].purpose, "Runs Aeneas");
    assert.equal(machines[0].category, "computer");
    // The check's own history goes by its id: its results and its incident are still there.
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM checks WHERE monitor_id = ?").get(check.id) as { n: number }).n, 1);
    assert.equal(s.get(incident.id)!.fields.monitor_id, check.id);

    assert.equal(foldHubMachine(t.hub), 0, "nothing left to move");
  } finally {
    t.cleanup();
  }
});

test("the hub's own machine keeps its purpose and kind when the machine called hub had others", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const own = hubMachineName(t.hub.cfg);
    s.create("fact", { category: "host", key: `host:${own}`, value: "The home server" });
    const other = s.create("fact", { category: "host", key: "host:hub", value: "Runs Aeneas" });
    updateMachineInfo(t.hub, own, { os: "Ubuntu 26.04 LTS", category: "computer" });
    updateMachineInfo(t.hub, "hub", { category: "other", model: "Something" });
    foldHubMachine(t.hub);
    assert.equal(s.get(other.id)!.fields.key, "host:hub", "kept in Memory as it was");
    const info = readMachineInfo(t.hub);
    assert.deepEqual([info[own]?.category, info[own]?.os, info[own]?.model], ["computer", "Ubuntu 26.04 LTS", "Something"]);
    assert.equal(info.hub, undefined);
  } finally {
    t.cleanup();
  }
});

test("a machine the owner added as hub is left alone", () => {
  const t = makeHub();
  try {
    writeMachines(t.hub.cfg, [{ name: "hub", ssh: "hub.lan" }]);
    const check = t.hub.store.create("monitor", { name: "hub ping", host: "hub", type: "ping", target: "hub.lan", interval_s: 120, enabled: true });
    assert.equal(foldHubMachine(t.hub), 0);
    assert.equal(t.hub.store.get(check.id)!.fields.host, "hub");
  } finally {
    t.cleanup();
  }
});
