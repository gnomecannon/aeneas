import { useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { convertCapture, discardCapture } from "../sync/actions";
import { fmtDateTime } from "../lib/time";
import { engine } from "../sync/engine";

const KINDS = ["task", "note", "reminder", "log", "fact"] as const;

export function Inbox() {
  const caps = useEntities("capture", (e) => !e.fields.processed).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const filed = useEntities("capture", (e) => !!e.fields.processed && e.created_at > weekAgo).sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const convert = async (c: Entity, kind: (typeof KINDS)[number]) => {
    setBusy(c.id);
    setErr("");
    try {
      await convertCapture(c, kind);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // The assistant files it as it files every capture: calendar, people, memory, tasks, logs.
  const fileIt = async (c: Entity) => {
    setBusy(c.id);
    setErr("");
    try {
      if (!engine.client) throw new Error("Hub not configured.");
      await engine.client.fileCapture(c.id);
      await engine.pull();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1>Unsorted Info</h1>
      {err && <div className="error">{err}</div>}
      {!caps.length && !filed.length && <div className="empty">Nothing to sort.</div>}
      <div className="list">
        {caps.map((c) => {
          const f = c.fields as { text: string; source: string; suggested_kind?: string };
          return (
            <div key={c.id} className="card">
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.text}</div>
              <div className="meta muted small" style={{ marginTop: 4 }}>
                {f.source} {fmtDateTime(c.created_at)}
                {f.suggested_kind && f.suggested_kind !== "none" ? ` suggests ${f.suggested_kind}` : ""}
              </div>
              <div className="actions">
                <button className="small primary" disabled={busy === c.id} onClick={() => void fileIt(c)} title="Let the assistant file it where it belongs">
                  {busy === c.id ? "Filing" : "File it"}
                </button>
                {KINDS.map((k) => (
                  <button key={k} className="small" disabled={busy === c.id} onClick={() => convert(c, k)}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
                <button className="small ghost danger" disabled={busy === c.id} onClick={() => discardCapture(c)}>
                  Discard
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* What was filed is a record, not work: collapsed until opened. */}
      {filed.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary>Filed this week ({filed.length})</summary>
          <div className="list">
            {filed.map((c) => (
              <div key={c.id} className="item">
                <a className="body" href={`#/item/${c.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  <div className="t" style={{ overflowWrap: "anywhere" }}>{String(c.fields.text)}</div>
                  <div className="meta"><span>{fmtDateTime(c.created_at)}</span><span>{String(c.fields.filed ?? (c.fields.filing === "pending" ? "Filing it now" : (c.fields.converted_to as unknown[] | undefined)?.length ? "Sorted by hand" : "Diary only"))}</span></div>
                </a>
                {/* The chat that filed it: tell the assistant what it got wrong there. */}
                {typeof c.fields.thread === "string" && <a className="small" href={`#/assistant/${c.fields.thread}`} title="Open the chat that filed this, to correct it">Fix</a>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
