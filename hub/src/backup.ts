import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DB } from "./db.js";
import { scheduleDaily } from "./schedule.js";
import { WorkKey } from "./workkey.js";
import { BackupKey, BackupKeyError, decryptFile, encryptFile } from "./backupkey.js";
import { errCode } from "./logsafe.js";

const RETENTION_DAYS = 30;

/** An encrypted nightly backup: `hub-YYYYMMDD-HHMMSS.sqlite.age`. */
export const BACKUP_FILE = /^hub-\d{8}-\d{6}\.sqlite\.age$/;
/** A plain backup an older hub wrote, encrypted once by `encryptPlainBackups`. */
export const PLAIN_BACKUP_FILE = /^hub-\d{8}-\d{6}\.sqlite$/;
/** A copy cut off by a stop: the plain VACUUM target, or an encryption's temp file. */
const PARTIAL_FILE = /^hub-\d{8}-\d{6}\.sqlite(\.age)?(\.\d+-[0-9a-f]+)?\.partial$/;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Remove copies older than 30 days (encrypted or plain) and cut-off copies a day old. Returns the names pruned. */
function prune(backupDir: string, now: Date): string[] {
  const pruned: string[] = [];
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, name);
    let mtime: number;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (PARTIAL_FILE.test(name)) { if (mtime < now.getTime() - 24 * 3600_000) fs.rmSync(full, { force: true }); continue; }
    if (!BACKUP_FILE.test(name) && !PLAIN_BACKUP_FILE.test(name)) continue;
    if (mtime < cutoff) { fs.rmSync(full, { force: true }); pruned.push(name); }
  }
  return pruned;
}

/**
 * VACUUM INTO a plain temp copy, encrypt it to the backup key as `hub-<stamp>.sqlite.age`, remove the plain copy,
 * and prune copies older than 30 days. Returns the new file path. The key is read first, so a key file that cannot
 * be read stops the backup before any plain copy is written, and the plain copy is removed even when encrypting fails.
 */
export async function runBackup(db: DB, backupDir: string, key: BackupKey, now: Date = new Date()): Promise<{ file: string; pruned: string[] }> {
  const recipient = key.recipient();
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const base = path.join(backupDir, `hub-${stamp(now)}.sqlite`);
  const file = `${base}.age`;
  // Written under a name the listing ignores: a hub killed mid-copy left a cut-off file under the final name,
  // listed as the newest backup. encryptFile renames into place only once the whole file is written.
  const part = `${base}.partial`;
  for (const f of [file, part]) fs.rmSync(f, { force: true });
  try {
    db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
    fs.chmodSync(part, 0o600);
    await encryptFile(part, file, recipient);
  } finally {
    fs.rmSync(part, { force: true });
  }
  return { file, pruned: prune(backupDir, now) };
}

/**
 * Copy an encrypted backup to a second folder (EA_BACKUP_COPY_DIR: an external drive, a network share), so a dead
 * disk does not take the backups with it, and prune copies there older than 30 days. The folder is never made: a
 * drive that is not plugged in or mounted is reported and skipped, not filled on the hub's own disk instead.
 */
export function copyBackup(file: string, copyDir: string, now: Date = new Date()): { copied: string | null; error?: string } {
  if (!copyDir) return { copied: null };
  try { if (!fs.statSync(copyDir).isDirectory()) return { copied: null, error: `${copyDir} is not a folder` }; }
  catch { return { copied: null, error: `${copyDir} is not there (a drive not plugged in or not mounted?)` }; }
  const name = path.basename(file);
  const dst = path.join(copyDir, name);
  const part = `${dst}.partial`;
  try {
    fs.copyFileSync(file, part);
    fs.chmodSync(part, 0o600);
    const st = fs.statSync(file);
    fs.utimesSync(part, st.atime, st.mtime);
    fs.renameSync(part, dst);
  } catch (e) {
    fs.rmSync(part, { force: true });
    return { copied: null, error: errCode(e) };
  }
  // Only encrypted copies are pruned there: anything else in that folder is the owner's.
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 3600_000;
  for (const n of fs.readdirSync(copyDir)) {
    if (!BACKUP_FILE.test(n)) continue;
    try { if (fs.statSync(path.join(copyDir, n)).mtimeMs < cutoff) fs.rmSync(path.join(copyDir, n), { force: true }); } catch { /* gone */ }
  }
  return { copied: dst };
}

