import { useEffect, useMemo, useState } from "react";
import { useEntities } from "../sync/hooks";
import { createEntity } from "../sync/edits";
import { engine } from "../sync/engine";
import { Sparkline, type Point } from "../components/Sparkline";
import { fmtDateTime } from "../lib/time";
import { SOURCE } from "../sync/actions";
import { CsvButton } from "../components/CsvButton";

type LogF = { type: string; value: number | string; unit?: string; at: string; note?: string };
type Logs7d = Record<string, Array<{ at: string; value: number | string }>>;

const TYPES = ["weight", "med", "bp", "caffeine", "mood", "activity"];

function num(v: number | string): number | null {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)/.exec(v);
  return m ? parseFloat(m[1]) : null;
}

export function Logs() {
  const logs = useEntities("log");
  const [weight, setWeight] = useState("");
  const [bp, setBp] = useState("");
  const [med, setMed] = useState("");
  const [activity, setActivity] = useState("");
  const [dash, setDash] = useState<Logs7d | null>(null);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    let alive = true;
    engine.client
      ?.dashboard()
      .then((d) => alive && setDash(d.logs_7d))
      .catch(() => alive && setDash(null));
    return () => {
      alive = false;
    };
  }, [logs.length]);

  const add = async (type: string, value: number | string, unit?: string) => {
    const fields: Record<string, unknown> = { type, value, at: new Date().toISOString(), source: SOURCE };
    if (unit) fields.unit = unit;
    await createEntity("log", fields);
    setFlash(`${type} ${value}`);
    setTimeout(() => setFlash(""), 1500);
  };

  const recent = (type: string) => {
    const seen = new Map<string, number>();
    for (const l of logs.filter((x) => x.fields.type === type).sort((a, b) => (a.fields.at > b.fields.at ? -1 : 1))) {
      const v = String(l.fields.value);
      if (!seen.has(v)) seen.set(v, 1);
      if (seen.size >= 6) break;
    }
    return [...seen.keys()];
  };
  const meds = useMemo(() => recent("med"), [logs]);
  const acts = useMemo(() => recent("activity"), [logs]);

  const series = (type: string): Point[] => {
    const src = dash?.[type] ?? logs.filter((l) => l.fields.type === type).map((l) => ({ at: l.fields.at as string, value: l.fields.value as number | string }));
    if (type === "caffeine" || type === "med" || type === "activity") {
      const perDay = new Map<string, number>();
      for (const p of src) {
        const d = new Date(p.at);
        d.setHours(12, 0, 0, 0);
        const k = d.toISOString();
        perDay.set(k, (perDay.get(k) ?? 0) + (type === "caffeine" ? (num(p.value) ?? 1) : 1));
      }
      return [...perDay.entries()].map(([at, value]) => ({ at, value }));
    }
    return src.map((p) => ({ at: p.at, value: num(p.value) ?? NaN })).filter((p) => Number.isFinite(p.value));
  };

  const today = logs.filter((l) => new Date(l.fields.at as string).toDateString() === new Date().toDateString()).sort((a, b) => (a.fields.at > b.fields.at ? -1 : 1));

  return (
    <div>
      <span className="title-row"><h1 style={{ margin: 0 }}>Logs</h1><CsvButton kind="log" /></span>
      {flash && <div className="ok">logged {flash}</div>}
      <div className="grid2">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const v = parseFloat(weight);
            if (Number.isFinite(v)) void add("weight", v, "lb").then(() => setWeight(""));
          }}
        >
          <h3>Weight</h3>
          <div className="row">
            <input type="number" step="0.1" inputMode="decimal" placeholder="lb" value={weight} onChange={(e) => setWeight(e.target.value)} className="grow" aria-label="Weight" />
            <button type="submit" disabled={!weight}>
              Log
            </button>
          </div>
          <Sparkline points={series("weight")} />
        </form>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{2,3}\/\d{2,3}$/.test(bp.trim())) void add("bp", bp.trim()).then(() => setBp(""));
          }}
        >
          <h3>BP</h3>
          <div className="row">
            <input placeholder="120/80" value={bp} onChange={(e) => setBp(e.target.value)} className="grow" aria-label="Blood pressure" />
            <button type="submit" disabled={!/^\d{2,3}\/\d{2,3}$/.test(bp.trim())}>
              Log
            </button>
          </div>
          <Sparkline points={series("bp")} />
        </form>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (med.trim()) void add("med", med.trim()).then(() => setMed(""));
          }}
        >
          <h3>Med taken</h3>
          <div className="chips" style={{ marginBottom: 8 }}>
            {meds.map((m) => (
              <button key={m} type="button" className="chip" onClick={() => add("med", m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="row">
            <input placeholder="med name" value={med} onChange={(e) => setMed(e.target.value)} className="grow" aria-label="Med name" />
            <button type="submit" disabled={!med.trim()}>
              Log
            </button>
          </div>
          <Sparkline points={series("med")} />
        </form>
        <div className="card">
          <h3>Caffeine</h3>
          <button onClick={() => add("caffeine", 1)} aria-label="Log one caffeine">
            +1
          </button>
          <Sparkline points={series("caffeine")} />
        </div>
        <div className="card">
          <h3>Mood</h3>
          <div className="mood">
            {[-2, -1, 0, 1, 2].map((m) => (
              <button key={m} onClick={() => add("mood", m)} aria-label={`Log mood ${m > 0 ? `plus ${m}` : m < 0 ? `minus ${-m}` : "zero"}`}>
                {m > 0 ? `+${m}` : m}
              </button>
            ))}
          </div>
          <Sparkline points={series("mood")} />
        </div>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (activity.trim()) void add("activity", activity.trim()).then(() => setActivity(""));
          }}
        >
          <h3>Activity</h3>
          <div className="chips" style={{ marginBottom: 8 }}>
            {acts.map((a) => (
              <button key={a} type="button" className="chip" onClick={() => add("activity", a)}>
                {a}
              </button>
            ))}
          </div>
          <div className="row">
            <input placeholder="activity" value={activity} onChange={(e) => setActivity(e.target.value)} className="grow" aria-label="Activity" />
            <button type="submit" disabled={!activity.trim()}>
              Log
            </button>
          </div>
          <Sparkline points={series("activity")} />
        </form>
      </div>
      {today.length > 0 && (
        <details open>
          <summary>Today ({today.length})</summary>
          <div className="list">
            {today.map((l) => {
              const f = l.fields as LogF;
              return (
                <div key={l.id} className="item">
                  <div className="body">
                    <span>
                      {f.type} {String(f.value)}
                      {f.unit ? ` ${f.unit}` : ""}
                    </span>
                    <span className="muted small"> {fmtDateTime(f.at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="muted small" style={{ marginTop: 8 }}>
        Sparklines: {dash ? "7 days from hub" : "7 days from local store"}. Types: {TYPES.join(", ")}.
      </div>
    </div>
  );
}
