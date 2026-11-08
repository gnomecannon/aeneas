import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import { wipeChats } from "./ai/wipe.js";
import { scheduleDaily } from "./schedule.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * How long chats and host command output are kept (tenet 1: nothing kept longer than the feature needs).
 *
 * `<data>/retention.json`: `{ chat_keep_days, command_output_keep_days }`, each a number of days or 0 for forever.
 * A hub without the file keeps everything, as every hub did before 2026-11-06: nothing is ever deleted unless the
 * person set a number (Settings, Privacy, or the Welcome page of a new hub). Once a night at 03:40:
 * - chats whose last message is older than `chat_keep_days` are deleted the way deleting a chat in the app does it
 *   (ai/wipe.ts: the chat, its call log and command rows, and pictures only it used);
 * - the output of host commands older than `command_output_keep_days` is cleared; the command, its result code and
 *   its journal entry stay.
 */
export interface Retention { chat_keep_days: number; command_output_keep_days: number }

const FOREVER: Retention = { chat_keep_days: 0, command_output_keep_days: 0 };
/** The choices offered; any whole number of days from 1 to 3650 is accepted. */
export const RETENTION_CHOICES = [0, 7, 30, 90, 365];
const DAY_MS = 86_400_000;

const fileOf = (hub: Pick<Hub, "cfg">) => path.join(hub.cfg.dataDir, "retention.json");

export function readRetention(hub: Pick<Hub, "cfg">): Retention {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(hub), "utf8")) as Partial<Retention>;
    return { chat_keep_days: days(v.chat_keep_days) ?? 0, command_output_keep_days: days(v.command_output_keep_days) ?? 0 };
  } catch { return { ...FOREVER }; }
}

function days(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3650 ? v : null;
}

/** PUT /settings/retention: change one or both; 0 keeps forever. */
export function setRetention(hub: Pick<Hub, "cfg">, body: Record<string, unknown>): Retention {
  const cur = readRetention(hub);
  for (const k of ["chat_keep_days", "command_output_keep_days"] as const) {
    if (body[k] === undefined) continue;
    const d = days(body[k]);
    if (d === null) throw new StoreError(422, `${k} must be a whole number of days from 0 (keep forever) to 3650`);
    cur[k] = d;
  }
  const file = fileOf(hub);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cur, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return cur;
}

/** Apply the setting now. Does nothing for a 0 (forever), so a hub that never chose deletes nothing. */
export function applyRetention(hub: Hub, now: Date = new Date()): { chats: number; outputs: number } {
  const r = readRetention(hub);
  let chats = 0;
  let outputs = 0;
  if (r.chat_keep_days > 0) {
    const cutoff = new Date(now.getTime() - r.chat_keep_days * DAY_MS).toISOString();
    const ids = (hub.chatDb.prepare("SELECT session_id FROM sessions WHERE last_at < ?").all(cutoff) as { session_id: string }[]).map((x) => x.session_id);
    if (ids.length) chats = wipeChats(hub.chatDb, hub.store, hub.ai.images, ids).sessions;
  }
  if (r.command_output_keep_days > 0) {
    const cutoff = new Date(now.getTime() - r.command_output_keep_days * DAY_MS).toISOString();
    outputs = hub.chatDb.prepare("UPDATE ai_actions SET output = NULL WHERE output IS NOT NULL AND COALESCE(ran_at, created_at) < ?").run(cutoff).changes;
  }
  if (chats || outputs) console.log(`[retention] deleted ${chats} chat(s), cleared ${outputs} command output(s)`);
  return { chats, outputs };
}

/** Once a night at 03:40 local. */
export function startRetentionJob(hub: Hub): () => void {
  return scheduleDaily("retention", 3, 40, () => { try { applyRetention(hub); } catch (e) { console.error(`[retention] ${errCode(e)}`); } });
}
