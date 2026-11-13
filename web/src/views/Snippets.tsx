import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { copyText } from "../sync/memory";
import { keepTyped, paramNames, renderDefaults, renderSnippet, snippetSegments, type SnippetF, type SnippetParam } from "../lib/memory";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { CsvButton } from "../components/CsvButton";

/** The parameter names a 422 from render or run names: the hub sends `{ missing: [...] }`. */
const missingParams = (d: unknown): string[] | null =>
  Array.isArray(d) ? (d as string[]) : d && typeof d === "object" && Array.isArray((d as { missing?: unknown }).missing) ? (d as { missing: string[] }).missing : null;

const OSES = ["linux", "windows", "macos", "any"] as const;
const LANGS = ["bash", "powershell", "python", "sql", "text"];

export function Snippets({ id, host }: { id?: string; host?: string | null }) {
  if (id === "new") return <SnippetForm host={host ?? undefined} />;
  if (id) return <SnippetPage id={id} />;
  return <SnippetList />;
}

function SnippetList() {
  const snippets = useEntities("snippet");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set(snippets.flatMap((s) => (s.fields as SnippetF).tags ?? []))].sort(), [snippets]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return snippets.filter((e) => {
      const f = e.fields as SnippetF;
      if (tag && !(f.tags ?? []).includes(tag)) return false;
      if (!s) return true;
      return f.title.toLowerCase().includes(s) || f.body.toLowerCase().includes(s) || (f.host ?? "").toLowerCase().includes(s) || (f.tags ?? []).some((t) => t.toLowerCase().includes(s));
    });
  }, [snippets, q, tag]);
  const groups = OSES.map((os) => [os, shown.filter((e) => (e.fields as SnippetF).os === os).sort((a, b) => String(a.fields.title).localeCompare(String(b.fields.title)))] as const).filter(([, v]) => v.length);

  return (
    <div>
      <div className="row between">
        <span className="title-row"><h1 style={{ margin: 0 }}>Snippets</h1><CsvButton kind="snippet" /></span>
        <button className="small primary" onClick={() => go("/snippets/new")}>
          New
        </button>
      </div>
      <input className="grow" style={{ marginTop: 10 }} placeholder="Search title, body, host, tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search snippets" />
      {tags.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }} aria-label="Tag filter">
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? "on" : ""}`} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      {!snippets.length && <div className="empty">No snippets. Save a command once, with its parameters at the top, and render it next time.</div>}
      {snippets.length > 0 && !shown.length && <div className="empty">Nothing matches.</div>}
      {groups.map(([os, items]) => (
        <section key={os} style={{ marginTop: 14 }}>
          <h3>
            {os} ({items.length})
          </h3>
          <div className="list">
            {items.map((e) => {
              const f = e.fields as SnippetF;
              return (
                <a key={e.id} href={`#/snippets/${e.id}`} className="item" style={{ color: "inherit" }}>
                  <div className="body">
                    <div className="t">{f.title}</div>
                    <div className="meta">
                      <span>{f.language}</span>
                      {f.host && <span className="mono">{f.host}</span>}
                      {paramNames(f.body).length > 0 && <span>{paramNames(f.body).length} params</span>}
                      {(f.tags ?? []).map((t) => (
                        <span key={t}>#{t}</span>
                      ))}
                      {f.last_used && <span>used {fmtDateTime(f.last_used)}</span>}
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The body with every `{{name}}` highlighted. */
export function SnippetBody({ body }: { body: string }) {
  return (
    <pre className="snippet-body">
      {snippetSegments(body).map((s, i) =>
        s.param ? (
          <mark key={i} className="param" data-param={s.param}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </pre>
  );
}

function SnippetPage({ id }: { id: string }) {
  const e = useEntity(id);
  const [editing, setEditing] = useState(false);
  if (!e) return <div className="empty">Snippet not found.</div>;
  if (editing) return <SnippetForm entity={e} onDone={() => setEditing(false)} />;
  const f = e.fields as SnippetF;
  return (
    <div className="col">
      <div className="row between">
        <h1 style={{ margin: 0 }}>{f.title}</h1>
        <div className="row">
          <button className="small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <a href="#/snippets" className="small">
            all snippets
          </a>
        </div>
      </div>
      <div className="meta small muted row">
        <span className="chip static">{f.os}</span>
        <span className="chip static">{f.language}</span>
        {f.host && (
          <a href={`#/hosts/${encodeURIComponent(f.host)}`} className="mono">
            {f.host}
          </a>
        )}
        {(f.tags ?? []).map((t) => (
          <span key={t}>#{t}</span>
        ))}
        {f.last_used && <span>used {fmtDateTime(f.last_used)}</span>}
      </div>
      <SnippetBody body={f.body} />
      <RenderForm e={e} />
    </div>
  );
}

function RenderForm({ e }: { e: Entity }) {
  const f = e.fields as SnippetF;
  const [rows, setRows] = useState(() => renderDefaults(f));
  const [out, setOut] = useState<string | null>(null);
  const [ran, setRan] = useState<{ host: string; exit_code: number | null; output: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Shell snippets can be tried on their host: read-only ones run at once, others go through the assistant.
  const runnable = /^(bash|sh|shell|zsh|powershell|pwsh)$/i.test(f.language) && !!f.host;
  const [copied, setCopied] = useState(false);
  // Only a change to the body or the parameters changes the rows, and typed values stay.
  const shape = JSON.stringify([f.body, f.params ?? []]);
  useEffect(() => setRows((prev) => keepTyped(prev, f)), [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!engine.client) return;
    setBusy(true);
    setErr("");
    setRan(null);
    try {
      const r = await engine.client.snippetRun(e.id, Object.fromEntries(rows.map((x) => [x.name, x.value])));
      setOut(null);
      setRan(r);
      await engine.refetch(e.id).catch(() => undefined);
    } catch (x) {
      setErr(x instanceof HubError && x.status === 422 && missingParams(x.detail) ? `Missing ${missingParams(x.detail)!.join(", ")}` : x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  const render = async () => {
    setBusy(true);
    setErr("");
    setOut(null);
    setRan(null);
    const params = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    try {
      if (engine.client) {
        try {
          const r = await engine.client.snippetRender(e.id, params);
          setOut(r.text);
          await engine.refetch(e.id).catch(() => undefined);
          return;
        } catch (x) {
          if (x instanceof HubError) {
            setErr(x.status === 422 && missingParams(x.detail) ? `Missing ${missingParams(x.detail)!.join(", ")}` : x.message);
            return;
          }
        }
      }
      setOut(renderSnippet(f, params));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card col"
      onSubmit={(ev) => {
        ev.preventDefault();
        void render();
      }}
    >
      <strong>Render</strong>
      {!rows.length && <div className="muted small">No parameters. Render copies the body as is.</div>}
      {rows.map((r, i) => (
        <div key={r.name} className="row">
          <label htmlFor={`p-${r.name}`} className="mono" style={{ width: 110, margin: 0 }}>
            {r.name}
          </label>
          <input id={`p-${r.name}`} className="grow mono" value={r.value} onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)))} placeholder={r.description ?? ""} autoCapitalize="off" spellCheck={false} />
        </div>
      ))}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          Render
        </button>
        {runnable && (
          <button type="button" onClick={() => void run()} disabled={busy || !engine.client} title="Runs at once when it only reads; anything that changes the host goes through the assistant">
            Run on {f.host}
          </button>
        )}
        {err && <span className="error">{err}</span>}
      </div>
      {ran && (
        <div>
          <span className="muted small">
            ran on {ran.host}, exit {ran.exit_code ?? "none"}
          </span>
          <pre className="snippet-body result">{ran.output || "(no output)"}</pre>
        </div>
      )}
      {out !== null && (
        <div>
          <div className="row between">
            <span className="muted small">result</span>
            <button
              type="button"
              className="small"
              onClick={() =>
                copyText(out).then((ok) => {
                  setCopied(ok);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "copied" : "Copy"}
            </button>
          </div>
          <pre className="snippet-body result">{out}</pre>
        </div>
      )}
    </form>
  );
}

type Draft = { title: string; os: SnippetF["os"]; language: string; body: string; params: SnippetParam[]; tags: string; host: string };

function SnippetForm({ entity, host, onDone }: { entity?: Entity; host?: string; onDone?: () => void }) {
  const f = entity?.fields as SnippetF | undefined;
  const [d, setD] = useState<Draft>({ title: f?.title ?? "", os: f?.os ?? "linux", language: f?.language ?? "bash", body: f?.body ?? "", params: (f?.params ?? []).map((p) => ({ ...p })), tags: (f?.tags ?? []).join(", "), host: f?.host ?? host ?? "" });
  const [err, setErr] = useState("");
  const set = (k: keyof Draft) => (ev: { target: { value: string } }) => setD({ ...d, [k]: ev.target.value });
  const setParam = (i: number, patch: Partial<SnippetParam>) => setD({ ...d, params: d.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const undeclared = paramNames(d.body).filter((n) => !d.params.some((p) => p.name === n));
  const valid = !!d.title.trim() && !!d.body.trim() && !!d.language.trim();

  const save = async () => {
    setErr("");
    const fields: Record<string, unknown> = {
      title: d.title.trim(),
      os: d.os,
      language: d.language.trim(),
      body: d.body,
      params: d.params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), ...(p.default ? { default: p.default } : {}), ...(p.description ? { description: p.description } : {}) })),
      tags: d.tags
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean),
    };
    if (d.host.trim()) fields.host = d.host.trim();
    else if (entity) fields.host = null;
    try {
      if (entity) {
        await updateEntity(entity, fields);
        onDone?.();
      } else {
        const e = await createEntity("snippet", fields);
        go(`/snippets/${e.id}`);
      }
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };

  return (
    <form
      className="col"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (valid) void save();
      }}
    >
      <h1 style={{ margin: 0 }}>{entity ? "Edit snippet" : "New snippet"}</h1>
      <input value={d.title} onChange={set("title")} placeholder="Title" aria-label="Title" style={{ fontWeight: 600 }} />
      <div className="row">
        <div className="grow">
          <label htmlFor="s-os">OS</label>
          <select id="s-os" value={d.os} onChange={set("os")}>
            {OSES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="s-lang">Language</label>
          <input id="s-lang" list="s-langs" value={d.language} onChange={set("language")} autoCapitalize="off" />
          <datalist id="s-langs">
            {LANGS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
        <div className="grow">
          <label htmlFor="s-host">Host</label>
          <input id="s-host" value={d.host} onChange={set("host")} placeholder="optional" autoCapitalize="off" className="mono" />
        </div>
      </div>
      <div>
        <label htmlFor="s-body">Body. Parameters as {"{{name}}"}</label>
        <textarea id="s-body" className="mono" rows={8} value={d.body} onChange={set("body")} autoCapitalize="off" spellCheck={false} />
      </div>
      <div>
        <div className="row between">
          <strong className="small">Params</strong>
          <div className="row">
            {undeclared.length > 0 && (
              <button type="button" className="small ghost" onClick={() => setD({ ...d, params: [...d.params, ...undeclared.map((name) => ({ name }))] })}>
                Add {undeclared.join(", ")}
              </button>
            )}
            <button type="button" className="small" onClick={() => setD({ ...d, params: [...d.params, { name: "" }] })}>
              Add param
            </button>
          </div>
        </div>
        {d.params.map((p, i) => (
          <div key={i} className="cmd-row" style={{ marginTop: 6 }}>
            <input value={p.name} onChange={(ev) => setParam(i, { name: ev.target.value })} placeholder="name" aria-label={`Param ${i + 1} name`} className="mono" autoCapitalize="off" />
            <input value={p.default ?? ""} onChange={(ev) => setParam(i, { default: ev.target.value })} placeholder="default" aria-label={`Param ${i + 1} default`} className="mono" autoCapitalize="off" />
            <input value={p.description ?? ""} onChange={(ev) => setParam(i, { description: ev.target.value })} placeholder="description" aria-label={`Param ${i + 1} description`} />
            <button type="button" className="small ghost danger" onClick={() => setD({ ...d, params: d.params.filter((_, j) => j !== i) })} aria-label={`Remove param ${i + 1}`}>
              x
            </button>
          </div>
        ))}
      </div>
      <div>
        <label htmlFor="s-tags">Tags</label>
        <input id="s-tags" value={d.tags} onChange={set("tags")} placeholder="comma separated" />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={!valid}>
          Save
        </button>
        <button type="button" className="ghost" onClick={() => (onDone ? onDone() : go("/snippets"))}>
          Cancel
        </button>
        {entity && (
          <button type="button" className="ghost danger" onClick={() => confirm("Delete this snippet") && softDelete(entity).then(() => go("/snippets"))}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
