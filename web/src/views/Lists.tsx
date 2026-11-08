import { useEffect, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity } from "../sync/edits";
import { instantiateChecklist, toggleChecklist } from "../sync/admin";
import { CLOSED_STAGES, checklistProgress, statesGrid, type ChecklistF, type Stage } from "../lib/admin";
import { go } from "../lib/router";
import { IfModule } from "../components/ModuleGate";

export function Lists({ id }: { id?: string }) {
  return id ? <ListPage id={id} /> : <ListIndex />;
}

const byTitle = (a: Entity, b: Entity) => String(a.fields.title).localeCompare(String(b.fields.title));

function Progress({ f }: { f: ChecklistF }) {
  const p = checklistProgress(f);
  return (
    <span className="muted small">
      {p.done} of {p.total}
    </span>
  );
}

/** The job applications list sits at the top of Lists. */
function JobsRow() {
  const apps = useEntities("application");
  const open = apps.filter((e) => !CLOSED_STAGES.includes(e.fields.stage as Stage)).length;
  return (
    <a href="#/lists/jobs" className="item" style={{ color: "inherit" }}>
      <div className="body row between">
        <span className="t">Job applications</span>
        <span className="muted small">{apps.length ? `${open} open of ${apps.length}` : "none yet"}</span>
      </div>
    </a>
  );
}

