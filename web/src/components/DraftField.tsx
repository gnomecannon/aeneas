import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { Entity } from "@everythingapp/shared";
import { useDraftSave } from "../lib/useDraftSave";

/**
 * One text field of an item in a list (a task's title, a fact's value), typed into freely and saved once typing pauses
 * (useDraftSave), instead of a write to the hub for every keystroke.
 */
function useField(item: Entity, field: string) {
  const { draft, edit } = useDraftSave(item, { toDraft: (f) => ({ [field]: String(f[field] ?? "") }) });
  return { value: String(draft?.[field] ?? ""), set: (v: string) => edit({ [field]: v }) };
}

type Own = { item: Entity; field: string };

export function DraftInput({ item, field, ...rest }: Own & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const f = useField(item, field);
  return <input {...rest} value={f.value} onChange={(e) => f.set(e.target.value)} />;
}

export function DraftTextarea({ item, field, ...rest }: Own & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const f = useField(item, field);
  return <textarea {...rest} value={f.value} onChange={(e) => f.set(e.target.value)} />;
}
