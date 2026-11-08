import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { engine } from "../sync/engine";
import type { Related } from "../sync/api";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { Markdown } from "../components/Markdown";
import { saveBlob } from "../lib/download";
import { localDate } from "../lib/planner";

type NoteF = { title: string; body: string; tags: string[]; path: string; pinned?: boolean; links?: string[]; suggested_tags?: string[] };
type RelatedGroups = { links: Related[]; backlinks: Related[]; similar: Related[] };

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
}

function byTitle(notes: Entity[], title: string): Entity | undefined {
  const t = title.toLowerCase();
  return notes.find((n) => (n.fields as NoteF).title.toLowerCase() === t);
}

/** Forms an idea can take (its tags besides `idea`), in the order the Ideas group lists them. */
const IDEA_FORMS: Array<[string, string]> = [["story", "Stories"], ["film", "Films"], ["book", "Books"], ["sketch", "Sketches"], ["song", "Songs"], ["game", "Games"], ["app", "Apps"], ["invention", "Inventions"], ["business", "Businesses"]];
const OPEN_KEY = "notes.open";
const DIARY_SHOWN = 7;

interface FolderNode { name: string; path: string; notes: Entity[]; children: FolderNode[]; count: number }

/** Notes as nested folders (Writing, then Comedy, then Sketches), each with its notes and a count of everything inside. */
export function folderTree(notes: Entity[]): FolderNode {
  const root: FolderNode = { name: "", path: "", notes: [], children: [], count: 0 };
  for (const n of notes) {
    const dir = folderOf((n.fields as NoteF).path);
    let node = root;
    if (dir !== "/") {
      for (const part of dir.split("/")) {
        const p = node.path ? `${node.path}/${part}` : part;
        let c = node.children.find((x) => x.path === p);
        if (!c) { c = { name: part, path: p, notes: [], children: [], count: 0 }; node.children.push(c); }
        node = c;
      }
    }
    node.notes.push(n);
  }
  const finish = (node: FolderNode): number => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    // The diary gains a note a day: newest first. Other folders by title.
    node.notes.sort(node.path === "Diary"
      ? (x, y) => String((y.fields as NoteF).path).localeCompare(String((x.fields as NoteF).path))
      : (x, y) => String(x.fields.title).localeCompare(String(y.fields.title)));
    node.count = node.notes.length + node.children.reduce((sum, c) => sum + finish(c), 0);
    return node.count;
  };
  finish(root);
  return root;
}

