import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { unzipSync } from "fflate";
import { identityToRecipient } from "age-encryption";
import { makeHub, plainBackup, TOKEN, fileMode } from "./helpers.js";
import { HUB_DIR, loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { encryptPlainBackups, listBackups, restoreBackup, runBackup } from "../src/backup.js";
import { BackupKey, BackupKeyError, decryptBytes, decryptFile, isAgeFile, parseRecoveryKey } from "../src/backupkey.js";
import { diskEncryption, type CmdRunner } from "../src/diskcrypt.js";
import { fillOutbox } from "../src/outbox.js";
import { WorkKey } from "../src/workkey.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { hubSecretValues } from "../src/secrets.js";

const MEETING = { title: "1:1 with Dana", start: "2026-10-28T14:00:00.000Z", end: "2026-10-28T14:30:00.000Z", all_day: false, location: "Zephyr room" };
const OLD = new Date("2026-10-20T03:00:00Z");

const bytesOf = (f: string) => fs.readFileSync(f).toString("latin1");
const keyLine = (f: string) => fs.readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-1"))!;

/** Run the hub's command line (src/main.ts) with its own environment; never the owner's hub.env. */
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "src/main.ts", ...args], { cwd: HUB_DIR, timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TZ: "America/New_York", EA_NO_DOTENV: "1", ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

test("backup key: made once on first start in age-keygen's format, owner-only, and never made again", async () => {
  const t = makeHub();
  try {
    const file = t.hub.cfg.backupKeyFile;
    assert.equal(file, path.join(t.dir, "backup.key"), "next to the work key");
    assert.equal(fileMode(file), 0o600);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.match(lines[0], /^# created: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const { identity, recipient } = t.hub.backupKey.load();
    assert.equal(lines[1], `# public key: ${recipient}`);
    assert.equal(lines[2], identity);
    assert.match(identity, /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    // The public half worked out here is the one the age library (and so the age tool) works out.
    assert.equal(await identityToRecipient(identity), recipient);
    assert.equal(parseRecoveryKey(`  ${identity.toLowerCase()}  \n`)?.recipient, recipient, "a pasted recovery key in any case reads the same");
    assert.equal(parseRecoveryKey("AGE-SECRET-KEY-1NOTAKEY"), null);

    const before = fs.readFileSync(file);
    const again = new BackupKey(file, path.join(t.dir, "x.json"));
    assert.equal(again.identity(), identity);
    assert.equal(again.created, false);
    assert.ok(fs.readFileSync(file).equals(before));
    // Two processes starting together on a fresh folder end up with one key.
    const fresh = path.join(t.dir, "fresh", "backup.key");
    const a = new BackupKey(fresh, path.join(t.dir, "a.json"));
    const b = new BackupKey(fresh, path.join(t.dir, "b.json"));
    assert.equal(a.identity(), b.identity());
    assert.deepEqual(fs.readdirSync(path.dirname(fresh)), ["backup.key"], "no temp file left");
    // The key is in what host command output hides.
    assert.ok(hubSecretValues(t.hub).includes(identity));
  } finally { t.cleanup(); }
});

test("backup key: a damaged or unreadable key file is refused and left as it is; no backup and no plain copy are made", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-bk-damaged-"));
  try {
    const file = path.join(dir, "backup.key");
    fs.writeFileSync(file, "# public key: age1whatever\nAGE-SECRET-KEY-1CUTOFF\n", { mode: 0o600 });
    const before = fs.readFileSync(file);
    assert.throws(() => new BackupKey(file, path.join(dir, "r.json")).load(), (e: unknown) => e instanceof BackupKeyError && /holds no usable key; it was left as it is/.test((e as Error).message));
    assert.ok(fs.readFileSync(file).equals(before));

    // A hub starting on it still serves; backups stop and say why.
    const hub = createHub(loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "" } as never));
    try {
      await assert.rejects(runBackup(hub.db, hub.cfg.backupDir, hub.backupKey), BackupKeyError);
      assert.deepEqual(fs.existsSync(hub.cfg.backupDir) ? fs.readdirSync(hub.cfg.backupDir) : [], [], "no plain copy was written");
      assert.ok(fs.readFileSync(file).equals(before), "still the same file");
      const { createApp } = await import("../src/app.js");
      const res = await createApp(hub).request("/setup/backup", { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.match(body.error, /backup key file cannot be read/);
      assert.ok(!body.error.includes(dir), "no path in the answer");
    } finally { hub.close(); }

    // A key file that cannot be read at all (permissions) is the same error, not a new key. Windows has no Unix
    // permission bits to take reading away with (chmod 000 changes nothing there), so this part is for Linux and macOS.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(file, 0o000);
      try { assert.throws(() => new BackupKey(file, path.join(dir, "r.json")).load(), /cannot be read \(EACCES\)/); }
      finally { fs.chmodSync(file, 0o600); }
      assert.ok(fs.readFileSync(file).equals(before));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("backups are encrypted, and restore with the key or the recovery key gives the database back", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("task", { title: "pack for zanzibar", status: "next", order: 1 });
    const { file } = await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey, new Date(2026, 10, 5, 3));
    assert.equal(path.basename(file), "hub-20261105-030000.sqlite.age");
    assert.equal(fileMode(file), 0o600);
    assert.ok(isAgeFile(file));
    assert.ok(!bytesOf(file).includes("zanzibar"));
    assert.ok(!bytesOf(file).includes("SQLite format 3"));
    assert.deepEqual(fs.readdirSync(t.hub.cfg.backupDir), ["hub-20261105-030000.sqlite.age"], "no plain or partial copy left");

    const out = path.join(t.dir, "restored.sqlite");
    const r = await restoreBackup(file, out, [t.hub.backupKey.identity()]);
    assert.equal(r.integrity, "ok");
    const db = new Database(out, { readonly: true });
    assert.equal((db.prepare("SELECT count(*) AS n FROM entities WHERE fields LIKE '%zanzibar%'").get() as { n: number }).n, 1);
    db.close();
    assert.equal(fileMode(out), 0o600);
    await assert.rejects(restoreBackup(file, out, [t.hub.backupKey.identity()]), /already there/, "never over a file");
    const other = (await import("../src/backupkey.js")).newIdentity();
    await assert.rejects(restoreBackup(file, path.join(t.dir, "x.sqlite"), [other.identity]), /not encrypted with this key/);
    // A copy cut short fails at its end, and nothing is put in place.
    const cut = path.join(t.dir, "cut.sqlite.age");
    fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, fs.statSync(file).size - 100));
    await assert.rejects(restoreBackup(cut, path.join(t.dir, "cut.sqlite"), [t.hub.backupKey.identity()]));
    assert.equal(fs.existsSync(path.join(t.dir, "cut.sqlite")), false);
    assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.startsWith("cut.sqlite.") && n !== "cut.sqlite.age"), [], "no temp file left");

    // On a new machine: no key file there, the recovery key in EA_RECOVERY_KEY. The command makes no key of its own.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "ea-bk-newmachine-"));
    try {
      const target = path.join(fresh, "hub.sqlite");
      const withKey = await cli(["restore", file, target], { EA_DATA_DIR: fresh, EA_RECOVERY_KEY: t.hub.backupKey.identity() });
      assert.equal(withKey.code, 0, withKey.out);
      assert.match(withKey.out, /integrity ok/);
      assert.ok(!withKey.out.includes(t.hub.backupKey.identity()), "the key is never printed");
      assert.equal(fs.existsSync(path.join(fresh, "backup.key")), false);
      const none = await cli(["restore", file, path.join(fresh, "again.sqlite")], { EA_DATA_DIR: fresh });
      assert.notEqual(none.code, 0);
      assert.match(none.out, /set EA_RECOVERY_KEY/);
      const bad = await cli(["restore", file, path.join(fresh, "again.sqlite")], { EA_DATA_DIR: fresh, EA_RECOVERY_KEY: "hunter2" });
      assert.notEqual(bad.code, 0);
      assert.ok(!bad.out.includes("hunter2"));
    } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
  } finally { t.cleanup(); }
});

