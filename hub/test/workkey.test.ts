import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { runBackup } from "../src/backup.js";
import { WorkKey } from "../src/workkey.js";
import { makeHub, plainBackup, TOKEN } from "./helpers.js";

const MEETING = { title: "1:1 with Dana", start: "2026-10-28T14:00:00.000Z", end: "2026-10-28T14:30:00.000Z", all_day: false, location: "Zephyr room" };

/** Every byte of the database, its WAL included. */
function fileText(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString("latin1")).join("");
}

test("work items are sealed on disk and out of the search index, yet read, sync and search as before", async () => {
  const t = makeHub();
  try {
    const ev = t.hub.store.create("event", MEETING, "work");
    const mine = t.hub.store.create("event", { ...MEETING, title: "Dinner at Luigi's", location: "Chinatown" });
    const raw = (id: string) => (t.hub.db.prepare("SELECT fields FROM entities WHERE id = ?").get(id) as { fields: string }).fields;
    assert.match(raw(ev.id), /^enc1:/);
    assert.ok(!raw(ev.id).includes("Dana"));
    assert.ok(raw(mine.id).includes("Luigi"));
    t.hub.db.pragma("wal_checkpoint(TRUNCATE)");
    assert.ok(!fileText(t.hub.cfg.dbPath).includes("Dana"));
    assert.ok(!fileText(t.hub.cfg.dbPath).includes("Zephyr"));

    assert.equal(t.hub.store.get(ev.id)!.fields.title, "1:1 with Dana");
    assert.ok((await (await t.api("/sync/changes?since=0")).text()).includes("1:1 with Dana"));
    const hits = t.hub.store.search("dana");
    assert.deepEqual(hits.map((h) => h.id), [ev.id]);
    assert.deepEqual(t.hub.store.search("zeph").map((h) => h.id), [ev.id]);
    assert.deepEqual(t.hub.store.search("dana", { kinds: ["task"] }), []);

    // Moving an item out of work unseals it; moving it in seals it.
    t.hub.store.apply({ id: mine.id, kind: "event", space: "work", ts: new Date().toISOString(), fields: {} });
    assert.match(raw(mine.id), /^enc1:/);
    assert.equal(t.hub.store.get(mine.id)!.fields.title, "Dinner at Luigi's");

    // A sealed value is bound to its row.
    t.hub.db.prepare("UPDATE entities SET fields = ? WHERE id = ?").run(raw(ev.id), mine.id);
    assert.equal(t.hub.store.get(mine.id), null);
  } finally { t.cleanup(); }
});

test("erasing the work space destroys the key, so older backups can no longer be read", async () => {
  const t = makeHub();
  try {
    const ev = t.hub.store.create("event", MEETING, "work");
    // The decrypted copy: the backup key opens the file, and the work key the work items in it.
    const file = await plainBackup(t, (await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey)).file);
    const before = fs.readFileSync(t.hub.cfg.workKeyFile);
    assert.equal(before.length, 32);
    assert.equal(fs.statSync(t.hub.cfg.workKeyFile).mode & 0o777, 0o600);
    assert.ok(t.hub.store.workKey.open(ev.id, (new Database(file, { readonly: true }).prepare("SELECT fields FROM entities WHERE id = ?").get(ev.id) as { fields: string }).fields));

    const off = await (await t.api("/space/work", { method: "PUT", json: { enabled: false, confirm: "erase work" } })).json() as { erased: number };
    assert.equal(off.erased, 1);
    assert.ok(!fs.readFileSync(t.hub.cfg.workKeyFile).equals(before));

    const old = new Database(file, { readonly: true });
    const sealed = (old.prepare("SELECT fields FROM entities WHERE id = ?").get(ev.id) as { fields: string }).fields;
    old.close();
    assert.equal(t.hub.store.workKey.open(ev.id, sealed), null);
    assert.equal(new WorkKey(t.hub.cfg.workKeyFile).open(ev.id, sealed), null);
    assert.ok(!fileText(file).includes("Dana"));
    assert.ok(!fileText(t.hub.cfg.dbPath).includes("Dana"));
    // The tombstone is readable with the new key, so devices still drop the item.
    assert.equal(t.hub.store.get(ev.id)!.fields.title, "-");
    assert.ok(t.hub.store.get(ev.id)!.deleted_at);
  } finally { t.cleanup(); }
});

