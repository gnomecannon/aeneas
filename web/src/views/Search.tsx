import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import { db } from "../sync/db";
import { kindLabel, linkFor } from "../lib/links";
import { go } from "../lib/router";

interface Hit {
  id: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

async function localSearch(q: string): Promise<Hit[]> {
  const s = q.toLowerCase();
  const all = await db.entities.filter((e) => !e.deleted_at).toArray();
  const hits: Hit[] = [];
  for (const e of all) {
    const f = e.fields as Record<string, unknown>;
    const title = e.kind === "application" ? `${String(f.role ?? "")} at ${String(f.company ?? "")}` : String(f.title ?? f.text ?? f.key ?? f.name ?? f.topic ?? f.what ?? f.value ?? "");
    const body = [f.body, f.notes, f.value, f.review, f.host, f.company, f.note, Array.isArray(f.tags) ? f.tags.join(" ") : ""].filter((x) => typeof x === "string" && x).join("\n");
    const hay = `${title}\n${body}`.toLowerCase();
    const i = hay.indexOf(s);
    if (i < 0) continue;
    hits.push({ id: e.id, kind: e.kind, title: title.slice(0, 80), snippet: hay.slice(Math.max(0, i - 40), i + 80).replace(/\n/g, " "), score: title.toLowerCase().includes(s) ? 2 : 1 });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

export function Search({ q }: { q: string }) {
  const [text, setText] = useState(q);
  const [hits, setHits] = useState<Hit[]>([]);
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.trim()) return;
    let alive = true;
    setBusy(true);
    const run = async () => {
      try {
        if (!engine.client) throw new Error("no hub");
        const r = await engine.client.search(q);
        if (alive) {
          setHits(r.hits);
          setSrc("hub");
        }
      } catch {
        const r = await localSearch(q);
        if (alive) {
          setHits(r);
          setSrc("local");
        }
      } finally {
        if (alive) setBusy(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [q]);

  return (
    <div>
      <h1>Search</h1>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) go(`/search?q=${encodeURIComponent(text.trim())}`);
        }}
        style={{ marginBottom: 8 }}
      >
        <input type="search" placeholder="Search tasks, notes, fix notes and everything else" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search everything" autoFocus={!q} />
      </form>
      <div className="muted small" style={{ marginBottom: 8 }}>
        {q ? `${hits.length} ${hits.length === 1 ? "result" : "results"} for "${q}"${src === "local" ? " (this device only, hub not reachable)" : ""}${busy ? ", searching" : ""}` : "Results come from the hub, or from this device when the hub is out of reach."}
      </div>
      <div className="list">
        {hits.map((h) => (
          <a key={`${h.kind}:${h.id}`} href={linkFor(h.kind, h.id, h.title)} className="item" style={{ color: "inherit" }}>
            <div className="body">
              <div className="t">
                <span className="muted small">{kindLabel(h.kind)} </span>
                {h.title}
              </div>
              {h.snippet && <div className="meta">{h.snippet}</div>}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
