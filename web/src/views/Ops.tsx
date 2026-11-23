import { plainError } from "../lib/errors";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, updateEntity } from "../sync/edits";
import { usePoll } from "../lib/usePoll";
import { go, replace } from "../lib/router";
import { checksLine, identityLine, machineBars, machineSections, needsALook, readingLabel, readingValue, techLight, thingStatus, type Look, type Thing } from "../lib/tech";
import { MachinesSettings } from "./settings/HubPrivacy";
import { MachinesStart } from "./settings/MachinesSetup";
import { doneWithFirstSteps, justSwitchedOn, useModules } from "../lib/modules";
import { HistoryList } from "./History";
import { historyItems } from "../lib/history";
import { useEscape } from "../lib/keys";
import { fmtDateTime, fmtDuration, relativePast } from "../lib/time";
import type { SensorRow } from "../sync/api";
import { sensorState } from "../lib/body";
import {
  EMPTY_MONITOR,
  MONITOR_TYPES,
  hubLineText,
  incidentSeconds,
  jobLine,
  lastErrors,
  monitorDraft,
  monitorFields,
  monitorState,
  uptimeStrip,
  type CheckRow,
  type HubBackupLine,
  type IncidentF,
  type MonitorDraft,
  type MonitorF,
  type MonitorType,
  type OpsMonitor,
} from "../lib/ops";

const msg = (e: unknown) => plainError(e);
const checksFailed = (n?: number) => `${n ?? 0} check${n === 1 ? "" : "s"} failed`;

const TARGET_HINT: Record<MonitorType, string> = {
  ping: "192.168.1.20",
  tcp: "192.168.1.20:22",
  http: "http://127.0.0.1:8787/health",
  tls: "https://core.example.ts.net:8787",
  dns: "core.example.ts.net",
  backup: "mac:laptop, windows:desktop, linux:me@nas",
};

/**
 * Tech, Overview: what needs a look (with Propose a fix and Acknowledge), then one card per machine, service and place,
 * from GET /ops and GET /sensors. A card opens the thing's page (Hosts.tsx), which holds its checks, readings, fix notes,
 * changes and snippets.
 */