test("old plain backups are sealed, lose their chat tables, are encrypted once with their times kept, and the plain files go", async () => {
  const t = makeHub();
  try {
    const dir = t.hub.cfg.backupDir;
    fs.mkdirSync(dir, { recursive: true });
    const ev = t.hub.store.create("event", MEETING, "work");
    // What an older hub wrote: plain work fields and chat tables.
    t.hub.db.prepare("UPDATE entities SET fields = ? WHERE id = ?").run(JSON.stringify(t.hub.store.get(ev.id)!.fields), ev.id);
    const good = path.join(dir, "hub-20261020-030000.sqlite");
    t.hub.db.exec(`VACUUM INTO '${good}'`);
    t.hub.store.patch(ev.id, { title: MEETING.title });
    const old = new Database(good);
    old.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, messages TEXT)");
    old.prepare("INSERT INTO sessions VALUES ('s', ?)").run("quokkaword");
    old.close();
    const damaged = path.join(dir, "hub-20261019-030000.sqlite");
    fs.writeFileSync(damaged, "SQLite format 3\0 cut off");
    const damagedBytes = fs.readFileSync(damaged);
    for (const f of [good, damaged]) fs.utimesSync(f, OLD, OLD);
    assert.ok(bytesOf(good).includes("Dana") && bytesOf(good).includes("quokkaword"));

    const r = await encryptPlainBackups(dir, t.hub.backupKey, t.hub.store.workKey);
    assert.deepEqual(r.converted.sort(), ["hub-20261019-030000.sqlite", "hub-20261020-030000.sqlite"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["hub-20261019-030000.sqlite.age", "hub-20261020-030000.sqlite.age"]);
    for (const f of fs.readdirSync(dir)) {
      assert.equal(fs.statSync(path.join(dir, f)).mtime.toISOString(), OLD.toISOString(), `${f} keeps its time`);
      assert.equal(fileMode(path.join(dir, f)), 0o600);
    }
    const plain = await plainBackup(t, `${good}.age`);
    assert.ok(!bytesOf(plain).includes("Dana"), "work items sealed before encrypting");
    assert.ok(!bytesOf(plain).includes("quokkaword"), "chat tables dropped");
    const db = new Database(plain, { readonly: true });
    assert.match((db.prepare("SELECT fields FROM entities WHERE id = ?").get(ev.id) as { fields: string }).fields, /^enc1:/);
    assert.equal(t.hub.store.workKey.open(ev.id, (db.prepare("SELECT fields FROM entities WHERE id = ?").get(ev.id) as { fields: string }).fields)?.includes("Dana"), true);
    db.close();
    // The damaged copy is kept as it was, encrypted.
    const back = path.join(t.dir, "damaged.out");
    await decryptFile(`${damaged}.age`, back, [t.hub.backupKey.identity()]);
    assert.ok(fs.readFileSync(back).equals(damagedBytes));
    assert.deepEqual((await encryptPlainBackups(dir, t.hub.backupKey, t.hub.store.workKey)).converted, [], "once");
    assert.ok(listBackups(dir).every((b) => b.encrypted));

    // A copy whose work items could not be sealed stays plain until they are.
    const stuck = path.join(dir, "hub-20261021-030000.sqlite");
    t.hub.db.prepare("UPDATE entities SET fields = ? WHERE id = ?").run(JSON.stringify(MEETING), ev.id);
    t.hub.db.exec(`VACUUM INTO '${stuck}'`);
    class NoSeal extends WorkKey { override seal(): string { throw new Error("disk full"); } }
    const s = await encryptPlainBackups(dir, t.hub.backupKey, new NoSeal(null));
    assert.deepEqual(s, { converted: [], skipped: ["hub-20261021-030000.sqlite"] });
    assert.ok(fs.existsSync(stuck));
    assert.equal(listBackups(dir).find((b) => b.file === "hub-20261021-030000.sqlite")?.encrypted, false);
  } finally { t.cleanup(); }
});

