import { useEffect, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, softDelete, updateEntity } from "../sync/edits";
import { CLOSED_STAGES, STAGES, guardNames, type ApplicationF, type Stage } from "../lib/admin";
import { fmtDateTime, fromLocalInput, toLocalInput } from "../lib/time";
import { localDate, parseDue } from "../lib/planner";
import { go } from "../lib/router";
import { CsvButton } from "../components/CsvButton";

/** Job applications: a list inside Lists, added here or by the assistant. */
export function JobApplications({ id }: { id?: string }) {
  return id ? <Application id={id} /> : <JobList />;
}


/** Newest first by when it was applied for, or saved. */
const newest = (a: Entity, b: Entity) => String(b.fields.applied_at ?? b.created_at).localeCompare(String(a.fields.applied_at ?? a.created_at));

function Row({ e }: { e: Entity }) {
  const f = e.fields as ApplicationF;
  const when = f.applied_at ? `applied ${new Date(f.applied_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "saved";
  return (
    <a href={`#/lists/jobs/${e.id}`} className="item" style={{ color: "inherit" }}>
      <div className="body">
        <div className="row between">
          <span className="t">
            {f.role}, <strong>{f.company}</strong>
          </span>
          <span className="chip static">{f.stage}</span>
        </div>
        <div className="meta">
          <span>{when}</span>
          {(f.next_step || f.next_at) && <span>next: {f.next_step ?? "follow up"}{f.next_at ? `, ${fmtDateTime(f.next_at)}` : ""}</span>}
        </div>
      </div>
    </a>
  );
}