export function Ops({ focus: asked }: { focus?: string | null }) {
  // Rerenders when Machines' first steps are done with (lib/modules.ts).
  useModules();
  const p = usePoll((c) => c.ops(), 30_000);
  // Sensors may be switched off: then there are only checks.
  const sp = usePoll((c) => c.sensors(), 60_000);
  const [adding, setAdding] = useState<"check" | "machine" | null>(null);
  const reload = p.reload;
  const reloadAll = useCallback(async () => { await Promise.all([p.reload(), sp.reload()]); }, [p.reload, sp.reload]);
  useEffect(() => engine.onNotify((n) => (n.kind === "monitor" || n.kind === "sensor") && void reloadAll()), [reloadAll]);
  useEscape(useCallback(() => setAdding(null), []));

  const data = p.data;
  const sensors = useMemo(() => sp.data ?? [], [sp.data]);
  const things = useMemo(() => data?.things ?? [], [data]);
  const monitors = useMemo(() => data?.monitors ?? [], [data]);
  const byMonitor = useMemo(() => new Map(monitors.map((m) => [m.id, m])), [monitors]);
  const bySensor = useMemo(() => new Map(sensors.map((s) => [s.name, s])), [sensors]);
  const looks = useMemo(() => needsALook(things, monitors, data?.incidents_open ?? [], sensors, data?.hub_backup ?? []), [things, monitors, data, sensors]);

  // A link to a check or its incident (a notification, search, linked items) opens the page of the thing it is on.
  const linked = useEntity(asked ?? undefined);
  const focus = linked?.kind === "incident" ? String(linked.fields.monitor_id ?? "") || asked : asked;
  useEffect(() => {
    if (!focus || !things.length) return;
    const t = things.find((x) => x.monitors.includes(focus));
    if (t) replace(`/hosts/${encodeURIComponent(t.name)}?focus=${encodeURIComponent(focus)}`);
  }, [focus, things]);

  const light = techLight(looks, things, monitors, sensors);
  const stale = !!(data && p.error);
  const machines = things.filter((t) => t.kind === "machine");
  const services = things.filter((t) => t.kind === "service");
  const places = things.filter((t) => t.kind === "place");
  // A hub from before 2026-11-19 sends no things: its checks still show, by machine name.
  const oldHub = !!data && !data.things;

  return (
    <div className="ops tech">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Overview</h1>
        <span className="muted small">{p.at ? `checked ${relativePast(p.at.toISOString())}` : ""}</span>
        <div className="row">
          <button className="small" onClick={() => void reloadAll()} disabled={p.busy}>
            Refresh
          </button>
          <button className="small" onClick={() => setAdding((a) => (a === "machine" ? null : "machine"))} aria-expanded={adding === "machine"}>
            Add machine
          </button>
          <button className="small primary" onClick={() => setAdding((a) => (a === "check" ? null : "check"))} aria-expanded={adding === "check"}>
            Add check
          </button>
        </div>
      </div>
      {!data && p.error && <div className={p.unavailable ? "muted small" : "error"}>{p.unavailable ? "Machines is switched off on this hub (Settings, Modules)." : p.error}</div>}
      {data && (
        <div className={`ops-light tone-${stale ? "muted" : light.tone}`} role="status" aria-label={`${light.label}${light.detail ? `, ${light.detail}` : ""}`}>
          <span className="label">{light.label}</span>
          {(light.detail || stale) && <span className="detail">{[light.detail, stale && p.at ? `as of ${relativePast(p.at.toISOString())}: the hub did not answer the last refresh` : ""].filter(Boolean).join("; ")}</span>}
        </div>
      )}

      {adding === "check" && <MonitorEditor key="new" monitor={null} hosts={machines.map((t) => t.name)} onDone={() => { setAdding(null); void reload(); }} />}
      {adding === "machine" && (
        <div className="card col" style={{ marginTop: 12 }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Machines the hub can reach</h2>
            <button className="small ghost" onClick={() => setAdding(null)}>Close</button>
          </div>
          <MachinesSettings onAdded={() => void reload()} />
          <div className="muted small">
            A machine with a check, fix notes or a change shows here too. For a sensor board somewhere in the house, see <a href="#/sensors">how a board posts readings</a>.
          </div>
        </div>
      )}

      {justSwitchedOn("homelab") && <MachinesStart onDone={() => doneWithFirstSteps("homelab")} onAdded={() => void reload()} />}

      <NeedsALook looks={looks} things={things} onChanged={reloadAll} />

      {oldHub && <div className="muted small" style={{ marginTop: 12 }}>This hub is older than this app: update it (Settings, About) to see a card for each machine.</div>}
      {machineSections(machines).map((sec) => (
        <ThingGrid key={sec.title} title={sec.title} things={sec.things} monitors={byMonitor} sensors={bySensor} hubBackup={data?.hub_backup ?? []} />
      ))}
      <ThingGrid title="Services" things={services} monitors={byMonitor} sensors={bySensor} hubBackup={data?.hub_backup ?? []} />
      <ThingGrid title="Places" things={places} monitors={byMonitor} sensors={bySensor} hubBackup={data?.hub_backup ?? []} />
      {data && !things.length && !oldHub && <div className="empty">Nothing watched yet. Add a machine, or a check for a machine or a web address.</div>}

      {data && <RecentActivity things={things} monitors={monitors} />}
    </div>
  );
}

/** Propose a fix: the hub starts (or reopens) a chat where the assistant finds the cause and proposes one change to approve. */
export function ProposeFix({ monitorId, sensor, className = "small" }: { monitorId?: string; sensor?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const propose = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      const r = monitorId ? await c.monitorPropose(monitorId) : await c.sensorPropose(sensor!);
      go(`/assistant/${r.session_id}`);
    } catch (e) {
      setErr(msg(e));
      setBusy(false);
    }
  };
  return (
    <>
      <button className={className} onClick={() => void propose()} disabled={busy || !engine.client} title="The assistant finds the cause and proposes one fix you approve or cancel">
        {busy ? "Starting" : "Propose a fix"}
      </button>
      {err && <div className="error" style={{ flexBasis: "100%" }}>{err}</div>}
    </>
  );
}

