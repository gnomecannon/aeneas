import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { runBackup } from "../src/backup.js";

test("dashboard: now is the doing task, else the lowest-order next task; logs grouped by type", async () => {
  const t = makeHub();
  try {
    const n2 = t.hub.store.create("task", { title: "second", status: "next", order: 2 });
    const n1 = t.hub.store.create("task", { title: "first", status: "next", order: 1 });
    t.hub.store.create("task", { title: "inbox", status: "inbox", order: 0 });
    let d = await (await t.api("/dashboard")).json() as any;
    assert.equal(d.now.id, n1.id);
    assert.deepEqual(d.next.map((x: any) => x.id), [n2.id]);
    const doing = t.hub.store.create("task", { title: "doing", status: "doing", order: 99 });
    d = await (await t.api("/dashboard")).json();
    assert.equal(d.now.id, doing.id);
    assert.deepEqual(d.next.map((x: any) => x.id), [n1.id, n2.id]);

    const log = await t.api("/log", { method: "POST", json: { type: "weight", value: 162, unit: "lb" } });
    assert.equal(log.status, 201);
    await t.api("/log", { method: "POST", json: { type: "med", value: "claritin" } });
    t.hub.store.create("log", { type: "weight", value: 250, at: "2020-01-01T00:00:00.000Z" });
    t.hub.store.create("capture", { text: "x", source: "api" });
    t.hub.store.create("project", { name: "P", status: "active", definition_of_done: "d" });
    t.hub.store.create("project", { name: "Q", status: "parked", definition_of_done: "d" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "today", remind_at: new Date().toISOString(), friction: "none" });
    t.hub.store.create("task", { status: "scheduled", order: 1, title: "next year", remind_at: "2030-01-01T00:00:00.000Z", friction: "none" });
    d = await (await t.api("/dashboard")).json();
    assert.equal(d.logs_7d.weight.length, 1);
    assert.equal(d.logs_7d.med[0].value, "claritin");
    assert.equal(d.captures_unprocessed, 1);
    assert.equal(d.projects_active.length, 1);
    assert.equal(d.reminders_today.length, 1);
  } finally { t.cleanup(); }
});

test("backup: VACUUM INTO writes a copy and prunes old ones", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("task", { title: "keep me", status: "next", order: 1 });
    const old = await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey, new Date("2026-01-01T03:00:00"));
    const past = new Date("2026-01-01T03:00:00");
    fs.utimesSync(old.file, past, past);
    const r = await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey);
    assert.ok(fs.existsSync(r.file));
    assert.ok(fs.statSync(r.file).size > 0);
    assert.deepEqual(r.pruned, [path.basename(old.file)]);
  } finally { t.cleanup(); }
});
