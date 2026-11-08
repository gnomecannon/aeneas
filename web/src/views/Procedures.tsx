import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { copyText } from "../sync/memory";
import { celebrate } from "../feel/events";
import { go } from "../lib/router";
import { relative } from "../lib/time";
import { advanceProcedure, procedureProgress, stepsFromText, type ProcedureF, type ProjectF } from "../lib/creative";

export function Procedures({ id }: { id?: string }) {
  if (id === "new") return <NewProcedure />;
  if (id) return <Runner id={id} />;
  return <ProcedureList />;
}

function ProcedureList() {
  const all = useEntities("procedure");
  const projects = useEntities("project");
  const nameOf = (pid?: string) => (pid ? String(projects.find((p) => p.id === pid)?.fields.name ?? "") : "");
  const open = all.filter((e) => !e.fields.done_at).sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  const done = all.filter((e) => !!e.fields.done_at).sort((a, b) => (String(a.fields.done_at) > String(b.fields.done_at) ? -1 : 1));
  const Row = ({ e }: { e: Entity }) => {
    const f = e.fields as ProcedureF;
    const p = procedureProgress(f);
    const project = nameOf(f.project_id);
    return (
      <a href={`#/procedures/${e.id}`} className="item" style={{ color: "inherit" }}>
        <div className="body">
          <div className="t">{f.title}</div>
          <div className="meta">
            <span>{p.done ? `finished ${relative(String(f.done_at))}` : `step ${p.current + 1} of ${p.total}`}</span>
            {f.steps[p.current]?.host && <span className="mono">{f.steps[p.current].host}</span>}
            {project && <span>{project}</span>}
          </div>
        </div>
      </a>
    );
  };
  return (
    <div>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Procedures</h1>
        <button className="small primary" onClick={() => go("/procedures/new")}>
          New from text
        </button>
      </div>
      {!open.length && <div className="empty">No open procedures. Paste steps from anywhere, or ask the assistant for numbered steps and press Run as procedure.</div>}
      <div className="list" style={{ marginTop: 10 }}>
        {open.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </div>
      {done.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>Finished ({done.length})</summary>
          <div className="list">
            {done.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Paste steps from anywhere. The hub splits them (a model when available); offline, the same rule-based split runs here. */
function NewProcedure() {
  const projects = useEntities("project", (e) => e.fields.status !== "done");
  const initialProject = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("project") ?? "";
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [host, setHost] = useState("");
  const [project, setProject] = useState(initialProject);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const preview = useMemo(() => stepsFromText(text, host.trim() || undefined), [text, host]);

  const create = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const body: { text: string; title?: string; host?: string; project_id?: string } = { text: text.trim() };
      if (title.trim()) body.title = title.trim();
      if (host.trim()) body.host = host.trim();
      if (project) body.project_id = project;
      let e: Entity;
      if (engine.client) {
        try {
          e = await engine.client.procedureFromText(body);
          await engine.absorb([e]);
        } catch (err) {
          if (err instanceof HubError) throw err;
          e = await createLocal(body, preview);
        }
      } else e = await createLocal(body, preview);
      go(`/procedures/${e.id}`);
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
        void create();
      }}
    >
      <div className="row between">
        <h1 style={{ margin: 0 }}>New procedure</h1>
        <a href="#/procedures" className="small">
          all procedures
        </a>
      </div>
      <div>
        <label htmlFor="np-text">Steps, pasted from anywhere. Numbered or bulleted lines, fenced blocks become commands.</label>
        <textarea id="np-text" rows={10} value={text} onChange={(e) => setText(e.target.value)} className="mono" spellCheck={false} autoFocus placeholder={"1. Snapshot first\n```\nzfs snapshot tank/scratch@pre\n```\n2. Verify with `zfs list -r tank/scratch`"} />
      </div>
      <div className="row">
        <div className="grow">
          <label htmlFor="np-title">Title</label>
          <input id="np-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="optional, first line otherwise" />
        </div>
        <div>
          <label htmlFor="np-host">Host</label>
          <input id="np-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="optional" className="mono" autoCapitalize="off" />
        </div>
        <div>
          <label htmlFor="np-project">Project</label>
          <select id="np-project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">none</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.fields as ProjectF).name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {preview.length > 0 && (
        <div className="muted small">
          {preview.length} step{preview.length === 1 ? "" : "s"}, {preview.filter((s) => s.command).length} with a command
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !preview.length}>
          Create
        </button>
        <button type="button" className="ghost" onClick={() => go("/procedures")}>
          Cancel
        </button>
      </div>
    </form>
  );
}

async function createLocal(body: { text: string; title?: string; host?: string; project_id?: string }, steps: ReturnType<typeof stepsFromText>): Promise<Entity> {
  const fields: Record<string, unknown> = { title: body.title ?? steps[0]?.text.slice(0, 80) ?? "Procedure", steps, current: 0 };
  if (body.project_id) fields.project_id = body.project_id;
  return createEntity("procedure", fields);
}

/** Exactly one step on screen. Done advances, Back steps back without clearing, Reset starts over. */
function Runner({ id }: { id: string }) {
  const e = useEntity(id);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const projects = useEntities("project");

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

  if (!e) return <div className="empty">{missing ? "Procedure not found." : "Loading"}</div>;
  const f = e.fields as ProcedureF;
  const p = procedureProgress(f);
  const step = f.steps[p.current];
  const project = f.project_id ? projects.find((x) => x.id === f.project_id) : undefined;

  const act = async (action: "done" | "back" | "reset") => {
    setBusy(true);
    setErr("");
    try {
      const c = engine.client;
      if (c) {
        try {
          // `step` names the step on screen, so a request sent again after a lost reply changes nothing.
          const step = Number(f.current ?? 0);
          const out = action === "reset" ? await c.procedureReset(id) : await c.procedureAdvance(id, action === "done" ? { done: true, step } : { back: true, step });
          await engine.absorb([out]);
          if (action === "done") celebrate("complete");
          return;
        } catch (err) {
          if (err instanceof HubError) throw err;
        }
      }
      const patch = advanceProcedure(f, action);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) fields[k] = v === undefined ? null : v;
      if (Object.keys(fields).length) await updateEntity(e, fields);
      if (action === "done") celebrate("complete");
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="runner">
      <div className="row between">
        <div>
          <h1 style={{ margin: 0 }}>{f.title}</h1>
          <div className="muted small">
            {project && (
              <a href={`#/projects/${project.id}`} style={{ marginRight: 8 }}>
                {(project.fields as ProjectF).name}
              </a>
            )}
            {f.started_at ? `started ${relative(f.started_at)}` : "not started"}
          </div>
        </div>
        <a href="#/procedures" className="small">
          all procedures
        </a>
      </div>

      {p.done ? (
        <div className="card big" style={{ marginTop: 12 }}>
          <div className="title">Finished</div>
          <div className="muted">
            {p.total} step{p.total === 1 ? "" : "s"} done{f.done_at ? `, ${relative(f.done_at)}` : ""}.
          </div>
          <div className="actions">
            <button onClick={() => void act("reset")} disabled={busy}>
              Reset
            </button>
            <button className="ghost danger" onClick={() => confirm("Delete this procedure") && softDelete(e).then(() => go("/procedures"))}>
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="card big step" style={{ marginTop: 12 }}>
          <div className="muted small progress">
            step {p.current + 1} of {p.total}
          </div>
          <div className="title">{step.text}</div>
          {(step.host || step.user) && (
            <div className="mono muted small">
              {step.user ? `${step.user}@` : ""}
              {step.host ?? ""}
            </div>
          )}
          {step.command && (
            <div className="cmd-block">
              <pre className="mono">{step.command}</pre>
              <button
                className="small"
                onClick={() =>
                  copyText(step.command!).then((ok) => {
                    setCopied(ok);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
                aria-label="Copy the command"
              >
                {copied ? "copied" : "Copy"}
              </button>
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="actions runner-actions">
            <button className="primary done" onClick={() => void act("done")} disabled={busy}>
              Done
            </button>
            <button className="small ghost" onClick={() => void act("back")} disabled={busy || p.current === 0}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
