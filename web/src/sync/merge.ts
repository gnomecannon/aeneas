import type { Entity, Patch } from "@everythingapp/shared";
import type { OutboxItem } from "./db";

/** Apply a patch to a local entity using per-field last-writer-wins. */
export function applyPatchLocal(local: Entity | undefined, patch: Patch): Entity {
  const base: Entity = local ?? {
    id: patch.id,
    kind: patch.kind,
    space: patch.space ?? "personal",
    created_at: patch.ts,
    updated_at: patch.ts,
    deleted_at: null,
    fields: {},
    field_ts: {},
  };
  const fields = { ...base.fields };
  const field_ts = { ...base.field_ts };
  let touched = false;
  for (const [k, v] of Object.entries(patch.fields)) {
    const prev = field_ts[k];
    if (!prev || patch.ts > prev) {
      fields[k] = v;
      field_ts[k] = patch.ts;
      touched = true;
    }
  }
  const deleted_at = typeof fields.deleted_at === "string" ? (fields.deleted_at as string) : fields.deleted_at === null ? null : base.deleted_at;
  return {
    ...base,
    space: patch.space ?? base.space,
    fields,
    field_ts,
    deleted_at,
    updated_at: touched && patch.ts > base.updated_at ? patch.ts : base.updated_at,
  };
}

/**
 * Merge an incoming hub entity over local pending patches.
 * The hub is authoritative, but pending patches with a newer ts than the hub's
 * field_ts must stay visible until the hub echoes them back.
 */
export function mergeIncoming(incoming: Entity, pending: Patch[]): Entity {
  let out: Entity = {
    ...incoming,
    deleted_at: incoming.deleted_at ?? null,
    field_ts: incoming.field_ts ?? {},
  };
  const ordered = [...pending].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const p of ordered) {
    if (p.id !== incoming.id) continue;
    out = applyPatchLocal(out, p);
  }
  return out;
}

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

/** Group outbox items into push batches, preserving enqueue order. */
/** Pushes of at most `batchSize` patches and about `maxBytes` of JSON (the hub refuses bodies over 2 MB). */
export function planFlush(items: OutboxItem[], batchSize = 500, maxBytes = 1_500_000): OutboxItem[][] {
  const sorted = [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const batches: OutboxItem[][] = [];
  let cur: OutboxItem[] = [];
  let bytes = 0;
  for (const it of sorted) {
    // Bytes, as the hub counts its 2 MB: Japanese or emoji text is two to four bytes a character.
    const n = utf8Length(JSON.stringify(it.patch));
    if (cur.length && (cur.length >= batchSize || bytes + n > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Entities touched by rejected patches must be refetched from the hub. */
export function rejectedIds(rejected: Array<{ id: string; reason: string }>): string[] {
  return [...new Set(rejected.map((r) => r.id))];
}
