import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { engine } from "../sync/engine";
import { copyText } from "../sync/memory";
import { deriveHosts, type HostSummary, type RunbookCommand, type RunbookF, type SnippetF } from "../lib/memory";
import { Markdown } from "../components/Markdown";
import { go } from "../lib/router";
import { fmtDateTime, relative } from "../lib/time";
import { JournalEntry, JournalForm, byAtDesc } from "./Journal";

/** Hosts from the hub, else derived from what is synced locally. */
function useHosts(): { hosts: HostSummary[]; source: "hub" | "local" } {
  const runbooks = useEntities("runbook");
  const journal = useEntities("journal");
  const snippets = useEntities("snippet");
  const facts = useEntities("fact", (e) => /^host:/.test(String(e.fields.key ?? "")));
  const local = useMemo(() => deriveHosts([...runbooks, ...journal, ...snippets, ...facts]), [runbooks, journal, snippets, facts]);
  const [hub, setHub] = useState<HostSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    engine.client
      ?.hosts()
      .then((h) => alive && setHub(h))
      .catch(() => alive && setHub(null));
    return () => {
      alive = false;
    };
  }, [local]);
  return hub ? { hosts: hub, source: "hub" } : { hosts: local, source: "local" };
}

export function Hosts({ host, runbookId }: { host?: string; runbookId?: string | null }) {
  if (host) return <HostPage host={decodeURIComponent(host)} runbookId={runbookId ?? undefined} />;
  return <HostList />;
}

