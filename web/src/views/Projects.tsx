import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { refetchAll } from "../sync/memory";
import { Markdown } from "../components/Markdown";
import { go } from "../lib/router";
import { fmtDateTime, relative } from "../lib/time";
import { useEscape } from "../lib/keys";
import { missingPartTasks, parsePartsText, partRows, partTotals, partsToText, musicMeta, procedureProgress, type MusicF, type ProcedureF, type ProjectF, type ProjectStatus, type ProjectSummary } from "../lib/creative";
import { Inventory } from "./Inventory";

const STATUSES: ProjectStatus[] = ["active", "parked", "done"];
const ORDER: Record<ProjectStatus, number> = { active: 0, parked: 1, done: 2 };

export function Projects({ id }: { id?: string }) {
  if (id === "inventory") return <Inventory />;
  if (id === "new") return <ProjectForm />;
  if (id) return <ProjectPage id={id} />;
  return <ProjectList />;
}

function StatusChip({ status }: { status: ProjectStatus }) {
  return <span className={`chip static status-${status}`}>{status}</span>;
}

/** Summaries for the list are fetched once per project; the hub holds the last session close. */
function useSummaries(ids: string[]): Record<string, ProjectSummary> {
  const [map, setMap] = useState<Record<string, ProjectSummary>>({});
  const key = ids.join(",");
  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    let alive = true;
    for (const id of key.split(",").filter(Boolean)) {
      c.projectSummary(id)
        .then((s) => alive && setMap((m) => ({ ...m, [id]: s })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}

function ProjectList() {
  const projects = useEntities("project");
  const sorted = useMemo(
    () => projects.slice().sort((a, b) => ORDER[(a.fields as ProjectF).status] - ORDER[(b.fields as ProjectF).status] || (a.updated_at > b.updated_at ? -1 : 1)),
    [projects],
  );
  const summaries = useSummaries(sorted.map((p) => p.id));
  return (
    <div className="projects">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Projects</h1>
        <div className="row">
          <a href="#/projects/inventory" className="small">
            inventory
          </a>
          <button className="small primary" onClick={() => go("/projects/new")}>
            New project
          </button>
        </div>
      </div>
      {!sorted.length && <div className="empty">No projects yet.</div>}
      <div className="list" style={{ marginTop: 10 }}>
        {sorted.map((p) => {
          const f = p.fields as ProjectF;
          const close = summaries[p.id]?.last_session_close ?? null;
          return (
            <a key={p.id} href={`#/projects/${p.id}`} className="item" style={{ color: "inherit" }}>
              <div className="body">
                <div className="row">
                  <span className="t grow" style={{ fontWeight: 600 }}>
                    {f.name}
                  </span>
                  {f.area === "music" && <span className="chip static">music</span>}
                  <StatusChip status={f.status} />
                </div>
                <div className="small" style={{ marginTop: 2 }}>
                  Done when: {f.definition_of_done || <span className="muted">not written</span>}
                </div>
                <div className="meta">
                  <span>{f.activity_at && (!close || f.activity_at > close) ? `worked on ${relative(f.activity_at)}` : close ? `last session ${relative(close)}` : "no session closed yet"}</span>
                  {f.parts?.length ? <span>{f.parts.length} parts</span> : null}
                  {f.repo && <span className="mono">{f.repo}</span>}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

type Draft = { name: string; status: ProjectStatus; definition_of_done: string; repo: string; parts: string; music: boolean };

/** Create or edit: name, status, definition of done, repo and parts rows (one per line, "2 x name"). */
function ProjectForm({ project, onDone }: { project?: Entity; onDone?: () => void }) {
  const f = project?.fields as ProjectF | undefined;
  const [d, setD] = useState<Draft>({ name: f?.name ?? "", status: f?.status ?? "active", definition_of_done: f?.definition_of_done ?? "", repo: f?.repo ?? "", parts: partsToText(f?.parts), music: f?.area === "music" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const parsed = useMemo(() => parsePartsText(d.parts), [d.parts]);

  const save = async () => {
    if (!d.name.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const existing = f?.parts ?? [];
      const fields: Record<string, unknown> = {
        name: d.name.trim(),
        status: d.status,
        definition_of_done: d.definition_of_done.trim(),
        repo: d.repo.trim() || null,
        area: d.music ? "music" : null,
        // Keep the hub's have and inventory_id on rows whose name did not change.
        parts: parsed.map((p) => {
          const prev = existing.find((e) => e.name.toLowerCase() === p.name.toLowerCase());
          return prev ? { ...prev, qty: p.qty } : p;
        }),
      };
      if (fields.repo === null) delete fields.repo;
      if (!project && fields.area === null) delete fields.area;
      if (project) {
        await updateEntity(project, { ...fields, repo: d.repo.trim() || null });
        onDone?.();
      } else {
        const e = await createEntity("project", fields);
        go(`/projects/${e.id}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!project && <h1 style={{ margin: 0 }}>New project</h1>}
      <div>
        <label htmlFor="pj-name">Name</label>
        <input id="pj-name" value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!project} />
      </div>
      <div className="row">
        <div>
          <label htmlFor="pj-status">Status</label>
          <select id="pj-status" value={d.status} onChange={(e) => set({ status: e.target.value as ProjectStatus })}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="pj-repo">Repo</label>
          <input id="pj-repo" value={d.repo} onChange={(e) => set({ repo: e.target.value })} placeholder="optional" className="mono" autoCapitalize="off" />
        </div>
      </div>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={d.music} onChange={(e) => set({ music: e.target.checked })} style={{ width: "auto" }} />
        Music project: it shows in Music with its songs and ideas
      </label>
      <div>
        <label htmlFor="pj-dod">Definition of done</label>
        <textarea id="pj-dod" rows={2} value={d.definition_of_done} onChange={(e) => set({ definition_of_done: e.target.value })} placeholder="One sentence you can check. The project is done when..." />
      </div>
      <div>
        <label htmlFor="pj-parts">Parts, one per line ("2 x 10k resistor")</label>
        <textarea id="pj-parts" rows={4} value={d.parts} onChange={(e) => set({ parts: e.target.value })} className="mono" spellCheck={false} />
        {parsed.length > 0 && (
          <div className="muted small">
            {parsed.length} part{parsed.length === 1 ? "" : "s"}: {parsed.map((p) => `${p.qty} x ${p.name}`).join(", ")}
          </div>
        )}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !d.name.trim()}>
          {project ? "Save" : "Create"}
        </button>
        <button type="button" className="ghost" onClick={() => (onDone ? onDone() : go("/projects"))}>
          Cancel
        </button>
        {project && (
          <button type="button" className="ghost danger" onClick={() => confirm("Delete this project") && softDelete(project).then(() => go("/projects"))}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

function useSummary(id: string): { summary: ProjectSummary | null; err: string; reload: () => void } {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub for the plan, parts and session history.");
      return;
    }
    let alive = true;
    c.projectSummary(id)
      .then((s) => {
        if (!alive) return;
        setSummary(s);
        setErr("");
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, n]);
  return { summary, err, reload: useCallback(() => setN((x) => x + 1), []) };
}

const WEEK = 7 * 86400_000;

function ProjectPage({ id }: { id: string }) {
  const project = useEntity(id);
  const f = project?.fields as ProjectF | undefined;
  const name = f?.name ?? "";
  const { summary, err, reload } = useSummary(id);
  const tasks = useEntities("task", (e) => e.fields.project_id === id, [id]);
  const inventory = useEntities("inventory");
  const procedures = useEntities("procedure", (e) => e.fields.project_id === id, [id]);
  const music = useEntities("music_idea", (e) => e.fields.project_id === id, [id]);
  const notes = useEntities("note", (e) => String(e.fields.path ?? "").startsWith(`Projects/${name}/`), [name]);
  const [editing, setEditing] = useState(false);
  const [dod, setDod] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEscape(
    useCallback(() => {
      setEditing(false);
      setPlanOpen(false);
    }, []),
  );

  const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => Number(a.fields.order) - Number(b.fields.order));
  const doing = tasks.filter((t) => t.fields.status === "doing");
  const done7 = tasks
    .filter((t) => t.fields.status === "done" && Date.now() - new Date(String(t.fields.done_at ?? t.updated_at)).getTime() < WEEK)
    .sort((a, b) => (String(a.fields.done_at ?? a.updated_at) > String(b.fields.done_at ?? b.updated_at) ? -1 : 1));
  const planLocal = notes.find((n) => n.fields.path === `Projects/${name}/Plan.md`);
  const plan = planLocal ?? summary?.plan_note ?? null;
  const otherNotes = notes.filter((n) => n.id !== plan?.id);
  const parts = useMemo(() => summary?.parts ?? partRows(f?.parts, inventory), [summary, f?.parts, inventory]);
  const totals = partTotals(parts);
  const missingTitles = missingPartTasks(parts);

  if (!project || !f) return <div className="empty">Project not found.</div>;
  if (editing) return <ProjectForm project={project} onDone={() => setEditing(false)} />;

  const addTask = async () => {
    const t = quick.trim();
    if (!t) return;
    const maxOrder = Math.max(0, ...next.map((x) => Number(x.fields.order) || 0));
    await createEntity("task", { title: t, status: "next", order: maxOrder + 1, project_id: id });
    setQuick("");
  };

  const addMissing = async () => {
    setBusy(true);
    try {
      const have = new Set(tasks.filter((t) => t.fields.status !== "done").map((t) => String(t.fields.title).toLowerCase()));
      let n = 0;
      for (const title of missingTitles) {
        if (have.has(title.toLowerCase())) continue;
        await createEntity("task", { title, status: "inbox", order: Date.now() + n, project_id: id });
        n++;
      }
      setMsg(n ? `${n} task${n === 1 ? "" : "s"} added to the inbox.` : "Those tasks already exist.");
    } finally {
      setBusy(false);
    }
  };

  const saveDod = async () => {
    if (dod === null || dod.trim() === f.definition_of_done) {
      setDod(null);
      return;
    }
    await updateEntity(project, { definition_of_done: dod.trim() });
    setDod(null);
  };

  return (
    <div className="project-page">
      <div className="row between">
        <div className="row">
          <h1 style={{ margin: 0 }}>{f.name}</h1>
          <StatusChip status={f.status} />
        </div>
        <div className="row">
          <button className="small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <a href="#/projects" className="small">
            all projects
          </a>
        </div>
      </div>

      <div className="callout resume" role="note" aria-label="Where I left off" style={{ marginTop: 12 }}>
        <div className="row between">
          <strong>Where I left off</strong>
          <span className="muted small">{project.field_ts?.resume_card ? `updated ${relative(project.field_ts.resume_card)}` : ""}</span>
        </div>
        {f.resume_card?.trim() ? <Markdown text={f.resume_card} images="link" /> : <div className="muted small">No resume card yet. Close an assistant session with this project selected and one is written here.</div>}
      </div>
      {err && <div className="muted small">{err}</div>}
      {f.activity && <Activity a={f.activity} at={f.activity_at} />}

      <section style={{ marginTop: 16 }}>
        <h2>Definition of done</h2>
        <div className="row">
          <input
            className="grow"
            value={dod ?? f.definition_of_done}
            onChange={(e) => setDod(e.target.value)}
            onBlur={() => void saveDod()}
            onKeyDown={(e) => e.key === "Enter" && void saveDod()}
            aria-label="Definition of done"
            placeholder="The project is done when..."
          />
          {dod !== null && (
            <button className="small primary" onClick={() => void saveDod()}>
              Save
            </button>
          )}
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>Tasks</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void addTask();
          }}
        >
          <input className="grow" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Add a next task for this project" aria-label="New task" />
          <button className="small" type="submit" disabled={!quick.trim()}>
            Add
          </button>
        </form>
        <TaskGroup label="Doing" items={doing} />
        <TaskGroup label="Next" items={next} />
        <TaskGroup label="Done, last 7 days" items={done7} muted />
        {!tasks.length && <div className="muted small" style={{ marginTop: 6 }}>No tasks yet.</div>}
      </section>

      <section style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Plan</h2>
          <div className="row">
            {plan && (
              <a href={`#/notes/${plan.id}`} className="small">
                open note
              </a>
            )}
            {!planOpen && (
              <button className="small primary" onClick={() => setPlanOpen(true)}>
                Update plan
              </button>
            )}
          </div>
        </div>
        {planOpen && (
          <PlanForm
            id={id}
            onDone={(note) => {
              setPlanOpen(false);
              if (note) void refetchAll([note.id]).then(reload);
            }}
          />
        )}
        {plan ? (
          <div className="card" style={{ marginTop: 8 }}>
            <Markdown text={String(plan.fields.body ?? "")} images="link" />
          </div>
        ) : (
          <div className="muted small" style={{ marginTop: 6 }}>
            No plan yet. Update plan writes Projects/{name}/Plan.md with Goal, Definition of done, Current state, Next, Parts and Log.
          </div>
        )}
      </section>

      <section style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Parts</h2>
          <div className="row">
            <a href="#/projects/inventory" className="small">
              inventory
            </a>
            {missingTitles.length > 0 && (
              <button className="small primary" onClick={() => void addMissing()} disabled={busy}>
                Add missing to tasks
              </button>
            )}
          </div>
        </div>
        {!parts.length && <div className="muted small" style={{ marginTop: 6 }}>No parts listed. Edit the project to add rows.</div>}
        {parts.length > 0 && (
          <>
            <div className="muted small" style={{ marginTop: 4 }}>
              {totals.have} have, {totals.missing} missing
            </div>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="cmds parts">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Need</th>
                    <th scope="col">Have</th>
                    <th scope="col">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p, i) => (
                    <tr key={i} className={p.missing > 0 ? "missing" : "have"}>
                      <td>
                        {p.inventory_id ? (
                          <a href={`#/projects/inventory?q=${encodeURIComponent(p.name)}`} style={{ color: "inherit" }}>
                            {p.name}
                          </a>
                        ) : (
                          p.name
                        )}
                      </td>
                      <td className="mono">{p.qty}</td>
                      <td className="mono">{p.have}</td>
                      <td className="mono">{p.missing > 0 ? <span className="warn">{p.missing}</span> : <span className="ok">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {msg && <div className="ok" style={{ marginTop: 6 }}>{msg}</div>}
      </section>

      <section style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Procedures</h2>
          <a href={`#/procedures/new?project=${encodeURIComponent(id)}`} className="small">
            new procedure
          </a>
        </div>
        {!procedures.length && <div className="muted small" style={{ marginTop: 6 }}>None linked.</div>}
        <div className="list" style={{ marginTop: 6 }}>
          {procedures.map((p) => {
            const pf = p.fields as ProcedureF;
            const pr = procedureProgress(pf);
            return (
              <a key={p.id} href={`#/procedures/${p.id}`} className="item" style={{ color: "inherit" }}>
                <div className="body">
                  <div className="t">{pf.title}</div>
                  <div className="meta">
                    <span>{pr.done ? "finished" : `step ${pr.current + 1} of ${pr.total}`}</span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>Music</h2>
        {!music.length && <div className="muted small">None linked.</div>}
        <div className="list" style={{ marginTop: 6 }}>
          {music.map((m) => {
            const mf = m.fields as MusicF;
            return (
              <a key={m.id} href={`#/music/${m.id}`} className="item" style={{ color: "inherit" }}>
                <div className="body">
                  <div className="row">
                    <span className="chip static">{mf.type}</span>
                    <span className="t grow">{mf.title}</span>
                    <span className="chip static">{mf.status}</span>
                  </div>
                  <div className="meta">
                    {musicMeta(mf).map((x) => (
                      <span key={x}>{x}</span>
                    ))}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>Notes</h2>
        <div className="muted small">Projects/{name}/</div>
        {!otherNotes.length && <div className="muted small">No other notes in this folder.</div>}
        <div className="list" style={{ marginTop: 6 }}>
          {otherNotes.map((n) => (
            <a key={n.id} href={`#/notes/${n.id}`} className="item" style={{ color: "inherit" }}>
              <div className="body">
                <div className="t">{String(n.fields.title)}</div>
                <div className="meta">
                  <span>{fmtDateTime(n.updated_at)}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function TaskGroup({ label, items, muted }: { label: string; items: Entity[]; muted?: boolean }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted small">{label}</div>
      <div className="list" style={{ marginTop: 4 }}>
        {items.map((t) => (
          <a key={t.id} href={`#/tasks?focus=${encodeURIComponent(t.id)}`} className={`item ${muted ? "off" : ""}`} style={{ color: "inherit", opacity: muted ? 0.7 : 1 }}>
            <div className="body">
              <div className="t">{String(t.fields.title)}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

/** Goal, current state, next and a log line for POST /projects/:id/plan. Empty fields are left out, so they keep what the note has. */
function PlanForm({ id, onDone }: { id: string; onDone: (note: Entity | null) => void }) {
  const [goal, setGoal] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const any = !!(goal.trim() || current.trim() || next.trim() || log.trim());
  const submit = async () => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const sections: Record<string, string> = {};
      if (goal.trim()) sections.goal = goal.trim();
      if (current.trim()) sections.current = current.trim();
      if (next.trim()) sections.next = next.trim();
      if (log.trim()) sections.log_line = log.trim();
      const note = await c.projectPlan(id, sections);
      onDone(note);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card col"
      style={{ marginTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <label htmlFor="pl-goal">Goal</label>
        <input id="pl-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="unchanged" />
      </div>
      <div>
        <label htmlFor="pl-current">Current state</label>
        <textarea id="pl-current" rows={2} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="unchanged" />
      </div>
      <div>
        <label htmlFor="pl-next">Next</label>
        <textarea id="pl-next" rows={2} value={next} onChange={(e) => setNext(e.target.value)} placeholder="unchanged" />
      </div>
      <div>
        <label htmlFor="pl-log">Log line (dated, appended)</label>
        <input id="pl-log" value={log} onChange={(e) => setLog(e.target.value)} placeholder="what happened today" />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !any}>
          Save plan
        </button>
        <button type="button" className="ghost" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What Codex and the repo last did on this project, from the project feed. */
function Activity({ a, at }: { a: NonNullable<ProjectF["activity"]>; at?: string }) {
  const r = a.repo;
  return (
    <section style={{ marginTop: 16 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Activity</h2>
        <span className="muted small">{at ? `latest ${relative(at)}` : ""}{a.source ? `, from ${a.source}` : ""}</span>
      </div>
      <div className="list" style={{ marginTop: 6 }}>
        {(a.threads ?? []).map((t) => (
          <details key={t.title + t.updated_at} className="item">
            <summary className="row between">
              <span className="t">{t.title}</span>
              <span className="muted small">{relative(t.updated_at)}</span>
            </summary>
            {t.last_message && <Markdown text={t.last_message} images="link" />}
          </details>
        ))}
      </div>
      {r?.last_commit_at && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {r.branch ? <span className="mono">{r.branch}</span> : null}
          {r.branch ? ", " : ""}
          {r.uncommitted ? `${r.uncommitted} files changed since the last commit (${fmtDateTime(r.last_commit_at)})` : `last commit ${fmtDateTime(r.last_commit_at)}`}
          {r.last_edit_at ? `, last edit ${relative(r.last_edit_at)}` : ""}
        </div>
      )}
    </section>
  );
}
