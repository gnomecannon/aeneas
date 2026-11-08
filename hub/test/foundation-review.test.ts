import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { makeHub, type TestHub } from "./helpers.js";
import { ConnectionStore } from "../src/imports/connections.js";
import { WorkSpace } from "../src/work.js";
import { FeedKeys } from "../src/feedkeys.js";
import { listBackups, runBackup, sealWorkInBackups } from "../src/backup.js";
import { calcTakeHome } from "../src/takehome.js";
import { imageGenerateAndWait, uploadReferences } from "../src/imagegen.js";
import { disconnectSteam } from "../src/imports/steam.js";

// Each case was a finding of the 2026-11-05 review of the hub's foundation (files, backups, devices, the image client).

test("foundation: an unreadable sign-ins file is an error, never empty, and a damaged one falls back to its last copy", () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "conn-test.json");
    const c = new ConnectionStore(file);
    c.update((x) => { x.keepass = { password: "vault-pass-FAKE", created_at: "2026-11-01T00:00:00Z" }; x.steam_key = "STEAMKEYFAKE"; });
    c.update((x) => { x.letterboxd = { username: "gnome" }; });
    // A read that fails (here: the path is a folder) refuses the update instead of writing only the new field.
    const broken = new ConnectionStore(t.dir);
    assert.throws(() => broken.update((x) => { x.letterboxd = { username: "x" }; }), /could not be read/);
    // A damaged file: the copy from before the last change is used, every sign-in kept.
    fs.writeFileSync(file, "{ half written");
    const read = c.get();
    assert.equal(read.keepass?.password, "vault-pass-FAKE");
    assert.equal(read.steam_key, "STEAMKEYFAKE");
    assert.equal(new ConnectionStore(path.join(t.dir, "none.json")).get().steam, undefined, "no file is no sign-ins");
  } finally { t.cleanup(); }
});

test("foundation: a work space switch file that cannot be read counts as off, and is written atomically", () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "ws-test.json");
    const w = new WorkSpace(file);
    assert.equal(w.enabled, true, "no file: on");
    w.setEnabled(false);
    assert.equal(w.enabled, false);
    fs.writeFileSync(file, "");
    assert.equal(w.enabled, false, "an empty file after a crash is off, not on");
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally { t.cleanup(); }
});

test("foundation: feed keys are not replaced when their file cannot be read", () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "fk-test.json");
    const k = new FeedKeys(file);
    const key = k.get("calendar");
    fs.writeFileSync(file, "{ broken");
    assert.throws(() => k.get("calendar"), /damaged/);
    fs.writeFileSync(file, JSON.stringify({ calendar: key }));
    assert.equal(k.get("calendar"), key);
  } finally { t.cleanup(); }
});

test("foundation: a picture cut off mid-write is replaced by the next save of the same picture", () => {
  const t = makeHub();
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]);
    const id = t.hub.ai.images.save(png.toString("base64"));
    const dir = path.join(t.hub.cfg.dataDir, "ai-images");
    const f = path.join(dir, `${id}.png`);
    fs.writeFileSync(f, png.subarray(0, 20));
    t.hub.ai.images.save(png.toString("base64"));
    assert.equal(fs.statSync(f).size, png.length);
  } finally { t.cleanup(); }
});

test("foundation: a backup is listed only once it is whole, and one damaged copy does not stop sealing the rest", async () => {
  const t = makeHub();
  try {
    const dir = path.join(t.dir, "bk");
    fs.mkdirSync(dir);
    // A copy cut off by a stop before this fix, under a final name, older than a good one.
    fs.writeFileSync(path.join(dir, "hub-20261101-030000.sqlite"), "SQLite format 3\0 cut off");
    // And a plain copy that is whole, as an older hub wrote it.
    t.hub.db.exec(`VACUUM INTO '${path.join(dir, "hub-20261102-030000.sqlite")}'`);
    const r = await runBackup(t.hub.db, dir, t.hub.backupKey, new Date(2026, 10, 5, 3));
    assert.equal(path.basename(r.file), "hub-20261105-030000.sqlite.age");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("partial")), []);
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
    assert.equal(path.basename(listBackups(dir)[0].file), "hub-20261105-030000.sqlite.age");
    // Seal: the damaged file is skipped, the good one is still handled (it has no plain work rows here).
    assert.doesNotThrow(() => sealWorkInBackups(dir, t.hub.store.workKey));
    new Database(path.join(dir, "hub-20261102-030000.sqlite")).close();
  } finally { t.cleanup(); }
});

