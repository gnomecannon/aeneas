import type { Entity, Source } from "@everythingapp/shared";
import { classifyCapture } from "@everythingapp/shared";
import { engine } from "./engine";
import { createEntity, updateEntity, now, uuid } from "./edits";
import { HubError } from "./api";
import { completeTaskPatch } from "@everythingapp/shared";
import { isWindowsApp } from "../tauri/bridge";
import { celebrate } from "../feel/events";

export const SOURCE: Source = isWindowsApp ? "windows" : "web";

function isNetworkError(e: unknown): boolean {
  return !(e instanceof HubError);
}

export interface CaptureResult {
  capture: Entity;
  created: Entity[];
  suggested_kind?: string;
  offline: boolean;
}

/** Fields for a converted entity derived from a capture text, matching the hub defaults. */
export function conversionFields(kind: string, text: string): Record<string, unknown> {
  const t = text.trim();
  const first = t.split("\n")[0].slice(0, 120);
  switch (kind) {
    case "task":
      return { title: first, notes: t.includes("\n") ? t : undefined, status: "inbox", order: Date.now() };
    case "note":
      return { title: first.slice(0, 80), body: t, tags: [], path: `Inbox/${first.slice(0, 60).replace(/[\\/:*?"<>|]/g, "-")}.md` };
    case "reminder":
      // A reminder is a task with a reminder time.
      return { title: first, status: "scheduled", order: Date.now(), remind_at: new Date(Date.now() + 3600_000).toISOString(), friction: "none" };
    case "log":
      return { type: "custom", value: t, at: now(), source: SOURCE };
    case "fact":
      return { category: "preference", key: t.toLowerCase().slice(0, 40).replace(/\W+/g, "_"), value: t, source: "user" };
    default:
      return {};
  }
}

function stripUndefined(f: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/**
 * Save and sort a capture. Out of reach of the hub it is kept here with `sort: true`, and the hub sorts it (diary, then
 * the assistant files it) once it syncs, so nothing saved offline waits in Unsorted Info.
 */
export async function capture(text: string, source: Source = SOURCE): Promise<CaptureResult> {
  // One id for the capture whichever way it goes: a reply lost after the hub saved it left a second copy here, which
  // the hub then filed a second time.
  const id = uuid();
  if (engine.client) {
    try {
      const res = await engine.client.capture(text, source, true, id);
      const all = [res.capture, ...(res.created ?? [])];
      await engine.absorb(all);
      return { capture: res.capture, created: res.created ?? [], suggested_kind: res.suggested_kind, offline: false };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  const cls = classifyCapture(text);
  const cap = await createEntity("capture", { text, source, processed: false, sort: true, suggested_kind: cls.kind }, "personal", id);
  return { capture: cap, created: [], suggested_kind: cls.kind, offline: true };
}

export async function convertCapture(cap: Entity, kind: "task" | "note" | "reminder" | "log" | "fact"): Promise<Entity> {
  const text = String(cap.fields.text ?? "");
  if (engine.client) {
    try {
      const ent = await engine.client.convert(cap.id, kind);
      await engine.absorb([ent]);
      await engine.refetch(cap.id);
      return ent;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  const ent = await createEntity(kind === "reminder" ? "task" : kind, stripUndefined(conversionFields(kind, text)));
  await updateEntity(cap, { processed: true, converted_to: [...((cap.fields.converted_to as string[]) ?? []), ent.id] });
  return ent;
}

export async function discardCapture(cap: Entity): Promise<void> {
  await updateEntity(cap, { processed: true });
}

export async function snoozeReminder(r: Entity, until: string, reason?: string): Promise<void> {
  const f = r.fields as { friction: string; snooze_log?: Array<{ at: string; until: string; reason: string }> };
  if (engine.client) {
    try {
      await engine.client.snooze(r.id, until, reason);
      await engine.refetch(r.id);
      return;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  if (f.friction !== "none" && !reason?.trim()) throw new HubError(422, "reason required to snooze this reminder");
  await updateEntity(r, {
    snoozed_until: until,
    snooze_log: [...(f.snooze_log ?? []), { at: now(), until, reason: reason ?? "" }],
  });
}

export async function ackReminder(r: Entity): Promise<void> {
  if (engine.client) {
    try {
      await engine.client.ack(r.id);
      celebrate("complete");
      await engine.refetch(r.id);
      return;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  await updateEntity(r, completeTaskPatch(r.fields));
  celebrate("complete");
}
