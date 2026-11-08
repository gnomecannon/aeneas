import type { Entity } from "@everythingapp/shared";
import { engine } from "./engine";
import { HubError, type HubClient } from "./api";
import { createEntity, now, updateEntity } from "./edits";
import { instantiateFields, toggleItem, type ChecklistF } from "../lib/admin";

/**
 * Calls the hub and absorbs the entity it returns. Returns undefined when there is no hub, it is unreachable, or it answers 404
 * (a hub without the route), so the caller can take the offline path. Any other hub answer is an error for the caller.
 */
export async function viaHub<T>(call: (c: HubClient) => Promise<T>): Promise<T | undefined> {
  const c = engine.client;
  if (!c) return undefined;
  try {
    return await call(c);
  } catch (e) {
    if (e instanceof HubError && e.status !== 404) throw e;
    return undefined;
  }
}

/** POST /checklists/:id/toggle, else the same flip written through the entity path. */
export async function toggleChecklist(e: Entity, index: number): Promise<void> {
  const out = await viaHub((c) => c.checklistToggle(e.id, index));
  if (out) return engine.absorb([out]);
  await updateEntity(e, { items: toggleItem((e.fields as ChecklistF).items ?? [], index, now()) });
}

/** POST /checklists/:id/instantiate, else the same copy created locally. Returns the copy. */
export async function instantiateChecklist(template: Entity, title?: string): Promise<Entity> {
  const out = await viaHub((c) => c.checklistInstantiate(template.id, title));
  if (out) {
    await engine.absorb([out]);
    return out;
  }
  return createEntity("checklist", instantiateFields(template, title));
}
