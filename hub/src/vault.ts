import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Entity } from "@everythingapp/shared";
import { Store, StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

export interface VaultEntry { path: string; hash: string; mtime: string; size: number }

export interface ParsedNote {
  id?: string;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  /** The note linker's links, from the `related` property (`- "[[Title]]"` lines), as titles. */
  related: string[];
  frontmatter: Record<string, string | string[]>;
}

/** Normalize a vault-relative path and reject anything that escapes the vault. */
export function safeRelPath(rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new StoreError(400, "path required");
  const cleaned = rel.replace(/\\/g, "/").trim();
  if (cleaned.startsWith("/") || cleaned.includes("\0") || /^[A-Za-z]:/.test(cleaned)) throw new StoreError(400, "invalid path");
  const parts = cleaned.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new StoreError(400, "invalid path");
  if (!cleaned.endsWith(".md")) throw new StoreError(400, "path must end in .md");
  return parts.join("/");
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

export function extractInlineTags(body: string): string[] {
  const out = new Set<string>();
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const re = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode))) out.add(m[2]);
  return [...out];
}

/** Frontmatter keys the hub writes itself; every other property is the owner's and is kept as it was written. */
const MANAGED_KEYS = new Set(["id", "title", "tags", "related"]);

/**
 * The frontmatter lines of every property the hub does not manage (aliases, created, cssclasses, status...), as
 * written, with their indented or list lines: kept on the note and written back unchanged on every rewrite.
 */
export function extraFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  const out: string[] = [];
  let keep = false;
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) keep = !MANAGED_KEYS.has(top[1]);
    else if (!/^\s/.test(line) && line.trim() !== "") keep = false;
    if (keep) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "");
}

function parseFrontmatter(text: string): { fm: Record<string, string | string[]>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: text };
  const block = text.slice(4, end);
  let body = text.slice(end + 4);
  body = body.replace(/^\r?\n/, "");
  const fm: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === "" && lines[i + 1]?.match(/^\s+-\s+/)) {
      const list: string[] = [];
      while (lines[i + 1]?.match(/^\s+-\s+/)) { i++; list.push(unquote(lines[i].replace(/^\s+-\s+/, ""))); }
      fm[key] = list;
      continue;
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      continue;
    }
    fm[key] = unquote(val);
  }
  return { fm, body };
}

