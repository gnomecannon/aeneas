import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { FieldsByKind, nowIso, type Entity, type Kind, type Patch } from "@everythingapp/shared";
import { FTS_TABLE, type DB } from "./db.js";
import type { Bus } from "./bus.js";
import { WorkKey } from "./workkey.js";
import { errCode } from "./logsafe.js";
import { patternProblem } from "./ai/rule-guard.js";

export class StoreError extends Error {
  /** `extra` keys are merged into the JSON error body next to `error` and `detail` (the planner's `conflict`). */
  constructor(public status: number, message: string, public detail?: unknown, public extra?: Record<string, unknown>) { super(message); }
}

export interface ApplyResult { entity: Entity; seq: number; changed: string[]; created: boolean }

/** Hook invoked after an entity write commits. `prev` is null on create. */
export type AfterWriteHook = (entity: Entity, prev: Entity | null, changed: string[]) => void;

interface Row { id: string; kind: string; space: string; created_at: string; updated_at: string; deleted_at: string | null; fields: string; field_ts: string }

/**
 * A test on one field for Store.listWhere: equal to a text or to true or false (`is`), anything but that, missing
 * included (`isNot`), one of some texts (`oneOf`), a text at or after another as text compares (`from`, for ISO
 * times), or present and not null (`set`). SQLite and JavaScript give the same answer for each.
 */
export type FieldTest =
  | { key: string; is: string | boolean }
  | { key: string; isNot: string | boolean }
  | { key: string; oneOf: string[] }
  | { key: string; from: string }
  | { key: string; set: true };

/**
 * The SQLite test for one field of a row's JSON, and its arguments. The path is written into the SQL (the field name
 * is checked first: letters, digits and _), so the expression matches the partial indexes on capture fields (db.ts)
 * and SQLite reads only the rows that pass, not the JSON of every capture with its photos.
 */
function fieldSql(t: FieldTest): [string, unknown[]] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.key)) throw new Error(`not a field name: ${t.key}`);
  const path = `'$.${t.key}'`;
  // true and false are told apart from 1 and 0 by json_type, as === does.
  if ("is" in t) return typeof t.is === "boolean" ? [`json_type(fields, ${path}) = ?`, [String(t.is)]] : [`json_extract(fields, ${path}) = ?`, [t.is]];
  if ("isNot" in t) return typeof t.isNot === "boolean" ? [`json_type(fields, ${path}) IS NOT ?`, [String(t.isNot)]] : [`json_extract(fields, ${path}) IS NOT ?`, [t.isNot]];
  if ("oneOf" in t) return [`json_extract(fields, ${path}) IN (${t.oneOf.map(() => "?").join(", ")})`, [...t.oneOf]];
  if ("from" in t) return [`(json_type(fields, ${path}) = 'text' AND json_extract(fields, ${path}) >= ?)`, [t.from]];
  return [`json_extract(fields, ${path}) IS NOT NULL`, []];
}

/** A kind written into SQL: a plain name, so a partial index on that kind can be used. */
function kindSql(kind: string): string {
  if (!/^[a-z_]+$/.test(kind)) throw new Error(`not a kind: ${kind}`);
  return `'${kind}'`;
}

function passes(v: unknown, t: FieldTest): boolean {
  if ("is" in t) return v === t.is;
  if ("isNot" in t) return v !== t.isNot;
  if ("oneOf" in t) return typeof v === "string" && t.oneOf.includes(v);
  if ("from" in t) return typeof v === "string" && v >= t.from;
  return v !== undefined && v !== null;
}

/** How far ahead of the hub's clock an edit's stamp may be before it counts as the moment the edit arrived. */
export const STAMP_SLACK_MS = 5 * 60_000;

/**
 * An edit's stamp as the hub keeps it: UTC with milliseconds (`toISOString`), so stamps compare as text. One that is
 * not a date and time is refused; one more than STAMP_SLACK_MS ahead of the hub's clock (a device whose clock runs
 * fast) becomes the hub's time, so it cannot beat edits made after it.
 */
export function normalizeStamp(ts: string, now: number = Date.now()): { ts: string; ahead: boolean } {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) throw new StoreError(422, "ts is not a date and time");
  const ahead = t > now + STAMP_SLACK_MS;
  return { ts: new Date(ahead ? now : t).toISOString(), ahead };
}