test("foundation: request filters, take-home names, devices and a JSON error from elsewhere", async () => {
  const t: TestHub = makeHub();
  try {
    t.hub.store.create("task", { title: "pay rent", status: "next", order: 1 });
    const all = (await (await t.api("/entities?kind=task&token=whatever")).json()) as unknown[];
    assert.equal(all.length, 1, "?token= is not a field filter");
    assert.throws(() => calcTakeHome({ salary: 90000, frequency: "toString" }), /frequency must be one of/);

    const dev = (await (await t.api("/devices/register", { method: "POST", json: { name: "Phone", platform: "iphone" } })).json()) as { device_id: string };
    t.hub.store.patch(dev.device_id, { deleted_at: new Date().toISOString() });
    await t.api("/devices/register", { method: "POST", json: { name: "Phone", platform: "iphone", device_id: dev.device_id } });
    assert.equal(t.hub.store.get(dev.device_id)!.deleted_at, null, "a device that registers again is back");
    const task = t.hub.store.list({ kind: "task" })[0];
    const other = (await (await t.api("/devices/register", { method: "POST", json: { name: "Evil", platform: "iphone", device_id: task.id } })).json()) as { device_id: string };
    assert.notEqual(other.device_id, task.id);
    assert.equal(t.hub.store.get(task.id)!.fields.title, "pay rent");
  } finally { t.cleanup(); }
});

test("foundation: image references are checked before upload, sent once each, and a submit carries an Idempotency-Key", async () => {
  const t = makeHub({ imageServiceUrl: "http://image-service.invalid:8794", imageServiceToken: "svc-token-FAKE-0123456789" });
  try {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    let n = 0;
    t.hub.fetch = (async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", headers: { ...(init.headers ?? {}) } });
      if (String(url).endsWith("/v1/assets")) return Response.json({ id: `a${n++}` });
      if (String(url).endsWith("/v1/jobs")) return Response.json({ jobs: [{ id: "c".repeat(32), status: "failed", error: "x" }] });
      return Response.json({ id: "c".repeat(32), status: "failed", error: "x" });
    }) as typeof fetch;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(64, 2)]);
    const p = t.hub.ai.images.save(png.toString("base64"));
    const g = t.hub.ai.images.save(gif.toString("base64"));
    assert.deepEqual(await uploadReferences(t.hub, [p, p, p]), ["a0"]);
    await assert.rejects(uploadReferences(t.hub, [g]), /PNG, JPEG or WebP/);
    assert.equal(calls.filter((c) => c.url.endsWith("/v1/assets")).length, 1);
    await imageGenerateAndWait(t.hub, { prompt: "x" }, 50).catch(() => []);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/jobs"));
    assert.ok(post && Object.keys(post.headers).some((h) => h.toLowerCase() === "idempotency-key"));
  } finally { t.cleanup(); }
});

test("foundation: unlinking Steam keeps the hub's Steam key from an old link", () => {
  const t = makeHub();
  try {
    t.hub.connections.update((c) => { c.steam = { api_key: "OLDKEYFAKE", steam_id: "76561198000000000" }; });
    disconnectSteam(t.hub);
    assert.equal(t.hub.connections.get().steam_key, "OLDKEYFAKE");
    assert.equal(t.hub.connections.get().steam, undefined);
  } finally { t.cleanup(); }
});
