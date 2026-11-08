import type { Entity, Kind, Patch, Space } from "@everythingapp/shared";
import { engine } from "./engine";
import { celebrate } from "../feel/events";

export function uuid(): string {
  const c = globalThis.crypto as Crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let lastTs = 0;
/**
 * Patch timestamp. Strictly increasing within this process so that two edits to the
 * same field in one millisecond do not collide under the hub's strict `ts > field_ts` rule.
 */
export function now(): string {
  let t = Date.now();
  if (t <= lastTs) t = lastTs + 1;
  lastTs = t;
  return new Date(t).toISOString();
}

export async function createEntity(kind: Kind, fields: Record<string, unknown>, space: Space = "personal", id: string = uuid()): Promise<Entity> {
  const patch: Patch = { id, kind, space, ts: now(), fields, create: true };
  const out = await engine.enqueue(patch);
  celebrate("create");
  return out;
}

export async function updateEntity(e: Pick<Entity, "id" | "kind" | "space">, fields: Record<string, unknown>): Promise<Entity> {
  const patch: Patch = { id: e.id, kind: e.kind, space: e.space, ts: now(), fields };
  const out = await engine.enqueue(patch);
  if (e.kind === "task" && (fields.status === "done" || (fields.done_at && fields.remind_at))) celebrate("complete");
  return out;
}

export async function softDelete(e: Pick<Entity, "id" | "kind" | "space">): Promise<Entity> {
  return updateEntity(e, { deleted_at: now() });
}