/** Text the FTS index holds for each kind: a title column and a body column. */
export function ftsText(kind: string, f: Record<string, any>): { title: string; text: string } {
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(s).join(" ") : "");
  switch (kind) {
    case "note": return { title: s(f.title), text: [s(f.body), arr(f.tags)].join("\n") };
    case "task": return { title: s(f.title), text: s(f.notes) };
    case "runbook": return { title: [s(f.host), s(f.title)].join(" "), text: [s(f.body), ...(Array.isArray(f.commands) ? f.commands.map((c: any) => `${s(c.label)} ${s(c.command)}`) : [])].join("\n") };
    case "capture": return { title: s(f.text).split("\n")[0].slice(0, 120), text: s(f.text) };
    case "fact": return { title: s(f.key), text: s(f.value) };
    case "project": return { title: s(f.name), text: [s(f.definition_of_done), s(f.resume_card)].join("\n") };
    case "reminder": return { title: s(f.title), text: "" };
    case "event": return { title: s(f.title), text: s(f.location) };
    case "ledger": return { title: s(f.topic), text: [arr(f.confirmed), arr(f.ruled_out)].join("\n") };
    case "journal": return { title: [s(f.host), s(f.what)].join(" "), text: [s(f.command), s(f.rollback)].join("\n") };
    case "snippet": return { title: s(f.title), text: [s(f.body), arr(f.tags), s(f.host)].join("\n") };
    case "procedure": return { title: s(f.title), text: Array.isArray(f.steps) ? f.steps.map((x: any) => `${s(x.text)} ${s(x.command)}`).join("\n") : "" };
    case "watch": return { title: s(f.title), text: [s(f.category), s(f.notes)].join("\n") };
    case "application": return { title: [s(f.role), s(f.company)].join(" at "), text: [s(f.stage), s(f.notes), s(f.next_step)].join("\n") };
    case "game": return { title: s(f.name), text: [arr(f.genres), s(f.notes)].join("\n") };
    case "person": return { title: [s(f.name), s(f.nickname)].filter(Boolean).join(" "), text: [s(f.organization), s(f.relationship), Array.isArray(f.emails) ? f.emails.map((x: any) => s(x.value)).join(" ") : "", Array.isArray(f.addresses) ? f.addresses.map((x: any) => [x.street, x.city].filter(Boolean).join(" ")).join("\n") : ""].join("\n") };
    case "image": return { title: s(f.title) || s(f.prompt).slice(0, 120), text: [s(f.prompt), s(f.caption)].join("\n") };
    case "film": return { title: [s(f.title), s(f.year)].filter(Boolean).join(" "), text: [s(f.review), arr(f.tags)].join("\n") };
    case "inventory": return { title: s(f.name), text: [s(f.category), s(f.location), arr(f.tags), s(f.notes)].join("\n") };
    case "music_idea": return { title: s(f.title), text: [s(f.type), s(f.key), s(f.body)].join("\n") };
    case "checklist": return { title: s(f.title), text: Array.isArray(f.items) ? f.items.map((x: any) => s(x.text)).join("\n") : "" };
    case "plan_rule": return { title: s(f.title), text: s(f.note) };
    case "rule": return { title: s(f.text).slice(0, 120), text: s(f.text) };
    case "food_option": return { title: s(f.name), text: [arr(f.items), arr(f.tags), s(f.notes)].join("\n") };
    case "pet_event": return { title: [s(f.pet), s(f.type)].join(" "), text: s(f.note) };
    default: return { title: "", text: "" };
  }
}

const WORK_KINDS = new Set(["task", "event"]);

export class Store {
  private hooks: AfterWriteHook[] = [];
  private q: Record<string, any>;

