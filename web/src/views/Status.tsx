import { useCallback, useEffect, useState } from "react";
import { engine } from "../sync/engine";
import { HubError, type HubStatus, type ProofDay, type ProofRun } from "../sync/api";
import { frictionItems, nowHeld } from "../lib/proof";
import { taskAlertAt } from "@everythingapp/shared";
import { META } from "../sync/db";
import { useMeta, useSyncState } from "../sync/hooks";
import { fmtBytes, fmtDateTime, fmtDuration, hoursSince, relative } from "../lib/time";
import { linkFor } from "../lib/links";

export const BACKUP_WARN_HOURS = 30;

type Loaded<T> = { data: T | null; error: string | null; unavailable: boolean };

function describeError(e: unknown): { error: string; unavailable: boolean } {
  if (e instanceof HubError && e.status === 404) return { error: "not available on this hub", unavailable: true };
  return { error: e instanceof Error ? e.message : String(e), unavailable: false };
}

/** Loads both status routes; refreshes every 60 s while the tab is visible. */
function useStatus(deviceId: string | undefined) {
  const sync = useSyncState();
  const [status, setStatus] = useState<Loaded<HubStatus>>({ data: null, error: null, unavailable: false });
  const [proof, setProof] = useState<Loaded<ProofRun>>({ data: null, error: null, unavailable: false });
  const [at, setAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const c = engine.client;
    if (!c) {
      setStatus({ data: null, error: "Needs the hub.", unavailable: false });
      setProof({ data: null, error: "Needs the hub.", unavailable: false });
      return;
    }
    setBusy(true);
    const [s, p] = await Promise.allSettled([c.status(), c.proof(14)]);
    setStatus(s.status === "fulfilled" ? { data: s.value, error: null, unavailable: false } : { data: null, ...describeError(s.reason) });
    setProof(p.status === "fulfilled" ? { data: p.value, error: null, unavailable: false } : { data: null, ...describeError(p.reason) });
    setAt(new Date());
    setBusy(false);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void load(), 60_000);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    void load();
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, sync.status === "setup", deviceId]);

  return { status, proof, at, busy, reload: load };
}

/** Column labels: `label` on desktop, `short` under 480 px where the table must fit 390 px without scrolling. */
const COLUMNS: Array<{ key: keyof ProofDay; label: string; short: string; title: string }> = [
  { key: "captures_created", label: "captures", short: "cap", title: "captures" },
  { key: "captures_auto_sorted", label: "sorted", short: "srt", title: "captures auto sorted" },
  { key: "tasks_done", label: "done", short: "done", title: "tasks done" },
  { key: "reminders_fired", label: "fired", short: "fir", title: "reminders fired" },
  { key: "reminders_acked", label: "acked", short: "ack", title: "reminders acknowledged" },
  { key: "reminders_snoozed", label: "snoozed", short: "snz", title: "reminders snoozed" },
  { key: "logs_created", label: "logs", short: "logs", title: "logs" },
  { key: "notes_edited", label: "notes", short: "note", title: "notes edited" },
  { key: "ai_calls", label: "AI", short: "ai", title: "AI calls" },
];

/** A number with a tiny bar underneath, scaled to the column maximum. */
function Cell({ value, max }: { value: number; max: number }) {
  const w = max > 0 ? Math.round((value / max) * 28) : 0;
  return (
    <td className="num">
      <span>{value}</span>
      <svg className="bar" width="28" height="3" aria-hidden="true">
        <rect width={w} height="3" rx="1" />
      </svg>
    </td>
  );
}

