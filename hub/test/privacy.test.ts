import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeHub, plainBackup } from "./helpers.js";
import { scripted } from "./ai-helpers.js";
import { setBackendOverride } from "../src/ai/backends.js";
import { fetchPage, pageReads } from "../src/ai/web.js";
import { moveChatTables, openChatDb, openDb } from "../src/db.js";
import { runBackup } from "../src/backup.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("privacy: chats live in chats.sqlite and never reach the nightly backup", async () => {
  const t = makeHub();
  setBackendOverride(scripted([() => ({ text: "the secret answer" })]));
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "c1", message: "my private question about zanzibar" } });
    assert.equal(fs.existsSync(path.join(t.dir, "chats.sqlite")), true);
    const main = t.hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'ai_calls', 'ai_actions')").all();
    assert.deepEqual(main, [], "no chat tables in the main database");
    const { file } = await runBackup(t.hub.db, path.join(t.dir, "backups"), t.hub.backupKey);
    assert.ok(!fs.readFileSync(await plainBackup(t, file)).includes(Buffer.from("zanzibar")), "backup holds no chat text");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("privacy: an older database's chat tables are moved out and the main file no longer contains them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-move-"));
  try {
    const mainPath = path.join(dir, "hub.sqlite");
    const old = new Database(mainPath);
    old.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, task_type TEXT NOT NULL, created_at TEXT NOT NULL, last_at TEXT NOT NULL, messages TEXT NOT NULL, title TEXT)");
    old.exec("CREATE TABLE ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT, task_type TEXT, backend TEXT NOT NULL, model TEXT NOT NULL, redactions INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER, completion_tokens INTEGER, ms INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1, error TEXT)");
    old.prepare("INSERT INTO sessions VALUES ('s', 'general', 'x', 'x', ?, 'Old chat')").run(JSON.stringify([{ role: "user", content: "quokkaword" }]));
    old.prepare("INSERT INTO ai_calls (at, backend, model, ms) VALUES ('x', 'ollama', 'm', 1)").run();
    old.close();
    const main = openDb(mainPath);
    const chats = openChatDb(path.join(dir, "chats.sqlite"));
    assert.deepEqual(moveChatTables(main, chats).moved, { sessions: 1, ai_calls: 1 });
    assert.equal((chats.prepare("SELECT title FROM sessions").get() as { title: string }).title, "Old chat");
    assert.deepEqual(moveChatTables(main, chats).moved, {}, "second run finds nothing");
    main.close(); chats.close();
    assert.ok(!fs.readFileSync(mainPath).includes(Buffer.from("quokkaword")), "the old text is gone from the main file");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("privacy: deleting a chat erases it, its images, command output, call log and ledger; other chats stay", async () => {
  const t = makeHub();
  t.hub.store.create("fact", { category: "host", key: "host:storage", value: "NAS" });
  setBackendOverride(scripted([() => ({ text: "ok" })]));
  try {
    const a = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "gone", message: "storage keeps failing, see screenshot", images: [PNG] } })).json() as { images: string[]; ledger_id: string };
    await t.api("/ai/chat", { method: "POST", json: { session_id: "kept", message: "hello there" } });
    t.hub.ai.hosts.propose("gone", { name: "storage", aliases: ["storage"], target: "storage", os: "linux", local: false, via: "" }, "reboot", "reboot", null);
    assert.ok(a.ledger_id);
    const res = await (await t.api("/ai/sessions/gone", { method: "DELETE" })).json() as { sessions: number; images: number; actions: number; calls: number; entities: number };
    assert.equal(res.sessions, 1);
    assert.equal(res.images, 1);
    assert.equal(res.actions, 1);
    assert.ok(res.calls >= 1);
    assert.equal(res.entities, 2, "the ledger and the attached picture's gallery record");
    assert.equal((await t.api("/ai/sessions/gone")).status, 404);
    assert.equal((await t.api(`/ai/images/${a.images[0]}`)).status, 404);
    const ledger = t.hub.store.get(a.ledger_id)!;
    assert.ok(ledger.deleted_at);
    assert.equal(ledger.fields.topic, "-");
    assert.ok(!JSON.stringify(t.hub.db.prepare("SELECT * FROM changes").all()).includes("keeps failing"), "no change row keeps the ledger text");
    assert.equal((await t.api("/ai/sessions/kept")).status, 200, "other chats are untouched");
    t.hub.close();
    for (const f of ["chats.sqlite", "hub.sqlite"]) {
      const file = path.join(t.dir, f);
      const all = Buffer.concat([fs.readFileSync(file), ...(fs.existsSync(`${file}-wal`) ? [fs.readFileSync(`${file}-wal`)] : [])]);
      assert.ok(!all.includes(Buffer.from("keeps failing")), `${f} has no trace`);
    }
  } finally { setBackendOverride(null); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("privacy: wiping all chats needs the confirm phrase and clears every chat-derived record", async () => {
  const t = makeHub();
  setBackendOverride(scripted([() => ({ text: "ok" })]));
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "x1", message: "first" } });
    await t.api("/ai/chat", { method: "POST", json: { session_id: "x2", message: "second", images: [PNG] } });
    t.hub.store.create("quiz", { date: "2026-10-27", items: [{ q: "what did we fix", a: "samba", hint: "", topic: "" }], source_sessions: ["x1"] });
    assert.equal((await t.api("/ai/sessions", { method: "DELETE", json: {} })).status, 422);
    const res = await (await t.api("/ai/sessions", { method: "DELETE", json: { confirm: "wipe all chats" } })).json() as { sessions: number; images: number; entities: number };
    assert.equal(res.sessions, 2);
    assert.equal(res.images, 1);
    assert.equal(res.entities, 2, "the ledger and the attached picture's gallery record");
    assert.equal(((await (await t.api("/ai/sessions")).json()) as { sessions: unknown[] }).sessions.length, 0);
    assert.equal((t.hub.chatDb.prepare("SELECT COUNT(*) AS n FROM ai_calls").get() as { n: number }).n, 0);
    assert.equal(t.hub.store.list({ kind: "quiz" }).length, 0);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("privacy: with a Tor proxy set, a page read never falls back to a direct connection", async () => {
  let direct = 0;
  const srv = http.createServer((_q, r) => { direct++; r.setHeader("content-type", "text/html"); r.end("<html><title>x</title><p>hello</p></html>"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  try {
    pageReads.allow.add("127.0.0.1");
    await assert.rejects(() => fetchPage(url, 1000, 5000, "127.0.0.1:9"), /through Tor/);
    assert.equal(direct, 0, "the page was not fetched directly");
    await assert.rejects(() => fetchPage(url, 1000, 5000), /only through Tor/, "without Tor nothing is sent");
    assert.equal((await fetchPage(url, 1000, 5000, "", true)).text, "hello", "direct only when the owner chose it");
  } finally { srv.close(); pageReads.allow.clear(); }
});

test("privacy: web lookups exist only with Tor, unless the owner chose to go without", () => {
  for (const [over, want] of [[{ searxngUrl: "http://127.0.0.1:8888" }, false], [{ searxngUrl: "http://127.0.0.1:8888", torSocks: "127.0.0.1:9052" }, true], [{ searxngUrl: "http://127.0.0.1:8888", webWithoutTor: true }, true]] as const) {
    const t = makeHub(over as Record<string, unknown>);
    try {
      t.hub.modules.set({ web: true });
      assert.equal(t.hub.ai.capabilities().web, want, JSON.stringify(over));
    } finally { t.cleanup(); }
  }
});