  /** Work entities are stored sealed with this key (see workkey.ts); a row it cannot open reads as absent. */
  constructor(public db: DB, public bus: Bus, public workKey: WorkKey = new WorkKey(null)) {
    this.q = {
      get: db.prepare("SELECT * FROM entities WHERE id = ?"),
      rowid: db.prepare("SELECT rowid FROM entities WHERE id = ?"),
      // OR REPLACE: a create may land on a work row sealed with a key that is gone, which reads as absent.
      insert: db.prepare("INSERT OR REPLACE INTO entities (id, kind, space, created_at, updated_at, deleted_at, fields, field_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
      update: db.prepare("UPDATE entities SET space = ?, updated_at = ?, deleted_at = ?, fields = ?, field_ts = ? WHERE id = ?"),
      change: db.prepare("INSERT INTO changes (entity_id, kind, ts) VALUES (?, ?, ?)"),
      // The highest seq ever issued (AUTOINCREMENT's high-water mark): purging the newest change rows (readings past
      // retention, an erase) must not move it back, or devices at the old seq would be told the hub was restored.
      maxSeq: db.prepare("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0), COALESCE((SELECT MAX(seq) FROM changes), 0)) AS seq"),
      ftsDel: db.prepare("DELETE FROM entities_fts WHERE rowid = ?"),
      ftsIns: db.prepare("INSERT INTO entities_fts (rowid, id, kind, title, text) VALUES (?, ?, ?, ?, ?)"),
    };
  }

  afterWrite(hook: AfterWriteHook): void { this.hooks.push(hook); }

  /** The entity in a row, or null for a work row whose key is gone. */
  private toEntity(r: Row): Entity | null {
    const fields = r.space === "work" ? this.workKey.open(r.id, r.fields) : r.fields;
    if (fields === null) return null;
    return {
      id: r.id, kind: r.kind as Kind, space: r.space as Entity["space"],
      created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
      fields: JSON.parse(fields), field_ts: JSON.parse(r.field_ts),
    };
  }

  /** The fields column as stored: sealed for work entities. */
  private pack(e: Pick<Entity, "id" | "space">, fields: Record<string, unknown>): string {
    const json = JSON.stringify(fields);
    return e.space === "work" ? this.workKey.seal(e.id, json) : json;
  }

  seq(): number { return (this.q.maxSeq.get() as { seq: number }).seq; }

  /** Move the change counter up to `seq` (never down): the next change gets a seq above every one given out before. */
  raiseSeq(seq: number): void {
    if (seq <= this.seq()) return;
    const has = this.db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'changes'").get();
    if (has) this.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'changes'").run(seq);
    else this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('changes', ?)").run(seq);
  }

  get(id: string): Entity | null {
    const r = this.q.get.get(id) as Row | undefined;
    return r ? this.toEntity(r) : null;
  }

  private stmts = new Map<string, Database.Statement<unknown[]>>();
  private stmt(sql: string): Database.Statement<unknown[]> {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare<unknown[]>(sql); this.stmts.set(sql, s); }
    return s;
  }

  /**
   * Simple listing, newest change first, with optional field equality filters (applied in JS). Rows are read one at
   * a time and reading stops at `limit`, so a short list of a big kind does not parse the whole kind.
   */
  list(opts: { kind?: string; space?: string; includeDeleted?: boolean; limit?: number; where?: Record<string, unknown> } = {}): Entity[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (opts.kind) { conds.push("kind = ?"); args.push(opts.kind); }
    if (opts.space) { conds.push("space = ?"); args.push(opts.space); }
    if (!opts.includeDeleted) conds.push("deleted_at IS NULL");
    const sql = `SELECT * FROM entities ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY updated_at DESC`;
    const where = opts.where ? Object.entries(opts.where) : [];
    return this.collect(this.stmt(sql).iterate(...args) as Iterable<Row>, (e) => where.every(([k, v]) => String(e.fields[k]) === String(v)), opts.limit);
  }

  /**
   * The live entities of a kind whose fields pass every test, newest change first. SQLite tests the stored JSON, so a
   * timer that needs a few rows of a big kind (open reminders among every task ever made) parses only those. Work rows
   * are sealed, so SQLite passes them all and they are tested here after opening, as every row is again.
   */
  listWhere(kind: string, tests: FieldTest[], opts: { limit?: number; includeDeleted?: boolean } = {}): Entity[] {
    const { sql, args } = this.whereSql(kind, tests, opts.includeDeleted === true);
    return this.collect(this.stmt(`SELECT * FROM entities WHERE ${sql} ORDER BY updated_at DESC`).iterate(...args) as Iterable<Row>, (e) => tests.every((t) => passes(e.fields[t.key], t)), opts.limit);
  }

