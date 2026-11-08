import type { Entity } from "@everythingapp/shared";
import { Store, StoreError } from "./store.js";
import { parseWhen } from "./when.js";
import { inAppUnits } from "./health.js";

export type ConvertKind = "task" | "note" | "reminder" | "log" | "fact";
const CONVERT_KINDS: ConvertKind[] = ["task", "note", "reminder", "log", "fact"];

/** Filesystem-safe file stem: no path separators, reserved characters or control characters; trimmed to `max` characters. */
export function slug(s: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\\/:*?"<>|#\[\]\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).replace(/[\s.]+$/, "");
  return cleaned || "Untitled";
}

/** A vault path under Inbox/ that no live note uses yet: `Inbox/<stem>.md`, then `Inbox/<stem> 2.md` and so on. */
export function uniqueInboxPath(store: Store, stem: string): string {
  return uniqueNotePath(store, "Inbox", stem);
}

/** A vault path in `folder` that no other live note uses yet: `<folder>/<stem>.md`, then `<folder>/<stem> 2.md` and so on. */
export function uniqueNotePath(store: Store, folder: string, stem: string, except?: string): string {
  const taken = new Set(store.list({ kind: "note", limit: 100000 }).filter((n) => n.id !== except).map((n) => String(n.fields.path ?? "").toLowerCase()));
  const dir = folder.replace(/^\/+|\/+$/g, "");
  for (let i = 1; i < 1000; i++) {
    const p = `${dir ? `${dir}/` : ""}${stem}${i > 1 ? ` ${i}` : ""}.md`;
    if (!taken.has(p.toLowerCase())) return p;
  }
  return `${dir ? `${dir}/` : ""}${stem} ${Date.now()}.md`;
}

/** The fallback threshold: text this long, or with a line break, is worth keeping as a note even when nobody could classify it. */
export function qualifiesForInboxNote(text: string): boolean {
  const t = text.trim();
  return t.length >= 80 || /\n/.test(t);
}

/** Note fields for an unclassified capture: title from the first line, path under Inbox/, body the full text. */
export function inboxNoteFields(store: Store, text: string): { title: string; body: string; path: string } {
  const firstLine = text.trim().split("\n")[0].trim();
  return { title: firstLine.slice(0, 80) || "Untitled", body: text, path: uniqueInboxPath(store, slug(firstLine, 60)) };
}

/** Fill the fields a kind requires when the classifier left them out. */
/**
 * `madeAt` is when the capture was made: a weight said at 21:50 and filed after midnight is that evening's, and "in 20
 * minutes" counts from when it was said, not from when the filer got to it.
 */
export function completeFields(kind: ConvertKind, text: string, fields: Record<string, unknown>, source?: string, store?: Store, madeAt: Date = new Date()): Record<string, unknown> {
  const f = { ...fields };
  const firstLine = text.split("\n")[0].trim();
  switch (kind) {
    case "task":
      f.title ??= firstLine;
      f.status ??= "inbox";
      f.order ??= Date.now();
      return f;
    case "note":
      f.title ??= firstLine.slice(0, 80);
      f.body ??= text;
      f.path ??= store ? uniqueInboxPath(store, slug(String(f.title))) : `Inbox/${slug(String(f.title))}.md`;
      return f;
    case "reminder": {
      // "Remind me ..." becomes a task with a reminder time (reminders are tasks since 2026-10-28).
      const rawTitle = String(f.title ?? firstLine);
      const at = typeof f.remind_at === "string" ? f.remind_at : typeof f.at === "string" ? f.at : null;
      delete f.at;
      if (!at) {
        const w = parseWhen(rawTitle, madeAt);
        f.title = w.rest || rawTitle;
        f.remind_at = w.at ?? new Date(Math.max(Date.now(), madeAt.getTime() + 60 * 60 * 1000)).toISOString();
      } else {
        f.title = rawTitle;
        f.remind_at = at;
      }
      f.friction ??= "none";
      f.status ??= "scheduled";
      f.order ??= Date.now();
      return f;
    }
    case "log":
      f.type ??= "custom";
      f.value ??= text;
      f.at ??= madeAt.toISOString();
      if (source) f.source ??= source;
      return inAppUnits(f);
    case "fact":
      f.category ??= "preference";
      f.key ??= text.toLowerCase().slice(0, 40).replace(/\W+/g, "_");
      f.value ??= text;
      f.source ??= "capture";
      return f;
  }
}

/** Create the target entity and mark the capture processed. `sortedBy` records whether the hub or the user made the call. */
/** Where a filed item lives, as Unsorted Info says it ("Calendar: Dinner at Luigi's with Jamie"). */
export const KIND_LABEL: Record<string, string> = {
  event: "Calendar", fact: "Memory", task: "Tasks", log: "Logs", food_option: "Food", note: "Notes", watch: "Renewals",
  pet_event: "Pet", journal: "Change journal", game: "Games", film: "Films", project: "Projects", inventory: "Inventory",
  person: "Contacts",
};
/** What a filed item is, in a few words: logs and pet events have no title ("weight 116.4 lb", "walk 40 minutes"). */
export function filedTitle(e: Entity): string {
  const f = e.fields;
  const words = (...xs: unknown[]) => xs.filter((x) => x != null && x !== "").map(String).join(" ");
  const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t);
  if (e.kind === "log") return clip(words(f.type === "custom" ? f.name : f.type, f.type === "custom" ? "" : f.name, f.value, f.unit, f.note));
  if (e.kind === "pet_event") return clip(words(f.type, f.note));
  if (e.kind === "fact") return clip(`${f.person ? `${String(f.person)}: ` : ""}${String(f.value ?? f.key ?? "")}`);
  return clip(String(f.title ?? f.name ?? f.key ?? f.type ?? ""));
}
export const filedLabel = (e: Entity) => `${KIND_LABEL[e.kind] ?? e.kind}: ${filedTitle(e)}`;

export function convertCapture(store: Store, capture: Entity, kind: string, fields: Record<string, unknown> = {}, sortedBy: "auto" | "manual" = "manual", space: "personal" | "work" = "personal"): Entity {
  if (!CONVERT_KINDS.includes(kind as ConvertKind)) throw new StoreError(422, `cannot convert a capture into ${kind}`);
  const text = String(capture.fields.text ?? "");
  const full = completeFields(kind as ConvertKind, text, fields, typeof capture.fields.source === "string" ? capture.fields.source : undefined, store, new Date(capture.created_at));
  const created = store.create(kind === "reminder" ? "task" : (kind as ConvertKind), full, space);
  const prior = Array.isArray(capture.fields.converted_to) ? capture.fields.converted_to : [];
  store.patch(capture.id, { processed: true, converted_to: [...prior, created.id], suggested_kind: kind, sorted_by: sortedBy, ...(space === "personal" ? { filed: filedLabel(created) } : {}) });
  return created;
}