test("pruning: copies over 30 days go whether encrypted or plain, cut-off partials a day old go, the rest stay", async () => {
  const t = makeHub();
  try {
    const dir = t.hub.cfg.backupDir;
    const now = new Date(2026, 10, 5, 3);
    const recent = await runBackup(t.hub.db, dir, t.hub.backupKey, new Date(2026, 10, 1, 3));
    fs.utimesSync(recent.file, new Date(2026, 10, 1, 3), new Date(2026, 10, 1, 3));
    const old = await runBackup(t.hub.db, dir, t.hub.backupKey, new Date(2026, 8, 1, 3));
    const past = new Date(2026, 8, 1, 3);
    fs.utimesSync(old.file, past, past);
    const oldPlain = path.join(dir, "hub-20260902-030000.sqlite");
    fs.writeFileSync(oldPlain, "x");
    fs.utimesSync(oldPlain, past, past);
    const stale = [path.join(dir, "hub-20261103-030000.sqlite.partial"), path.join(dir, "hub-20261103-030000.sqlite.age.123-0a1b2c3d.partial")];
    for (const f of stale) { fs.writeFileSync(f, "x"); fs.utimesSync(f, new Date(2026, 10, 3, 3), new Date(2026, 10, 3, 3)); }
    const fresh = path.join(dir, "hub-20261105-025900.sqlite.age.99-deadbeef.partial");
    fs.writeFileSync(fresh, "x");
    fs.utimesSync(fresh, new Date(2026, 10, 5, 2, 59), new Date(2026, 10, 5, 2, 59));
    const r = await runBackup(t.hub.db, dir, t.hub.backupKey, now);
    assert.deepEqual(r.pruned.sort(), [path.basename(old.file), path.basename(oldPlain)].sort());
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(fresh), path.basename(recent.file), path.basename(r.file)].sort());
    assert.deepEqual(listBackups(dir).map((b) => [b.file, b.encrypted]), [[path.basename(r.file), true], [path.basename(recent.file), true]]);
  } finally { t.cleanup(); }
});