/** A YAML scalar as written: double quotes are JSON-style escapes (what `quote` writes), single quotes double a quote. */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // Read back what quote() wrote; a title like Mom's "famous" chili no longer gains a backslash on each round.
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function quote(s: string): string {
  return /[:#\[\]{},&*?|<>=!%@`"'\\]|^\s|\s$/.test(s) || s === "" ? JSON.stringify(s) : s;
}

/** Parse a markdown file into note fields. Title: frontmatter, else first heading, else filename. */
export function parseNoteFile(text: string, relPath: string): ParsedNote {
  const { fm, body } = parseFrontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(body);
  const fileName = path.basename(relPath, ".md");
  const title = (typeof fm.title === "string" && fm.title) || heading?.[1].trim() || fileName;
  let tags: string[] = [];
  if (Array.isArray(fm.tags)) tags = fm.tags;
  else if (typeof fm.tags === "string" && fm.tags) tags = fm.tags.split(/[,\s]+/).filter(Boolean);
  tags = [...new Set([...tags.map((t) => t.replace(/^#/, "")), ...extractInlineTags(body)])];
  const id = typeof fm.id === "string" && /^[0-9a-f-]{36}$/i.test(fm.id) ? fm.id : undefined;
  const rel = Array.isArray(fm.related) ? fm.related : typeof fm.related === "string" && fm.related ? [fm.related] : [];
  // `[[file name|Title]]` (written so Obsidian can open it by file name) means the note titled Title.
  const titleOf = (r: string) => { const m = /\[\[([^\]|]+)\|([^\]]+)\]\]/.exec(r); return m ? [m[2].trim()] : r.includes("[[") ? extractWikilinks(r) : [r.trim()]; };
  const related = [...new Set(rel.flatMap(titleOf).filter(Boolean))];
  return { id, title, body, tags, links: extractWikilinks(body), related, frontmatter: fm };
}

/**
 * Render a note entity to file text: frontmatter with id, title, tags and the note linker's `related` links, then the
 * body. `related` is a list of `[[Title]]` links, which Obsidian shows in its graph and backlinks like links in the text.
 */
export function renderNoteFile(e: Entity, fileOf: (title: string) => string | null = () => null): string {
  const f = e.fields;
  const tags: string[] = Array.isArray(f.tags) ? f.tags : [];
  const related: string[] = Array.isArray(f.related) ? f.related : [];
  // Obsidian opens a link by file name: a note whose file is named otherwise is linked as [[file name|Title]].
  const link = (t: string) => { const stem = fileOf(t); return stem && stem !== t ? `[[${stem}|${t}]]` : `[[${t}]]`; };
  const extra = typeof f.frontmatter_extra === "string" && f.frontmatter_extra.trim() ? f.frontmatter_extra.split("\n") : [];
  const lines = ["---", `id: ${e.id}`, `title: ${quote(String(f.title ?? ""))}`, `tags: [${tags.map(quote).join(", ")}]`,
    ...(related.length ? ["related:", ...related.map((t) => `  - ${JSON.stringify(link(t))}`)] : []), ...extra, "---", ""];
  const body = String(f.body ?? "");
  return lines.join("\n") + body + (body.endsWith("\n") || body === "" ? "" : "\n");
}

export class Vault {
  private suppressHook = false;
  /** Set by the knowledge map so links include title mentions, not only wikilinks. */
  linkDeriver: ((noteId: string, body: string, title: string, related: string[]) => string[]) | null = null;

  /** Patch derived fields without rewriting the file. */
  patchQuiet(id: string, fields: Record<string, unknown>): void {
    this.suppressHook = true;
    try { this.store.patch(id, fields); } finally { this.suppressHook = false; }
  }

  constructor(public dir: string, private store: Store) {
    fs.mkdirSync(dir, { recursive: true });
    store.afterWrite((e, prev) => this.onEntityWritten(e, prev));
  }

  abs(rel: string): string {
    const safe = safeRelPath(rel);
    const full = path.resolve(this.dir, safe);
    const root = path.resolve(this.dir) + path.sep;
    if (!full.startsWith(root)) throw new StoreError(400, "invalid path");
    return full;
  }

  /** Walk the vault for .md files. Hidden folders (.obsidian, .trash) are skipped. */
  index(): VaultEntry[] {
    const out: VaultEntry[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue;
        const full = path.join(dir, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(full, r);
        else if (ent.isFile() && ent.name.endsWith(".md")) {
          const st = fs.statSync(full);
          out.push({ path: r, hash: sha256(fs.readFileSync(full)), mtime: st.mtime.toISOString(), size: st.size });
        }
      }
    };
    walk(this.dir, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(rel: string): string | null {
    const full = this.abs(rel);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf8");
  }

  private noteForPath(rel: string): Entity | null {
    const row = this.store.db.prepare("SELECT entity_id FROM vault_files WHERE path = ?").get(rel) as { entity_id: string } | undefined;
    if (row?.entity_id) {
      const e = this.store.get(row.entity_id);
      if (e && e.kind === "note") return e;
    }
    return this.store.list({ kind: "note", includeDeleted: true, where: { path: rel } })[0] ?? null;
  }

  /** Write a file and upsert the note entity for it. Injects an id into the frontmatter when missing. */
  write(rel: string, text: string, mtime?: string | number): VaultEntry {
    const safe = safeRelPath(rel);
    const full = this.abs(safe);
    const parsed = parseNoteFile(text, safe);
    const existing = this.noteForPath(safe);
    const id = parsed.id ?? existing?.id ?? randomUUID();
    let content = text;
    if (!parsed.id) {
      // Prepend or extend the frontmatter so the file carries its entity id.
      if (text.startsWith("---\n")) content = `---\nid: ${id}\n` + text.slice(4);
      else content = `---\nid: ${id}\n---\n` + text;
    }
    const extra = extraFrontmatter(content);
    const fields: Record<string, unknown> = {
      title: parsed.title, body: parsed.body, tags: parsed.tags, path: safe, related: parsed.related,
      frontmatter_extra: extra || null,
      links: this.linkDeriver ? this.linkDeriver(id, parsed.body, parsed.title, parsed.related) : [...new Set([...parsed.links, ...parsed.related])], deleted_at: null,
    };
    this.suppressHook = true;
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
      if (mtime !== undefined && mtime !== "") {
        const d = typeof mtime === "number" ? new Date(mtime) : new Date(/^\d+$/.test(String(mtime)) ? Number(mtime) : String(mtime));
        if (!Number.isNaN(d.getTime())) fs.utimesSync(full, d, d);
      }
      const cur = this.store.get(id);
      if (cur) this.store.patch(id, fields);
      else this.store.create("note", fields, "personal", id);
    } finally {
      this.suppressHook = false;
    }
    return this.record(safe, id);
  }

  /**
   * Write a note the hub makes itself (a project's plan, a cover letter) over the one at `rel`, keeping what others
   * added to it: the owner's tags and the linker's next to `tags`, its related links and its other properties.
   */
  writeOwn(rel: string, note: { title: string; tags: string[]; body: string }): VaultEntry {
    const safe = safeRelPath(rel);
    const had = this.noteForPath(safe);
    const keep = had && !had.deleted_at ? had : null;
    const oldTags = Array.isArray(keep?.fields.tags) ? (keep!.fields.tags as string[]) : [];
    const text = renderNoteFile({
      id: keep?.id ?? randomUUID(), kind: "note", space: "personal", created_at: "", updated_at: "", deleted_at: null, field_ts: {},
      fields: {
        title: note.title, body: note.body, tags: [...new Set([...note.tags, ...oldTags])],
        related: Array.isArray(keep?.fields.related) ? keep!.fields.related : [],
        frontmatter_extra: keep?.fields.frontmatter_extra ?? null,
      },
    } as Entity, (t) => this.fileStemOf(t));
    return this.write(safe, text);
  }

  /** Delete the file and mark the note entity deleted. */
  remove(rel: string): boolean {
    const safe = safeRelPath(rel);
    const full = this.abs(safe);
    const note = this.noteForPath(safe);
    const existed = fs.existsSync(full);
    this.suppressHook = true;
    try {
      if (existed) fs.rmSync(full);
      this.store.db.prepare("DELETE FROM vault_files WHERE path = ?").run(safe);
      if (note && !note.deleted_at) this.store.patch(note.id, { deleted_at: new Date().toISOString() });
    } finally {
      this.suppressHook = false;
    }
    return existed || !!note;
  }

  private record(rel: string, entityId: string): VaultEntry {
    const full = this.abs(rel);
    const st = fs.statSync(full);
    const entry: VaultEntry = { path: rel, hash: sha256(fs.readFileSync(full)), mtime: st.mtime.toISOString(), size: st.size };
    this.store.db.prepare("INSERT INTO vault_files (path, hash, mtime, size, entity_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime, size = excluded.size, entity_id = excluded.entity_id")
      .run(entry.path, entry.hash, entry.mtime, entry.size, entityId);
    return entry;
  }

  /** Entity side of the mirror: a note write becomes a file write. */
  /** Which note a file belongs to: the vault's record of it, else the id in its own frontmatter. */
  private ownerOf(rel: string): string | null {
    const row = this.store.db.prepare("SELECT entity_id FROM vault_files WHERE path = ?").get(rel) as { entity_id: string } | undefined;
    if (row?.entity_id) return row.entity_id;
    try { const text = this.read(rel); return text ? parseNoteFile(text, rel).id ?? null : null; } catch { return null; }
  }

  /** Remove a note's file, only when it is that note's (a second note at the same path keeps its own). */
  private dropFile(rel: string, id: string): void {
    const owner = this.ownerOf(rel);
    if (owner && owner !== id) return;
    try { fs.rmSync(this.abs(rel), { force: true }); } catch { /* ignore */ }
    this.store.db.prepare("DELETE FROM vault_files WHERE path = ?").run(rel);
  }

  /**
   * The path a note is written at: its own, unless a file name starts with a dot (hidden, so never indexed and
   * overwritten on every start) or another live note already has that file, in which case "Title 2.md" and so on.
   */
  private fitPath(rel: string, id: string): string {
    const parts = rel.split("/").map((p) => (p.startsWith(".") ? p.replace(/^\.+\s*/, "") || "Untitled" : p));
    let fit = parts.join("/");
    if (!fit.endsWith(".md")) fit += ".md";
    const stem = fit.slice(0, -3);
    const taken = (p: string) => {
      const owner = this.ownerOf(p);
      if (!owner || owner === id) return false;
      const other = this.store.get(owner);
      return !!other && !other.deleted_at;
    };
    for (let n = 2; taken(fit) && n < 1000; n++) fit = `${stem} ${n}.md`;
    return fit;
  }

  private onEntityWritten(e: Entity, prev: Entity | null): void {
    if (this.suppressHook || e.kind !== "note") return;
    if (e.space === "work") return;
    let rel: string;
    try { rel = safeRelPath(String(e.fields.path ?? "")); } catch { return; }
    const prevPath = prev?.fields.path ? (() => { try { return safeRelPath(String(prev.fields.path)); } catch { return null; } })() : null;
    if (e.deleted_at) {
      this.dropFile(rel, e.id);
      if (prevPath && prevPath !== rel) this.dropFile(prevPath, e.id);
      return;
    }
    // Another note's file is never overwritten: this one moves to a free name, and every device learns it by sync.
    const fit = this.fitPath(rel, e.id);
    if (fit !== rel) {
      this.suppressHook = true;
      try { e = this.store.patch(e.id, { path: fit }); } finally { this.suppressHook = false; }
      rel = fit;
    }
    if (prevPath && prevPath !== rel) this.dropFile(prevPath, e.id);
    const full = this.abs(rel);
    // A file written before the hub kept other properties: they are read from it before it is rewritten.
    if (e.fields.frontmatter_extra === undefined && fs.existsSync(full)) {
      const extra = extraFrontmatter(fs.readFileSync(full, "utf8"));
      if (extra) {
        this.suppressHook = true;
        try { e = this.store.patch(e.id, { frontmatter_extra: extra }); } finally { this.suppressHook = false; }
      }
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, renderNoteFile(e, (t) => this.fileStemOf(t)), "utf8");
    this.record(rel, e.id);
    // A renamed note (by the linker or the owner): other notes' related links follow it instead of going dead.
    const oldTitle = typeof prev?.fields.title === "string" ? prev.fields.title : "";
    const newTitle = String(e.fields.title ?? "");
    if (oldTitle && newTitle && oldTitle !== newTitle) {
      for (const other of this.store.list({ kind: "note", space: "personal" })) {
        const rel2 = Array.isArray(other.fields.related) ? (other.fields.related as string[]) : [];
        if (other.id === e.id || !rel2.includes(oldTitle)) continue;
        this.store.patch(other.id, { related: [...new Set(rel2.map((t) => (t === oldTitle ? newTitle : t)))] });
      }
    }
    // Keep derived links in the entity without triggering another file write.
    const related = Array.isArray(e.fields.related) ? (e.fields.related as string[]) : [];
    const links = this.linkDeriver ? this.linkDeriver(e.id, String(e.fields.body ?? ""), String(e.fields.title ?? ""), related) : [...new Set([...extractWikilinks(String(e.fields.body ?? "")), ...related])];
    if (JSON.stringify(links) !== JSON.stringify(e.fields.links ?? [])) {
      this.suppressHook = true;
      try { this.store.patch(e.id, { links }); } finally { this.suppressHook = false; }
    }
  }

  /** The file name (without .md) of the live note with this title, for links Obsidian can open. */
  private fileStemOf(title: string): string | null {
    const n = this.store.list({ kind: "note", where: { title } }).find((x) => !x.deleted_at && x.space !== "work");
    return n ? path.basename(String(n.fields.path ?? ""), ".md") || null : null;
  }

  /** Startup pass: files changed on disk update their entities; notes without a file get one. */
  reconcile(): { imported: number; exported: number } {
    let imported = 0;
    let exported = 0;
    const known = new Map<string, { hash: string }>();
    for (const r of this.store.db.prepare("SELECT path, hash FROM vault_files").all() as { path: string; hash: string }[]) known.set(r.path, r);
    const onDisk = new Set<string>();
    // File names of notes are personal text: the log says how many and why, never which (CONTRACT.md, privacy rules).
    let notImported = 0, firstImportErr = "", missing = 0;
    for (const f of this.index()) {
      onDisk.add(f.path);
      if (known.get(f.path)?.hash === f.hash) continue;
      try {
        this.write(f.path, fs.readFileSync(this.abs(f.path), "utf8"));
        imported++;
      } catch (e) {
        if (!notImported++) firstImportErr = errCode(e);
      }
    }
    if (notImported) console.error(`[vault] ${notImported} file(s) could not be imported (first: ${firstImportErr})`);
    for (const p of known.keys()) {
      if (!onDisk.has(p)) {
        missing++;
        this.store.db.prepare("DELETE FROM vault_files WHERE path = ?").run(p);
      }
    }
    if (missing) console.warn(`[vault] ${missing} file(s) missing on disk; their note entities are kept`);
    for (const e of this.store.list({ kind: "note", space: "personal" })) {
      let rel: string;
      try { rel = safeRelPath(String(e.fields.path ?? "")); } catch { continue; }
      if (onDisk.has(rel)) continue;
      try { this.onEntityWritten(e, null); exported++; } catch (err) { console.error(`[vault] could not export note ${e.id}: ${errCode(err)}`); }
    }
    return { imported, exported };
  }
}