/** True when the newest encrypted backup is older than `hours` (or there is none). */
export function backupOverdue(backupDir: string, hours = 26, now: Date = new Date()): boolean {
  const newest = listBackups(backupDir).find((b) => b.encrypted);
  return !newest || now.getTime() - Date.parse(newest.at) > hours * 3600_000;
}

/**
 * Schedule a backup at 03:00 local time every day: plain copies an older hub left are sealed and encrypted first,
 * then the night's copy is made, and copied to `copyDir` when set. A hub that was off at 03:00 (a laptop asleep, a
 * power cut) makes the missed one 10 minutes after it starts. Errors are logged and the next run still happens.
 * Returns a stop function.
 */
export function startNightlyBackup(db: DB, backupDir: string, key: BackupKey, workKey: WorkKey, hour = 3, copyDir = ""): () => void {
  const run = async () => {
    // Older plain copies are on this machine's own disk, beside the live database, so keeping them costs nothing; they
    // are encrypted (and the plain files removed) only once the owner has saved the recovery key, so a lost disk before
    // then still leaves copies that open without it.
    if (key.recoverySaved()) {
      const c = await encryptPlainBackups(backupDir, key, workKey);
      if (c.converted.length) console.log(`[backup] encrypted ${c.converted.length} older plain backups`);
    }
    const r = await runBackup(db, backupDir, key);
    console.log(`[backup] wrote ${r.file}${r.pruned.length ? `, pruned ${r.pruned.length}` : ""}`);
    const c = copyBackup(r.file, copyDir);
    if (c.copied) console.log(`[backup] copied to ${c.copied}`);
    else if (c.error) console.error(`[backup] second copy not made: ${c.error}`);
  };
  const go = () => { run().catch((e) => console.error(`[backup] failed: ${e instanceof BackupKeyError ? e.message : errCode(e)}`)); };
  const stop = scheduleDaily("backup", hour, 0, go);
  const late = setTimeout(() => { if (backupOverdue(backupDir)) { console.log("[backup] the last nightly backup was missed; making it now"); go(); } }, 10 * 60_000);
  late.unref?.();
  return () => { clearTimeout(late); stop(); };
}

/**
 * Seal the work items in backups made before the work key existed, and drop their search entries, so erasing the
 * work space (which destroys the key) leaves no readable work text in older copies either. Keeps each file's time,
 * which the pruning goes by. Returns the files it rewrote. Only plain copies: encrypted ones were sealed before.
 */
export function sealWorkInBackups(backupDir: string, key: WorkKey): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(backupDir).filter((n) => PLAIN_BACKUP_FILE.test(n)); } catch { return []; }
  const done: string[] = [];
  for (const name of names) {
    const file = path.join(backupDir, name);
    const st = fs.statSync(file);
    let db: InstanceType<typeof Database> | null = null;
    // One damaged copy (cut off before this fix) is skipped, not the end of the run: later copies are still sealed.
    // It is closed first: on Windows a file left open cannot be encrypted and removed afterwards.
    try { db = new Database(file); db.prepare("SELECT 1 FROM entities LIMIT 1").get(); }
    catch (e) { db?.close(); console.error(`[backup] ${name} cannot be read, left as it is: ${errCode(e)}`); continue; }
    try {
      const plain = db.prepare("SELECT rowid, id, fields FROM entities WHERE space = 'work' AND fields NOT LIKE 'enc1:%'").all() as { rowid: number; id: string; fields: string }[];
      if (!plain.length) continue;
      db.pragma("secure_delete = ON");
      const set = db.prepare("UPDATE entities SET fields = ? WHERE id = ?");
      const fts = db.prepare("DELETE FROM entities_fts WHERE rowid = ?");
      db.transaction(() => { for (const r of plain) { set.run(key.seal(r.id, r.fields), r.id); fts.run(r.rowid); } }).immediate();
      db.exec("INSERT INTO entities_fts(entities_fts) VALUES('optimize')");
      db.exec("VACUUM");
      done.push(name);
    } catch (e) {
      console.error(`[backup] ${name} could not be sealed: ${errCode(e)}`);
    } finally {
      db.close();
      fs.utimesSync(file, st.atime, st.mtime);
    }
  }
  return done;
}

/** Drop the chat tables a backup made before chats moved to chats.sqlite still holds (VACUUMed, time kept). */
export function dropChatTables(file: string): boolean {
  const st = fs.statSync(file);
  const db = new Database(file);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'ai_calls', 'ai_actions')").all() as { name: string }[]).map((t) => t.name);
    if (!tables.length) return false;
    db.pragma("secure_delete = ON");
    for (const t of tables) db.exec(`DROP TABLE ${t}`);
    db.exec("VACUUM");
    return true;
  } finally {
    db.close();
    fs.utimesSync(file, st.atime, st.mtime);
  }
}

