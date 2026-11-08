import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, softDelete } from "../sync/edits";
import { copyText, patchEntity } from "../sync/memory";
import type { JournalF } from "../lib/memory";
import { fmtDateTime } from "../lib/time";
import { CsvButton } from "../components/CsvButton";
import { Markdown } from "../components/Markdown";
import { rollbackText, usePreflight } from "../sync/preflight";

const RISKS = ["low", "medium", "high"] as const;
const OUTCOMES = ["planned", "done", "failed", "reverted"] as const;

export const EMPTY_JOURNAL = { host: "", what: "", command: "", risk: "low" as JournalF["risk"], rollback: "", outcome: "done" as NonNullable<JournalF["outcome"]> };
export type JournalDraft = typeof EMPTY_JOURNAL;

export function journalFields(d: JournalDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { host: d.host.trim(), at: new Date().toISOString(), what: d.what.trim(), risk: d.risk, outcome: d.outcome };
  if (d.command.trim()) out.command = d.command.trim();
  if (d.rollback.trim()) out.rollback = d.rollback.trim();
  return out;
}

/** The add form shared by the Journal view and a host page. `host` fixes the host and hides its field. */
export function JournalForm({ host, hosts, onDone }: { host?: string; hosts: string[]; onDone: () => void }) {
  const [d, setD] = useState<JournalDraft>({ ...EMPTY_JOURNAL, host: host ?? "" });
  const [err, setErr] = useState("");
  const set = (k: keyof JournalDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const valid = !!d.host.trim() && !!d.what.trim();
  const pf = usePreflight(d.command);
  return (
    <form
      className="card col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        setErr("");
        createEntity("journal", journalFields(d))
          .then(onDone)
          .catch((x) => setErr(x instanceof Error ? x.message : String(x)));
      }}
    >
      {!host && (
        <div>
          <label htmlFor="j-host">Host</label>
          <input id="j-host" list="j-hosts" value={d.host} onChange={set("host")} placeholder="pve1" autoCapitalize="off" />
          <datalist id="j-hosts">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </div>
      )}
      <div>
        <label htmlFor="j-what">What was done</label>
        <input id="j-what" value={d.what} onChange={set("what")} placeholder="One line" />
      </div>
      <div>
        <label htmlFor="j-cmd">Command or UI action</label>
        <textarea id="j-cmd" className="mono" rows={2} value={d.command} onChange={set("command")} autoCapitalize="off" spellCheck={false} />
      </div>
      {pf && (
        <div className="callout preflight small" role="note" aria-label="Pre-flight">
          <Markdown text={pf.block} />
          {(d.risk !== "high" || !d.rollback.trim()) && (
            <button
              type="button"
              className="small"
              style={{ marginTop: 6 }}
              onClick={() => setD({ ...d, risk: "high", rollback: d.rollback.trim() ? d.rollback : rollbackText(pf) })}
            >
              {d.rollback.trim() ? "Mark high risk" : "Mark high risk and use this rollback"}
            </button>
          )}
        </div>
      )}
      <div className="row">
        <div className="grow">
          <label htmlFor="j-risk">Risk</label>
          <select id="j-risk" value={d.risk} onChange={set("risk")}>
            {RISKS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor="j-out">Outcome</label>
          <select id="j-out" value={d.outcome} onChange={set("outcome")}>
            {OUTCOMES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="j-rb">Rollback</label>
        <input id="j-rb" value={d.rollback} onChange={set("rollback")} placeholder="How to undo it" />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={!valid}>
          Add entry
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RiskChip({ risk }: { risk: string }) {
  return <span className={`chip static risk-${risk}`}>{risk}</span>;
}

export function OutcomeChip({ outcome }: { outcome?: string }) {
  const o = outcome ?? "done";
  return <span className={`chip static outcome-${o}`}>{o}</span>;
}

/** One journal entry. `showHost` adds the host as a link, for the all-hosts view. */
export function JournalEntry({ e, showHost, focus }: { e: Entity; showHost?: boolean; focus?: boolean }) {
  const f = e.fields as JournalF;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const setOutcome = async (outcome: "done" | "reverted") => {
    setBusy(true);
    setErr("");
    try {
      await patchEntity(e, { outcome });
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id={`journal-${e.id}`} className={`item journal risk-${f.risk} ${focus ? "focus" : ""}`}>
      <div className="body">
        <div className="row">
          <RiskChip risk={f.risk} />
          <OutcomeChip outcome={f.outcome} />
          {showHost && (
            <a href={`#/hosts/${encodeURIComponent(f.host)}`} className="mono small">
              {f.host}
            </a>
          )}
          <span className="muted small">{fmtDateTime(f.at)}</span>
        </div>
        <div className="t" style={{ marginTop: 4 }}>
          {f.what}
        </div>
        {f.command && (
          <div className="row top" style={{ marginTop: 4 }}>
            <pre className="grow cmd">{f.command}</pre>
            <button
              className="small ghost"
              onClick={() =>
                copyText(f.command!).then((ok) => {
                  setCopied(ok);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              aria-label={`Copy command for ${f.what}`}
            >
              {copied ? "copied" : "Copy"}
            </button>
          </div>
        )}
        {f.rollback && (
          <div className="small">
            <span className="muted">rollback </span>
            {f.rollback}
          </div>
        )}
        {err && <div className="error">{err}</div>}
        {f.outcome === "planned" && (
          <div className="row" style={{ marginTop: 6 }}>
            <button className="small primary" disabled={busy} onClick={() => void setOutcome("done")}>
              Mark done
            </button>
            <button className="small" disabled={busy} onClick={() => void setOutcome("reverted")}>
              Mark reverted
            </button>
          </div>
        )}
        <div className="meta" style={{ marginTop: 4 }}>
          {f.session_id && <a href={`#/assistant/${encodeURIComponent(f.session_id)}`}>session</a>}
          <button className="small ghost danger" onClick={() => confirm("Delete this entry") && softDelete(e)}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export const byAtDesc = (a: Entity, b: Entity) => (String(a.fields.at) > String(b.fields.at) ? -1 : 1);

export function Journal({ focus }: { focus?: string | null } = {}) {
  const entries = useEntities("journal");
  const hosts = useMemo(() => [...new Set(entries.map((e) => String(e.fields.host)))].sort(), [entries]);
  const [host, setHost] = useState<string | null>(null);
  const [risk, setRisk] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (focus) document.getElementById(`journal-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, entries.length]);

  const shown = entries.filter((e) => (!host || e.fields.host === host) && (!risk || e.fields.risk === risk)).sort(byAtDesc);

  return (
    <div className="journal-view">
      <div className="row between">
        <span className="title-row"><h1 style={{ margin: 0 }}>Change journal</h1><CsvButton kind="journal" /></span>
        {!adding && (
          <button className="small primary" onClick={() => setAdding(true)}>
            Add entry
          </button>
        )}
      </div>
      {adding && (
        <div style={{ marginTop: 10 }}>
          <JournalForm hosts={hosts} onDone={() => setAdding(false)} />
        </div>
      )}
      {hosts.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          <div className="chips" aria-label="Host filter">
            <button className={`chip ${!host ? "on" : ""}`} onClick={() => setHost(null)}>
              all hosts
            </button>
            {hosts.map((h) => (
              <button key={h} className={`chip ${host === h ? "on" : ""}`} onClick={() => setHost(host === h ? null : h)}>
                {h}
              </button>
            ))}
          </div>
          <select value={risk ?? ""} onChange={(e) => setRisk(e.target.value || null)} style={{ width: "auto" }} aria-label="Risk filter">
            <option value="">any risk</option>
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}
      {!entries.length && <div className="empty">No journal entries. The assistant writes them when it helps with a host; add one by hand for anything else.</div>}
      {entries.length > 0 && !shown.length && <div className="empty">Nothing matches.</div>}
      <div className="list" style={{ marginTop: 10 }}>
        {shown.map((e) => (
          <JournalEntry key={e.id} e={e} showHost focus={e.id === focus} />
        ))}
      </div>
    </div>
  );
}
