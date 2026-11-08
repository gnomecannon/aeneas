/**
 * Module 2 actions. Hand edits to a ledger or a journal outcome go through PATCH /entities/:id
 * when the hub answers (the contract's route for them) and through the normal entity path otherwise,
 * so they still land in the outbox offline.
 */
import type { Entity } from "@everythingapp/shared";
import { engine } from "./engine";
import { HubError } from "./api";
import { updateEntity } from "./edits";

const isNetworkError = (e: unknown) => !(e instanceof HubError);

export async function patchEntity(e: Entity, fields: Record<string, unknown>): Promise<Entity> {
  if (engine.client) {
    try {
      const out = await engine.client.patchEntity(e.id, fields);
      await engine.absorb([out]);
      return out;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
    }
  }
  return updateEntity(e, fields);
}

/** Pull the entities a hub action created so they show before the next sync cycle. */
export async function refetchAll(ids: Array<string | undefined>): Promise<void> {
  for (const id of ids) if (id) await engine.refetch(id).catch(() => undefined);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
