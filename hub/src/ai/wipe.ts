import { nowIso } from "@everythingapp/shared";
import type { DB } from "../db.js";
import type { Store } from "../store.js";
import type { ImageStore } from "./images.js";
import type { StoredMessage } from "./sessions.js";

/**
 * Deleting chats so nothing is left to find.
 *
 * - The session rows, their AI call log and host command output are deleted from chats.sqlite (secure_delete
 *   zeroes the pages; VACUUM and a WAL truncate leave no old copy in the file or its journal).
 * - Images only those chats used are deleted from disk, except those the gallery keeps (generated, saved, uploaded).
 * - What the chats produced on synced entities (troubleshooting ledgers, procedures made from replies, and for a
 *   full wipe the recall quizzes) is blanked and tombstoned, so every device drops it, and their older change rows
 *   are compacted away.
 * - chats.sqlite is never in the nightly backups, so no copy survives elsewhere.
 * Facts the assistant saved, runbook notes and journal entries are the owner's records and stay.
 */

export interface WipeResult { sessions: number; images: number; actions: number; calls: number; entities: number }

function imagesOf(db: DB, ids: string[] | null): Set<string> {
  const rows = (ids === null
    ? db.prepare("SELECT messages FROM sessions").all()
    : ids.map((id) => db.prepare("SELECT messages FROM sessions WHERE session_id = ?").get(id)).filter(Boolean)) as { messages: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try { for (const m of JSON.parse(r.messages) as StoredMessage[]) for (const i of m.images ?? []) out.add(i); } catch { /* unreadable row */ }
  }
  return out;
}

/** Blank an entity's fields and tombstone it, so every device drops the content. */
function blank(store: Store, id: string, empty: Record<string, unknown>): boolean {
  const e = store.get(id);
  if (!e || e.deleted_at) return false;
  store.patch(id, { ...empty, deleted_at: nowIso() });
  return true;
}

const EMPTY_LEDGER = { topic: "-", tried: [], ruled_out: [], confirmed: [], open: false };
const EMPTY_PROCEDURE = { title: "-", steps: [{ text: "-" }], current: 0 };
const EMPTY_IMAGE = { title: "-", session_id: "-", width: 0, height: 0, bytes: 0 };
const EMPTY_QUIZ = { items: [{ q: "-", a: "-", hint: "", topic: "" }], source_sessions: [] };

/** Wipe the given chats, or every chat when `sessionIds` is null. */
export function wipeChats(chatDb: DB, store: Store, images: ImageStore, sessionIds: string[] | null): WipeResult {
  const all = sessionIds === null;
  const ids = all ? (chatDb.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]).map((r) => r.session_id) : sessionIds;
  const keep = all ? new Set<string>() : imagesOf(chatDb, (chatDb.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]).map((r) => r.session_id).filter((s) => !ids.includes(s)));
  // A picture in the gallery keeps its bytes (a generated one the chat showed, one saved or uploaded there), unless
  // its record goes with these chats (one attached in them, blanked below). Only other chats used to be checked, so
  // deleting a chat left gallery records whose picture was gone.
  const idSet = new Set(ids);
  const goes = (im: { fields: Record<string, unknown> }) => im.fields.source === "attached" && (all || idSet.has(String(im.fields.session_id)));
  for (const im of store.list({ kind: "image", limit: 100000 })) if (!goes(im)) keep.add(String(im.fields.image_id));
  const drop = [...imagesOf(chatDb, ids)].filter((i) => !keep.has(i));

  const res: WipeResult = { sessions: 0, images: 0, actions: 0, calls: 0, entities: 0 };
  chatDb.transaction(() => {
    if (all) {
      res.sessions = chatDb.prepare("DELETE FROM sessions").run().changes;
      res.actions = chatDb.prepare("DELETE FROM ai_actions").run().changes;
      res.calls = chatDb.prepare("DELETE FROM ai_calls").run().changes;
    } else {
      for (const id of ids) {
        // Internal calls for a chat use "<id>:<purpose>" ids (summaries, drafts).
        res.sessions += chatDb.prepare("DELETE FROM sessions WHERE session_id = ? OR session_id LIKE ?").run(id, `${id}:%`).changes;
        res.actions += chatDb.prepare("DELETE FROM ai_actions WHERE session_id = ?").run(id).changes;
        res.calls += chatDb.prepare("DELETE FROM ai_calls WHERE session_id = ? OR session_id LIKE ?").run(id, `${id}:%`).changes;
      }
    }
  })();
  for (const i of drop) if (images.remove(i)) res.images++;

  for (const l of store.list({ kind: "ledger", limit: 100000 })) if ((all || idSet.has(String(l.fields.session_id))) && blank(store, l.id, EMPTY_LEDGER)) res.entities++;
  for (const p of store.list({ kind: "procedure", limit: 100000 })) if (p.fields.source_session && (all || idSet.has(String(p.fields.source_session))) && blank(store, p.id, EMPTY_PROCEDURE)) res.entities++;
  if (all) for (const q of store.list({ kind: "quiz", limit: 100000 })) if (blank(store, q.id, EMPTY_QUIZ)) res.entities++;
  // Pictures attached in these chats also leave the gallery: deleting a chat erases its images everywhere.
  for (const im of store.list({ kind: "image", limit: 100000 })) if (goes(im) && blank(store, im.id, EMPTY_IMAGE)) res.entities++;

  if (res.entities) {
    store.compactChanges();
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    store.db.exec("VACUUM");
  }
  chatDb.pragma("wal_checkpoint(TRUNCATE)");
  chatDb.exec("VACUUM");
  return res;
}
