import { useEffect, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntity, useSyncState } from "../sync/hooks";
import { engine } from "../sync/engine";
import { softDelete } from "../sync/edits";
import type { RelatedItem } from "../sync/api";
import { itemTitle } from "../components/LinkedItem";
import { kindLabel, linkFor } from "../lib/links";
import { fmtDateTime } from "../lib/time";
import { go } from "../lib/router";

/** Bookkeeping, links (shown under Related) and device state. */
const HIDDEN = new Set(["apple", "field_ts", "converted_to", "links", "suggested_tags", "suggested_kind", "sorted_by", "filing", "filing_attempts",
  "external_id", "fired", "snooze_log", "checkins", "attachments", "source", "processed", "thread"]);

function show(v: unknown): string {
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDateTime(v) : v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as any).value ?? (x as any).text ?? (x as any).name ?? "") : show(x))).filter(Boolean).join(", ");
  return "";
}

/** "Related": what an item points at, what points at it, and people by name. Nothing when there is none. */
export function Related({ id, exclude = [] }: { id: string; exclude?: string[] }) {
  const [items, setItems] = useState<RelatedItem[]>([]);
  // Opened straight from a link, the page renders before the hub client exists: load once it does.
  const sync = useSyncState();
  const ready = !!engine.client && sync.status !== "setup";
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    engine.client?.related(id).then((r) => alive && setItems(r)).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [id, ready]);
  const shown = items.filter((r) => !exclude.includes(r.why));
  if (!shown.length) return null;
  return (
    <section style={{ marginTop: 20 }}>
      <h2>Related</h2>
      <div className="list">
        {shown.map((r) => (
          <a key={r.id} className="item" href={linkFor(r.kind, r.id, r.title)}>
            <div className="body">
              <div className="t">{r.title}</div>
              {r.lines?.map((l) => <div key={l} className="small">{l}</div>)}
              <div className="meta"><span>{r.why}</span><span>{kindLabel(r.kind)}</span><span>{fmtDateTime(r.at)}</span></div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

/** Any item on its own page: what it says in plain words and what it connects to. */
export function Item({ id }: { id: string }) {
  const e = useEntity(id);
  const [fetched, setFetched] = useState<Entity | null>(null);
  useEffect(() => {
    if (e) return;
    engine.client?.entity(id).then((x) => setFetched(x as Entity)).catch(() => setFetched(null));
  }, [id, e]);
  const item = e ?? fetched;
  if (!item) return <div className="empty">Loading.</div>;
  if (item.deleted_at) return <div className="empty">This item was deleted.</div>;
  const title = itemTitle(item);
  // An all-day event is stored at midnight UTC: its day is the date part, not a local time.
  const allDay = item.kind === "event" && item.fields.all_day === true;
  const day = (v: unknown) => new Date(`${String(v).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const rows = Object.keys(item.fields).sort()
    .filter((k) => !HIDDEN.has(k) && !k.endsWith("_id") && !(allDay && (k === "end" || k === "all_day")))
    .map((k) => [allDay && k === "start" ? "day" : k.replace(/_/g, " "), allDay && k === "start" ? day(item.fields[k]) : show(item.fields[k])] as const)
    .filter(([, v]) => v && v !== title);
  return (
    <div>
      <h1 style={{ overflowWrap: "anywhere" }}>{title}</h1>
      <div className="muted small">{kindLabel(item.kind)}, added {fmtDateTime(item.created_at)}</div>
      {rows.length > 0 && (
        <dl className="fields" style={{ marginTop: 16 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--line, rgba(127,127,127,.15))" }}>
              <dt className="muted" style={{ minWidth: 120, textTransform: "capitalize" }}>{k}</dt>
              <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Related id={item.id} />
      <div className="actions" style={{ marginTop: 20 }}>
        {/* A capture the assistant filed: its chat is where a wrong filing is corrected. */}
        {item.kind === "capture" && typeof item.fields.thread === "string" && <button className="small" onClick={() => go(`/assistant/${String(item.fields.thread)}`)}>Fix the filing</button>}
        <button className="small ghost danger" onClick={() => { if (confirm("Delete this item?")) { void softDelete(item); history.back(); } }}>Delete</button>
      </div>
    </div>
  );
}
