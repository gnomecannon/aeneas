import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";

test("snippets: the seeded examples render, a read-only one runs on its host, and one that changes something does not", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "server", local: true }, { name: "desk-pc", ssh: "desk-pc", os: "windows" }]));
    t.hub.cfg.hostsFile = path.join(t.dir, "hosts.json");
    const ran: string[] = [];
    t.hub.ai.hosts.runner = async (_h, command) => { ran.push(command); return { exit_code: 0, output: "Mounted on Use%\n/mnt/b 97%", timed_out: false, ms: 5 }; };
    const first = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.deepEqual(first.snippets, { created: 4, kept: 0 });
    assert.deepEqual(runSeed(t.hub.store, t.hub.cfg.seedDir).snippets, { created: 0, kept: 4 });
    const all = t.hub.store.list({ kind: "snippet" });
    const disks = all.find((s) => s.fields.title === "Disks fuller than a threshold")!;
    const res = await t.api(`/snippets/${disks.id}/run`, { method: "POST", json: { params: { min_pct: "90" } } });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { host: string; command: string; exit_code: number; output: string };
    assert.equal(out.host, "server");
    assert.equal(out.command, "df -h --output=target,pcent,size,used | awk 'NR==1 || $2+0 >= 90'");
    assert.match(out.output, /97%/);
    assert.deepEqual(ran, [out.command]);
    // A parameter cannot slip a change in: the rendered text is checked.
    const big = all.find((s) => s.fields.title === "Biggest folders under a path")!;
    assert.equal((await t.api(`/snippets/${big.id}/run`, { method: "POST", json: { params: { path: "/tmp; rm -rf /tmp/x" } } })).status, 409);
    const port = all.find((s) => s.fields.title === "Is a port open")!;
    assert.equal((await t.api(`/snippets/${port.id}/run`, { method: "POST", json: { host: "server" } })).status, 422, "a Windows snippet on a Linux host");
    const sql = t.hub.store.create("snippet", { title: "Count rows", os: "any", language: "sql", body: "SELECT 1", params: [], tags: [] });
    assert.equal((await t.api(`/snippets/${sql.id}/run`, { method: "POST", json: { host: "server" } })).status, 422);
    assert.equal(ran.length, 1);
  } finally { t.cleanup(); }
});
