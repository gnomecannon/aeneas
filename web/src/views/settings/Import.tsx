import { useEffect, useState } from "react";
import type { ImportJob } from "../../sync/api";
import { engine } from "../../sync/engine";
import { SubPage, errorText } from "./common";

const ACTIVE = new Set(["waiting", "reading", "learning"]);

function summary(j: ImportJob): string {
  const c = j.counts;
  const parts = [
    c.notes && `${c.notes} note${c.notes === 1 ? "" : "s"}`, c.people && `${c.people} ${c.people === 1 ? "person" : "people"}`,
    c.tasks && `${c.tasks} task${c.tasks === 1 ? "" : "s"}`, c.facts && `${c.facts} fact${c.facts === 1 ? "" : "s"} learned`,
    c.skipped && `${c.skipped} already here`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing yet";
}

/**
 * Settings, Bring your data in: upload what other apps hold (a ChatGPT export, a Google Takeout, a notes folder or
 * Obsidian vault as a .zip, Evernote notebooks, text) or paste text, once. The hub sorts it into notes, people,
 * tasks and, when asked, facts about you.
 */
export function ImportPage() {
  const client = engine.client;
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [learn, setLearn] = useState(true);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => void client?.importJobs().then((r) => setJobs(r.jobs)).catch(() => undefined);
  useEffect(load, [client]);
  const running = jobs.some((j) => ACTIVE.has(j.state));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const send = async () => {
    setMsg(null);
    try {
      for (const f of files) {
        setBusy(`Uploading ${f.name}`);
        await client!.uploadImport(f, f.name, learn);
      }
      setFiles([]);
      setMsg({ ok: true, text: "Uploaded. The hub is sorting it; you can leave this page." });
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(""); load(); }
  };
  const paste = async () => {
    setBusy("Sending");
    try { await client!.importText(title.trim(), text, learn); setText(""); setTitle(""); setMsg({ ok: true, text: "Saved. The hub is sorting it." }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(""); load(); }
  };
  return (
    <SubPage path="/settings/import" title="Bring your data in">
      <section className="card col">
        <div className="muted small">
          Bring in what you already have, once. The hub reads it and files it: conversations and notes become notes you can search and the assistant can read, contacts become people, open tasks become tasks. Nothing already here is overwritten or doubled.
        </div>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>ChatGPT:</strong> Settings, Data controls, Export data. Upload the .zip from the email.</li>
          <li><strong>Google:</strong> takeout.google.com with Keep, Calendar, Contacts and Tasks. Upload the .zip (calendar history becomes a note per year, so your phone's calendar is not filled with the past).</li>
          <li><strong>Notes:</strong> an Obsidian vault, a Notion, Bear or Joplin export, or any folder of .md or .txt files, zipped; Evernote .enex notebooks.</li>
          <li><strong>Anything else:</strong> a .txt, .ics or .vcf file, or paste text below.</li>
        </ul>
        <label className="small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} aria-label="Learn about me from it" style={{ marginTop: 3 }} />
          <span style={{ flex: 1 }}>Learn about me from it: the model reads your own words and keeps new facts in Memory. Uses the model for a while (minutes to hours for a big export); it pauses for chats and while a game uses the graphics card.</span>
        </label>
        <div className="row wrap">
          <input type="file" multiple accept=".zip,.json,.md,.markdown,.txt,.ics,.vcf,.enex" onChange={(e) => setFiles([...(e.target.files ?? [])])} aria-label="Files to bring in" />
          <button type="button" className="primary" disabled={!client || !files.length || !!busy} onClick={() => void send()}>{busy.startsWith("Uploading") ? busy : "Bring it in"}</button>
        </div>
        <details>
          <summary className="small">Paste text instead</summary>
          <div className="col">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" />
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Notes, a journal, a list, anything" aria-label="Text to bring in" />
            <div><button type="button" disabled={!client || !text.trim() || !!busy} onClick={() => void paste()}>Save and sort</button></div>
          </div>
        </details>
        {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
      </section>
      {!!jobs.length && (
        <section className="card col">
          <h2>Imports</h2>
          {jobs.map((j) => (
            <div key={j.id} className="col" style={{ gap: 2 }}>
              <div className="row">
                <strong className="grow">{j.name}</strong>
                {ACTIVE.has(j.state) && <button type="button" className="ghost small" onClick={() => void client?.stopImport(j.id).then(load)}>Stop</button>}
              </div>
              <div className="small">
                {j.kinds.length ? `${j.kinds.join(", ")}: ` : ""}{summary(j)}
              </div>
              <div className={j.state === "failed" ? "error small" : "muted small"}>
                {j.state === "failed" ? j.error : ACTIVE.has(j.state) ? j.detail : j.state === "stopped" ? j.detail : `Done ${j.finished_at ? new Date(j.finished_at).toLocaleString() : ""}`}
                {j.state === "learning" && j.learned.total ? <progress value={j.learned.done} max={j.learned.total} style={{ marginLeft: 8, verticalAlign: "middle" }} /> : null}
              </div>
            </div>
          ))}
        </section>
      )}
    </SubPage>
  );
}
