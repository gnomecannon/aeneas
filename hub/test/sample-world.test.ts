import { test, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { nameHubMachine, seedMachines, seedWorld } from "../scripts/sample-world.js";
import { runSeeds } from "../src/seed.js";
import { techThings } from "../src/tech.js";

// The demo hub's made-up month (demo-hub.ts), which the Apple apps' sample mode is recorded from, on the starter seed
// every new hub gets (the demo hub's).
const STARTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "seed");

test("the sample's machines are each identified as a real hub identifies its own, and the journal's server is the hub's machine, with the hub's own check", async () => {
  const t = makeHub({ seedDir: STARTER });
  try {
    nameHubMachine(t.hub.cfg);
    runSeeds(t.hub.store, t.hub.cfg);
    seedWorld(t.hub);
    await seedMachines(t.hub);
    const machines = techThings(t.hub).filter((m) => m.kind === "machine");
    assert.deepEqual(machines.map((m) => [m.name, m.category]), [["laptop", "computer"], ["nas01", "computer"], ["server", "computer"]]);
    const server = machines.find((m) => m.name === "server")!;
    assert.equal(server.hub, true, "the hub runs on it");
    const check = t.hub.store.list({ kind: "monitor" }).find((m) => m.fields.name === "hub health")!;
    assert.equal(check.fields.host, "server");
    assert.deepEqual(server.monitors, [check.id]);
    assert.ok(server.os_name, "it says what it runs");
    assert.equal(machines.find((m) => m.name === "laptop")!.os_name, "macOS 26.1");
  } finally {
    t.cleanup();
  }
});

test("seeded just after midnight, nothing that happened is later than the moment it was seeded", () => {
  const seededAt = new Date(2026, 10, 25, 0, 30).getTime();
  mock.timers.enable({ apis: ["Date"], now: seededAt });
  const t = makeHub();
  try {
    seedWorld(t.hub);
    const happened = ["at", "done_at", "last_check", "last_ok", "last_played"];
    const later: string[] = [];
    for (const e of t.hub.store.list({ limit: 100000 })) {
      for (const k of happened) {
        const v = e.fields[k];
        if (typeof v === "string" && v.includes("T") && Date.parse(v) > seededAt) later.push(`${e.kind} ${k} ${v}`);
      }
      if (e.kind === "task" && typeof e.fields.remind_at === "string" && Date.parse(e.fields.remind_at) <= Date.parse(e.updated_at) && Date.parse(e.fields.remind_at) > seededAt) later.push(`task remind_at ${e.fields.remind_at}`);
    }
    assert.deepEqual(later, []);
  } finally {
    t.cleanup();
    mock.timers.reset();
  }
});
