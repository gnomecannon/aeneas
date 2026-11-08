import { promises as fs } from "node:fs";
import path from "node:path";
import { SKIP_DIRS, type Matcher } from "./ignore.ts";

export interface LocalFile {
  rel: string;
  abs: string;
  mtimeMs: number;
  size: number;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Recursively list .md files under vaultDir, skipping .obsidian, .trash, dot-directories and ignored paths. */
export async function listLocal(vaultDir: string, ignore: Matcher): Promise<Map<string, LocalFile>> {
  const out = new Map<string, LocalFile>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(vaultDir, abs));
      if (e.isDirectory()) {
        if (SKIP_DIRS.includes(e.name) || e.name.startsWith(".")) continue;
        if (ignore.isIgnored(rel + "/x.md")) continue;
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        if (e.name.startsWith(".")) continue;
        if (ignore.isIgnored(rel)) continue;
        const st = await fs.stat(abs);
        out.set(rel, { rel, abs, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  await walk(vaultDir);
  return out;
}

export async function readLocal(vaultDir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(vaultDir, rel), "utf8");
}

/** Write content and set the file mtime to the hub's mtime when it parses. Returns the resulting mtimeMs. */
export async function writeLocal(vaultDir: string, rel: string, content: string, mtime?: string): Promise<number> {
  const abs = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  const t = mtime ? new Date(mtime) : null;
  if (t && !Number.isNaN(t.getTime())) {
    try {
      await fs.utimes(abs, t, t);
    } catch {
      /* mtime is a nicety; ignore */
    }
  }
  const st = await fs.stat(abs);
  return st.mtimeMs;
}

/** Move a local file into .trash/ keeping its folder structure. Returns the trash-relative destination. */
export async function trashLocal(vaultDir: string, rel: string, now: Date): Promise<string> {
  const src = path.join(vaultDir, rel);
  let dest = path.join(vaultDir, ".trash", rel);
  try {
    await fs.access(dest);
    const ext = path.extname(dest);
    dest = dest.slice(0, -ext.length) + ` (${stamp(now)})` + ext;
  } catch {
    /* no collision */
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(src, dest);
  return toPosix(path.relative(vaultDir, dest));
}

export function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
}

/** "Folder/Note.md" -> "Folder/Note (conflict 2026-10-21 1432).md" */
export function conflictName(rel: string, now: Date): string {
  const ext = path.posix.extname(rel);
  return rel.slice(0, rel.length - ext.length) + ` (conflict ${stamp(now)})` + ext;
}
