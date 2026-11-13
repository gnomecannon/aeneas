import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity } from "../sync/edits";
import { usePoll } from "../lib/usePoll";
import { useEscape } from "../lib/keys";
import { fmtDate, fmtDateTime, fmtDuration, relative, relativePast } from "../lib/time";
import type { JournalF } from "../lib/memory";
import type { SensorRow } from "../sync/api";
import { Chart } from "../components/Chart";
import { dayPoints, formatValue, shortDay, timePoints, type Series } from "../lib/dashboard";
import { sensorState, sensorTone } from "../lib/body";
import { daysLeft, fmtDaysLeft, parseDue } from "../lib/planner";
import {
  EMPTY_MONITOR,
  MONITOR_TYPES,
  hubLineText,
  incidentSeconds,
  isBackup,
  jobLine,
  lastErrors,
  monitorDraft,
  monitorFields,
  monitorState,
  trafficLight,
  uptimeStrip,
  type CheckRow,
  type HubBackupLine,
  type IncidentF,
  type MonitorDraft,
  type MonitorF,
  type MonitorType,
  type OpsData,
  type OpsMonitor,
} from "../lib/ops";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const checksFailed = (n?: number) => `${n ?? 0} check${n === 1 ? "" : "s"} failed`;
const DAY = 86400_000;

const TARGET_HINT: Record<MonitorType, string> = {
  ping: "192.168.1.20",
  tcp: "192.168.1.20:22",
  http: "http://127.0.0.1:8787/health",
  tls: "https://core.example.ts.net:8787",
  dns: "core.example.ts.net",
  backup: "mac:laptop, windows:desktop, linux:me@nas",
};

