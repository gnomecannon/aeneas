import { plainError } from "../lib/errors";
import { useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { go } from "../lib/router";
import { useDraftSave } from "../lib/useDraftSave";
import { fmtDate, fmtDateTime, fmtTime } from "../lib/time";
import { MUSIC_STATUS_LABEL, MUSIC_TYPES, isHummed, musicMeta, musicProjectCards, parseMusicQuick, type MusicF, type MusicProjectCard, type MusicStatus, type MusicType, type ProjectF } from "../lib/creative";
import { HumRecorder, HumResult } from "../components/Hum";
import { HumSongIcon } from "../components/HumSongIcon";

const STATUSES: MusicStatus[] = ["idea", "wip", "done"];

export function Music({ id }: { id?: string }) {
  if (id === "projects") return <MusicProjectsPage />;
  if (id) return <IdeaPage id={id} />;
  return <MusicList />;
}

function Row({ e }: { e: Entity }) {
  const f = e.fields as MusicF;
  return (
    <a href={`#/music/${e.id}`} className="item" style={{ color: "inherit" }}>
      <div className="body">
        <div className="row">
          <span className="t grow">{f.title}</span>
          <span className={`chip static status-${f.status}`}>{MUSIC_STATUS_LABEL[f.status] ?? f.status}</span>
        </div>
        <div className="meta">
          <span title={isHummed(f) ? "Recorded" : "Added"}>{fmtDateTime(e.created_at)}</span>
          {musicMeta(f).map((x) => (
            <span key={x} className="mono">
              {x}
            </span>
          ))}
          {f.tags && f.tags.length > 0 && <span>{f.tags.map((t) => `#${t}`).join(" ")}</span>}
        </div>
      </div>
    </a>
  );
}

/** A group's heading: "Riffs (4)", the type and how many ideas it holds (it read "Riff 4", like an idea's name). */
const TYPE_HEADINGS: Record<MusicType, string> = { riff: "Riffs", progression: "Progressions", lyric: "Lyrics", song: "Songs" };

/** When an idea was made, with the date even when it was today ("Nov 24 9:41 PM"): what tells two hums apart. */
function madeAt(f: MusicF, iso: string): string {
  return `${isHummed(f) ? "Recorded" : "Added"} ${fmtDate(iso)} ${fmtTime(iso)}`;
}

/**
 * Music (gnomecannon/aeneas#13): one row of actions (a line to type and Hum Song), the way into Projects, then the
 * ideas by type. Projects have a page of their own; cheat sheets and checklists are notes, pointed to at the foot.
 */
function MusicList() {
  const all = useEntities("music_idea");
  const projects = useEntities("project", (p) => (p.fields as ProjectF).area === "music");
  const [status, setStatus] = useState<MusicStatus | null>(null);

  const groups = useMemo(() => {
    const out: Array<{ type: MusicType; items: Entity[] }> = [];
    for (const t of MUSIC_TYPES) {
      const items = all
        .filter((e) => (e.fields as MusicF).type === t && (!status || (e.fields as MusicF).status === status))
        .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
      if (items.length) out.push({ type: t, items });
    }
    return out;
  }, [all, status]);

  return (
    <div className="music">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Music</h1>
        <a href="#/music/projects" className="to-projects">
          Projects{projects.length ? ` (${projects.length})` : ""} {"\u203a"}
        </a>
      </div>
      <MusicAdd autoFocus />

      {all.length > 0 && (
        <div className="chips" style={{ marginTop: 14 }} role="group" aria-label="Status filter">
          {STATUSES.map((s) => (
            <button key={s} type="button" className={`chip ${status === s ? "on" : ""}`} aria-pressed={status === s} onClick={() => setStatus(status === s ? null : s)}>
              {MUSIC_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}
      {!groups.length && <div className="empty">{all.length ? "Nothing with that status." : "No ideas yet. Type a line above, or press Hum Song."}</div>}
      {groups.map((g) => (
        <section key={g.type} style={{ marginTop: 14 }}>
          <h2>
            {TYPE_HEADINGS[g.type]} <span className="muted small" style={{ fontWeight: 400 }}>({g.items.length})</span>
          </h2>
          <div className="list">
            {g.items.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </div>
        </section>
      ))}
      <div className="muted small" style={{ marginTop: 14 }}>
        Cheat sheets and checklists are notes: <a href="#/notes">Notes, Music, Reference</a>.
      </div>
    </div>
  );
}

/**
 * The row of actions: one line (chords, time signature, bpm and tuning are picked out, the rest is the title) and
 * Hum Song, which opens the recorder under the row. With a project (a card on the Projects page), what is added goes
 * into that project.
 */
function MusicAdd({ projectId, autoFocus = false }: { projectId?: string; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [humming, setHumming] = useState(false);
  const preview = useMemo(() => (text.trim() ? parseMusicQuick(text) : null), [text]);

  const capture = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      let e: Entity | null = null;
      if (engine.client) {
        try {
          e = await engine.client.musicQuick(t, projectId);
          await engine.absorb([e]);
        } catch (err) {
          if (err instanceof HubError) throw err;
        }
      }
      if (!e) {
        const q = parseMusicQuick(t);
        const fields: Record<string, unknown> = { title: q.title, type: q.type, body: q.body, status: "idea", tags: [] };
        for (const k of ["key", "bpm", "time_sig", "tuning"] as const) if (q[k] != null) fields[k] = q[k];
        if (projectId) fields.project_id = projectId;
        e = await createEntity("music_idea", fields);
      }
      setSaved(String(e.fields.title));
      setText("");
      setTimeout(() => setSaved(null), 3000);
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col music-add">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <input className="grow mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="Am F C G 6/8 112bpm drop D" aria-label={projectId ? "New idea in this project" : "Quick capture"} autoCapitalize="off" autoFocus={autoFocus} />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>
          Save
        </button>
        <button type="button" className={humming ? "on" : ""} aria-pressed={humming} onClick={() => setHumming(!humming)}>
          <HumSongIcon /> Hum Song
        </button>
      </form>
      {preview && (
        <div className="muted small">
          {preview.type}: {preview.title}
          {musicMeta(preview).length ? `, ${musicMeta(preview).join(", ")}` : ""}
        </div>
      )}
      {saved && <div className="ok">Saved {saved}.</div>}
      {err && <div className="error">{err}</div>}
      {humming && (
        <div className="card" style={{ margin: 0 }}>
          <HumRecorder projectId={projectId} onDone={(idea) => go(`/music/${idea.id}`)} />
        </div>
      )}
    </div>
  );
}

const OPEN_KEY = "music.projects.open";

function readOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

/**
 * Music's Projects page: each project a release in the making (an album, an EP, a single), a card that opens to its
 * ideas and hummed takes with the row of actions for adding to it. Cards start closed; the ones opened stay open on
 * this device. A project started here opens at once.
 */
function MusicProjectsPage() {
  const projects = useEntities("project", (p) => (p.fields as ProjectF).area === "music");
  const ideas = useEntities("music_idea");
  const cards = useMemo(() => musicProjectCards(projects, ideas), [projects, ideas]);
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // From the latest set, not the one this render saw: a project started here opens after its save, when other cards
  // may have been opened or closed meanwhile.
  const toggle = (id: string, isOpen: boolean) =>
    setOpen((cur) => {
      if (cur.has(id) === isOpen) return cur;
      const next = new Set(cur);
      if (isOpen) next.add(id); else next.delete(id);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* private window */ }
      return next;
    });

  const start = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const p = await createEntity("project", { name: name.trim(), status: "active", definition_of_done: "", area: "music" });
      setName("");
      toggle(p.id, true);
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="music music-projects col">
      <a className="sub-back" href="#/music">
        {"\u2039"} Music
      </a>
      <h1>Projects</h1>
      <div className="muted small">Each is a release in the making, an album, an EP or a single, with its ideas and hummed takes.</div>
      <form className="row" onSubmit={(ev) => { ev.preventDefault(); void start(); }}>
        <input className="grow" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="New album, EP or single" aria-label="New project" />
        <button type="submit" className="primary" disabled={busy || !name.trim()}>Start</button>
      </form>
      {err && <div className="error">{err}</div>}
      {!cards.length && <div className="empty">No projects yet. Name one above to start it.</div>}
      {cards.map((c) => (
        <ProjectCard key={c.project.id} card={c} open={open.has(c.project.id)} onToggle={(o) => toggle(c.project.id, o)} />
      ))}
    </div>
  );
}

/** One project's card: closed, its name, status and what it holds; open, the row of actions, its ideas and its takes. */
function ProjectCard({ card, open, onToggle }: { card: MusicProjectCard; open: boolean; onToggle: (open: boolean) => void }) {
  const { project: p, ideas, takes } = card;
  const f = p.fields as ProjectF;
  const holds = [ideas.length ? `${ideas.length} ${ideas.length === 1 ? "idea" : "ideas"}` : "", takes.length ? `${takes.length} hummed ${takes.length === 1 ? "take" : "takes"}` : ""].filter(Boolean).join(", ") || "empty";
  return (
    <details className="card music-project" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="t">{f.name}</span>
        <span className={`chip static status-${f.status}`}>{f.status}</span>
        <span className="muted small">{holds}</span>
      </summary>
      {open && (
        <div className="col" style={{ marginTop: 8 }}>
          {f.definition_of_done && <div className="small">Done when: {f.definition_of_done}</div>}
          <MusicAdd projectId={p.id} />
          {ideas.length > 0 && (
            <section>
              <h3>Ideas ({ideas.length})</h3>
              <div className="list">{ideas.map((e) => <Row key={e.id} e={e} />)}</div>
            </section>
          )}
          {takes.length > 0 && (
            <section>
              <h3>Hummed takes ({takes.length})</h3>
              <div className="list">{takes.map((e) => <Row key={e.id} e={e} />)}</div>
            </section>
          )}
          <a href={`#/projects/${p.id}`} className="small">
            Status, tasks and plan: the project page
          </a>
        </div>
      )}
    </details>
  );
}

type Draft = { title: string; type: MusicType; body: string; key: string; bpm: string; time_sig: string; tuning: string; tags: string; project_id: string; audio_ref: string };

/** An idea's fields as the page's boxes hold them: text, the tags joined. */
const ideaDraft = (raw: Record<string, unknown>): Draft => {
  const f = raw as MusicF;
  return { title: f.title ?? "", type: f.type ?? "riff", body: f.body ?? "", key: f.key ?? "", bpm: f.bpm != null ? String(f.bpm) : "", time_sig: f.time_sig ?? "", tuning: f.tuning ?? "", tags: (f.tags ?? []).join(", "), project_id: f.project_id ?? "", audio_ref: f.audio_ref ?? "" };
};

/** The stored fields for edited boxes: a number, a list, null for an emptied box; an emptied title keeps the old one. */
function ideaFields(d: Partial<Draft>, e: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(d) as Array<keyof Draft>) {
    const v = d[k] ?? "";
    if (k === "bpm") out.bpm = v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
    else if (k === "tags") out.tags = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "title") out.title = v.trim() || (e.fields as MusicF).title;
    else if (k === "type" || k === "body") out[k] = v;
    else out[k] = v.trim() || null;
  }
  return out;
}

/**
 * The body and details save together a second after the last keystroke, like notes, and at once on leaving. Status is
 * one press. A hum's title, key and tempo come from the hub when it has listened: they show unless that box has an edit.
 */
function IdeaPage({ id }: { id: string }) {
  const e = useEntity(id);
  // Music ideas belong to music projects (the current one stays listed even if it is not one).
  const current = (e?.fields as MusicF | undefined)?.project_id;
  const projects = useEntities("project", (p) => p.fields.status !== "done" && ((p.fields as ProjectF).area === "music" || p.id === current), [current]);
  const { draft, edit, saved } = useDraftSave(e, { toDraft: ideaDraft, toFields: ideaFields });

  if (!e || !draft) return <div className="empty">Idea not found.</div>;
  const f = e.fields as MusicF;

  const field = (k: keyof Draft, label: string, extra: Record<string, unknown> = {}) => (
    <div>
      <label htmlFor={`mi-${k}`}>{label}</label>
      <input id={`mi-${k}`} value={draft[k]} onChange={(ev) => edit({ [k]: ev.target.value })} {...extra} />
    </div>
  );

  return (
    <div className="music-idea">
      <div className="row between">
        <input value={draft.title} onChange={(ev) => edit({ title: ev.target.value })} aria-label="Title" style={{ fontWeight: 600, fontSize: 18, flex: 1, minWidth: 0 }} />
        <a href="#/music" className="small">
          all music
        </a>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>{madeAt(f, e.created_at)}</div>
      <div className="row" style={{ marginTop: 10 }} role="group" aria-label="Status">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${f.status === s ? "on" : ""}`} aria-pressed={f.status === s} onClick={() => void updateEntity(e, { status: s })}>
            {MUSIC_STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {f.midi && <div style={{ marginTop: 10 }}><HumResult idea={e} /></div>}
      <textarea value={draft.body} onChange={(ev) => edit({ body: ev.target.value })} rows={f.midi ? 4 : 14} className="mono" aria-label="Body" placeholder="Chords, tab, lyrics, settings. Markdown is fine." spellCheck={false} style={{ marginTop: 10 }} />
      <div className="grid-meta" style={{ marginTop: 10 }}>
        <div>
          <label htmlFor="mi-type">Type</label>
          <select id="mi-type" value={draft.type} onChange={(ev) => edit({ type: ev.target.value as MusicType })}>
            {MUSIC_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        {field("key", "Key", { placeholder: "Am", className: "mono" })}
        {field("bpm", "BPM", { type: "number", inputMode: "numeric", min: 20, max: 400, className: "mono" })}
        {field("time_sig", "Time", { placeholder: "4/4", className: "mono" })}
        {field("tuning", "Tuning", { placeholder: "standard" })}
        {field("tags", "Tags", { placeholder: "comma separated" })}
        <div>
          <label htmlFor="mi-project">Project</label>
          <select id="mi-project" value={draft.project_id} onChange={(ev) => edit({ project_id: ev.target.value })}>
            <option value="">none</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.fields as ProjectF).name}
              </option>
            ))}
          </select>
        </div>
        {field("audio_ref", "Audio", { placeholder: "file name or URL", className: "mono" })}
      </div>
      <div className="row between small muted" style={{ marginTop: 10 }}>
        <span>{saved ? `saved ${fmtDateTime(e.updated_at)}` : "editing"}</span>
        <button className="small ghost danger" onClick={() => confirm("Delete this idea") && softDelete(e).then(() => go("/music"))}>
          Delete
        </button>
      </div>
    </div>
  );
}