test("an older hub's plain work rows and backups are sealed on start, keeping backup times", () => {
  const t = makeHub();
  const dir = t.dir;
  let id = "";
  try {
    id = t.hub.store.create("event", MEETING, "work").id;
    // What a hub before the work key wrote: plain fields and a search entry.
    const plain = JSON.stringify(t.hub.store.get(id)!.fields);
    t.hub.db.prepare("UPDATE entities SET fields = ? WHERE id = ?").run(plain, id);
    const rowid = (t.hub.db.prepare("SELECT rowid FROM entities WHERE id = ?").get(id) as { rowid: number }).rowid;
    t.hub.db.prepare("INSERT INTO entities_fts (rowid, id, kind, title, text) VALUES (?, ?, 'event', ?, ?)").run(rowid, id, MEETING.title, MEETING.location);
    // A plain backup, as an older hub wrote them.
    fs.mkdirSync(t.hub.cfg.backupDir, { recursive: true });
    const file = path.join(t.hub.cfg.backupDir, "hub-20261020-030000.sqlite");
    t.hub.db.exec(`VACUUM INTO '${file}'`);
    const old = new Date("2026-10-20T03:00:00Z");
    fs.utimesSync(file, old, old);
    assert.ok(fileText(file).includes("Dana"));
    t.hub.close();

    const hub = createHub(loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "" } as never));
    try {
      assert.match((hub.db.prepare("SELECT fields FROM entities WHERE id = ?").get(id) as { fields: string }).fields, /^enc1:/);
      assert.equal(hub.store.get(id)!.fields.title, "1:1 with Dana");
      assert.equal((hub.db.prepare("SELECT count(*) AS n FROM entities_fts WHERE id = ?").get(id) as { n: number }).n, 0);
      hub.db.pragma("wal_checkpoint(TRUNCATE)");
      assert.ok(!fileText(hub.cfg.dbPath).includes("Dana"));
      assert.ok(!fileText(file).includes("Dana"));
      assert.equal(fs.statSync(file).mtime.toISOString(), old.toISOString());
      assert.deepEqual(hub.store.search("dana").map((h) => h.id), [id]);
    } finally { hub.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with the key file gone, sealed work items read as absent, a device can send them again, and an erase still tombstones them", async () => {
  const t = makeHub();
  const dir = t.dir;
  try {
    const ev = t.hub.store.create("event", MEETING, "work");
    t.hub.close();
    fs.rmSync(path.join(dir, "work.key"));

    const hub = createHub(loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "" } as never));
    try {
      assert.equal(hub.store.get(ev.id), null);
      assert.deepEqual(hub.store.unreadableWork(), [ev.id]);
      assert.deepEqual(hub.store.list({ space: "work" }), []);

      const back = hub.store.apply({ id: ev.id, kind: "event", space: "work", ts: new Date().toISOString(), create: true, fields: MEETING });
      assert.equal(back.entity.fields.title, "1:1 with Dana");
      assert.deepEqual(hub.store.unreadableWork(), []);

      const other = hub.store.create("task", { title: "Access review", status: "next", order: 1 }, "work");
      hub.db.prepare("UPDATE entities SET fields = ? WHERE id = ?").run(new WorkKey(null).seal(other.id, "{}"), other.id);
      const { wipeWork } = await import("../src/work.js");
      assert.equal(wipeWork(hub).erased, 2);
      const tomb = hub.store.get(other.id)!;
      assert.ok(tomb.deleted_at);
      assert.equal(tomb.fields.title, "-");
    } finally { hub.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
