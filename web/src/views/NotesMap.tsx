import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import type { NotesGraph } from "../sync/api";
import { useEntities } from "../sync/hooks";
import { go } from "../lib/router";

type NoteF = { title: string; path: string; tags?: string[]; links?: string[] };

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
}

/** Offline stand-in for /notes/graph from local note entities. */
function localGraph(notes: Entity[]): NotesGraph {
  const nodes = notes.map((n) => {
    const f = n.fields as NoteF;
    return { id: n.id, title: f.title, path: f.path, tags: f.tags ?? [], folder: folderOf(f.path) };
  });
  const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
  const edges: Array<{ from: string; to: string }> = [];
  for (const n of notes) {
    for (const t of (n.fields as NoteF).links ?? []) {
      const to = byTitle.get(t.toLowerCase());
      if (to && to !== n.id) edges.push({ from: n.id, to });
    }
  }
  return { nodes, edges };
}

const FOLDER_COLORS = ["#2f5fbf", "#3a8f5a", "#c2871a", "#b4443c", "#7a4fb0", "#2a8f9a", "#8a6d3b", "#5a5f7a"];

export function NotesMap() {
  const notes = useEntities("note");
  const [graph, setGraph] = useState<NotesGraph | null>(null);
  const [src, setSrc] = useState<"hub" | "local">("local");
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        if (!engine.client) throw new Error("no hub");
        const g = await engine.client.notesGraph();
        if (alive) {
          setGraph(g);
          setSrc("hub");
        }
      } catch {
        if (alive) {
          setGraph(localGraph(notes));
          setSrc("local");
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [notes.length]);

  const layout = useMemo(() => {
    if (!graph) return null;
    // Wide margins so outward node labels stay inside the viewBox.
    const W = 900;
    const H = 560;
    const cx = W / 2;
    const cy = H / 2;
    const R = 200;
    // Group by folder so each folder occupies one contiguous arc.
    const folders = [...new Set(graph.nodes.map((n) => n.folder))].sort();
    const ordered = folders.flatMap((f) => graph.nodes.filter((n) => n.folder === f).sort((a, b) => a.title.localeCompare(b.title)));
    const n = Math.max(ordered.length, 1);
    const pos = new Map<string, { x: number; y: number; angle: number; color: string }>();
    ordered.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      pos.set(node.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), angle, color: FOLDER_COLORS[folders.indexOf(node.folder) % FOLDER_COLORS.length] });
    });
    const arcs = folders.map((f) => {
      const idx = ordered.map((x, i) => (x.folder === f ? i : -1)).filter((i) => i >= 0);
      const mid = ((idx[0] + idx[idx.length - 1]) / 2 / n) * Math.PI * 2 - Math.PI / 2;
      // Folder labels sit inside the ring; node labels point outward, so they never collide.
      const c = Math.cos(mid);
      // Anchor so the text runs toward the centre, away from the ring.
      const anchor: "start" | "end" | "middle" = c < -0.2 ? "start" : c > 0.2 ? "end" : "middle";
      return { folder: f, x: cx + R * 0.7 * c, y: cy + R * 0.7 * Math.sin(mid), anchor, color: FOLDER_COLORS[folders.indexOf(f) % FOLDER_COLORS.length] };
    });
    return { W, H, pos, arcs, ordered };
  }, [graph]);

  if (!graph || !layout) return <div className="muted small">loading</div>;
  const { W, H, pos, arcs, ordered } = layout;
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const linked = new Set<string>();
  if (hover) for (const e of graph.edges) if (e.from === hover || e.to === hover) linked.add(e.from === hover ? e.to : e.from);

  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Map</h1>
        <span className="muted small">
          {graph.nodes.length} notes, {graph.edges.length} links ({src})
        </span>
        <button className="small" onClick={() => go("/notes")}>
          List
        </button>
      </div>
      {!graph.nodes.length && <div className="empty">No notes to map.</div>}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 900, height: "auto", display: "block", margin: "0 auto" }} role="img" aria-label="Notes map">
        {graph.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const hot = hover && (e.from === hover || e.to === hover);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? "var(--accent)" : "var(--border)"} strokeWidth={hot ? 2 : 1} />;
        })}
        {arcs.map((a) => (
          <text key={a.folder} x={a.x} y={a.y} fill={a.color} fontSize={12} textAnchor={a.anchor} dominantBaseline="middle" opacity={0.85}>
            {a.folder.length > 24 ? a.folder.slice(0, 23) + "." : a.folder}
          </text>
        ))}
        {ordered.map((node) => {
          const p = pos.get(node.id)!;
          const r = 6 + Math.min(10, (degree.get(node.id) ?? 0) * 2);
          const dim = hover && hover !== node.id && !linked.has(node.id);
          const right = Math.cos(p.angle) >= 0;
          return (
            <g
              key={node.id}
              style={{ cursor: "pointer" }}
              opacity={dim ? 0.35 : 1}
              role="link"
              tabIndex={0}
              aria-label={`Open note ${node.title}`}
              onClick={() => go(`/notes/${node.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  go(`/notes/${node.id}`);
                }
              }}
              onFocus={() => setHover(node.id)}
              onBlur={() => setHover(null)}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
            >
              <circle cx={p.x} cy={p.y} r={r} fill={p.color} />
              <text x={p.x + (right ? r + 4 : -(r + 4))} y={p.y} fill="var(--text)" fontSize={12} textAnchor={right ? "start" : "end"} dominantBaseline="middle">
                {node.title.length > 28 ? node.title.slice(0, 27) + "." : node.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
