import Dexie, { type Table } from "dexie";
import type { Entity, Patch } from "@everythingapp/shared";

export interface OutboxItem {
  seq?: number;
  patch: Patch;
  attempts: number;
  enqueued_at: string;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  model?: string;
  backend?: string;
  redactions?: number;
  rules_applied?: string[];
  actions?: { tool: string; ok: boolean; writes: boolean }[];
  /** Set when the hub turned the reply into a procedure (numbered steps); the Assistant offers to run it. */
  procedure_id?: string;
  /** Image ids stored on the hub (GET /ai/images/:id). */
  images?: string[];
  /** A host command proposed (assistant turn) or approved (user turn). */
  approval?: { action_id: string; host: string; command: string; status?: string; exit_code?: number | null };
  /** A mail the assistant wrote for the owner to send (since 2026-11-24): its card goes under this reply. */
  mail_proposal?: { id: string; state?: "sent" | "cancelled" | "edited" };
  at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  /** "auto" lets the hub decide per message; older sessions kept their fixed type. */
  task_type: "auto" | "general" | "troubleshoot" | "draft" | "plan";
  allow_cloud: boolean;
  messages: ChatMsg[];
  created_at: string;
  updated_at: string;
  /**
   * The hub has had this chat: its list named it, or the whole chat came from it. False for a chat started here until
   * then; missing on chats kept from before this was recorded.
   */
  on_hub?: boolean;
}

export class EADatabase extends Dexie {
  entities!: Table<Entity, string>;
  outbox!: Table<OutboxItem, number>;
  meta!: Table<MetaRow, string>;
  sessions!: Table<ChatSession, string>;

  constructor(name = "everythingapp") {
    super(name);
    this.version(1).stores({
      entities: "id, kind, space, updated_at, [kind+space]",
      outbox: "++seq, patch.id",
      meta: "key",
      sessions: "id, updated_at",
    });
  }
}

export const db = new EADatabase();

export const META = {
  hubUrl: "hub_url",
  token: "token",
  deviceId: "device_id",
  deviceName: "device_name",
  seq: "seq",
  theme: "theme",
  pinned: "pinned",
  autostart: "autostart",
  setupFile: "setup_file",
  /** Edits the hub refused, newest last (RejectedEdit[]). Shown in Settings until cleared. */
  rejected: "sync_rejected",
  /** Why this device is not paired any more (it was removed on the hub), shown on the setup screen until it pairs again. */
  unpaired: "unpaired_reason",
  /** The hub's own id (`hid` in pairing links, `hub_id` from GET /link/routes): how this device tells its hub from another. */
  hubId: "hub_id",
  /** The Windows and Android apps: the hub's last answer to GET /link/routes (the ways to it), raced on the next start. */
  routes: "hub_routes",
  /** When the hub last answered a whole sync (ms): an offline device says how long ago once that is over an hour. */
  syncedAt: "synced_at",
} as const;

export interface RejectedEdit { id: string; kind: string; title: string; reason: string; at: string; fields: Record<string, unknown> }

export async function getMeta<T = unknown>(key: string, d?: EADatabase): Promise<T | undefined> {
  const row = await (d ?? db).meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown, d?: EADatabase): Promise<void> {
  await (d ?? db).meta.put({ key, value });
}
