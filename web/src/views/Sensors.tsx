import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import type { SensorRow } from "../sync/api";
import { META } from "../sync/db";
import { useMeta } from "../sync/hooks";
import { Sparkline } from "../components/Sparkline";
import { usePoll } from "../lib/usePoll";
import { csvFilename, sensorState, sensorTone } from "../lib/body";
import { relative } from "../lib/time";
import { go } from "../lib/router";

type Settings = { min: string; max: string; alert: boolean; stale_minutes: string; location: string };

function settingsOf(s: SensorRow): Settings {
  return { min: s.min != null ? String(s.min) : "", max: s.max != null ? String(s.max) : "", alert: s.alert !== false, stale_minutes: String(s.stale_minutes ?? 180), location: s.location ?? "" };
}

function num(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? null : n;
}

function SensorCard({ s, onSaved }: { s: SensorRow; onSaved: () => Promise<void> }) {
  const [edit, setEdit] = useState<Settings>(() => settingsOf(s));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) setEdit(settingsOf(s));
    // Only refresh the editor from the hub while it is closed; typing must not be overwritten by a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.min, s.max, s.alert, s.stale_minutes, s.location, open]);
  const state = sensorState(s);
  const tone = sensorTone(state);
  const bounds = [s.min, s.max].filter((v): v is number => v != null);

  const save = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("save");
    setErr("");
    try {
      const stale = num(edit.stale_minutes);
      await c.patchEntity(s.id, { min: num(edit.min), max: num(edit.max), alert: edit.alert, stale_minutes: stale && stale > 0 ? Math.round(stale) : 180, location: edit.location.trim() || null });
      setOpen(false);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // An alert opens a chat where the assistant looks into it and proposes one fix, which runs only when approved.
  const alerting = s.alert !== false && (state === "high" || state === "low" || state === "stale");
  const propose = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("fix");
    setErr("");
    try {
      const r = await c.sensorPropose(s.name);
      go(`/assistant/${r.session_id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("csv");
    setErr("");
    try {
      const text = await c.sensorCsv(s.name, 30);
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFilename(s.name, 30);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card sensor">
      <div className="row between">
        <div>
          <strong>{s.name}</strong> {s.location && <span className="muted small">{s.location}</span>}
        </div>
        <span className={`chip static tone-${tone}`}>{state}</span>
      </div>
      <div className="big" style={{ marginTop: 4 }}>
        {s.last_value != null ? `${s.last_value} ${s.unit}` : "no reading"}
        {s.last_at && <span className="muted small"> {relative(s.last_at)}</span>}
      </div>
      <Sparkline points={s.series_24h} hours={24} lines={bounds} />
      <div className="muted small">
        24 h{bounds.length ? `, bounds ${s.min ?? "none"} to ${s.max ?? "none"} ${s.unit}` : ", no bounds"}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {alerting && (
          <button className="small primary" onClick={() => void propose()} disabled={busy === "fix" || !engine.client} title="The assistant finds the cause and proposes a fix you approve or cancel">
            {busy === "fix" ? "Starting" : "Propose a fix"}
          </button>
        )}
        <button className="small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Close" : "Settings"}
        </button>
        <button className="small ghost" onClick={() => void download()} disabled={busy === "csv"}>
          Download CSV
        </button>
      </div>
      {open && (
        <form
          className="col"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="row">
            <div style={{ width: 90 }}>
              <label htmlFor={`${s.name}-min`}>Min</label>
              <input id={`${s.name}-min`} type="number" step="any" value={edit.min} onChange={(e) => setEdit({ ...edit, min: e.target.value })} />
            </div>
            <div style={{ width: 90 }}>
              <label htmlFor={`${s.name}-max`}>Max</label>
              <input id={`${s.name}-max`} type="number" step="any" value={edit.max} onChange={(e) => setEdit({ ...edit, max: e.target.value })} />
            </div>
            <div style={{ width: 110 }}>
              <label htmlFor={`${s.name}-stale`}>Stale after, min</label>
              <input id={`${s.name}-stale`} type="number" min={1} value={edit.stale_minutes} onChange={(e) => setEdit({ ...edit, stale_minutes: e.target.value })} />
            </div>
            <div className="grow">
              <label htmlFor={`${s.name}-loc`}>Location</label>
              <input id={`${s.name}-loc`} value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} />
            </div>
          </div>
          <label style={{ color: "inherit", fontSize: 15 }}>
            <input type="checkbox" checked={edit.alert} onChange={(e) => setEdit({ ...edit, alert: e.target.checked })} /> Alert when outside the bounds
          </label>
          <div className="row">
            <button type="submit" className="small primary" disabled={busy === "save"}>
              Save
            </button>
            <button type="button" className="small ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Home sensors from GET /sensors, with settings saved through the entity path and a how-to for the Pico rig. */
export function Sensors() {
  const p = usePoll((c) => c.sensors());
  const hubUrl = useMeta<string>(META.hubUrl) ?? "https://hub.example";
  const [howto, setHowto] = useState(false);
  // The sensor key only posts readings, so it can sit on a board (feedkeys.ts); fetched when the how-to opens.
  const [key, setKey] = useState("");
  useEffect(() => { if (howto && !key) void engine.client?.feeds().then((f) => setKey(f.sensors.key)).catch(() => undefined); }, [howto, key]);
  const list = (p.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const example = `import network, urequests, time
# Pico W: join wifi, then post one reading every 5 minutes.
HUB = "${hubUrl}"
KEY = "${key || "<sensor key>"}"   # posts readings only, nothing else
NAME = "planter_moisture"
UNIT = "%"

def post(value):
    r = urequests.post(f"{HUB}/sensors/{NAME}/readings?key={KEY}",
                       json={"value": value, "unit": UNIT})
    r.close()

while True:
    post(read_sensor())
    time.sleep(300)`;

  return (
    <div className="sensors">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Sensors</h1>
        <span className="muted small">{p.at ? `checked ${relative(p.at.toISOString())}` : ""}</span>
        <button className="small" onClick={() => void p.reload()} disabled={p.busy}>
          Refresh
        </button>
      </div>
      {!p.data && p.error && <div className={p.unavailable ? "muted small" : "error"}>{p.unavailable ? "Sensors are not available on this hub." : p.error}</div>}
      {p.data && !list.length && <div className="empty">No sensors yet. The first reading posted creates one.</div>}
      <div className="grid2">
        {list.map((s) => (
          <SensorCard key={s.id} s={s} onSaved={p.reload} />
        ))}
      </div>
      <details className="card" style={{ marginTop: 12 }} open={howto} onToggle={(e) => setHowto((e.target as HTMLDetailsElement).open)}>
        <summary>How to post readings</summary>
        <p className="small" style={{ marginTop: 8 }}>
          POST <code>{hubUrl}/sensors/&lt;name&gt;/readings?key=&lt;sensor key&gt;</code> with a JSON body <code>{"{"}"value": 21.5, "unit": "C"{"}"}</code>. The first post creates the sensor. Readings outside the bounds raise one alert per crossing. MicroPython on a Pico W:
        </p>
        <pre className="small">{example}</pre>
        <div className="row wrap small">
          <span className="muted">The sensor key only posts readings. A board using the hub token keeps working, but the key is safer on a board.</span>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              if (!confirm("Make a new sensor key? Boards using the old key stop posting until they get the new one.")) return;
              void engine.client?.rotateFeed("sensors").then((f) => setKey(f.sensors.key)).catch(() => undefined);
            }}
          >
            New key
          </button>
        </div>
      </details>
    </div>
  );
}