test("routes: the backup view, the recovery key once asked (no-store, never logged), saved, and a new key asks again", async () => {
  const t = makeHub({ logRequests: true });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await runBackup(t.hub.db, t.hub.cfg.backupDir, t.hub.backupKey);
    const { recipient, identity } = t.hub.backupKey.load();
    const v = await (await t.api("/setup/backup")).json() as Record<string, any>;
    assert.deepEqual(Object.keys(v).sort(), ["backups", "disk", "encrypted", "recipient", "recovery_saved"]);
    assert.equal(v.encrypted, true);
    assert.equal(v.recipient, recipient);
    assert.equal(v.recovery_saved, false);
    assert.equal(v.backups.length, 1);
    assert.deepEqual(Object.keys(v.backups[0]).sort(), ["at", "bytes", "encrypted", "file"]);
    assert.match(v.backups[0].file, /^hub-\d{8}-\d{6}\.sqlite\.age$/);
    assert.ok(v.disk.encrypted === null || typeof v.disk.encrypted === "boolean");
    assert.equal(typeof v.disk.detail, "string");
    assert.ok(!JSON.stringify(v).includes(identity));

    const res = await t.api("/setup/backup/reveal", { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { recovery_key } = await res.json() as { recovery_key: string };
    assert.equal(recovery_key, keyLine(t.hub.cfg.backupKeyFile));
    assert.equal(parseRecoveryKey(recovery_key)?.recipient, recipient);
    assert.ok(logged.some((l) => l.includes("POST /setup/backup/reveal 200")), "the request is logged");
    assert.ok(!logged.some((l) => l.includes(identity)), "the key is not");
    assert.ok(refuseToolCall("POST", "/setup/backup/reveal"), "the assistant's tools cannot ask for it");
    assert.ok(refuseToolCall("GET", "/setup/backup/reveal"));
    assert.ok(refuseToolCall("POST", "/setup/backup/saved"));

    assert.deepEqual(await (await t.api("/setup/backup/saved", { method: "POST" })).json(), { recovery_saved: true });
    assert.equal((await (await t.api("/setup/backup")).json() as { recovery_saved: boolean }).recovery_saved, true);
    const saved = fs.readFileSync(path.join(t.dir, "backup-recovery.json"), "utf8");
    assert.ok(saved.includes(recipient) && !saved.includes(identity));

    // A plain backup an older hub left: not everything is encrypted yet.
    t.hub.db.exec(`VACUUM INTO '${path.join(t.hub.cfg.backupDir, "hub-20261020-030000.sqlite")}'`);
    const mixed = await (await t.api("/setup/backup")).json() as { encrypted: boolean; backups: { encrypted: boolean }[] };
    assert.equal(mixed.encrypted, false);
    assert.deepEqual(mixed.backups.map((b) => b.encrypted), [true, false]);

    // A new key (the old file gone) asks for its recovery key again.
    fs.rmSync(t.hub.cfg.backupKeyFile);
    t.hub.backupKey = new BackupKey(t.hub.cfg.backupKeyFile, path.join(t.dir, "backup-recovery.json"));
    const after = await (await t.api("/setup/backup")).json() as { recipient: string; recovery_saved: boolean };
    assert.notEqual(after.recipient, recipient);
    assert.equal(after.recovery_saved, false);
  } finally { console.log = log; t.cleanup(); }
});

test("disk check: FileVault, LUKS, ZFS, fscrypt and plain disks, and null with a reason when it cannot tell", async () => {
  const fake = (answers: Record<string, { code?: number; stdout?: string }>): CmdRunner => async (cmd, args, timeoutMs) => {
    assert.ok(timeoutMs > 0 && timeoutMs <= 5000, "every command has a short limit");
    const a = answers[cmd] ?? answers[`${cmd} ${args[0]}`] ?? { code: 127, stdout: "" };
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: "" };
  };
  const df = { stdout: "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1942700360 1745463144 141981968 93% /System/Volumes/Data\n" };
  const plist = (fv: boolean) => ({ stdout: `<plist><dict><key>Encryption</key><true/><key>FileVault</key><${fv}/></dict></plist>` });
  const mac = (a: Record<string, { code?: number; stdout?: string }>) => diskEncryption("/Users/x/data", fake(a), "darwin");
  assert.deepEqual(await mac({ df, diskutil: plist(true) }), { encrypted: true, detail: "FileVault is on for /System/Volumes/Data" });
  assert.equal((await mac({ df, diskutil: plist(false) })).encrypted, false, "Encryption alone (Apple chips) is not FileVault");
  assert.equal((await mac({ df, diskutil: { code: 1 }, fdesetup: { stdout: "true\n" } })).encrypted, true);
  const slow = await mac({ df, diskutil: { code: 1 }, fdesetup: { code: -1 } });
  assert.equal(slow.encrypted, null);
  assert.match(slow.detail, /could not tell.*in time/);

  const linux = (a: Record<string, { code?: number; stdout?: string }>) => diskEncryption("/home/x/data", fake(a), "linux");
  const luks = await linux({ findmnt: { stdout: "/dev/mapper/ubuntu--vg-ubuntu--lv ext4 /\n" }, lsblk: { stdout: "ubuntu--vg-ubuntu--lv lvm\ndm_crypt-0 crypt\nnvme0n1p3 part\nnvme0n1 disk\n" } });
  assert.equal(luks.encrypted, true);
  assert.match(luks.detail, /dm_crypt-0/);
  const plain = await linux({ findmnt: { stdout: "/dev/nvme0n1p2 ext4 /\n" }, lsblk: { stdout: "nvme0n1p2 part\nnvme0n1 disk\n" } });
  assert.equal(plain.encrypted, false);
  assert.match(plain.detail, /not encrypted; use LUKS/);
  assert.equal((await linux({ findmnt: { stdout: "/dev/sda2[/@home] btrfs /home\n" }, lsblk: { stdout: "luks-1 crypt\nsda2 part\n" } })).encrypted, true);
  assert.equal((await linux({ findmnt: { stdout: "rpool/data zfs /data\n" }, zfs: { stdout: "aes-256-gcm\n" } })).encrypted, true);
  assert.equal((await linux({ findmnt: { stdout: "rpool/data zfs /data\n" }, zfs: { stdout: "off\n" } })).encrypted, false);
  assert.equal((await linux({ findmnt: { stdout: "/dev/sdb1 ext4 /srv\n" }, fscrypt: { stdout: '"/srv/data" is encrypted with fscrypt.\n' } })).encrypted, true);
  const overlay = await linux({ findmnt: { stdout: "overlay overlay /\n" } });
  assert.equal(overlay.encrypted, null);
  assert.match(overlay.detail, /overlay/);
  assert.equal((await linux({ findmnt: { code: 1 } })).encrypted, null);
  assert.deepEqual(await diskEncryption("C:\\data", fake({}), "win32"), { encrypted: null, detail: "not checked on Windows: reading BitLocker's state needs an administrator" });

  // This machine, for real: an answer of the right shape, quickly.
  const t0 = Date.now();
  const here = await diskEncryption(os.tmpdir());
  assert.ok(here.encrypted === null || typeof here.encrypted === "boolean");
  assert.ok(here.detail.length > 0);
  assert.ok(Date.now() - t0 < 15_000);
});