function JobList() {
  const apps = useEntities("application");
  const open = apps.filter((e) => !CLOSED_STAGES.includes(e.fields.stage as Stage)).sort(newest);
  const closed = apps.filter((e) => CLOSED_STAGES.includes(e.fields.stage as Stage)).sort(newest);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");

  const add = async () => {
    if (!company.trim() || !role.trim()) return;
    await createEntity("application", { company: company.trim(), role: role.trim(), stage: "applied", applied_at: new Date().toISOString() });
    setCompany("");
    setRole("");
  };

  return (
    <div className="col career">
      <span className="title-row"><h1 style={{ margin: 0 }}>Job applications</h1><CsvButton kind="application" /></span>
      <form
        className="row quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" />
        <input placeholder="Role" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" />
        <button className="primary" type="submit" disabled={!company.trim() || !role.trim()}>
          Add
        </button>
      </form>
      <div className="muted small">Or tell the assistant: "applied to the SRE role at Globex".</div>
      <div className="list">
        {open.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </div>
      {closed.length > 0 && (
        <details>
          <summary>Closed ({closed.length})</summary>
          <div className="list">
            {closed.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </div>
        </details>
      )}
      {!apps.length && <div className="empty">No applications yet.</div>}
    </div>
  );
}

const TONES = ["plain", "warm", "direct"] as const;

/** A text field saved through the entity path when it loses focus, only when it changed. */
function Field({ e, k, label, type = "text", multiline }: { e: Entity; k: keyof ApplicationF; label: string; type?: string; multiline?: boolean }) {
  const raw = (e.fields as Record<string, unknown>)[k];
  const toInput = (v: unknown) => (v == null ? "" : type === "datetime-local" ? toLocalInput(String(v)) : type === "date" ? localDate(parseDue(String(v))) : String(v));
  const [v, setV] = useState(toInput(raw));
  useEffect(() => setV(toInput(raw)), [raw]);
  const save = () => {
    if (v === toInput(raw)) return;
    let out: unknown = v.trim() || null;
    if (out && type === "datetime-local") out = fromLocalInput(v) ?? null;
    if (out && type === "date") out = new Date(`${v}T12:00:00`).toISOString();
    void updateEntity(e, { [k]: out });
  };
  const id = `app-${String(k)}`;
  return (
    <div className={multiline ? "full" : ""}>
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea id={id} rows={4} value={v} onChange={(x) => setV(x.target.value)} onBlur={save} /> : <input id={id} type={type} value={v} onChange={(x) => setV(x.target.value)} onBlur={save} />}
    </div>
  );
}

function Application({ id }: { id: string }) {
  const e = useEntity(id);
  const [missing, setMissing] = useState(false);
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
  if (!e || e.deleted_at) return <div className="empty">{missing ? "Application not found." : "Loading"}</div>;
  const f = e.fields as ApplicationF;

  return (
    <div className="career">
      <div className="row between">
        <div>
          <h1 style={{ margin: 0 }}>{f.company}</h1>
          <div className="muted">{f.role}</div>
        </div>
        <a href="#/lists/jobs" className="small">
          all applications
        </a>
      </div>
      <div className="chips" role="group" aria-label="Stage" style={{ margin: "12px 0" }}>
        {STAGES.map((s) => (
          <button key={s} type="button" className={`chip ${f.stage === s ? "on" : ""}`} aria-pressed={f.stage === s} onClick={() => f.stage !== s && void updateEntity(e, { stage: s as Stage })}>
            {s}
          </button>
        ))}
      </div>
      <div className="card app-form">
        <Field e={e} k="company" label="Company" />
        <Field e={e} k="role" label="Role" />
        <Field e={e} k="applied_at" label="Applied" type="date" />
        <Field e={e} k="salary" label="Salary" />
        <Field e={e} k="next_step" label="Next step" />
        <Field e={e} k="next_at" label="Next date" type="datetime-local" />
        <div>
          <label>Remote</label>
          <div className="chips" role="group" aria-label="Remote">
            {(["remote", "hybrid", "onsite"] as const).map((r) => (
              <button key={r} type="button" className={`chip ${f.remote === r ? "on" : ""}`} aria-pressed={f.remote === r} onClick={() => void updateEntity(e, { remote: f.remote === r ? null : r })}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <Field e={e} k="url" label="URL" type="url" />
        <Field e={e} k="notes" label="Notes" multiline />
        {f.url && (
          <div className="full small">
            <a href={f.url} target="_blank" rel="noreferrer">
              Open the posting
            </a>
          </div>
        )}
      </div>
      <CoverLetter e={e} />
      <div className="actions">
        <button className="ghost danger small" onClick={() => confirm("Delete this application") && softDelete(e).then(() => go("/lists/jobs"))}>
          Delete
        </button>
      </div>
    </div>
  );
}

function CoverLetter({ e }: { e: Entity }) {
  const f = e.fields as ApplicationF;
  const [job, setJob] = useState("");
  const [tone, setTone] = useState<(typeof TONES)[number]>("plain");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "muted"; text: string } | null>(null);

  const draft = async () => {
    const c = engine.client;
    if (!c) {
      setMsg({ tone: "error", text: "Needs the hub." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await c.coverLetter(e.id, { job_text: job.trim() || undefined, tone });
      await engine.absorb([r.note]);
      setMsg({ tone: "ok", text: `Drafted with ${r.backend}. Saved as a note.` });
    } catch (x) {
      if (x instanceof HubError && x.status === 503) setMsg({ tone: "muted", text: "No model reachable. Try again when the model host is up." });
      else if (x instanceof HubError && x.status === 422) {
        const names = guardNames(x.detail);
        setMsg({ tone: "error", text: names.length ? `The draft named employers not in your facts or the job text: ${names.join(", ")}. Nothing was saved.` : `${x.message}. Nothing was saved.` });
      } else if (x instanceof HubError) setMsg({ tone: "error", text: x.message });
      else setMsg({ tone: "error", text: "Hub unreachable. Drafting needs the hub." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card col" style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0 }}>Draft cover letter</h2>
      <textarea rows={5} placeholder="Paste the job text (optional)" value={job} onChange={(x) => setJob(x.target.value)} aria-label="Job text" />
      <div className="row">
        <div className="chips" role="group" aria-label="Tone">
          {TONES.map((t) => (
            <button key={t} type="button" className={`chip ${tone === t ? "on" : ""}`} aria-pressed={tone === t} onClick={() => setTone(t)}>
              {t}
            </button>
          ))}
        </div>
        <button className="primary" onClick={() => void draft()} disabled={busy}>
          {busy ? "Drafting" : "Draft"}
        </button>
      </div>
      {msg && <div className={msg.tone === "muted" ? "muted small" : msg.tone}>{msg.text}</div>}
      {f.letter_note_id && (
        <a href={`#/notes/${f.letter_note_id}`} className="small">
          Open the saved letter
        </a>
      )}
      {!f.letter_note_id && !msg && <div className="muted small">Uses only your identity and history facts and the job text.</div>}
    </div>
  );
}