/**
 * Encrypt the plain `hub-*.sqlite` backups an older hub wrote, once. Their work items are sealed first
 * (sealWorkInBackups) and the chat tables of copies made before chats moved out are dropped (chats are in no
 * backup); then each is encrypted to `<name>.age` with its file times kept (the 30-day pruning goes by them) and the
 * plain file removed. A copy that still holds plain work items (its sealing failed) is left for the next run. A
 * damaged copy that cannot be opened is encrypted as it is: it cannot be sealed, and it is still the owner's data.
 */
export async function encryptPlainBackups(backupDir: string, key: BackupKey, workKey: WorkKey): Promise<{ converted: string[]; skipped: string[] }> {
  const converted: string[] = [];
  const skipped: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(backupDir).filter((n) => PLAIN_BACKUP_FILE.test(n)).sort(); } catch { return { converted, skipped }; }
  if (!names.length) return { converted, skipped };
  const recipient = key.recipient();
  sealWorkInBackups(backupDir, workKey);
  for (const name of names) {
    const file = path.join(backupDir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    let readable = true;
    let left = 0;
    try {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try { left = (db.prepare("SELECT count(*) AS n FROM entities WHERE space = 'work' AND fields NOT LIKE 'enc1:%'").get() as { n: number }).n; }
      finally { db.close(); }
    } catch { readable = false; }
    if (left) { skipped.push(name); console.error(`[backup] ${name} still holds ${left} plain work items; left plain until they are sealed`); continue; }
    try {
      if (readable && dropChatTables(file)) console.log(`[backup] dropped the chat tables of ${name}`);
    } catch (e) { console.error(`[backup] ${name}: chat tables could not be dropped: ${errCode(e)}`); }
    const out = `${file}.age`;
    await encryptFile(file, out, recipient);
    fs.utimesSync(out, st.atime, st.mtime);
    for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
    converted.push(name);
  }
  return { converted, skipped };
}

export interface BackupInfo { file: string; at: string; bytes: number; encrypted: boolean }

/** Backup files on disk, newest first: the encrypted ones, and any plain one an older hub left that is not encrypted yet. */
export function listBackups(backupDir: string): BackupInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const n of names) {
    const encrypted = BACKUP_FILE.test(n);
    if (!encrypted && !PLAIN_BACKUP_FILE.test(n)) continue;
    try { const st = fs.statSync(path.join(backupDir, n)); out.push({ file: n, at: st.mtime.toISOString(), bytes: st.size, encrypted }); } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

/**
 * Decrypt the backup `src` to `dst` with any of `identities`, check it with PRAGMA integrity_check and only then
 * put it at `dst`, which must not exist yet. Returns what the check found.
 */
export async function restoreBackup(src: string, dst: string, identities: string[]): Promise<{ integrity: string; entities: number }> {
  if (fs.existsSync(dst)) throw new BackupKeyError(`${dst} is already there; move it aside or name another path`);
  const tmp = `${dst}.restoring`;
  for (const side of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${tmp}${side}`, { force: true });
  try {
    try { await decryptFile(src, tmp, identities); }
    catch (e) {
      if (/no identity matched/i.test((e as Error).message)) throw new BackupKeyError(`${path.basename(src)} was not encrypted with this key; give the recovery key saved at that time in EA_RECOVERY_KEY`);
      throw e;
    }
    let integrity: string;
    let entities: number;
    try {
      const db = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        integrity = String(db.pragma("integrity_check", { simple: true }));
        entities = (db.prepare("SELECT count(*) AS n FROM entities").get() as { n: number }).n;
      } finally { db.close(); }
    } catch (e) { throw new BackupKeyError(`the decrypted file is not a hub database: ${(e as Error).message}`); }
    if (integrity !== "ok") throw new BackupKeyError(`the decrypted database failed its integrity check: ${integrity}`);
    // A hard link puts it in place without ever writing over a file that appeared meanwhile (rename where the file
    // system has no hard links).
    try { fs.linkSync(tmp, dst); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || fs.existsSync(dst)) throw new BackupKeyError(`${dst} appeared while restoring; nothing was written over it`);
      fs.renameSync(tmp, dst);
    }
    return { integrity, entities };
  } finally {
    for (const side of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${tmp}${side}`, { force: true });
  }
}
