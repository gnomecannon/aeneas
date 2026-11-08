import { nowIso } from "@everythingapp/shared";
import type { DB } from "../db.js";
import type { AiMessage } from "./backends.js";

/**
 * Chat sessions kept on the hub, so a conversation started on the phone continues on the Mac or Windows.
 * Messages hold only what a person sees: user and assistant turns, image references and the actions taken.
 * Tool calls and their raw results stay out; the actions list says what ran.
 * `summary` covers messages [0, summary_upto) once a chat outgrows the model's context window.
 */

/** An item a tool wrote, kept so a later turn can name it by id instead of guessing. */
export interface TouchedItem { id: string; kind: string; title?: string; deleted?: boolean }
export interface SessionAction { tool: string; ok: boolean; writes: boolean; items?: TouchedItem[] }
export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  at?: string;
  /** Image ids (see images.ts). */
  images?: string[];
  actions?: SessionAction[];
  /** Set on a user turn that approved a host command, and on an assistant turn that proposed one. */
  approval?: { action_id: string; host: string; command: string; status?: string; exit_code?: number | null };
}

export interface Session {
  session_id: string;
  task_type: string;
  title: string;
  created_at: string;
  last_at: string;
  messages: StoredMessage[];
  summary: string | null;
  summary_upto: number;
}

export interface SessionListItem { session_id: string; title: string; task_type: string; created_at: string; last_at: string; message_count: number; preview: string }

interface Row { session_id: string; task_type: string; title: string | null; created_at: string; last_at: string; messages: string; summary: string | null; summary_upto: number; deleted_at: string | null }

/** A title from the first user line: plain text, at most 60 characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

function parse(raw: string): StoredMessage[] {
  try {
    const v = JSON.parse(raw) as AiMessage[] | StoredMessage[];
    return (Array.isArray(v) ? v : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => m as StoredMessage);
  } catch { return []; }
}

/** The capture inside a filing prompt that older hubs stored as the chat's first turn, or null. */
export function captureInPrompt(text: string): string | null {
  const m = /^\[Capture to file\][^"]*"([\s\S]*?)"\s+(?:Their day then was|It is already saved)/.exec(text);
  return m ? m[1] : null;
}

export class Sessions {
  constructor(private db: DB) {}

  /**
   * Capture filing chats from before 2026-11-02 hold the whole filing prompt as the owner's turn. Keep the capture in its
   * place and title the chat as a capture. Returns how many changed.
   */
  tidyCaptureThreads(): number {
    const rows = this.db.prepare("SELECT session_id, title, messages FROM sessions WHERE session_id LIKE 'capture-%'").all() as { session_id: string; title: string | null; messages: string }[];
    let n = 0;
    for (const r of rows) {
      const messages = parse(r.messages);
      const first = messages.find((m) => m.role === "user");
      const text = first ? captureInPrompt(first.content) : null;
      if (!first || text === null) continue;
      first.content = text;
      const title = !r.title || r.title.startsWith("[Capture to file]") ? `Capture: ${titleFrom(text)}` : r.title;
      this.db.prepare("UPDATE sessions SET messages = ?, title = ? WHERE session_id = ?").run(JSON.stringify(messages), title, r.session_id);
      n++;
    }
    return n;
  }

  get(id: string, opts: { includeDeleted?: boolean } = {}): Session | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(id) as Row | undefined;
    if (!r || (r.deleted_at && !opts.includeDeleted)) return null;
    const messages = parse(r.messages);
    return {
      session_id: r.session_id, task_type: r.task_type, created_at: r.created_at, last_at: r.last_at, messages,
      title: r.title || titleFrom(messages.find((m) => m.role === "user")?.content ?? ""),
      summary: r.summary, summary_upto: Math.min(r.summary_upto ?? 0, messages.length),
    };
  }

  /** Newest first. Internal sessions (resume cards, quiz builds) carry a ':' suffix and are left out. */
  list(limit = 100): SessionListItem[] {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE deleted_at IS NULL AND session_id NOT LIKE '%:%' ORDER BY last_at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 500)) as Row[];
    return rows.map((r) => {
      const messages = parse(r.messages);
      const last = [...messages].reverse().find((m) => m.content.trim());
      return {
        session_id: r.session_id, task_type: r.task_type, created_at: r.created_at, last_at: r.last_at,
        title: r.title || titleFrom(messages.find((m) => m.role === "user")?.content ?? ""),
        message_count: messages.length,
        preview: (last?.content ?? "").replace(/\s+/g, " ").slice(0, 140),
      };
    });
  }

  /**
   * Replace the stored messages. Creates the session on first save. A deleted session comes back if written again
   * (a new message in it), except by a reply that was being worked on when it was deleted: `startedAt` is when that
   * turn began, and a delete after it stands (the chat came back whole, earlier turns and all).
   */
  save(id: string, taskType: string, messages: StoredMessage[], opts: { startedAt?: string } = {}): void {
    const now = nowIso();
    const title = titleFrom(messages.find((m) => m.role === "user")?.content ?? "");
    // Erased while the reply was worked on (the row is gone): the reply does not make it again.
    if (opts.startedAt && !this.db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(id)) return;
    this.db.prepare(
      `INSERT INTO sessions (session_id, task_type, created_at, last_at, messages, title) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET task_type = excluded.task_type, last_at = excluded.last_at, messages = excluded.messages,
         title = COALESCE(sessions.title, excluded.title), deleted_at = NULL
       WHERE sessions.deleted_at IS NULL OR sessions.deleted_at < ?`,
    ).run(id, taskType, now, now, JSON.stringify(messages), title, opts.startedAt ?? "9999-12-31T00:00:00.000Z");
  }

  setSummary(id: string, summary: string, upto: number): void {
    this.db.prepare("UPDATE sessions SET summary = ?, summary_upto = ? WHERE session_id = ?").run(summary, upto, id);
  }

  rename(id: string, title: string): boolean {
    return this.db.prepare("UPDATE sessions SET title = ? WHERE session_id = ? AND deleted_at IS NULL").run(title.trim().slice(0, 120) || null, id).changes > 0;
  }

  /** Soft delete: the row stays for the quiz and the ledger history, hidden from every list. */
  remove(id: string): boolean {
    return this.db.prepare("UPDATE sessions SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL").run(nowIso(), id).changes > 0;
  }
}