/** Notes tagged `idea`, by the form they take (a story, a sketch), wherever they are filed. */
export function ideaGroups(notes: Entity[]): Array<[string, string, Entity[]]> {
  const ideas = notes.filter((n) => ((n.fields as NoteF).tags ?? []).some((t) => t.toLowerCase() === "idea"));
  const out: Array<[string, string, Entity[]]> = [];
  const placed = new Set<string>();
  for (const [form, label] of IDEA_FORMS) {
    const items = ideas.filter((n) => !placed.has(n.id) && ((n.fields as NoteF).tags ?? []).some((t) => t.toLowerCase() === form));
    items.forEach((n) => placed.add(n.id));
    if (items.length) out.push([form, label, items]);
  }
  const rest = ideas.filter((n) => !placed.has(n.id));
  if (rest.length) out.push(["other", "Other", rest]);
  for (const g of out) g[2].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

function readOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

export function Notes({ id }: { id?: string }) {
  const notes = useEntities("note");
  const [q, setQ] = useState("");
  const filtering = !!q.trim();
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return notes;
    return notes.filter((n) => {
      const f = n.fields as NoteF;
      return f.title.toLowerCase().includes(s) || f.path.toLowerCase().includes(s) || (f.body ?? "").toLowerCase().includes(s) || (f.tags ?? []).some((t) => t.toLowerCase().includes(s));
    });
  }, [notes, q]);
  const tree = useMemo(() => folderTree(filtered), [filtered]);
  const ideas = useMemo(() => ideaGroups(filtered), [filtered]);
  const [allDiary, setAllDiary] = useState(false);
  // Tags and links come from the model, which runs only when asked (Tag notes), so the GPU stays free for games.
  const [linking, setLinking] = useState<{ waiting: number; running: boolean } | null>(null);
  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    const read = () => void c.notesLinking().then(setLinking).catch(() => undefined);
    read();
    const t = setInterval(read, 15_000);
    return () => clearInterval(t);
  }, []);
  // Folders start collapsed; the ones opened stay open on this device. A filter opens everything it matches.
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const toggle = (key: string, isOpen: boolean) => {
    if (filtering || open.has(key) === isOpen) return;
    const next = new Set(open);
    if (isOpen) next.add(key); else next.delete(key);
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* private window */ }
  };
  // The open note's folders open, so it shows in the list.
  useEffect(() => {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    const parts = folderOf((n.fields as NoteF).path).split("/").filter((p) => p && p !== "/");
    const want = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    if (want.some((k) => !open.has(k))) setOpen((cur) => new Set([...cur, ...want]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, notes.length]);

  const exportAll = async () => {
    try {
      const blob = await engine.client!.exportNotes();
      saveBlob(blob, `notes-${localDate(new Date())}.tar.gz`);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const create = async () => {
    const title = "Untitled";
    const e = await createEntity("note", { title, body: "", tags: [], path: `Inbox/${title} ${Date.now()}.md` });
    go(`/notes/${e.id}`);
  };

  const noteList = (items: Entity[]) => (
    <div className="list">
      {items.map((n) => (
        <a key={n.id} href={`#/notes/${n.id}`} className="item" style={{ display: "block", color: "inherit", fontWeight: n.id === id ? 600 : 400 }}>
          {String(n.fields.title) || "(untitled)"}
        </a>
      ))}
    </div>
  );

  const folder = (node: FolderNode) => {
    const capped = node.path === "Diary" && !allDiary && !filtering && node.notes.length > DIARY_SHOWN;
    return (
      <details key={node.path} open={filtering || open.has(node.path)} onToggle={(e) => toggle(node.path, (e.currentTarget as HTMLDetailsElement).open)}>
        <summary>{node.name} <span className="count">{node.count}</span></summary>
        {node.notes.length > 0 && noteList(capped ? node.notes.slice(0, DIARY_SHOWN) : node.notes)}
        {node.path === "Diary" && !filtering && node.notes.length > DIARY_SHOWN && (
          <button className="small ghost" onClick={() => setAllDiary((v) => !v)}>{allDiary ? "Last 7 days" : `All ${node.notes.length} days`}</button>
        )}
        {node.children.map(folder)}
      </details>
    );
  };

  return (
    <div className="split">
      <div className="side">
        <input placeholder="Filter notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter notes" style={{ marginBottom: 6 }} />
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="small" onClick={create}>
            New
          </button>
          <button className="small" onClick={() => go("/notes/map")}>
            Map
          </button>
          <button className="small ghost" disabled={!engine.client} onClick={() => void exportAll()} title="Download every note as markdown files">
            Export all
          </button>
          {linking && (linking.waiting > 0 || linking.running) && (
            <button className="small" disabled={linking.running} onClick={() => void engine.client?.notesLinkNow().then(setLinking)} title="The model reads the changed notes and gives them tags and links; it stops for any chat">
              {linking.running ? `Tagging ${linking.waiting}` : `Tag ${linking.waiting} ${linking.waiting === 1 ? "note" : "notes"}`}
            </button>
          )}
        </div>
        {!notes.length && <div className="empty">No notes.</div>}
        <div className="tree">
          {ideas.length > 0 && (
            <details open={filtering || open.has("ideas")} onToggle={(e) => toggle("ideas", (e.currentTarget as HTMLDetailsElement).open)}>
              <summary>Ideas <span className="count">{ideas.reduce((sum, g) => sum + g[2].length, 0)}</span></summary>
              {ideas.map(([form, label, items]) => (
                <details key={form} open={filtering || open.has(`ideas/${form}`)} onToggle={(e) => toggle(`ideas/${form}`, (e.currentTarget as HTMLDetailsElement).open)}>
                  <summary>{label} <span className="count">{items.length}</span></summary>
                  {noteList(items)}
                </details>
              ))}
            </details>
          )}
          {tree.children.map(folder)}
          {tree.notes.length > 0 && noteList(tree.notes)}
        </div>
      </div>
      <div>{id ? <Editor id={id} notes={notes} /> : <div className="empty">Pick a note or create one.</div>}</div>
    </div>
  );
}

/** Offline stand-in for /notes/:id/related built from local `links` fields. */
function localRelated(note: Entity, notes: Entity[]): RelatedGroups {
  const f = note.fields as NoteF;
  const toRel = (n: Entity, why: string): Related => ({ id: n.id, title: (n.fields as NoteF).title, path: (n.fields as NoteF).path, why });
  const links = (f.links ?? []).map((t) => byTitle(notes, t)).filter((n): n is Entity => !!n && n.id !== note.id).map((n) => toRel(n, "link"));
  const backlinks = notes.filter((n) => n.id !== note.id && ((n.fields as NoteF).links ?? []).some((t) => t.toLowerCase() === f.title.toLowerCase())).map((n) => toRel(n, "backlink"));
  const mine = new Set((f.tags ?? []).map((t) => t.toLowerCase()));
  const similar = notes
    .filter((n) => n.id !== note.id && !links.some((l) => l.id === n.id) && !backlinks.some((l) => l.id === n.id))
    .map((n) => {
      const nf = n.fields as NoteF;
      const shared = (nf.tags ?? []).filter((t) => mine.has(t.toLowerCase()));
      const sameFolder = folderOf(nf.path) === folderOf(f.path);
      return shared.length || sameFolder ? toRel(n, shared.length ? `tags ${shared.join(", ")}` : "same folder") : null;
    })
    .filter((x): x is Related => !!x)
    .slice(0, 8);
  return { links, backlinks, similar };
}

function Editor({ id, notes }: { id: string; notes: Entity[] }) {
  const note = useEntity(id);
  const [draft, setDraft] = useState<NoteF | null>(null);
  const [saved, setSaved] = useState(true);
  const [related, setRelated] = useState<RelatedGroups | null>(null);
  const [relatedSrc, setRelatedSrc] = useState<"hub" | "local">("local");
  const [err, setErr] = useState("");
  // Notes open formatted; Edit (or a double-click) shows the text.
  const [editing, setEditing] = useState(false);
  const [newTag, setNewTag] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastId = useRef<string>("");

  useEffect(() => {
    if (!note) return;
    if (lastId.current !== id || saved) {
      // A different note opens formatted, or straight into the editor when it is empty.
      if (lastId.current !== id) setEditing(!String((note.fields as NoteF).body ?? "").trim());
      lastId.current = id;
      setDraft({ ...(note.fields as NoteF), tags: (note.fields as NoteF).tags ?? [], body: (note.fields as NoteF).body ?? "" });
      setSaved(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, note?.updated_at]);

  // Related comes from the hub (links, backlinks, similar), or from the local links when it is out of reach.
  const refresh = useCallback(
    async () => {
      if (!note) return;
      setErr("");
      const c = engine.client;
      if (c) {
        try {
          setRelated(await c.notesRelated(note.id));
          setRelatedSrc("hub");
          return;
        } catch { /* offline: the local links below */ }
      }
      setRelated(localRelated(note, notes));
      setRelatedSrc("local");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note?.id, note?.updated_at, notes.length],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const edit = (patch: Partial<NoteF>) => {
    if (!draft || !note) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(patch) as Array<keyof NoteF>) fields[k] = next[k];
      void updateEntity(note, fields).then(async () => {
        setSaved(true);
        // The hub derives links on write; give the outbox a moment to flush, then refresh.
        setTimeout(() => void refresh(), 400);
      });
    }, 1000);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!note || !draft) return <div className="empty">Note not found.</div>;

  const group = (label: string, items: Related[]) => (
    <div>
      <div className="muted small">{label}</div>
      {!items.length && <div className="muted small">none</div>}
      {items.map((r) => (
        <div key={`${label}:${r.id}`} className="small">
          <a href={`#/notes/${r.id}`}>{r.title}</a>
          {r.why && <span className="muted"> {r.why}</span>}
        </div>
      ))}
    </div>
  );

  return (
    <div className="col">
      <input value={draft.title} onChange={(e) => edit({ title: e.target.value })} placeholder="Title" aria-label="Title" style={{ fontSize: 18, fontWeight: 600 }} />
      <div className="row wrap" aria-label="Tags">
        <div className="chips">
          {draft.tags.map((t) => (
            <span key={t} className="chip">
              {t}
              <button className="chip-x" onClick={() => edit({ tags: draft.tags.filter((x) => x !== t) })} aria-label={`Remove tag ${t}`}>
                {"\u00D7"}
              </button>
            </span>
          ))}
        </div>
        <input
          className="grow"
          style={{ minWidth: 140 }}
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && newTag.trim()) {
              e.preventDefault();
              const t = newTag.trim().replace(/^#/, "");
              if (!draft.tags.includes(t)) edit({ tags: [...draft.tags, t] });
              setNewTag("");
            }
          }}
          placeholder="Add a tag, then Enter"
          aria-label="Add a tag"
        />
      </div>
      <div className="muted small">The assistant tags and links notes by itself. Remove a tag it added and it stays removed.</div>
      {err && <div className="error">{err}</div>}
      {editing ? (
        <textarea value={draft.body} onChange={(e) => edit({ body: e.target.value })} rows={16} placeholder="Write. Mention another note by its title to link it." aria-label="Body" autoFocus />
      ) : (
        <div className="note-read" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {draft.body.trim() ? <Markdown text={draft.body} /> : <div className="muted">Empty. Choose Edit to write.</div>}
        </div>
      )}
      <div className="row between small muted">
        <span>{saved ? `saved ${fmtDateTime(note.updated_at)}` : "editing"}</span>
        <span className="row">
          <button className="small" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>
          <button className="small ghost" onClick={() => saveBlob(new Blob([`# ${draft.title}\n\n${draft.body}\n`], { type: "text/markdown" }), `${(draft.title || "note").replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`)}>
            Download .md
          </button>
          <button className="small ghost danger" onClick={() => confirm("Delete this note") && softDelete(note).then(() => go("/notes"))}>
            Delete
          </button>
        </span>
      </div>
      <details className="small">
        <summary>Details</summary>
        <label htmlFor="note-path">File path in the notes folder</label>
        <input id="note-path" value={draft.path} onChange={(e) => edit({ path: e.target.value })} className="mono" />
      </details>
      <div className="card">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Related</h3>
          <span className="muted small">{relatedSrc}</span>
        </div>
        {!related && <div className="muted small">loading</div>}
        {related && (
          <div className="grid2" style={{ marginTop: 8 }}>
            {group("Links", related.links)}
            {group("Backlinks", related.backlinks)}
            {group("Similar", related.similar)}
          </div>
        )}
      </div>
    </div>
  );
}

