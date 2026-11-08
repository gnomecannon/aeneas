import fs from "node:fs";
import path from "node:path";
import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * The work space switch. Off means: every work entity is blanked and tombstoned (so every device drops it), the
 * work key is destroyed (so the nightly backups and the Litestream replica, which hold the items sealed with it, can
 * no longer be read), the change history and file are compacted so the old text is not left behind, and new work
 * entities are refused until it is turned on again. The iPhone calendar import checks this before importing.
 */

const EPOCH = "1970-01-01T00:00:00.000Z";

export class WorkSpace {
  constructor(private file: string) {}

  /**
   * On unless the file says off. A file that exists and cannot be read counts as off: written in place, a crash
   * after an erase left it empty, which read as on and let work items be written again.
   */
  get enabled(): boolean {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
    try { return (JSON.parse(raw) as { enabled?: boolean }).enabled !== false; }
    catch { console.error("[work] work-space.json cannot be read; the work space counts as off"); return false; }
  }

  setEnabled(on: boolean): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ enabled: on }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function workCounts(hub: Hub): { events: number; tasks: number; other: number } {
  const all = hub.store.list({ space: "work", limit: 1_000_000 });
  const events = all.filter((e) => e.kind === "event").length;
  const tasks = all.filter((e) => e.kind === "task").length;
  return { events, tasks, other: all.length - events - tasks };
}

/** Every field emptied, with the few values a schema insists on set to something meaningless. */
function blankFields(e: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.fields)) {
    out[k] = typeof v === "string" ? "" : typeof v === "number" ? 0 : typeof v === "boolean" ? false : Array.isArray(v) ? [] : v === null ? null : {};
  }
  out.title = "-";
  if (e.kind === "event") Object.assign(out, { start: EPOCH, end: EPOCH, all_day: false });
  if (e.kind === "task") Object.assign(out, { status: "done", done_at: EPOCH });
  return out;
}

/**
 * Chats keep what the assistant said about work items ("Acme - ThreatLocker at 11"): on an erase their names go
 * from every chat, its title and its summary too, and the chat database is compacted so no old page keeps them.
 */
function scrubChats(hub: Hub, names: string[]): number {
  if (!names.length) return 0;
  let n = 0;
  const rows = hub.chatDb.prepare("SELECT session_id, messages, title, summary FROM sessions").all() as { session_id: string; messages: string; title: string | null; summary: string | null }[];
  const scrub = (v: string | null) => { if (!v) return v; let out = v; for (const t of names) out = out.split(t).join("[work item]"); return out; };
  const update = hub.chatDb.prepare("UPDATE sessions SET messages = ?, title = ?, summary = ? WHERE session_id = ?");
  for (const r of rows) {
    const m = scrub(r.messages)!, t = scrub(r.title), s = scrub(r.summary);
    if (m !== r.messages || t !== r.title || s !== r.summary) { update.run(m, t, s, r.session_id); n++; }
  }
  hub.chatDb.pragma("wal_checkpoint(TRUNCATE)");
  hub.chatDb.exec("VACUUM");
  return n;
}

export function wipeWork(hub: Hub): { erased: number } {
  let erased = 0;
  const work = hub.store.list({ space: "work", includeDeleted: true, limit: 1_000_000 });
  // Longest first, so a name inside a longer one does not leave a piece behind; JSON-escaped too, as chats store them.
  const names = [...new Set(work.flatMap((e) => [e.fields.title, e.fields.location]).map((v) => String(v ?? "").trim()).filter((v) => v.length >= 4 && v !== "-"))]
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b.length - a.length);
  for (const e of work) {
    try {
      hub.store.patch(e.id, { ...blankFields(e), deleted_at: e.deleted_at ?? nowIso() });
    } catch {
      // A shape the blanking does not satisfy: still tombstone it so devices drop it.
      hub.store.patch(e.id, { title: "-", deleted_at: e.deleted_at ?? nowIso() });
    }
    erased++;
  }
  // Items sealed with a key that is gone cannot be read, but devices may still hold them: a blank tombstone over each.
  const kinds = new Map((hub.store.db.prepare("SELECT id, kind FROM entities WHERE space = 'work'").all() as { id: string; kind: string }[]).map((r) => [r.id, r.kind]));
  for (const id of hub.store.unreadableWork()) {
    const kind = kinds.get(id);
    const blank = kind === "event" ? { title: "-", start: EPOCH, end: EPOCH, all_day: false } : { title: "-", status: "done", order: 0, done_at: EPOCH };
    try {
      hub.store.apply({ id, kind: kind as Entity["kind"], space: "work", ts: nowIso(), create: true, fields: { ...blank, deleted_at: nowIso() } });
      erased++;
    } catch { /* left for rotateWorkKey to purge */ }
  }
  hub.store.rotateWorkKey();
  try { scrubChats(hub, names); } catch (e) { console.error(`[work] chats not scrubbed: ${errCode(e)}`); }
  hub.store.optimizeFts();
  hub.store.compactChanges();
  hub.store.db.pragma("wal_checkpoint(TRUNCATE)");
  hub.store.db.exec("VACUUM");
  return { erased };
}

/** Turn the work space on or off. Off erases it first; the caller must have confirmed. */
export function setWorkSpace(hub: Hub, on: boolean): { enabled: boolean; erased: number } {
  if (on) {
    hub.work.setEnabled(true);
    return { enabled: true, erased: 0 };
  }
  hub.work.setEnabled(false);
  return { enabled: false, ...wipeWork(hub) };
}

/** While the work space is off nothing may be written to it, so a queued edit from an offline device cannot bring erased text back. */
export function assertWorkAllowed(hub: Hub, space: string | undefined): void {
  if (space === "work" && !hub.work.enabled) throw new StoreError(409, "the work space is turned off");
}