  /** The WHERE for listWhere and countWhere. Work rows are sealed: for kinds that can be work they pass SQLite. */
  private whereSql(kind: string, tests: FieldTest[], includeDeleted: boolean): { sql: string; args: unknown[] } {
    const conds: string[] = [];
    const args: unknown[] = [];
    for (const t of tests) {
      const [sql, a] = fieldSql(t);
      conds.push(sql); args.push(...a);
    }
    const test = !conds.length ? "" : WORK_KINDS.has(kind) ? ` AND CASE WHEN space = 'work' THEN 1 ELSE (${conds.join(" AND ")}) END` : ` AND ${conds.join(" AND ")}`;
    return { sql: `kind = ${kindSql(kind)}${includeDeleted ? "" : " AND deleted_at IS NULL"}${test}`, args };
  }

  /** How SQLite answers listWhere (EXPLAIN QUERY PLAN), for tests that the capture indexes are used. */
  planOf(kind: string, tests: FieldTest[]): string[] {
    const { sql, args } = this.whereSql(kind, tests, false);
    return (this.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM entities WHERE ${sql} ORDER BY updated_at DESC`).all(...args) as { detail: string }[]).map((r) => r.detail);
  }

  /** How many live entities of a kind pass every test, counted by SQLite without parsing them (work rows are opened). */
  countWhere(kind: string, tests: FieldTest[]): number {
    if (WORK_KINDS.has(kind)) return this.listWhere(kind, tests).length;
    const { sql, args } = this.whereSql(kind, tests, false);
    return (this.stmt(`SELECT COUNT(*) AS n FROM entities WHERE ${sql}`).get(...args) as { n: number }).n;
  }

  /** When each live entity of a kind was made, without parsing them (a capture can hold a photo). */
  createdTimes(kind: string): string[] {
    if (WORK_KINDS.has(kind)) return this.list({ kind }).map((e) => e.created_at);
    return (this.stmt("SELECT created_at FROM entities WHERE kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC").all(kind) as { created_at: string }[]).map((r) => r.created_at);
  }

  private collect(rows: Iterable<Row>, keep: (e: Entity) => boolean, limit?: number): Entity[] {
    const out: Entity[] = [];
    for (const r of rows) {
      const e = this.toEntity(r);
      if (!e || !keep(e)) continue;
      out.push(e);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** Create an entity with hub-assigned id and timestamp. Validates with the full kind schema. */
  create(kind: Kind, fields: Record<string, unknown>, space: Entity["space"] = "personal", id?: string): Entity {
    const patch: Patch = { id: id ?? randomUUID(), kind, space, ts: nowIso(), fields, create: true };
    return this.apply(patch).entity;
  }

  /** Patch an existing entity with a hub timestamp. Hub-side writes always win over the field's current ts. */
  patch(id: string, fields: Record<string, unknown>, ts?: string): Entity {
    const cur = this.get(id);
    if (!cur) throw new StoreError(404, "entity not found");
    let t = ts ?? nowIso();
    if (!ts) {
      // Two hub writes inside the same millisecond must not drop the second one.
      for (const k of Object.keys(fields)) {
        const prev = cur.field_ts[k];
        if (prev && prev >= t) t = new Date(new Date(prev).getTime() + 1).toISOString();
      }
    }
    return this.apply({ id, kind: cur.kind, ts: t, fields }).entity;
  }

  /**
   * Write fields straight to the row with a hub timestamp: no change row, no bus event, no after-write hooks.
   * For liveness-style bookkeeping (device last_seen) that must not wake every client. Returns null when the id is unknown.
   */
  /**
   * Drop every change row that is not the newest for its entity. Safe for all clients: a change row returns the
   * entity's current state, so a client behind the cursor still receives each entity once, at its newest row.
   */
  compactChanges(): { removed: number; remaining: number } {
    const r = this.db.prepare("DELETE FROM changes WHERE seq NOT IN (SELECT max(seq) FROM changes GROUP BY entity_id)").run();
    const remaining = (this.db.prepare("SELECT count(*) AS n FROM changes").get() as { n: number }).n;
    return { removed: Number(r.changes), remaining };
  }

  patchSilent(id: string, fields: Record<string, unknown>): Entity | null {
    const cur = this.get(id);
    if (!cur) return null;
    const schema = FieldsByKind[cur.kind as keyof typeof FieldsByKind] as z.ZodObject<any>;
    const clears = new Set(Object.keys(fields).filter((k) => fields[k] === null));
    const r = schema.partial().safeParse(Object.fromEntries(Object.entries(fields).filter(([k]) => !clears.has(k))));
    if (!r.success) throw new StoreError(422, "invalid fields", r.error.issues);
    const now = nowIso();
    const merged: Record<string, unknown> = { ...cur.fields };
    const fieldTs: Record<string, string> = { ...cur.field_ts };
    for (const k of Object.keys(fields)) {
      if (!(k in r.data) && !clears.has(k)) continue;
      if (clears.has(k)) delete merged[k]; else merged[k] = r.data[k];
      fieldTs[k] = now;
    }
    const entity: Entity = { ...cur, updated_at: now, fields: merged, field_ts: fieldTs };
    this.q.update.run(entity.space, entity.updated_at, entity.deleted_at, this.pack(entity, merged), JSON.stringify(fieldTs), id);
    this.indexFts(entity);
    return entity;
  }

  /** Per-field last-writer-wins merge. Throws StoreError on rejection. */
  apply(input: Patch): ApplyResult {
    const schema = FieldsByKind[input.kind as keyof typeof FieldsByKind];
    if (!schema) throw new StoreError(422, `unknown kind ${input.kind}`);
    const nowMs = Date.now();
    const stamp = normalizeStamp(input.ts, nowMs);
    // A stored stamp this far ahead came from a fast clock (or is not a date) before stamps were checked: it never
    // blocks a newer write, or the field would stay frozen until the clock caught up.
    const future = new Date(nowMs + STAMP_SLACK_MS).toISOString();
    const run = this.db.transaction((): { res: ApplyResult; prev: Entity | null; noop: boolean } => {
      const prev = this.get(input.id);
      let ts = stamp.ts;
      // Edits from a fast clock that arrive together all become "now": each later one still lands after the one
      // before it, as it would have with its own stamp.
      if (stamp.ahead && prev) {
        for (const k of Object.keys(input.fields)) {
          const p = prev.field_ts[k];
          if (p && p <= future && p >= ts) ts = new Date(Date.parse(p) + 1).toISOString();
        }
      }
      const patch: Patch = { ...input, ts };
      if (prev && prev.kind !== patch.kind) throw new StoreError(409, `kind mismatch: entity is ${prev.kind}`);
      // A move between spaces goes by last writer wins like a field, its stamp kept as `field_ts.space`: an edit queued
      // on a device before the move (older builds name the space they saw in every patch) no longer moves it back.
      const moving = !!prev && !!patch.space && patch.space !== prev.space && (!prev.field_ts.space || prev.field_ts.space > future || patch.ts > prev.field_ts.space);
      const space = prev ? (moving ? patch.space! : prev.space) : (patch.space ?? "personal");
      if (space === "work" && !WORK_KINDS.has(patch.kind)) throw new StoreError(422, "work space holds only task and event entities");

      // deleted_at is an envelope column that moves through the same LWW rule as any field.
      const { deleted_at: deletedIn, ...rawFields } = patch.fields;
      const hasDeleted = Object.prototype.hasOwnProperty.call(patch.fields, "deleted_at");
      // null clears a field (zod optionals do not accept null).
      const clears = new Set(Object.keys(rawFields).filter((k) => rawFields[k] === null));
      const toValidate = Object.fromEntries(Object.entries(rawFields).filter(([k]) => !clears.has(k)));

      let validated: Record<string, unknown>;
      let created = false;
      if (!prev) {
        if (!patch.create) throw new StoreError(404, "entity not found; send create: true to create it");
        const r = (schema as z.ZodObject<any>).safeParse(toValidate);
        if (!r.success) throw new StoreError(422, "invalid fields", r.error.issues);
        validated = r.data;
        created = true;
      } else {
        const r = (schema as z.ZodObject<any>).partial().safeParse(toValidate);
        if (!r.success) throw new StoreError(422, "invalid fields", r.error.issues);
        validated = r.data;
      }

      const fields: Record<string, unknown> = prev ? { ...prev.fields } : {};
      const fieldTs: Record<string, string> = prev ? { ...prev.field_ts } : {};
      const changed: string[] = [];
      const newer = (k: string) => !fieldTs[k] || fieldTs[k] > future || patch.ts > fieldTs[k];

      for (const k of Object.keys(validated)) {
        if (!newer(k)) continue;
        if (prev && !(k in rawFields) && k in fields) continue; // defaults never overwrite existing values
        fields[k] = validated[k];
        fieldTs[k] = patch.ts;
        changed.push(k);
      }
      for (const k of clears) {
        if (!newer(k)) continue;
        delete fields[k];
        fieldTs[k] = patch.ts;
        changed.push(k);
      }
      if (moving) fieldTs.space = patch.ts;
      let deleted_at = prev?.deleted_at ?? null;
      if (hasDeleted && newer("deleted_at")) {
        deleted_at = typeof deletedIn === "string" ? deletedIn : null;
        fieldTs.deleted_at = patch.ts;
        changed.push("deleted_at");
      }
      // A rule's pattern runs on every reply: one that does not compile, is too long or backtracks without end is refused.
      if (patch.kind === "rule" && (changed.includes("pattern") || changed.includes("flags"))) {
        const bad = patternProblem(fields.pattern, fields.flags);
        if (bad) throw new StoreError(422, bad);
      }

      // created_at keeps the client's offline timestamp when it is earlier than the hub clock; updated_at is hub time.
      const now = nowIso();
      const entity: Entity = {
        id: patch.id, kind: patch.kind, space,
        created_at: prev?.created_at ?? (patch.ts < now ? patch.ts : now),
        updated_at: changed.length || created || space !== prev!.space ? now : prev!.updated_at,
        deleted_at, fields, field_ts: fieldTs,
      };
      // A write that changes nothing (a retried push, an import sending the same values) leaves no change row,
      // so it wakes no device.
      // A move between spaces is a change too: it reseals or unseals the row and devices must see the new space.
      if (!created && !changed.length && space === prev!.space) return { res: { entity: prev!, seq: this.seq(), changed, created }, prev, noop: true };
      if (created) {
        this.q.insert.run(entity.id, entity.kind, entity.space, entity.created_at, entity.updated_at, entity.deleted_at, this.pack(entity, fields), JSON.stringify(fieldTs));
      } else {
        this.q.update.run(entity.space, entity.updated_at, entity.deleted_at, this.pack(entity, fields), JSON.stringify(fieldTs), entity.id);
      }
      this.indexFts(entity);
      const info = this.q.change.run(entity.id, entity.kind, patch.ts);
      const seq = Number(info.lastInsertRowid);
      return { res: { entity, seq, changed, created }, prev, noop: false };
    });
    // IMMEDIATE takes the write lock at the start, where busy_timeout waits for another writer (a deploy's seed run,
    // a script). A deferred transaction that reads first and then writes fails at once with "database is locked"
    // when another connection wrote in between: SQLite does not wait there, to avoid a deadlock.
    const { res, prev, noop } = run.immediate();
    if (noop) return res;
    this.bus.emit("change", { seq: res.seq, id: res.entity.id, kind: res.entity.kind });
    for (const h of this.hooks) {
      try { h(res.entity, prev, res.changed); } catch (e) { console.error(`[store] after-write hook failed for ${res.entity.id}: ${errCode(e)}`); }
    }
    return res;
  }

  private indexFts(e: Entity): void {
    const row = this.q.rowid.get(e.id) as { rowid: number } | undefined;
    if (!row) return;
    this.q.ftsDel.run(row.rowid);
    // Work text stays out of the index, which is plain text in every copy of the file; search() scans it instead.
    if (e.deleted_at || e.space === "work") return;
    const t = ftsText(e.kind, e.fields);
    if (!t.title && !t.text) return;
    this.q.ftsIns.run(row.rowid, e.id, e.kind, t.title, t.text);
  }

  /**
   * Hard delete: the rows, their change history and their FTS entries are gone and no tombstone is written.
   * Only for high-volume data nobody syncs by default (sensor readings past retention).
   */
  purge(ids: string[]): number {
    if (!ids.length) return 0;
    const fts = this.db.prepare("DELETE FROM entities_fts WHERE rowid IN (SELECT rowid FROM entities WHERE id = ?)");
    const ch = this.db.prepare("DELETE FROM changes WHERE entity_id = ?");
    const ent = this.db.prepare("DELETE FROM entities WHERE id = ?");
    let n = 0;
    this.db.transaction(() => {
      for (const id of ids) { fts.run(id); ch.run(id); n += ent.run(id).changes; }
    }).immediate();
    return n;
  }

  /** Bump when `ftsText` covers more kinds or fields: the hub rebuilds the index once on its next start. */
  static readonly FTS_VERSION = 6;

  /** Rebuild the index when it was built by an older `ftsText` (recorded in SQLite's user_version). */
  reindexFtsIfOutdated(): boolean {
    const v = Number(this.db.pragma("user_version", { simple: true }));
    if (v >= Store.FTS_VERSION) return false;
    // Versions 4 and 5 stemmed words (porter); 6 is plain again. The table itself is made again with the tokenizer.
    if (v < 6) this.db.exec(`DROP TABLE IF EXISTS entities_fts; ${FTS_TABLE}`);
    this.reindexFts();
    this.db.pragma(`user_version = ${Store.FTS_VERSION}`);
    return true;
  }

  /** Rebuild the FTS index from scratch (used after schema changes or on demand). */
  reindexFts(): void {
    this.db.exec("DELETE FROM entities_fts");
    for (const e of this.list({ includeDeleted: false })) this.indexFts(e);
    this.optimizeFts();
  }

  /** Merge the index into one segment, so terms of deleted rows are dropped from the file and not just marked. */
  optimizeFts(): void {
    this.db.exec("INSERT INTO entities_fts(entities_fts) VALUES('optimize')");
  }

  /**
   * Whether the owner has put anything here: a hub in use, not a new one. Any kind the starter seed does not make
   * counts (a hub used only for Ops incidents, sensor readings, pet events or notes is in use too).
   */
  hasOwnerData(): boolean {
    return !!this.db.prepare("SELECT 1 FROM entities WHERE kind NOT IN ('fact', 'rule', 'plan_rule', 'runbook', 'food_option', 'music_idea', 'snippet', 'monitor', 'checklist', 'device') LIMIT 1").get();
  }

  /**
   * Seal work rows still stored as plain text (written before the work key existed) and drop their search entries.
   * No change row: the entities are the same. Returns how many were sealed.
   */
  sealWorkRows(): number {
    const rows = this.db.prepare("SELECT rowid, id, fields FROM entities WHERE space = 'work' AND fields NOT LIKE 'enc1:%'").all() as { rowid: number; id: string; fields: string }[];
    if (!rows.length) return 0;
    const set = this.db.prepare("UPDATE entities SET fields = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const r of rows) { set.run(this.workKey.seal(r.id, r.fields), r.id); this.q.ftsDel.run(r.rowid); }
    }).immediate();
    this.optimizeFts();
    return rows.length;
  }

  /** Work rows sealed with a key that is gone. */
  unreadableWork(): string[] {
    const rows = this.db.prepare("SELECT id, fields FROM entities WHERE space = 'work'").all() as { id: string; fields: string }[];
    return rows.filter((r) => this.workKey.open(r.id, r.fields) === null).map((r) => r.id);
  }

  /** Destroy the work key and reseal every work row with a new one; rows the old key could not open are purged. */
  rotateWorkKey(): void {
    const rows = this.db.prepare("SELECT id, fields FROM entities WHERE space = 'work'").all() as { id: string; fields: string }[];
    const lost: string[] = [];
    this.workKey.rotate((open, seal) => {
      const set = this.db.prepare("UPDATE entities SET fields = ? WHERE id = ?");
      this.db.transaction(() => {
        for (const r of rows) {
          const plain = open(r.id, r.fields);
          if (plain === null) lost.push(r.id); else set.run(seal(r.id, plain), r.id);
        }
      }).immediate();
    });
    this.purge(lost);
  }

  /** Change feed paged by seq. Returns the current state of each changed entity. */
  changes(since: number, opts: { kinds?: string[]; excludeKinds?: string[]; space?: string; limit?: number } = {}): { changes: { seq: number; entity: Entity }[]; seq: number; more: boolean } {
    const limit = opts.limit ?? 500;
    const conds = ["c.seq > ?"];
    const args: unknown[] = [since];
    if (opts.kinds?.length) { conds.push(`c.kind IN (${opts.kinds.map(() => "?").join(",")})`); args.push(...opts.kinds); }
    else if (opts.excludeKinds?.length) { conds.push(`c.kind NOT IN (${opts.excludeKinds.map(() => "?").join(",")})`); args.push(...opts.excludeKinds); }
    if (opts.space) { conds.push("e.space = ?"); args.push(opts.space); }
    // The rows and the latest seq come from one snapshot: a commit from another process (the deploy's seed) between
    // the two reads would move the cursor past a row this page never returned.
    const read = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT c.seq AS seq, e.* FROM changes c JOIN entities e ON e.id = c.entity_id WHERE ${conds.join(" AND ")} ORDER BY c.seq ASC LIMIT ?`,
      ).all(...args, limit + 1) as (Row & { seq: number })[];
      return { rows, latest: this.seq() };
    });
    const { rows, latest } = read.deferred();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const changes = page.flatMap((r) => { const entity = this.toEntity(r); return entity ? [{ seq: r.seq, entity }] : []; });
    const seq = more ? page[page.length - 1].seq : Math.max(latest, since);
    return { changes, seq, more };
  }

  search(q: string, opts: { kinds?: string[]; limit?: number } = {}): { id: string; kind: string; title: string; snippet: string; score: number }[] {
    const limit = opts.limit ?? 50;
    const query = toFtsQuery(q);
    if (!query) return [];
    const conds = ["entities_fts MATCH ?"];
    const args: unknown[] = [query];
    if (opts.kinds?.length) { conds.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`); args.push(...opts.kinds); }
    const rows = this.db.prepare(
      `SELECT id, kind, title, snippet(entities_fts, 3, '[', ']', ' ... ', 12) AS snippet, bm25(entities_fts, 0, 0, 2.0, 1.0) AS score FROM entities_fts WHERE ${conds.join(" AND ")} ORDER BY score LIMIT ?`,
    ).all(...args, limit) as { id: string; kind: string; title: string; snippet: string; score: number }[];
    const hits = rows.map((r) => ({ ...r, score: Math.round(-r.score * 1000) / 1000 }));
    return [...hits, ...this.searchWork(q, opts.kinds)].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Work items are not in the index; they are few, so they are opened and matched here (each word as a word prefix). */
  private searchWork(q: string, kinds?: string[]): { id: string; kind: string; title: string; snippet: string; score: number }[] {
    const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    const words = q.split(/\s+/).map((w) => fold(w.replace(/["*]/g, "").trim())).filter(Boolean);
    if (!words.length) return [];
    const out: { id: string; kind: string; title: string; snippet: string; score: number }[] = [];
    for (const e of this.list({ space: "work" })) {
      if (kinds?.length && !kinds.includes(e.kind)) continue;
      const t = ftsText(e.kind, e.fields);
      const tokens = fold(`${t.title} ${t.text}`).split(/[^\p{L}\p{N}]+/u);
      if (!words.every((w) => tokens.some((tok) => tok.startsWith(w)))) continue;
      const inTitle = words.every((w) => fold(t.title).split(/[^\p{L}\p{N}]+/u).some((tok) => tok.startsWith(w)));
      out.push({ id: e.id, kind: e.kind, title: t.title, snippet: t.text.replace(/\s+/g, " ").slice(0, 120), score: inTitle ? 2 : 1 });
    }
    return out;
  }
}

/** A word without a plural or tense ending ("groceries" and "grocery" to "grocer", "walked" to "walk"), or null. */
export function wordBase(w: string): string | null {
  const lower = w.toLowerCase();
  for (const [end, keep] of [["ies", 3], ["es", 2], ["ed", 2], ["ing", 3], ["y", 1], ["s", 1]] as const) {
    if (lower.endsWith(end) && lower.length - keep >= 4) return w.slice(0, w.length - keep);
  }
  return null;
}

/**
 * Turn free text into a safe FTS5 query: each word becomes a quoted prefix term, or with a plural or tense ending
 * either the word or its base as a prefix ("grocery" finds Groceries, "walked" finds walk).
 */
export function toFtsQuery(q: string): string {
  const words = q.split(/\s+/).map((w) => w.replace(/["*()]/g, "").trim()).filter(Boolean);
  if (!words.length) return "";
  // An explicit AND: FTS5 does not take implicit AND next to a parenthesized group ("saturday night" failed).
  return words.map((w) => { const b = wordBase(w); return b ? `("${w}"* OR "${b}"*)` : `"${w}"*`; }).join(" AND ");
}
