import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { makeHub } from "./helpers.js";

test("a write waits for another process's write instead of failing with 'database is locked' (deploy seed, 2026-11-03)", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("capture", { text: "before", source: "web" });
    const dbPath = path.join(t.dir, "hub.sqlite");
    const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
    // Another connection (a seed run during a deploy) holds the write lock for 300 ms.
    const w = new Worker(`
      const Database = require(${JSON.stringify(sqlite)});
      const { parentPort } = require("node:worker_threads");
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma("busy_timeout = 15000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE entities SET updated_at = updated_at").run();
      parentPort.postMessage("locked");
      const until = Date.now() + 300; while (Date.now() < until) {}
      db.exec("COMMIT"); db.close(); parentPort.postMessage("done");
    `, { eval: true });
    await new Promise<void>((r) => w.once("message", () => r()));
    const t0 = Date.now();
    // A read first, then a write in the same transaction: the case that used to fail at once.
    const made = t.hub.store.create("capture", { text: "during", source: "web" });
    assert.ok(made.id);
    assert.ok(Date.now() - t0 >= 100, "it waited for the other writer");
    await new Promise((r) => w.once("exit", r));
  } finally { t.cleanup(); }
});