function ListIndex() {
  const all = useEntities("checklist");
  const open = all.filter((e) => !e.fields.template && !e.fields.archived).sort(byTitle);
  const templates = all.filter((e) => !!e.fields.template).sort(byTitle);
  const archived = all.filter((e) => !e.fields.template && !!e.fields.archived).sort(byTitle);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const add = async () => {
    if (!title.trim()) return;
    const e = await createEntity("checklist", { title: title.trim(), kind: "generic", items: [], template: false, tags: [] });
    setTitle("");
    go(`/lists/${e.id}`);
  };

  const use = async (t: Entity) => {
    setBusy(true);
    setErr("");
    try {
      const copy = await instantiateChecklist(t);
      go(`/lists/${copy.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ e }: { e: Entity }) => (
    <a href={`#/lists/${e.id}`} className="item" style={{ color: "inherit" }}>
      <div className="body row between">
        <span className="t">{String(e.fields.title)}</span>
        <Progress f={e.fields as ChecklistF} />
      </div>
    </a>
  );

  return (
    <div className="lists">
      <h1>Lists</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="grow" placeholder="New list" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New list title" style={{ width: "auto" }} />
        <button className="primary" type="submit" disabled={!title.trim()}>
          Add
        </button>
      </form>
      <div className="list" style={{ marginTop: 10 }}>
        <IfModule id="jobs"><JobsRow /></IfModule>
        {open.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </div>
      <h2 className="section-h">Templates</h2>
      {err && <div className="error">{err}</div>}
      <div className="list">
        {templates.map((t) => (
          <div key={t.id} className="item">
            <div className="body row between">
              <a href={`#/lists/${t.id}`} className="t" style={{ color: "inherit" }}>
                {String(t.fields.title)}
              </a>
              <span className="row">
                <span className="muted small">{((t.fields as ChecklistF).items ?? []).length} items</span>
                <button className="small primary" onClick={() => void use(t)} disabled={busy} aria-label={`Use ${String(t.fields.title)}`}>
                  Use
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
      {archived.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>Archived ({archived.length})</summary>
          <div className="list">
            {archived.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ListPage({ id }: { id: string }) {
  const e = useEntity(id);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (e) return;
    const t = setTimeout(() => {
      void engine
        .refetch(id)
        .catch(() => undefined)
        .finally(() => setMissing(true));
    }, 400);
    return () => clearTimeout(t);
  }, [id, e]);

  if (!e || e.deleted_at) return <div className="empty">{missing ? "List not found." : "Loading"}</div>;
  const f = e.fields as ChecklistF;
  const items = f.items ?? [];

  const toggle = async (index: number) => {
    if (busy !== null) return;
    setBusy(index);
    setErr("");
    try {
      await toggleChecklist(e, index);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(null);
    }
  };

  const addItem = async () => {
    if (!text.trim()) return;
    await updateEntity(e, { items: [...items, { text: text.trim() }] });
    setText("");
  };

  const use = async () => {
    const copy = await instantiateChecklist(e);
    go(`/lists/${copy.id}`);
  };

  return (
    <div className="lists">
      <div className="row between">
        <div>
          <h1 style={{ margin: 0 }}>{f.title}</h1>
          <div className="muted small">
            {f.template ? `template, ${items.length} items` : f.kind === "states" ? "" : `${checklistProgress(f).done} of ${items.length}`}
            {f.archived ? ", archived" : ""}
          </div>
        </div>
        <a href="#/lists" className="small">
          all lists
        </a>
      </div>
      {err && <div className="error">{err}</div>}

      {f.kind === "states" ? (
        <StatesGrid items={items} onToggle={(i) => void toggle(i)} />
      ) : f.template ? (
        <div className="list" style={{ marginTop: 12 }}>
          {items.map((it, i) => (
            <div key={i} className="item">
              <span className="t">{it.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="ticks" style={{ marginTop: 12 }}>
          {items.map((it, i) => (
            <button key={i} type="button" className={`tick ${it.done_at ? "on" : ""}`} aria-pressed={!!it.done_at} disabled={busy === i} onClick={() => void toggle(i)}>
              <span className="box" aria-hidden="true">
                {it.done_at ? "✓" : ""}
              </span>
              <span className="t">{it.text}</span>
              {it.note && <span className="muted small">{it.note}</span>}
            </button>
          ))}
        </div>
      )}

      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(ev) => {
          ev.preventDefault();
          void addItem();
        }}
      >
        <input className="grow" placeholder="Add item" value={text} onChange={(ev) => setText(ev.target.value)} aria-label="Add item" style={{ width: "auto" }} />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      <div className="actions">
        {f.template && (
          <button className="primary" onClick={() => void use()}>
            Use
          </button>
        )}
        {!f.template && (
          <button className="ghost" onClick={() => void updateEntity(e, { archived: !f.archived }).then(() => !f.archived && go("/lists"))}>
            {f.archived ? "Unarchive" : "Archive"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 50 two-letter chips. Hover shows the full name; a long press shows it under the grid without toggling. */
function StatesGrid({ items, onToggle }: { items: ChecklistF["items"]; onToggle: (index: number) => void }) {
  const chips = statesGrid(items);
  const done = chips.filter((c) => c.done).length;
  const [shown, setShown] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const start = (label: string) => {
    held.current = false;
    timer.current = setTimeout(() => {
      held.current = true;
      setShown(label);
    }, 450);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="title-count">
        <strong>{done}</strong> <span className="muted">of {chips.length} states</span>
      </div>
      <div className="states" role="group" aria-label="States visited">
        {chips.map((c) => {
          const label = `${c.name}, ${c.done ? "visited" : "not visited"}`;
          return (
            <button
              key={c.code}
              type="button"
              className={`state ${c.done ? "on" : ""}`}
              title={c.name}
              aria-label={label}
              aria-pressed={c.done}
              onPointerDown={() => start(label)}
              onPointerUp={stop}
              onPointerLeave={stop}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setShown(label);
              }}
              onClick={() => {
                if (held.current) {
                  held.current = false;
                  return;
                }
                setShown(`${c.name}, ${c.done ? "not visited" : "visited"}`);
                onToggle(c.index);
              }}
            >
              {c.code}
            </button>
          );
        })}
      </div>
      <div className="muted small" aria-live="polite" style={{ minHeight: 18, marginTop: 6 }}>
        {shown}
      </div>
    </div>
  );
}
