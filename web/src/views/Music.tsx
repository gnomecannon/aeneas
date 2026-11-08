import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { MUSIC_TYPES, musicMeta, parseMusicQuick, type MusicF, type MusicStatus, type MusicType, type ProjectF } from "../lib/creative";
import { HumRecorder, HumResult } from "../components/Hum";

const STATUSES: MusicStatus[] = ["idea", "wip", "done"];

export function Music({ id }: { id?: string }) {
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
          <span className={`chip static status-${f.status}`}>{f.status}</span>
        </div>
        <div className="meta">
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

function MusicList() {
  const all = useEntities("music_idea");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [status, setStatus] = useState<MusicStatus | null>(null);
  const preview = useMemo(() => (text.trim() ? parseMusicQuick(text) : null), [text]);

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

  const capture = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      let e: Entity | null = null;
      if (engine.client) {
        try {
          e = await engine.client.musicQuick(t);
          await engine.absorb([e]);
        } catch (err) {
          if (err instanceof HubError) throw err;
        }
      }
      if (!e) {
        const q = parseMusicQuick(t);
        const fields: Record<string, unknown> = { title: q.title, type: q.type, body: q.body, status: "idea", tags: [] };
        for (const k of ["key", "bpm", "time_sig", "tuning"] as const) if (q[k] != null) fields[k] = q[k];
        e = await createEntity("music_idea", fields);
      }
      setSaved(String(e.fields.title));
      setText("");
      setTimeout(() => setSaved(null), 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="music">
      <h1>Music</h1>
      <form
        className="card col"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <div className="row">
          <input className="grow mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="Am F C G 6/8 112bpm drop D" aria-label="Quick capture" autoCapitalize="off" autoFocus />
          <button className="primary" type="submit" disabled={busy || !text.trim()}>
            Save
          </button>
        </div>
        {preview && (
          <div className="muted small">
            {preview.type}: {preview.title}
            {musicMeta(preview).length ? `, ${musicMeta(preview).join(", ")}` : ""}
          </div>
        )}
        {saved && <div className="ok">Saved {saved}.</div>}
        {err && <div className="error">{err}</div>}
      </form>

      <details className="card" style={{ marginTop: 10 }}>
        <summary><strong>Hum it</strong> <span className="muted small">a melody or a rhythm, to notes and a MIDI file</span></summary>
        <div style={{ marginTop: 8 }}>
          <HumRecorder onDone={(idea) => go(`/music/${idea.id}`)} />
        </div>
      </details>

      <MusicProjects ideas={all} />
      <div className="muted small" style={{ marginTop: 4 }}>
        Cheat sheets and checklists are notes: <a href="#/notes">Notes, Music, Reference</a>.
      </div>

      <div className="chips" style={{ marginTop: 14 }} role="group" aria-label="Status filter">
        {STATUSES.map((s) => (
          <button key={s} type="button" className={`chip ${status === s ? "on" : ""}`} aria-pressed={status === s} onClick={() => setStatus(status === s ? null : s)}>
            {s}
          </button>
        ))}
      </div>
      {!groups.length && <div className="empty">{all.length ? "Nothing with that status." : "No ideas yet. Type a line above."}</div>}
      {groups.map((g) => (
        <section key={g.type} style={{ marginTop: 14 }}>
          <h2 style={{ textTransform: "capitalize" }}>
            {g.type} <span className="muted small" style={{ fontWeight: 400 }}>{g.items.length}</span>
          </h2>
          <div className="list">
            {g.items.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Music projects: projects with area music, shown here with their ideas; a new one starts here. */
function MusicProjects({ ideas }: { ideas: Entity[] }) {
  const projects = useEntities("project", (p) => (p.fields as ProjectF).area === "music" && p.fields.status !== "done");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await createEntity("project", { name: name.trim(), status: "active", definition_of_done: "", area: "music" });
      setName("");
      go(`/projects/${p.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={{ marginTop: 4 }}>
      <h2>Projects</h2>
      <div className="list">
        {projects.map((p) => {
          const f = p.fields as ProjectF;
          const n = ideas.filter((m) => (m.fields as MusicF).project_id === p.id).length;
          return (
            <a key={p.id} href={`#/projects/${p.id}`} className="item" style={{ color: "inherit" }}>
              <div className="body">
                <div className="row">
                  <span className="t grow" style={{ fontWeight: 600 }}>{f.name}</span>
                  <span className={`chip static status-${f.status}`}>{f.status}</span>
                </div>
                <div className="meta">
                  <span>{n} {n === 1 ? "idea" : "ideas"}</span>
                  {f.definition_of_done && <span>Done when: {f.definition_of_done}</span>}
                </div>
              </div>
            </a>
          );
        })}
      </div>
      <form className="row" style={{ marginTop: 6 }} onSubmit={(ev) => { ev.preventDefault(); void start(); }}>
        <input className="grow" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="New music project (an album, an EP, a song)" aria-label="New music project" />
        <button type="submit" disabled={busy || !name.trim()}>Start</button>
      </form>
    </section>
  );
}

type Draft = { title: string; type: MusicType; body: string; key: string; bpm: string; time_sig: string; tuning: string; tags: string; project_id: string; audio_ref: string };

/** The body autosaves a second after the last keystroke, like notes. Status is one press. */
function IdeaPage({ id }: { id: string }) {
  const e = useEntity(id);
  // Music ideas belong to music projects (the current one stays listed even if it is not one).
  const projects = useEntities("project", (p) => p.fields.status !== "done" && ((p.fields as ProjectF).area === "music" || p.id === (e?.fields as MusicF | undefined)?.project_id));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (e && !draft) {
      const f = e.fields as MusicF;
      setDraft({ title: f.title ?? "", type: f.type ?? "riff", body: f.body ?? "", key: f.key ?? "", bpm: f.bpm != null ? String(f.bpm) : "", time_sig: f.time_sig ?? "", tuning: f.tuning ?? "", tags: (f.tags ?? []).join(", "), project_id: f.project_id ?? "", audio_ref: f.audio_ref ?? "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e?.id]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A hum's title, key and tempo come from the hub when it has listened: show them unless something is being typed.
  const humState = (e?.fields as MusicF | undefined)?.midi?.state;
  useEffect(() => {
    if (!e || !draft || !saved) return;
    const f = e.fields as MusicF;
    setDraft({ ...draft, title: f.title ?? "", key: f.key ?? "", bpm: f.bpm != null ? String(f.bpm) : "", tags: (f.tags ?? []).join(", ") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humState]);

  if (!e || !draft) return <div className="empty">Idea not found.</div>;
  const f = e.fields as MusicF;

  const toFields = (d: Draft, keys: Array<keyof Draft>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === "bpm") out.bpm = d.bpm.trim() && Number.isFinite(Number(d.bpm)) ? Number(d.bpm) : null;
      else if (k === "tags") out.tags = d.tags.split(",").map((s) => s.trim()).filter(Boolean);
      else if (k === "title") out.title = d.title.trim() || f.title;
      else if (k === "type" || k === "body") out[k] = d[k];
      else out[k] = d[k].trim() || null;
    }
    return out;
  };

  const edit = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void updateEntity(e, toFields(next, Object.keys(patch) as Array<keyof Draft>)).then(() => setSaved(true));
    }, 1000);
  };

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
      <div className="row" style={{ marginTop: 10 }} role="group" aria-label="Status">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${f.status === s ? "on" : ""}`} aria-pressed={f.status === s} onClick={() => void updateEntity(e, { status: s })}>
            {s}
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