/** Homelab ops: traffic light, monitor cards, incidents, renewals due and recent changes, from GET /ops. */
export function Ops({ focus: asked }: { focus?: string | null }) {
  const p = usePoll((c) => c.ops(), 30_000);
  // A link to an incident (search, linked items) focuses its monitor.
  const linked = useEntity(asked ?? undefined);
  const focus = linked?.kind === "incident" ? String(linked.fields.monitor_id ?? "") || asked : asked;
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [editing, setEditing] = useState<OpsMonitor | "new" | null>(null);
  const reload = p.reload;

  useEffect(() => engine.onNotify((n) => n.kind === "monitor" && void reload()), [reload]);
  useEffect(() => {
    if (focus) {
      setOpen(focus);
      document.getElementById(`mon-${focus}`)?.scrollIntoView({ block: "start" });
    }
  }, [focus, !!p.data]);
  useEscape(useCallback(() => (editing ? setEditing(null) : setOpen(null)), [editing]));

  const data = p.data;
  const monitors = useMemo(() => {
    const rank = (m: OpsMonitor) => {
      const f = m.fields as MonitorF;
      if (f.enabled === false) return 3;
      const s = monitorState(f);
      return s === "down" ? 0 : s === "unknown" ? 1 : 2;
    };
    return (data?.monitors ?? []).slice().sort((a, b) => rank(a) - rank(b) || String(a.fields.name).localeCompare(String(b.fields.name)));
  }, [data]);
  const light = trafficLight(monitors);
  // The light says what Ops knows: the hub's own backups count, and a board the hub did not refresh says it is old.
  const hubBad = !!data?.hub_backup?.some((l) => !l.ok);
  const stale = !!(data && p.error);
  const lightTone = stale ? "muted" : hubBad && light.tone !== "danger" ? "danger" : light.tone;
  const lightLabel = hubBad && light.down === 0 ? "This hub's backup needs a look" : light.label;
  const lightDetail = [hubBad && light.down > 0 ? "this hub's backup needs a look" : "", light.detail, stale && p.at ? `as of ${relativePast(p.at.toISOString())}: the hub did not answer the last refresh` : ""].filter(Boolean).join("; ");
  const uptime = new Map((data?.uptime_24h ?? []).map((u) => [u.name, u.pct]));
  // Backups get a section of their own: one card per machine, a line per job.
  const checks = monitors.filter((m) => !isBackup(m));
  const backups = monitors.filter(isBackup);
  const card = (m: OpsMonitor) => (
    <MonitorCard
      key={m.id}
      m={m}
      pct={uptime.get(String(m.fields.name)) ?? null}
      open={open === m.id}
      onToggle={() => setOpen((o) => (o === m.id ? null : m.id))}
      onEdit={() => setEditing(m)}
      onChanged={reload}
    />
  );

  return (
    <div className="ops">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Ops</h1>
        <span className="muted small">{p.at ? `checked ${relativePast(p.at.toISOString())}` : ""}</span>
        <div className="row">
          <button className="small" onClick={() => void reload()} disabled={p.busy}>
            Refresh
          </button>
          <button className="small primary" onClick={() => setEditing("new")}>
            Add monitor
          </button>
        </div>
      </div>
      {!data && p.error && <div className={p.unavailable ? "muted small" : "error"}>{p.unavailable ? "Ops is not available on this hub." : p.error}</div>}
      {data && (
        <div className={`ops-light tone-${lightTone}`} role="status" aria-label={`${lightLabel}${lightDetail ? `, ${lightDetail}` : ""}`}>
          <span className="label">{lightLabel}</span>
          {lightDetail && <span className="detail">{lightDetail}</span>}
        </div>
      )}
      {data && p.error && <div className="muted small">Last refresh failed: {p.error}</div>}

      {/* Keyed, so Edit on another monitor starts from that monitor's values (it kept the first one's and saved them over it). */}
      {editing && <MonitorEditor key={editing === "new" ? "new" : editing.id} monitor={editing === "new" ? null : editing} hosts={data?.hosts.map((h) => h.host) ?? []} onDone={() => setEditing(null)} />}

      {data && !monitors.length && <div className="empty">No monitors yet. Add one to start watching a host.</div>}
      <div className="ops-grid">{checks.map(card)}</div>

      {(backups.length > 0 || !!data?.hub_backup?.length) && (
        <section style={{ marginTop: 20 }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Backups</h2>
            <span className="muted small">{backupSummary(backups, data?.hub_backup ?? [])}</span>
          </div>
          <div className="ops-grid" style={{ marginTop: 8 }}>
            {!!data?.hub_backup?.length && <HubBackupCard lines={data.hub_backup} />}
            {backups.map(card)}
          </div>
        </section>
      )}

      <SensorGraphs />

      {data && <Incidents data={data} onChanged={reload} />}
    </div>
  );
}

/** "This hub and 3 machines, all good" or "1 of 4 needs a look". */
function backupSummary(backups: OpsMonitor[], hub: HubBackupLine[]): string {
  const on = backups.filter((m) => m.fields.enabled !== false);
  const total = on.length + (hub.length ? 1 : 0);
  const bad = on.filter((m) => monitorState(m.fields as MonitorF) === "down").length + (hub.some((l) => !l.ok) ? 1 : 0);
  const unknown = on.filter((m) => monitorState(m.fields as MonitorF) === "unknown").length;
  const machines = `${on.length} machine${on.length === 1 ? "" : "s"}`;
  const what = hub.length ? (on.length ? `This hub and ${machines}` : "This hub") : machines;
  if (!total) return "";
  if (bad) return `${bad} of ${total} need${bad === 1 ? "s" : ""} a look`;
  return unknown ? `${unknown} of ${total} not checked yet` : `${what}, all good`;
}

/** The hub's own data: its nightly copy, a second folder, the copy to storage and the live copy, a line each. */
function HubBackupCard({ lines }: { lines: HubBackupLine[] }) {
  const bad = lines.some((l) => !l.ok);
  return (
    <div className={`card ${bad ? "down" : ""}`} style={{ cursor: "default" }}>
      <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
        <div className="row" style={{ gap: 8, fontWeight: 600, flexWrap: "nowrap" }}>
          <span className={`dot lg ${bad ? "down" : "up"}`} aria-hidden="true" />
          <span>This hub</span>
        </div>
        <span className={`chip static tone-${bad ? "danger" : "ok"}`}>{bad ? "needs a look" : "up"}</span>
      </div>
      <div className="muted small mon-target">the hub's own data, made and kept by the hub</div>
      <ul className="plain job-lines" aria-label="This hub's backups">
        {lines.map((l) => (
          <li key={l.label} title={l.at ? fmtDateTime(l.at) : undefined}>
            <span className={`dot ${l.ok ? "up" : "down"}`} aria-hidden="true" />
            <span className="job-label">{l.label}</span>
            <span className={l.ok ? "" : "error"}>
              {hubLineText(l)}
              {l.at && <span className="muted"> ({fmtDateTime(l.at)})</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type SensorSpan = "24h" | 7 | 30 | 90;
const SENSOR_SPANS: SensorSpan[] = ["24h", 7, 30, 90];

/** A graph for every sensor: the last 24 hours reading by reading, or a daily mean over 7 to 90 days. */
function SensorGraphs() {
  const p = usePoll((c) => c.sensors(), 60_000);
  const sensors = p.data ?? [];
  if (!sensors.length) return null;
  return (
    <section style={{ marginTop: 20 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Sensors</h2>
        <a href="#/sensors" className="small">
          sensor settings
        </a>
      </div>
      {p.error && <div className="muted small">Last refresh failed: {p.error}</div>}
      <div className="ops-grid" style={{ marginTop: 8 }}>
        {sensors.map((s) => (
          <SensorGraph key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

function SensorGraph({ s }: { s: SensorRow }) {
  const [span, setSpan] = useState<SensorSpan>("24h");
  const [series, setSeries] = useState<Series | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (span === "24h") return;
    let alive = true;
    setErr("");
    engine.client
      ?.dashboardSeries(`sensor:${s.name}`, span)
      .then((r) => alive && setSeries(r))
      .catch((e) => alive && setErr(msg(e)));
    return () => {
      alive = false;
    };
  }, [s.name, span, s.last_at]);
  const state = sensorState(s);
  const bounds = [s.min, s.max].filter((v): v is number => v != null);
  const now = Date.now();
  const daily = span !== "24h" && series && series.days === span ? series : null;
  return (
    <div className="card sensor-graph" style={{ cursor: "default" }}>
      <div className="row between" style={{ flexWrap: "nowrap" }}>
        <strong style={{ overflowWrap: "anywhere" }}>{s.name}</strong>
        <span className={`chip static tone-${sensorTone(state)}`}>{state}</span>
      </div>
      <div className="mon-stats">
        <span>{s.last_value != null ? formatValue(s.last_value, s.unit) : "no reading"}</span>
        {s.last_at && <span>{relativePast(s.last_at)}</span>}
        {s.location && <span>{s.location}</span>}
      </div>
      {span === "24h" ? (
        <Chart points={timePoints(s.series_24h, now - DAY, now)} kind="line" unit={s.unit} bounds={bounds} height={80} label={`${s.name}, last 24 hours`} axis={["24 h ago", "now"]} />
      ) : err ? (
        <div className="error">{err}</div>
      ) : daily ? (
        <Chart points={dayPoints(daily.points)} kind="line" unit={s.unit} bounds={bounds} height={80} label={`${s.name}, daily mean over ${span} days`} axis={[shortDay(daily.from), "today"]} />
      ) : (
        <div className="muted small chart-empty">Loading</div>
      )}
      <div className="seg seg-sm" role="group" aria-label={`Range for ${s.name}`} style={{ marginTop: 6 }}>
        {SENSOR_SPANS.map((v) => (
          <button key={String(v)} type="button" className={span === v ? "on" : ""} aria-pressed={span === v} onClick={() => setSpan(v)}>
            {v === "24h" ? "24h" : `${v}d`}
          </button>
        ))}
      </div>
    </div>
  );
}

function MonitorCard({ m, pct, open, onToggle, onEdit, onChanged }: { m: OpsMonitor; pct: number | null; open: boolean; onToggle: () => void; onEdit: () => void; onChanged: () => Promise<void> }) {
  const f = m.fields as MonitorF;
  const state = monitorState(f);
  /** A backup machine read since 2026-11-13: one line per job instead of latency and uptime. */
  const jobs = f.type === "backup" && f.jobs?.length ? f.jobs : null;
  /** Its last check could not reach the machine (away): what it shows is from the last time it could. */
  const away = f.type === "backup" && state === "up" && !!f.last_error;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  // A Check now error goes once a newer check is in.
  useEffect(() => setErr(""), [f.last_check]);
  const inc = m.incident_open;
  /** Down with its machine: the incident is the machine's (one Acknowledge, on the machine's own card). */
  const joined = !!inc && String(inc.fields.monitor_id) !== m.id;

  const check = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      await c.monitorCheck(m.id);
      setHistoryKey((k) => k + 1);
      await onChanged();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  /** The whole card toggles the history, except clicks on its own controls. */
  const onCardClick = (e: MouseEvent) => {
    if (open) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, form")) return;
    onToggle();
  };

  return (
    <div id={`mon-${m.id}`} className={`card ${open ? "open" : ""} ${state === "down" ? "down" : ""} ${f.enabled === false ? "off" : ""}`} onClick={onCardClick}>
      <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
        <button className="mon-head" onClick={onToggle} aria-expanded={open} aria-label={`${f.name}, ${state}. ${open ? "Hide" : "Show"} history`}>
          <span className={`dot lg ${state}`} aria-hidden="true" />
          <span>{f.name}</span>
        </button>
        <span className={`chip static tone-${away ? "muted" : state === "up" ? "ok" : state === "down" ? "danger" : "muted"}`}>{f.enabled === false ? "off" : away ? "away" : state}</span>
      </div>
      <div className="mono muted mon-target">
        {jobs ? f.target : `${f.type} ${f.target}`}
      </div>
      {jobs ? (
        <>
          <ul className="plain job-lines" aria-label={`${f.name} jobs`}>
            {jobs.map((j) => {
              const l = jobLine(j);
              return (
                <li key={j.job} title={l.at ? fmtDateTime(l.at) : undefined}>
                  <span className={`dot ${l.tone === "ok" ? "up" : "down"}`} aria-hidden="true" />
                  <span className="job-label">{l.label}</span>
                  <span className={l.tone === "danger" ? "error" : ""}>
                    {l.text}
                    {l.at && <span className="muted"> ({fmtDateTime(l.at)})</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mon-stats">
            <span>{f.last_check ? `checked ${relativePast(f.last_check)}` : "never checked"}</span>
          </div>
          {away && (
            <div className="muted small" style={{ overflowWrap: "anywhere" }}>
              Not reached since {f.last_reached ? relativePast(f.last_reached) : f.last_ok ? relativePast(f.last_ok) : "it was added"}: {f.last_error}
            </div>
          )}
        </>
      ) : (
        <div className="mon-stats">
          <span>{f.last_latency_ms != null && state !== "down" ? `${Math.round(f.last_latency_ms)} ms` : "no latency"}</span>
          <span>{f.last_check ? `checked ${relativePast(f.last_check)}` : "never checked"}</span>
          <span>{pct != null ? `${pct}% 24 h` : "no 24 h data"}</span>
        </div>
      )}
      {!jobs && f.last_detail && !(String(inc?.fields.last_error ?? f.last_error ?? "")).includes(f.last_detail) && <div className="small" style={{ overflowWrap: "anywhere" }}>{f.last_detail}</div>}
      {!inc && state !== "down" && !away && f.last_error && <div className="muted small" style={{ overflowWrap: "anywhere" }}>{f.last_error}</div>}
      {inc && joined && (
        <div className="inc-strip">
          {f.last_error && <div className="err">{f.last_error}</div>}
          <div className="small">Down with {String(inc.fields.name)}: its machine stopped answering.</div>
        </div>
      )}
      {inc && !joined && <IncidentStrip inc={inc} host={f.host} onChanged={onChanged} showError={!jobs} />}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="small" onClick={() => void check()} disabled={busy}>
          {busy ? "Checking" : "Check now"}
        </button>
        <button className="small ghost" onClick={onEdit} aria-label={`Edit ${f.name}`}>
          Edit
        </button>
        {open && (
          <button className="small ghost" onClick={onToggle}>
            Close
          </button>
        )}
      </div>
      {open && <History id={m.id} reloadKey={historyKey} lastCheck={f.last_check} intervalS={f.interval_s} />}
    </div>
  );
}

/** The red strip on a card with an open incident: the error, acknowledge and the runbook link. */
/** `showError` false: the card already says what is wrong (a backup machine's job lines). */
function IncidentStrip({ inc, host, onChanged, showError = true }: { inc: Entity; host?: string; onChanged: () => Promise<void>; showError?: boolean }) {
  const f = inc.fields as IncidentF;
  return (
    <div className="inc-strip">
      {showError && <div className="err">{f.last_error ?? "down"}</div>}
      {f.also_down?.length ? <div className="small">Also down with it: {f.also_down.join(", ")}</div> : null}
      <div className="muted small">
        down {fmtDuration(incidentSeconds(f))}, {checksFailed(f.checks_failed)}
      </div>
      <AckControl inc={inc} onChanged={onChanged} />
      {host && (
        <a href={`#/hosts/${encodeURIComponent(host)}`} className="small">
          {host} runbook
        </a>
      )}
    </div>
  );
}

/** "Acknowledge" opens a one-line note; the hub stamps the incident and, with a note, writes a journal entry. */
function AckControl({ inc, onChanged }: { inc: Entity; onChanged: () => Promise<void> }) {
  const f = inc.fields as IncidentF;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (f.acknowledged_at) {
    return (
      <div className="small" style={{ margin: "4px 0" }}>
        Acknowledged {relativePast(f.acknowledged_at)}
        {f.ack_note ? `: ${f.ack_note}` : ""}
      </div>
    );
  }
  const save = async () => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const out = await c.incidentAck(inc.id, note.trim() || undefined);
      await engine.absorb([out]).catch(() => undefined);
      setEditing(false);
      setNote("");
      await onChanged();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <div className="row" style={{ margin: "6px 0" }}>
        <button className="small primary" onClick={() => setEditing(true)} aria-label={`Acknowledge ${f.name}`}>
          Acknowledge
        </button>
      </div>
    );
  }
  return (
    <form
      className="ack-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input ref={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you do? Optional" aria-label={`Note for ${f.name}`} maxLength={300} />
      <button type="submit" className="small primary" disabled={busy}>
        Acknowledge
      </button>
      <button type="button" className="small ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {err && <div className="error" style={{ flexBasis: "100%" }}>{err}</div>}
    </form>
  );
}

/** 24 h timeline from GET /monitors/:id/history, one cell per check (bucketed when dense), and the last errors. */
function History({ id, reloadKey, lastCheck, intervalS }: { id: string; reloadKey: number; lastCheck?: string; intervalS?: number }) {
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    engine.client
      ?.monitorHistory(id, 24)
      .then((r) => alive && (setRows(r), setErr("")))
      .catch((e) => alive && setErr(msg(e)));
    return () => {
      alive = false;
    };
  }, [id, reloadKey, lastCheck]);
  if (err) return <div className="error">{err}</div>;
  if (!rows) return <div className="muted small">Loading history</div>;
  const cells = uptimeStrip(rows, { intervalS });
  const errors = lastErrors(rows, 5);
  const fails = rows.filter((r) => !r.ok).length;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small">
        <strong>Last 24 h</strong> <span className="muted">{rows.length} checks, {fails} failed</span>
      </div>
      {cells.length ? (
        <>
          <div className="uptime-strip" role="img" aria-label={`${rows.length} checks in 24 hours, ${fails} failed`}>
            {cells.map((c, i) => (
              <span key={i} className={c.state} title={`${fmtDateTime(c.from)}${c.checks > 1 ? ` to ${fmtDateTime(c.to)}, ${c.checks} checks` : ""}${c.fails ? `, ${c.fails} failed` : ""}`} />
            ))}
          </div>
          <div className="strip-axis" aria-hidden="true">
            <span>24 h ago</span>
            <span>now</span>
          </div>
        </>
      ) : (
        <div className="muted small">No checks in 24 h.</div>
      )}
      <div className="small" style={{ marginTop: 8 }}>
        <strong>Last errors</strong>
      </div>
      {errors.length ? (
        <ul className="plain small">
          {errors.map((r) => (
            <li key={r.at}>
              <span className="muted">{fmtDateTime(r.at)}</span> {r.error ?? "failed"}
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small">None in 24 h.</div>
      )}
    </div>
  );
}

/** Add or edit a monitor through the entity path; the hub fills the state fields. */
function MonitorEditor({ monitor, hosts, onDone }: { monitor: Entity | null; hosts: string[]; onDone: () => void }) {
  const [d, setD] = useState<MonitorDraft>(() => (monitor ? monitorDraft(monitor.fields as MonitorF) : { ...EMPTY_MONITOR }));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
    ref.current?.querySelector("input")?.focus();
  }, []);
  const hostOptions = useMemo(() => [...new Set([...hosts, d.host].filter(Boolean))].sort(), [hosts, d.host]);
  const set = (patch: Partial<MonitorDraft>) => setD((x) => ({ ...x, ...patch }));
  const pre = monitor ? `me-${monitor.id.slice(0, 8)}` : "me-new";

  const save = async () => {
    setErr("");
    let fields: Record<string, unknown>;
    try {
      fields = monitorFields(d);
    } catch (e) {
      setErr(msg(e));
      return;
    }
    setBusy(true);
    try {
      if (monitor) await updateEntity(monitor, fields);
      else await createEntity("monitor", Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)));
      onDone();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={ref}
      className="card col"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <strong>{monitor ? `Edit ${String(monitor.fields.name)}` : "New monitor"}</strong>
      <div className="row top">
        <div className="grow" style={{ minWidth: 160 }}>
          <label htmlFor={`${pre}-name`}>Name</label>
          <input id={`${pre}-name`} value={d.name} onChange={(e) => set({ name: e.target.value })} autoCapitalize="off" />
        </div>
        <div style={{ width: 150 }}>
          <label htmlFor={`${pre}-host`}>Host</label>
          <select id={`${pre}-host`} value={d.host} onChange={(e) => set({ host: e.target.value })}>
            <option value="">none</option>
            {hostOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 100 }}>
          <label htmlFor={`${pre}-type`}>Type</label>
          <select id={`${pre}-type`} value={d.type} onChange={(e) => set({ type: e.target.value as MonitorType })}>
            {MONITOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row top">
        <div className="grow" style={{ minWidth: 200 }}>
          <label htmlFor={`${pre}-target`}>Target</label>
          <input id={`${pre}-target`} className="mono" value={d.target} onChange={(e) => set({ target: e.target.value })} placeholder={TARGET_HINT[d.type]} autoCapitalize="off" spellCheck={false} />
        </div>
        <div className="grow" style={{ minWidth: 140 }}>
          <label htmlFor={`${pre}-expect`}>Expect, optional</label>
          <input id={`${pre}-expect`} value={d.expect} onChange={(e) => set({ expect: e.target.value })} placeholder={d.type === "http" ? "200 or body text" : d.type === "dns" ? "address" : d.type === "backup" ? "hours: 28, or 28,verify=200,restore=900" : ""} autoCapitalize="off" />
        </div>
      </div>
      <div className="row top">
        <div style={{ width: 100 }}>
          <label htmlFor={`${pre}-int`}>Interval, s</label>
          <input id={`${pre}-int`} type="number" min={10} value={d.interval_s} onChange={(e) => set({ interval_s: e.target.value })} />
        </div>
        <div style={{ width: 100 }}>
          <label htmlFor={`${pre}-to`}>Timeout, s</label>
          <input id={`${pre}-to`} type="number" min={1} value={d.timeout_s} onChange={(e) => set({ timeout_s: e.target.value })} />
        </div>
        <div style={{ width: 130 }}>
          <label htmlFor={`${pre}-fails`}>Fails before down</label>
          <input id={`${pre}-fails`} type="number" min={1} value={d.fails_before_down} onChange={(e) => set({ fails_before_down: e.target.value })} />
        </div>
      </div>
      {d.type === "backup" && (
        <div className="muted small">
          One monitor per machine: it reads the backup, its verification and, on Linux, the restore test in one ssh login, and is down when any of them is. Add <span className="mono">#verify</span> or <span className="mono">#restore</span> to the target to watch one job only.
        </div>
      )}
      <label style={{ color: "inherit", fontSize: 15 }}>
        <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
      </label>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button type="submit" className="small primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Open incidents first, then the ones closed in the last 7 days; beside them renewals due and recent changes. */
function Incidents({ data, onChanged }: { data: OpsData; onChanged: () => Promise<void> }) {
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const closed = useEntities("incident", (e) => !!e.fields.closed_at && String(e.fields.closed_at) >= weekAgo)
    .slice()
    .sort((a, b) => (String(a.fields.closed_at) < String(b.fields.closed_at) ? 1 : -1));
  const open = data.incidents_open.slice().sort((a, b) => (String(a.fields.opened_at) < String(b.fields.opened_at) ? 1 : -1));

  return (
    <>
      <section style={{ marginTop: 20 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Incidents</h2>
          <span className="muted small">
            {open.length} open, {data.incidents_7d} opened in 7 days
          </span>
        </div>
        {!open.length && !closed.length && <div className="muted small" style={{ marginTop: 6 }}>No incidents in 7 days.</div>}
        <div className="list" style={{ marginTop: 8 }}>
          {open.map((e) => (
            <IncidentRow key={e.id} e={e} onChanged={onChanged} />
          ))}
          {closed.map((e) => (
            <IncidentRow key={e.id} e={e} onChanged={onChanged} />
          ))}
        </div>
      </section>
      <div className="ops-lists">
        <section className="card">
          <h2 style={{ margin: "0 0 6px" }}>Due in 30 days</h2>
          {!data.watches_due_30d.length && <div className="muted small">Nothing due.</div>}
          <ul className="plain">
            {data.watches_due_30d.map((w) => (
              <li key={w.id} className="row between small" style={{ padding: "3px 0", flexWrap: "nowrap" }}>
                <a href={`#/renewals?focus=${w.id}`} className="grow" style={{ overflowWrap: "anywhere" }}>
                  {String(w.fields.title)}
                </a>
                {/* A date without a time is that local day, as on Renewals (read as midnight UTC it showed the day before in the US). */}
                <span className={daysLeft(String(w.fields.due)) < 0 ? "error" : "muted"} style={{ whiteSpace: "nowrap" }}>
                  {fmtDate(parseDue(String(w.fields.due)).toISOString())}, {fmtDaysLeft(daysLeft(String(w.fields.due)))}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <div className="row between">
            <h2 style={{ margin: "0 0 6px" }}>Recent changes</h2>
            <a href="#/journal" className="small">
              journal
            </a>
          </div>
          {!data.journal_recent.length && <div className="muted small">Nothing logged.</div>}
          <ul className="plain">
            {data.journal_recent.map((j) => {
              const f = j.fields as JournalF;
              return (
                <li key={j.id} className="small" style={{ padding: "3px 0" }}>
                  <a href={`#/hosts/${encodeURIComponent(f.host)}`} className="mono">
                    {f.host}
                  </a>{" "}
                  <a href={`#/journal?focus=${j.id}`} style={{ color: "inherit" }}>
                    {f.what}
                  </a>{" "}
                  <span className="muted">{relative(f.at)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

function IncidentRow({ e, onChanged }: { e: Entity; onChanged: () => Promise<void> }) {
  const f = e.fields as IncidentF;
  const isOpen = !f.closed_at;
  return (
    <div className={`item incident ${isOpen ? "open" : ""}`}>
      <div className="body">
        <div className="row between">
          <strong style={{ overflowWrap: "anywhere" }}>{f.name}</strong>
          <span className={`chip static tone-${isOpen ? "danger" : "ok"}`}>{isOpen ? "open" : "closed"}</span>
        </div>
        {f.last_error && <div className={isOpen ? "error" : "muted small"} style={{ overflowWrap: "anywhere" }}>{f.last_error}</div>}
        {f.also_down?.length ? <div className="small">Also down with it: {f.also_down.join(", ")}</div> : null}
        <div className="meta">
          <span>opened {fmtDateTime(f.opened_at)}</span>
          {f.closed_at && <span>closed {fmtDateTime(f.closed_at)}</span>}
          <span>{isOpen ? "down" : "lasted"} {fmtDuration(incidentSeconds(f))}</span>
          <span>{checksFailed(f.checks_failed)}</span>
          {f.journal_id && <a href={`#/journal?focus=${f.journal_id}`}>journal</a>}
        </div>
        {isOpen ? <AckControl inc={e} onChanged={onChanged} /> : f.acknowledged_at ? <div className="small">Acknowledged{f.ack_note ? `: ${f.ack_note}` : ""}</div> : <div className="muted small">Not acknowledged</div>}
      </div>
    </div>
  );
}
