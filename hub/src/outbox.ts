import fs from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import { type BackupKey, encryptBytes, encryptFile, writeAtomic } from "./backupkey.js";

/**
 * The outbox: what the nightly copy to storage sends besides the encrypted database backup, already encrypted to
 * the backup key, in `<data>/outbox/` (deploy/user-backup/backup-to-storage.sh mirrors the folder as it is). No plain
 * picture, recording or settings file leaves the machine.
 *
 * - `settings.zip.age`: the settings beside the database in one zip (below), with the Feel image shapes.
 * - `gallery/<file>.age`: each picture a live gallery record keeps (chat pictures stay out, as chats do).
 * - `audio/<file>.age`: each hum recording.
 * Pictures and recordings are encrypted once: an outbox file carries its source's modification time and is made
 * again only when the source changes, so rsync sends only new ones. A file whose source is gone is removed, so the
 * mirror drops it too.
 */

/**
 * The owner's name and pet, module switches, the dashboard, themes, the machines list and the work space switch.
 * Sign-ins (connections.json), the password vault, ai.json (model keys), the feed keys and both key files never go.
 */
export const SETTINGS_FILES = ["profile.json", "modules.json", "dashboard.json", "feel.json", "hosts.json", "work-space.json", "device-keys.json", "retention.json"];

export interface MirrorCount { sealed: number; kept: number; removed: number }
export interface OutboxReport { dir: string; settings: number; gallery: MirrorCount; audio: MirrorCount }

const sameSecond = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000);

/** Encrypt each named file of `srcDir` into `dstDir` as `<name>.age`, once, and remove what is no longer named. */
async function mirror(srcDir: string, names: string[], dstDir: string, recipient: string): Promise<MirrorCount> {
  const n: MirrorCount = { sealed: 0, kept: 0, removed: 0 };
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  const want = new Set<string>();
  for (const name of names) {
    if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\")) continue;
    const src = path.join(srcDir, name);
    let st: fs.Stats;
    try { st = fs.statSync(src); } catch { continue; }
    if (!st.isFile()) continue;
    const out = `${name}.age`;
    want.add(out);
    const dst = path.join(dstDir, out);
    try { if (sameSecond(fs.statSync(dst).mtimeMs, st.mtimeMs)) { n.kept++; continue; } } catch { /* not there yet */ }
    await encryptFile(src, dst, recipient);
    fs.utimesSync(dst, st.atime, st.mtime);
    n.sealed++;
  }
  for (const name of fs.readdirSync(dstDir)) {
    if (want.has(name)) continue;
    fs.rmSync(path.join(dstDir, name), { recursive: true, force: true });
    if (name.endsWith(".age")) n.removed++;
  }
  return n;
}

function filesIn(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } }).sort(); } catch { return []; }
}

/** The settings files and Feel image shapes in one zip, or null when there are none. */
export function settingsZip(dataDir: string): { zip: Uint8Array; files: number } | null {
  const entries: Zippable = {};
  let files = 0;
  const add = (name: string, file: string) => {
    try { const st = fs.statSync(file); if (!st.isFile()) return; entries[name] = [fs.readFileSync(file), { mtime: st.mtime }]; files++; } catch { /* not there */ }
  };
  for (const f of SETTINGS_FILES) add(f, path.join(dataDir, f));
  const shapes = path.join(dataDir, "feel-images");
  for (const f of filesIn(shapes)) add(`feel-images/${f}`, path.join(shapes, f));
  return files ? { zip: zipSync(entries, { level: 6 }), files } : null;
}

/** Fill the outbox for tonight's copy to storage. `gallery` names the pictures under `<data>/ai-images` to send. */
export async function fillOutbox(dataDir: string, key: BackupKey, gallery: string[], dir = path.join(dataDir, "outbox")): Promise<OutboxReport> {
  const recipient = key.recipient();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archive = path.join(dir, "settings.zip.age");
  const s = settingsZip(dataDir);
  if (s) writeAtomic(archive, await encryptBytes(s.zip, recipient));
  else fs.rmSync(archive, { force: true });
  return {
    dir,
    settings: s?.files ?? 0,
    gallery: await mirror(path.join(dataDir, "ai-images"), gallery, path.join(dir, "gallery"), recipient),
    audio: await mirror(path.join(dataDir, "audio"), filesIn(path.join(dataDir, "audio")), path.join(dir, "audio"), recipient),
  };
}