/** The rows of what needs a look, each with Propose a fix (an assistant chat that proposes one change to approve) and Acknowledge for a check that is down. */
export function NeedsALook({ looks, things, onChanged }: { looks: Look[]; things: Thing[]; onChanged: () => Promise<void> }) {
  if (!looks.length) return null;
  const by = new Map(things.map((t) => [t.name, t]));
  return (
    <section className="card needs-look" aria-label="Needs a look">
      <h2 style={{ margin: "0 0 4px" }}>Needs a look</h2>
      {looks.map((l) => (
        <div key={l.key} className={`look-row ${l.acknowledged ? "acked" : ""}`}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="look-title">
              <span className={`dot ${l.acknowledged ? "unknown" : "down"}`} aria-hidden="true" />
              <span>{l.title}</span>
              {l.thing && (
                <a href={`#/hosts/${encodeURIComponent(l.thing)}`} className={`small ${by.get(l.thing)?.kind === "place" ? "" : "mono"}`}>
                  {by.get(l.thing)?.label ?? l.thing}
                </a>
              )}
            </div>
            {l.detail && <div className="muted small" style={{ overflowWrap: "anywhere" }}>{l.detail}</div>}
            {l.incident && <AckControl inc={l.incident} onChanged={onChanged} />}
          </div>
          {(l.monitorId || l.sensor) && (
            <div className="look-fix">
              <ProposeFix monitorId={l.monitorId} sensor={l.sensor} />
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** A heading and a card per thing; nothing when there are none of that kind. */
function ThingGrid({ title, things, monitors, sensors, hubBackup }: { title: string; things: Thing[]; monitors: Map<string, OpsMonitor>; sensors: Map<string, SensorRow>; hubBackup: HubBackupLine[] }) {
  if (!things.length) return null;
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <div className="ops-grid thing-grid" style={{ marginTop: 8 }}>
        {things.map((t) => (
          <ThingCard key={t.name} t={t} monitors={monitors} sensors={sensors} hubBackup={hubBackup} />
        ))}
      </div>
    </section>
  );
}

/** One machine, service or place: how it is, its checks in a line, and its CPU, memory and fullest disk (or a place's readings). */
function ThingCard({ t, monitors, sensors, hubBackup }: { t: Thing; monitors: Map<string, OpsMonitor>; sensors: Map<string, SensorRow>; hubBackup: HubBackupLine[] }) {
  const st = thingStatus(t, monitors, sensors, hubBackup);
  const line = checksLine(t, monitors);
  const bars = t.kind === "place" ? [] : machineBars(t, sensors);
  const readings = t.kind === "place" ? t.sensors.map((n) => sensors.get(n)).filter((s): s is SensorRow => !!s) : [];
  return (
    <a href={`#/hosts/${encodeURIComponent(t.name)}`} className={`card thing ${st.tone === "danger" ? "down" : ""}`} style={{ color: "inherit" }}>
      <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
        <div className="row" style={{ gap: 8, fontWeight: 600, flexWrap: "nowrap", minWidth: 0 }}>
          <span className={`dot lg ${st.tone === "danger" ? "down" : st.tone === "ok" ? "up" : "unknown"}`} aria-hidden="true" />
          <span className={t.kind === "place" ? "" : "mono"} style={{ overflowWrap: "anywhere" }}>{t.label}</span>
        </div>
        <span className={`chip static tone-${st.tone}`}>{st.label}</span>
      </div>
      {identityLine(t) && <div className="small" style={{ marginTop: 2, overflowWrap: "anywhere" }}>{identityLine(t)}</div>}
      {(line || t.hub) && <div className="muted small" style={{ marginTop: 2 }}>{[t.hub ? "the hub's machine" : "", line].filter(Boolean).join(", ")}</div>}
      {bars.map((b) => (
        <div key={b.label} className="stat-bar">
          <div className="row between small" style={{ flexWrap: "nowrap" }}>
            <span>{b.label}</span>
            <span className={b.tone === "danger" ? "error" : "muted"}>{b.text}</span>
          </div>
          <div className="bar" aria-hidden="true">
            <i className={b.tone === "danger" ? "hi" : ""} style={{ width: `${b.value}%` }} />
          </div>
        </div>
      ))}
      {readings.map((s) => (
        <div key={s.name} className="row between small" style={{ flexWrap: "nowrap" }}>
          <span>{readingLabel(s.name, t.name)}</span>
          <span className={sensorState(s) !== "ok" && s.alert !== false ? "error" : "muted"}>{readingValue(s)}</span>
        </div>
      ))}
    </a>
  );
}

/** The latest from every machine's and place's History, with all changes and all snippets a click away. */
function RecentActivity({ things, monitors }: { things: Thing[]; monitors: OpsMonitor[] }) {
  const journal = useEntities("journal");
  const incidents = useEntities("incident");
  const runbooks = useEntities("runbook");
  const items = useMemo(() => {
    const thingOf = new Map(things.flatMap((t) => t.monitors.map((id) => [id, t.name] as const)));
    const hostOf = (id: string) => thingOf.get(id) ?? (String(monitors.find((m) => m.id === id)?.fields.host ?? "").toLowerCase() || undefined);
    return historyItems({ journal, incidents, runbooks, hostOf });
  }, [journal, incidents, runbooks, things, monitors]);
  return (
    <section className="card activity" style={{ marginTop: 20 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Recent activity</h2>
        <span className="row small">
          <a href="#/journal">all changes</a>
          <a href="#/snippets">all snippets</a>
        </span>
      </div>
      <HistoryList items={items} showHost step={8} />
    </section>
  );
}

/** The hub's own data: its nightly copy, a second folder, the copy to storage and the live copy, a line each. */
export function HubBackupCard({ lines }: { lines: HubBackupLine[] }) {
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

export function MonitorCard({ m, pct, open, onToggle, onEdit, onChanged }: { m: OpsMonitor; pct: number | null; open: boolean; onToggle: () => void; onEdit: () => void; onChanged: () => Promise<void> }) {
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
          <div className="row" style={{ marginTop: 6 }}><ProposeFix monitorId={m.id} /></div>
        </div>
      )}
      {inc && !joined && <IncidentStrip inc={inc} monitorId={m.id} onChanged={onChanged} showError={!jobs} />}
      {!inc && state === "down" && f.enabled !== false && <div className="row" style={{ marginTop: 8 }}><ProposeFix monitorId={m.id} /></div>}
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

/** The red strip on a card with an open incident: the error, Propose a fix and Acknowledge (the card is on its machine's page). */
/** `showError` false: the card already says what is wrong (a backup machine's job lines). */
function IncidentStrip({ inc, monitorId, onChanged, showError = true }: { inc: Entity; monitorId: string; onChanged: () => Promise<void>; showError?: boolean }) {
  const f = inc.fields as IncidentF;
  return (
    <div className="inc-strip">
      {showError && <div className="err">{f.last_error ?? "down"}</div>}
      {f.also_down?.length ? <div className="small">Also down with it: {f.also_down.join(", ")}</div> : null}
      <div className="muted small">
        down {fmtDuration(incidentSeconds(f))}, {checksFailed(f.checks_failed)}
      </div>
      <div className="row" style={{ alignItems: "center", gap: 6 }}>
        <ProposeFix monitorId={monitorId} />
        <AckControl inc={inc} onChanged={onChanged} />
      </div>
    </div>
  );
}

/** "Acknowledge" opens a one-line note; the hub stamps the incident and, with a note, writes a journal entry. */
export function AckControl({ inc, onChanged }: { inc: Entity; onChanged: () => Promise<void> }) {
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
export function MonitorEditor({ monitor, hosts, host, onDone }: { monitor: Entity | null; hosts: string[]; host?: string; onDone: () => void }) {
  const [d, setD] = useState<MonitorDraft>(() => (monitor ? monitorDraft(monitor.fields as MonitorF) : { ...EMPTY_MONITOR, ...(host ? { host } : {}) }));
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

/** An incident: open ones with Acknowledge, closed ones with how long they lasted and the note. */
export function IncidentRow({ e, onChanged }: { e: Entity; onChanged: () => Promise<void> }) {
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
