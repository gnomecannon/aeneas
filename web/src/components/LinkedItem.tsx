import type { Entity } from "@everythingapp/shared";
import { useEntity } from "../sync/hooks";
import { kindLabel, linkFor } from "../lib/links";

/** The name an item goes by, whatever its kind. */
export function itemTitle(e: Entity): string {
  const f = e.fields;
  if (e.kind === "application") return `${String(f.company ?? "")} ${String(f.role ?? "")}`.trim();
  if (e.kind === "pet_event") return [f.type, f.note].filter(Boolean).map(String).join(", ");
  return String(f.title ?? f.name ?? f.text ?? f.value ?? kindLabel(e.kind));
}

/** "Renewal: Domain" as a link to the item a reminder (or anything else) points at. Nothing when it is gone. */
export function LinkedItem({ id }: { id?: string }) {
  const e = useEntity(id);
  if (!e || e.deleted_at) return null;
  const title = itemTitle(e);
  const label = kindLabel(e.kind);
  return (
    <a href={linkFor(e.kind, e.id, title)} title={`Open the ${label}`}>
      {label.charAt(0).toUpperCase() + label.slice(1)}: {title}
    </a>
  );
}
