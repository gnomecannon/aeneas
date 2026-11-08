import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

/**
 * Search index. Plain words, so a typed prefix finds the word ("universit" finds University); plurals and tenses are
 * matched by the query (toFtsQuery). Porter stemming broke prefixes and was taken out. Changing the tokenizer needs a
 * new Store.FTS_VERSION, which recreates the table on the next start.
 */
export const FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  title,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  space TEXT NOT NULL DEFAULT 'personal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  fields TEXT NOT NULL,
  field_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind, space);
CREATE INDEX IF NOT EXISTS entities_updated ON entities(updated_at);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity_id);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  push_token TEXT,
  registered_at TEXT NOT NULL,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS vault_files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime TEXT NOT NULL,
  size INTEGER NOT NULL,
  entity_id TEXT
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS checks_monitor_at ON checks(monitor_id, at);
CREATE INDEX IF NOT EXISTS checks_at ON checks(at);

-- Mail the Gmail link listed for the filer: the message id, when it arrived and what was filed. Never the mail itself.
CREATE TABLE IF NOT EXISTS mail (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  UNIQUE (account, id)
);
CREATE INDEX IF NOT EXISTS mail_state ON mail(state, n);
-- What a mail is about (a subscription, a pet's due vaccine) and the newest mail applied to it, so older mail never wins.
CREATE TABLE IF NOT EXISTS mail_keys (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  entity_id TEXT
);
-- The note linker: the text it last read for each note (a hash of title, folder and text), so a note is read again
-- only when it changes, and the tries on a version it could not read.
CREATE TABLE IF NOT EXISTS note_analysis (
  id TEXT PRIMARY KEY,
  hash TEXT,
  at TEXT,
  tried_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

${FTS_TABLE}
`;

/** Open (and create) the hub database with WAL and the full schema. */
export function openDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 15000");
  // Deleted rows are overwritten with zeros, so a wiped chat or entity cannot be recovered from free pages.
  db.pragma("secure_delete = ON");
  db.exec(SCHEMA);
  return db;
}

/**
 * Chats, the AI call log and host command output live in their own file (chats.sqlite), never in the nightly
 * backups, so wiping them is complete: no copy survives on the hub machine or in its backups.
 */
const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  messages TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  summary_upto INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_last_at ON sessions(last_at);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session_id TEXT,
  task_type TEXT,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE TABLE IF NOT EXISTS ai_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  host TEXT NOT NULL,
  command TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  rollback TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ran_at TEXT,
  exit_code INTEGER,
  output TEXT,
  journal_id TEXT
);
CREATE INDEX IF NOT EXISTS ai_actions_session ON ai_actions(session_id, created_at);
`;

export function openChatDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 15000");
  db.pragma("secure_delete = ON");
  db.exec(CHAT_SCHEMA);
  return db;
}

const CHAT_TABLES = ["sessions", "ai_calls", "ai_actions"] as const;

/**
 * Move chat tables an older hub kept in the main database into the chat database, then drop them from the main
 * one and VACUUM it so their pages are gone. Runs once; later starts find nothing to move.
 */
export function moveChatTables(main: DB, chats: DB): { moved: Record<string, number> } {
  const moved: Record<string, number> = {};
  const has = (t: string) => !!main.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!CHAT_TABLES.some(has)) return { moved };
  for (const t of CHAT_TABLES) {
    if (!has(t)) continue;
    const rows = main.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    const target = new Set((chats.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    chats.transaction(() => {
      for (const r of rows) {
        const cols = Object.keys(r).filter((c) => target.has(c) && !(t === "ai_calls" && c === "id"));
        chats.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c] as never));
      }
    })();
    moved[t] = rows.length;
    main.exec(`DROP TABLE ${t}`);
  }
  main.pragma("wal_checkpoint(TRUNCATE)");
  main.exec("VACUUM");
  return { moved };
}
