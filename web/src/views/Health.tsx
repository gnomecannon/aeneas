import { useMemo, useState } from "react";
import { engine } from "../sync/engine";
import { Sparkline } from "../components/Sparkline";
import { usePoll } from "../lib/usePoll";
import { fmtDelta, mergeMeds } from "../lib/body";
import { fmtDateTime, relative } from "../lib/time";
import { WEEKDAYS, type Weekday } from "../lib/planner";
import { useEntities } from "../sync/hooks";
import type { Entity } from "@everythingapp/shared";

/** Body summary from GET /health/summary. Logs stays the one-tap input; this is the read side plus meds chips and the injection day. */
export function Health() {
  const h = usePoll((c) => c.healthSummary(30));
  const s = h.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [err, setErr] = useState("");
  // The injection's name: the one already set, else typed in.
  const [name, setName] = useState("");
  const [weekday, setWeekday] = useState<Weekday>("fri");
  const [time, setTime] = useState("09:00");
  const [setting, setSetting] = useState(false);

  const meds = useMemo(() => (s ? mergeMeds(s.meds_expected, s.meds_today) : []), [s]);

  const logMed = async (med: string) => {
    const c = engine.client;
    if (!c) return;
    setBusy(med);
    setErr("");
    try {
      await c.log({ type: "med", value: med });
      setFlash(`logged ${med}`);
      setTimeout(() => setFlash(""), 1500);
      await h.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveInjection = async () => {
    const c = engine.client;
    if (!c || !name.trim() || !/^\d{2}:\d{2}$/.test(time)) return;
    setBusy("injection");
    setErr("");
    try {
      await c.injectionDay({ name: name.trim(), weekday, time });
      setSetting(false);
      await h.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stat = (label: string, value: string, sub?: string) => (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );

  return (
    <div className="health">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Health</h1>
        <span className="muted small">{h.at ? `checked ${relative(h.at.toISOString())}` : ""}</span>
        <a href="#/logs" className="small">
          Log
        </a>
      </div>
      {flash && <div className="ok">{flash}</div>}
      {err && <div className="error">{err}</div>}
      {!s && h.error && <div className={h.unavailable ? "muted small" : "error"}>{h.unavailable ? "Health summary is not available on this hub." : h.error}</div>}
      <History />
      {s && (
        <>
          <div className="grid3">
            <div className="card stat">
              <div className="muted small">Weight</div>
              <div className="big">{s.weight.latest != null ? `${s.weight.latest} ${s.weight.unit ?? "lb"}` : "none"}</div>
              <div className="muted small">
                {s.weight.at ? `${fmtDateTime(s.weight.at)}. ` : ""}
                {s.weight.delta_7d != null ? `${fmtDelta(s.weight.delta_7d)} 7d` : ""}
                {s.weight.delta_30d != null ? `, ${fmtDelta(s.weight.delta_30d)} 30d` : ""}
              </div>
              <Sparkline points={s.weight.series} days={30} />
            </div>
            {stat("Blood pressure", s.bp.latest ?? "none", s.bp.at ? fmtDateTime(s.bp.at) : undefined)}
            {stat("Caffeine today", String(s.caffeine_today))}
            <div className="card stat">
              <div className="muted small">Mood 7d</div>
              <Sparkline points={s.mood.series_7d} />
            </div>
            <div className="card stat">
              <div className="muted small">Sleep</div>
              {s.sleep.last && <div className="big">{`${Math.floor(s.sleep.last.value / 60)} h ${Math.round(s.sleep.last.value % 60)} min`}</div>}
              {s.sleep.last && <div className="muted small">night of {new Date(s.sleep.last.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>}
              <Sparkline points={s.sleep.series_7d} />
            </div>
            {s.steps && (
              <div className="card stat">
                <div className="muted small">Steps</div>
                <div className="big">{s.steps.today != null ? s.steps.today.toLocaleString() : s.steps.latest ? s.steps.latest.value.toLocaleString() : "none"}</div>
                <div className="muted small">{s.steps.today != null ? "today" : s.steps.latest ? new Date(s.steps.latest.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "from Apple Health"}</div>
                <Sparkline points={s.steps.series_14d} days={14} />
              </div>
            )}
            {stat("Activity 7d", `${Math.round(s.activity_hours_7d * 10) / 10} h`)}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Meds today</h3>
            {!meds.length && <div className="muted small">No meds expected. Add a fact health:medications on the hub.</div>}
            <div className="chips" role="group" aria-label="Meds today">
              {meds.map((m) => (
                <button key={m.name} type="button" className={`chip ${m.taken ? "on" : ""}`} aria-pressed={m.taken} disabled={busy === m.name} onClick={() => void logMed(m.name)} title={m.taken ? "taken, tap to log again" : "tap to log taken"}>
                  {m.name}
                  {m.extra ? " (extra)" : ""}
                </button>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="row between">
              <h3 style={{ margin: 0 }}>Next injection</h3>
              <button className="small ghost" onClick={() => { if (!name && s?.next_injection) setName(s.next_injection.name); setSetting((v) => !v); }} aria-expanded={setting}>
                {setting ? "Close" : "Set day"}
              </button>
            </div>
            <div style={{ marginTop: 6 }}>
              {s.next_injection ? (
                <>
                  <span className="big">{fmtDateTime(s.next_injection.at)}</span> <span className="muted small">{s.next_injection.name}, {relative(s.next_injection.at)}</span>
                </>
              ) : (
                <span className="muted">No injection day set.</span>
              )}
            </div>
            {setting && (
              <form
                className="row"
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveInjection();
                }}
              >
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Injection name" style={{ width: 120 }} />
                <select value={weekday} onChange={(e) => setWeekday(e.target.value as Weekday)} aria-label="Weekday">
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
                <button type="submit" className="small primary" disabled={busy === "injection" || !name.trim()}>
                  Save
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const METRICS = [
  ["weight", "Weight"],
  ["bp", "Blood pressure"],
  ["sleep", "Sleep"],
  ["steps", "Steps"],
  ["activity", "Workouts"],
  ["caffeine", "Caffeine"],
  ["mood", "Mood"],
  ["med", "Meds"],
] as const;
const RANGES = [["7", "Week"], ["31", "Month"], ["366", "Year"], ["0", "All"]] as const;

function valueText(type: string, e: Entity): string {
  const v = e.fields.value;
  if (type === "sleep" && typeof v === "number") return `${Math.floor(v / 60)} h ${Math.round(v % 60)} min`;
  if (type === "steps" && typeof v === "number") return `${v.toLocaleString()} steps`;
  if (type === "weight") return `${String(v)} ${String(e.fields.unit ?? "lb")}`;
  if (type === "caffeine") return `${String(v ?? 1)} cup${v === 1 ? "" : "s"}`;
  return String(v ?? "");
}

/** Every reading of one measure over a range, typed here or synced with Apple Health, newest first. */
function History() {
  const logs = useEntities("log");
  const [type, setType] = useState<string>("weight");
  const [days, setDays] = useState<string>("31");
  const rows = useMemo(() => {
    const cutoff = days === "0" ? "" : new Date(Date.now() - Number(days) * 86400_000).toISOString();
    return logs
      .filter((e) => e.fields.type === type && e.fields.note !== "end" && String(e.fields.at ?? "") >= cutoff)
      .sort((a, b) => String(b.fields.at).localeCompare(String(a.fields.at)));
  }, [logs, type, days]);
  const points = rows
    .map((e) => ({ at: String(e.fields.at), value: type === "bp" ? parseFloat(String(e.fields.value)) : typeof e.fields.value === "number" ? e.fields.value : NaN }))
    .filter((p) => Number.isFinite(p.value));
  return (
    <div className="card col" style={{ marginTop: 12 }}>
      <h3 style={{ margin: 0 }}>History</h3>
      <div className="chips" role="group" aria-label="Measure">
        {METRICS.map(([k, label]) => (
          <button key={k} type="button" className={`chip ${type === k ? "on" : ""}`} aria-pressed={type === k} onClick={() => setType(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Range">
        {RANGES.map(([k, label]) => (
          <button key={k} type="button" className={`chip ${days === k ? "on" : ""}`} aria-pressed={days === k} onClick={() => setDays(k)}>
            {label}
          </button>
        ))}
      </div>
      {points.length >= 2 && <Sparkline points={points} days={days === "0" ? Math.max(1, Math.ceil((Date.now() - Date.parse(points[points.length - 1].at)) / 86400_000) + 1) : Number(days)} />}
      <div className="list">
        {rows.slice(0, 300).map((e) => (
          <div key={e.id} className="item">
            <div className="body row between">
              <span>{valueText(type, e)}</span>
              <span className="muted small">
                {e.fields.note === "Apple Health" ? "Health, " : ""}
                {fmtDateTime(String(e.fields.at))}
              </span>
            </div>
          </div>
        ))}
      </div>
      {!rows.length && <div className="muted small">Nothing in this range.</div>}
      {rows.length > 300 && <div className="muted small">Showing the newest 300 of {rows.length}.</div>}
    </div>
  );
}
