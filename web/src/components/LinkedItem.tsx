import { GONE_KINDS, type Entity } from "@everythingapp/shared";
import { useEntity } from "../sync/hooks";
import { kindLabel, linkFor } from "../lib/links";

/** The name an item goes by, whatever its kind. */
export function itemTitle(e: Entity): string {
  const f = e.fields;
  if (e.kind === "pet_event") return [f.type, f.note].filter(Boolean).map(String).join(", ");
  return String(f.title ?? f.name ?? f.text ?? f.value ?? kindLabel(e.kind));
}

/**
 * "Renewal: Domain" as a link to the item a reminder (or anything else) points at. Nothing when it is gone, or when no
 * screen shows its kind any more (a job application a follow-up task points at: GONE_KINDS).
 */
export function LinkedItem({ id }: { id?: string }) {
  const e = useEntity(id);
  if (!e || e.deleted_at || GONE_KINDS.includes(e.kind)) return null;
  const title = itemTitle(e);
  const label = kindLabel(e.kind);
  return (
    <a href={linkFor(e.kind, e.id, title)} title={`Open the ${label}`}>
      {label.charAt(0).toUpperCase() + label.slice(1)}: {title}
    </a>
  );
}