function HostList() {
  const { hosts, source } = useHosts();
  const [name, setName] = useState("");
  return (
    <div>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Machines</h1>
        <span className="muted small">{source}</span>
      </div>
      <p className="muted small" style={{ margin: "6px 0 0" }}>
        Every computer you run. Each one keeps fix notes (what broke on it and the exact steps that fixed it), a log of changes you made, and command snippets. The assistant writes the fix notes when you finish a troubleshooting chat, so the next time the answer is already here.
      </p>
      <form
        className="row"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          const h = name.trim().toLowerCase();
          if (h) go(`/hosts/${encodeURIComponent(h)}`);
        }}
      >
        <input className="grow" placeholder="Open or add a machine by name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Machine name" autoCapitalize="off" />
        <button className="small" type="submit" disabled={!name.trim()}>
          Open
        </button>
      </form>
      {!hosts.length && <div className="empty">No machines yet. A machine appears once it has fix notes, a logged change, a snippet or a fact about it.</div>}
      <div className="list" style={{ marginTop: 10 }}>
        {hosts.map((h) => (
          <a key={h.host} href={`#/hosts/${encodeURIComponent(h.host)}`} className="item host" style={{ color: "inherit" }}>
            <div className="body">
              <div className="t mono" style={{ fontWeight: 600 }}>
                {h.host}
              </div>
              <div className="meta">
                <span>{h.runbooks ? "fix notes" : "no fix notes"}</span>
                <span>{h.journal_entries} change{h.journal_entries === 1 ? "" : "s"}</span>
                <span>{h.snippets} snippet{h.snippets === 1 ? "" : "s"}</span>
                <span>{h.last_change ? `changed ${relative(h.last_change)}` : "no changes logged"}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function HostPage({ host, runbookId }: { host: string; runbookId?: string }) {
  const runbooks = useEntities("runbook", (e) => e.fields.host === host, [host]);
  const journal = useEntities("journal", (e) => e.fields.host === host, [host]);
  const snippets = useEntities("snippet", (e) => e.fields.host === host, [host]);
  const allJournal = useEntities("journal");
  const hosts = useMemo(() => [...new Set(allJournal.map((e) => String(e.fields.host)))].sort(), [allJournal]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (runbookId) document.getElementById(`runbook-${runbookId}`)?.scrollIntoView({ block: "start" });
  }, [runbookId, runbooks.length]);

  const newRunbook = async () => {
    const e = await createEntity("runbook", { host, title: `Fix notes: ${host}`, body: `# ${host}\n`, commands: [] });
    setEditing(e.id);
  };

  return (
    <div className="host-page">
      <div className="row between">
        <h1 style={{ margin: 0, fontFamily: "var(--mono)" }}>{host}</h1>
        <a href="#/hosts" className="small">
          all machines
        </a>
      </div>

      <section style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Fix notes</h2>
          {!runbooks.length && (
            <button className="small primary" onClick={() => void newRunbook()}>
              Start fix notes
            </button>
          )}
        </div>
        {!runbooks.length && <div className="muted small" style={{ marginTop: 6 }}>No fix notes for {host} yet. They are what broke on this machine and how it was fixed. The assistant writes them when you finish a troubleshooting chat about {host}, or start them yourself.</div>}
        {runbooks
          .slice()
          .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
          .map((rb) =>
            editing === rb.id ? <RunbookEditor key={rb.id} id={rb.id} onClose={() => setEditing(null)} /> : <RunbookView key={rb.id} rb={rb} onEdit={() => setEditing(rb.id)} focus={rb.id === runbookId} />,
          )}
      </section>

      <section style={{ marginTop: 20 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Journal</h2>
          {!adding && (
            <button className="small primary" onClick={() => setAdding(true)}>
              Add entry
            </button>
          )}
        </div>
        {adding && (
          <div style={{ marginTop: 8 }}>
            <JournalForm host={host} hosts={hosts} onDone={() => setAdding(false)} />
          </div>
        )}
        {!journal.length && <div className="muted small" style={{ marginTop: 6 }}>Nothing logged for {host}.</div>}
        <div className="list" style={{ marginTop: 8 }}>
          {journal
            .slice()
            .sort(byAtDesc)
            .map((e) => (
              <JournalEntry key={e.id} e={e} />
            ))}
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Snippets</h2>
          <a href={`#/snippets/new?host=${encodeURIComponent(host)}`} className="small">
            new snippet
          </a>
        </div>
        {!snippets.length && <div className="muted small" style={{ marginTop: 6 }}>No snippets tied to {host}.</div>}
        <div className="list" style={{ marginTop: 8 }}>
          {snippets.map((s) => {
            const f = s.fields as SnippetF;
            return (
              <a key={s.id} href={`#/snippets/${s.id}`} className="item" style={{ color: "inherit" }}>
                <div className="body">
                  <div className="t">{f.title}</div>
                  <div className="meta">
                    <span>{f.os}</span>
                    <span>{f.language}</span>
                    {(f.tags ?? []).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function CommandsTable({ commands }: { commands: RunbookCommand[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  if (!commands.length) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table className="cmds">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">User</th>
            <th scope="col">Command</th>
            <th scope="col">
              <span className="sr-only">Copy</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {commands.map((c, i) => (
            <tr key={i}>
              <td>{c.label}</td>
              <td className="mono">
                {c.user}
                {c.host ? `@${c.host}` : ""}
              </td>
              <td className="mono cmd">{c.command}</td>
              <td>
                <button
                  className="small ghost"
                  onClick={() =>
                    copyText(c.command).then((ok) => {
                      setCopied(ok ? i : null);
                      setTimeout(() => setCopied(null), 1500);
                    })
                  }
                  aria-label={`Copy ${c.label}`}
                >
                  {copied === i ? "copied" : "Copy"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunbookView({ rb, onEdit, focus }: { rb: Entity; onEdit: () => void; focus?: boolean }) {
  const f = rb.fields as RunbookF;
  return (
    <div id={`runbook-${rb.id}`} className={`card runbook ${focus ? "focus" : ""}`} style={{ marginTop: 8 }}>
      <div className="row between">
        <strong>{f.title}</strong>
        <div className="row">
          {f.last_verified && <span className="muted small">verified {fmtDateTime(f.last_verified)}</span>}
          <button className="small" onClick={onEdit} aria-label={`Edit ${f.title}`}>
            Edit
          </button>
        </div>
      </div>
      {f.body?.trim() ? <Markdown text={f.body} images="link" /> : <div className="muted small">Empty. Edit to write it.</div>}
      <CommandsTable commands={f.commands ?? []} />
    </div>
  );
}

type RunbookDraft = { title: string; body: string; commands: RunbookCommand[] };

/** The same plain textarea editor as Notes: edits save a second after the last keystroke. */
function RunbookEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const rb = useEntity(id);
  const [draft, setDraft] = useState<RunbookDraft | null>(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rb && !draft) {
      const f = rb.fields as RunbookF;
      setDraft({ title: f.title, body: f.body ?? "", commands: (f.commands ?? []).map((c) => ({ ...c })) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rb?.id]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const edit = (patch: Partial<RunbookDraft>) => {
    if (!draft || !rb) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(patch) as Array<keyof RunbookDraft>) fields[k] = next[k];
      void updateEntity(rb, fields).then(() => setSaved(true));
    }, 1000);
  };

  const setCmd = (i: number, patch: Partial<RunbookCommand>) => {
    if (!draft) return;
    edit({ commands: draft.commands.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  };

  if (!rb || !draft) return <div className="empty">Fix notes not found.</div>;
  const host = String(rb.fields.host);
  return (
    <div className="card col" style={{ marginTop: 8 }}>
      <input value={draft.title} onChange={(e) => edit({ title: e.target.value })} aria-label="Fix notes title" style={{ fontWeight: 600 }} />
      <textarea value={draft.body} onChange={(e) => edit({ body: e.target.value })} rows={14} className="mono" aria-label="Fix notes" placeholder="One section per problem: ## YYYY-MM-DD: what broke, then what fixed it" spellCheck={false} />
      <div>
        <div className="row between">
          <strong className="small">Commands</strong>
          <button className="small" onClick={() => edit({ commands: [...draft.commands, { label: "", host, user: "root", command: "" }] })}>
            Add command
          </button>
        </div>
        {draft.commands.map((c, i) => (
          <div key={i} className="cmd-row" style={{ marginTop: 6 }}>
            <input value={c.label} onChange={(e) => setCmd(i, { label: e.target.value })} placeholder="Label" aria-label={`Command ${i + 1} label`} />
            <input value={c.user} onChange={(e) => setCmd(i, { user: e.target.value })} placeholder="user" aria-label={`Command ${i + 1} user`} className="mono" autoCapitalize="off" />
            <input value={c.command} onChange={(e) => setCmd(i, { command: e.target.value })} placeholder="command" aria-label={`Command ${i + 1}`} className="mono" autoCapitalize="off" spellCheck={false} />
            <button className="small ghost danger" onClick={() => edit({ commands: draft.commands.filter((_, j) => j !== i) })} aria-label={`Remove command ${i + 1}`}>
              x
            </button>
          </div>
        ))}
      </div>
      <div className="row between small muted">
        <span>{saved ? `saved ${fmtDateTime(rb.updated_at)}` : "editing"}</span>
        <div className="row">
          <button className="small" onClick={onClose}>
            Done
          </button>
          <button className="small ghost danger" onClick={() => confirm("Delete these fix notes") && softDelete(rb).then(onClose)}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