test("outbox: the settings in one encrypted archive, each picture and recording encrypted once, gone when its source is", async () => {
  const t = makeHub();
  try {
    const d = t.dir;
    const id = t.hub.backupKey.identity();
    fs.writeFileSync(path.join(d, "profile.json"), JSON.stringify({ name: "Plainname Owner" }));
    fs.writeFileSync(path.join(d, "connections.json"), JSON.stringify({ steam_key: "STEAMKEYFAKE" }));
    fs.mkdirSync(path.join(d, "feel-images"), { recursive: true });
    fs.writeFileSync(path.join(d, "feel-images", "shape1"), "shape-bytes");
    fs.mkdirSync(path.join(d, "ai-images"), { recursive: true });
    fs.writeFileSync(path.join(d, "ai-images", "kept.png"), "gallery-picture-bytes");
    fs.writeFileSync(path.join(d, "ai-images", "chat.png"), "chat-picture-bytes");
    fs.mkdirSync(path.join(d, "audio"), { recursive: true });
    fs.writeFileSync(path.join(d, "audio", "idea.wav"), "hum-recording-bytes");

    const r = await fillOutbox(d, t.hub.backupKey, ["kept.png", "../escape.png"]);
    assert.ok(r.settings >= 2, "profile.json and the image shape at least");
    assert.deepEqual(r.gallery, { sealed: 1, kept: 0, removed: 0 });
    assert.deepEqual(r.audio, { sealed: 1, kept: 0, removed: 0 });
    const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((n) => fs.statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]);
    const files = walk(r.dir);
    assert.deepEqual(files.map((f) => path.relative(r.dir, f).split(path.sep).join("/")).sort(), ["audio/idea.wav.age", "gallery/kept.png.age", "settings.zip.age"]);
    for (const f of files) {
      assert.ok(isAgeFile(f), `${f} is encrypted`);
      for (const plain of ["Plainname", "shape-bytes", "gallery-picture-bytes", "hum-recording-bytes", "STEAMKEYFAKE"]) assert.ok(!bytesOf(f).includes(plain));
    }
    const zip = unzipSync(await decryptBytes(fs.readFileSync(path.join(r.dir, "settings.zip.age")), [id]));
    assert.ok(Buffer.from(zip["profile.json"]).toString().includes("Plainname Owner"));
    assert.equal(Buffer.from(zip["feel-images/shape1"]).toString(), "shape-bytes");
    assert.equal(zip["connections.json"], undefined, "sign-ins never go");
    assert.equal(Object.keys(zip).some((n) => n.includes("key")), false);
    const pic = path.join(d, "pic.out");
    await decryptFile(path.join(r.dir, "gallery", "kept.png.age"), pic, [id]);
    assert.equal(fs.readFileSync(pic, "utf8"), "gallery-picture-bytes");

    // Unchanged files are not encrypted again (rsync then sends nothing new); a changed one is.
    const enc = path.join(r.dir, "audio", "idea.wav.age");
    const first = fs.readFileSync(enc);
    const again = await fillOutbox(d, t.hub.backupKey, ["kept.png"]);
    assert.deepEqual(again.gallery, { sealed: 0, kept: 1, removed: 0 });
    assert.deepEqual(again.audio, { sealed: 0, kept: 1, removed: 0 });
    assert.ok(fs.readFileSync(enc).equals(first));
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(d, "audio", "idea.wav"), "hum-recording-bytes-retaken");
    fs.utimesSync(path.join(d, "audio", "idea.wav"), later, later);
    assert.deepEqual((await fillOutbox(d, t.hub.backupKey, ["kept.png"])).audio, { sealed: 1, kept: 0, removed: 0 });
    // A deleted recording and a picture no longer in the gallery leave the outbox, so the mirror drops them too.
    fs.rmSync(path.join(d, "audio", "idea.wav"));
    const gone = await fillOutbox(d, t.hub.backupKey, []);
    assert.deepEqual(gone.audio, { sealed: 0, kept: 0, removed: 1 });
    assert.deepEqual(gone.gallery, { sealed: 0, kept: 0, removed: 1 });
    assert.deepEqual(walk(r.dir).map((f) => path.relative(r.dir, f)), ["settings.zip.age"]);
  } finally { t.cleanup(); }
});