export function ProofTable({ proof }: { proof: ProofRun }) {
  const rows = proof.rows ?? [];
  const max: Partial<Record<keyof ProofDay, number>> = {};
  for (const c of COLUMNS) max[c.key] = Math.max(0, ...rows.map((d) => Number(d[c.key]) || 0));
  const totals = proof.totals ?? {};
  return (
    <div className="table-wrap">
      <table className="proof">
        <thead>
          <tr>
            <th scope="col">day</th>
            {COLUMNS.map((c) => (
              <th key={c.key} scope="col" title={c.title} aria-label={c.title}>
                <span className="wide" aria-hidden="true">
                  {c.label}
                </span>
                <span className="narrow" aria-hidden="true">
                  {c.short}
                </span>
              </th>
            ))}
            <th scope="col" title="Now view had a task" aria-label="Now view had a task">
              now
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day.slice(5)}</th>
              {COLUMNS.map((c) => (
                <Cell key={c.key} value={Number(d[c.key]) || 0} max={max[c.key] ?? 0} />
              ))}
              <td className={`now ${nowHeld(d) ? "yes" : "no"}`}>
                <span className="sr-only">{nowHeld(d) ? "yes" : "no"}</span>
                <span aria-hidden="true">{nowHeld(d) ? "y" : "."}</span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">total</th>
            {COLUMNS.map((c) => (
              <td key={c.key} className="num">
                {totals[c.key] ?? rows.reduce((n, d) => n + (Number(d[c.key]) || 0), 0)}
              </td>
            ))}
            <td className="now">{rows.filter(nowHeld).length}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Unavailable({ what, l }: { what: string; l: Loaded<unknown> }) {
  if (l.unavailable) return <div className="muted small">{what} is not available on this hub.</div>;
  return <div className="error">{l.error}</div>;
}

export function Status() {
  const deviceId = useMeta<string>(META.deviceId);
  const { status, proof, at, busy, reload } = useStatus(deviceId);
  const s = status.data;
  const friction = frictionItems(proof.data?.friction);
  const due = s?.reminders.due_next;
  const nextReminder = due && typeof due === "object" ? { id: due.id, title: String(due.fields?.title ?? "") || "(untitled)", at: taskAlertAt(due.fields ?? {}) } : null;
  const backupAge = s ? hoursSince(s.backups.latest_at) : Infinity;
  const backupStale = s ? !s.backups.latest_at || backupAge > BACKUP_WARN_HOURS : false;

  return (
    <div className="status-view">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Status</h1>
        <span className="muted small">
          {at ? `checked ${relative(at.toISOString())}` : ""}
          {busy ? ", loading" : ""}
        </span>
        <button className="small" onClick={() => void reload()} disabled={busy}>
          Refresh
        </button>
      </div>

      {!s && <Unavailable what="Hub status" l={status} />}
      {s && (
        <div className="grid2">
          <div className="card">
            <h3>Hub</h3>
            <dl className="facts">
              <dt>version</dt>
              <dd className="mono">{s.version}</dd>
              <dt>uptime</dt>
              <dd>
                {fmtDuration(s.uptime_s)} <span className="muted small">since {fmtDateTime(s.started_at)}</span>
              </dd>
              <dt>database</dt>
              <dd>
                {fmtBytes(s.db.bytes)}, seq {s.db.seq}
              </dd>
              <dt>entities</dt>
              <dd>
                <span className="chips">
                  {Object.entries(s.db.entities_by_kind)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, n]) => (
                      <span key={k} className="chip static">
                        {k} {n}
                      </span>
                    ))}
                </span>
              </dd>
            </dl>
          </div>

          <div className="card">
            <h3>Devices</h3>
            {!s.devices.length && <div className="muted small">none registered</div>}
            <ul className="plain">
              {s.devices
                .slice()
                .sort((a, b) => (a.last_seen > b.last_seen ? -1 : 1))
                .map((d) => (
                  <li key={d.id} className="row between">
                    <span>
                      {d.name} <span className="muted small">{d.platform}</span>
                      {d.id === deviceId && <span className="muted small"> (this device)</span>}
                    </span>
                    <span className="muted small" title={fmtDateTime(d.last_seen)}>
                      {relative(d.last_seen)}
                    </span>
                  </li>
                ))}
            </ul>
          </div>

          <div className="card">
            <h3>Backups</h3>
            {s.backups.latest_at ? (
              <div>
                <div className="mono small" style={{ overflowWrap: "anywhere" }}>
                  {s.backups.latest_file}
                </div>
                <div className={backupStale ? "warn" : ""}>
                  {relative(s.backups.latest_at)} ({Math.round(backupAge)} h), {s.backups.count} kept
                </div>
                {backupStale && (
                  <div className="warn small" role="alert">
                    Latest backup is older than {BACKUP_WARN_HOURS} h.
                  </div>
                )}
              </div>
            ) : (
              <div className="warn" role="alert">
                No backup recorded.
              </div>
            )}
          </div>

          <div className="card">
            <h3>AI</h3>
            <dl className="facts">
              <dt>backends</dt>
              <dd>{s.ai.backends_configured.length ? s.ai.backends_configured.join(", ") : "none"}</dd>
              <dt>calls 24 h</dt>
              <dd>
                {s.ai.calls_24h}
                {s.ai.avg_latency_ms_24h != null ? `, avg ${s.ai.avg_latency_ms_24h} ms` : ""}
              </dd>
              <dt>last call</dt>
              <dd>{s.ai.last_call_at ? `${relative(s.ai.last_call_at)} via ${s.ai.last_backend ?? "?"}` : "none yet"}</dd>
            </dl>
          </div>

          <div className="card">
            <h3>Reminders</h3>
            <dl className="facts">
              <dt>next due</dt>
              <dd>{nextReminder ? <a href={linkFor("task", nextReminder.id)}>{nextReminder.title}</a> : "nothing pending"}{nextReminder?.at && <span className="muted small"> {fmtDateTime(nextReminder.at)} ({relative(nextReminder.at)})</span>}</dd>
              <dt>fired 24 h</dt>
              <dd>{s.reminders.fired_24h}</dd>
            </dl>
          </div>

          <div className="card">
            <h3>Unsorted Info</h3>
            <div>
              {s.captures_unprocessed === 0 ? "nothing unsorted" : <a href="#/inbox">{s.captures_unprocessed} unsorted captures</a>}
            </div>
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 16 }}>Proof run, last 14 days</h2>
      {!proof.data && <Unavailable what="The proof run" l={proof} />}
      {proof.data && (
        <>
          <ProofTable proof={proof.data} />
          <h3 style={{ marginTop: 16 }}>Friction ({friction.length})</h3>
          {!friction.length && <div className="muted small">nothing stuck</div>}
          <ul className="plain list">
            {friction.map((f) => (
              <li key={`${f.kind}:${f.id}`} className="item">
                <div className="body">
                  <div className="t">
                    <span className="muted small">{f.kind} </span>
                    <a href={linkFor(f.kind, f.id)}>{f.title || "(untitled)"}</a>
                  </div>
                  {f.detail && <div className="meta">{f.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