test("the backup command: older plain copies encrypted, the night's copy made, the outbox filled, the key never printed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-bk-cli-"));
  try {
    const hub = createHub(loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "" } as never));
    hub.store.create("task", { title: "cli backup check", status: "next", order: 1 });
    fs.mkdirSync(hub.cfg.backupDir, { recursive: true });
    const plain = path.join(hub.cfg.backupDir, "hub-20261020-030000.sqlite");
    hub.db.exec(`VACUUM INTO '${plain}'`);
    fs.utimesSync(plain, OLD, OLD);
    fs.writeFileSync(path.join(hub.cfg.backupDir, "gallery-files.txt"), "old.png\n");
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "Cli Owner" }));
    const identity = hub.backupKey.identity();
    hub.close();

    // Until the recovery key is saved, the older plain copy stays: it is the one copy that opens without that key.
    const first = await cli(["backup"], { EA_DATA_DIR: dir });
    assert.equal(first.code, 0, first.out);
    assert.doesNotMatch(first.out, /encrypted 1 older plain backups/);
    assert.ok(fs.existsSync(plain), "kept until the recovery key is saved");
    for (const f of fs.readdirSync(path.join(dir, "backups"))) if (f.endsWith(".sqlite.age")) fs.rmSync(path.join(dir, "backups", f));
    const again = createHub(loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "" } as never));
    again.backupKey.markSaved();
    again.close();

    const r = await cli(["backup"], { EA_DATA_DIR: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /encrypted 1 older plain backups/);
    assert.match(r.out, /wrote .*hub-\d{8}-\d{6}\.sqlite\.age/);
    assert.match(r.out, /outbox .*settings files in one archive/);
    const names = fs.readdirSync(path.join(dir, "backups")).sort();
    assert.equal(names.length, 2);
    assert.ok(names.every((n) => n.endsWith(".sqlite.age")), names.join(", "));
    assert.equal(fs.statSync(path.join(dir, "backups", "hub-20261020-030000.sqlite.age")).mtime.toISOString(), OLD.toISOString());
    assert.ok(fs.existsSync(path.join(dir, "outbox", "settings.zip.age")));
    assert.equal(fs.existsSync(path.join(dir, "backups", "gallery-files.txt")), false, "the old plain list of picture names is gone");

    const k = await cli(["backup-key"], { EA_DATA_DIR: dir });
    assert.equal(k.code, 0, k.out);
    assert.match(k.out, /^recipient=age1[0-9a-z]{58}$/m);
    assert.match(k.out, /^file=.*backup\.key$/m);
    for (const out of [r.out, k.out]) assert.ok(!out.includes(identity), "the key is never printed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
