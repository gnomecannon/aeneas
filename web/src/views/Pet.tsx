import { useCallback, useEffect, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { createEntity, updateEntity } from "../sync/edits";
import { usePoll } from "../lib/usePoll";
import { custodyLabel, custodyNow, DEFAULT_CYCLE_DAYS, nextHandoffFrom } from "../lib/body";
import { fmtDate, fmtDateTime, relative } from "../lib/time";
import { useEscape } from "../lib/keys";
import { useEntities } from "../sync/hooks";
import { CsvButton } from "../components/CsvButton";
import { refreshProfile, usePetName, useProfile } from "../lib/profile";
import { engine } from "../sync/engine";
import { localDate } from "../lib/planner";


const TYPES = ["vet", "med", "incident", "custody", "weight", "food", "note"] as const;
type PetType = (typeof TYPES)[number];
type PetF = { pet: string; type: PetType; at: string; note?: string; cost?: number; next_due?: string };

const QUICK: Array<{ label: string; type: PetType; note: string }> = [
  { label: "Walked", type: "note", note: "Walked" },
  { label: "Fed", type: "food", note: "Fed" },
  { label: "Meds", type: "med", note: "Meds given" },
];

/** A new entry is dated today, the local day the form is opened (not the UTC day, which turns over in the evening). */
const empty = () => ({ type: "note" as PetType, date: localDate(new Date()), note: "", cost: "", next_due: "" });

export function Pet() {
  const profile = useProfile();
  if (profile && !profile.pet) return <NamePet />;
  return <PetView />;
}

/** No pet named yet: name one (the assistant then logs for it by name), or leave this page empty. */
function NamePet() {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="col" style={{ maxWidth: 520 }}>
      <h1>Pet</h1>
      <div className="muted">Name your pet to log walks, food, meds, vet visits and custody here and with the assistant.</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void engine.client?.setProfile(undefined, name.trim()).then(() => refreshProfile()).catch((x) => setErr(String(x))); }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pet's name" aria-label="Pet's name" />
        <button type="submit" className="primary" disabled={!name.trim()}>Save</button>
      </form>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

function PetView() {
  const PET_NAME = usePetName();
  const p = usePoll((c) => c.petSummary(PET_NAME));
  const s = p.data;
  const custodyEvents = useEntities("pet_event", (e) => e.fields.type === "custody" && String(e.fields.pet).toLowerCase() === PET_NAME.toLowerCase());
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(empty);
  const [flash, setFlash] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEscape(useCallback(() => setAdding(false), []));

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const quick = async (q: (typeof QUICK)[number]) => {
    setBusy(q.label);
    setErr("");
    try {
      await createEntity("pet_event", { pet: PET_NAME, type: q.type, at: new Date().toISOString(), note: q.note });
      setFlash(`${q.label.toLowerCase()}, noted`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!form.date) return;
    const fields: Record<string, unknown> = { pet: PET_NAME, type: form.type, at: new Date(`${form.date}T12:00:00`).toISOString() };
    if (form.note.trim()) fields.note = form.note.trim();
    const cost = Number(form.cost);
    if (form.cost.trim() && Number.isFinite(cost)) fields.cost = cost;
    if (form.next_due) fields.next_due = new Date(`${form.next_due}T09:00:00`).toISOString();
    await createEntity("pet_event", fields);
    setForm(empty());
    setAdding(false);
    setFlash("event added");
  };

  const event = (e: Entity) => {
    const f = e.fields as PetF;
    return (
      <div key={e.id} className="item">
        <div className="body">
          <div className="row">
            <span className={`chip static pet-${f.type}`}>{f.type}</span>
            <span className="t grow">{f.note ?? ""}</span>
            <span className="muted small">{fmtDate(f.at)}</span>
          </div>
          <div className="meta">
            {f.cost != null && <span>{f.cost} cost</span>}
            {f.next_due && <span>next {fmtDate(f.next_due)}</span>}
          </div>
        </div>
      </div>
    );
  };

  const custody = s?.custody;
  const handoff = custodyNow(custodyEvents);

  return (
    <div className="pet">
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="title-row"><h1 style={{ margin: 0 }}>{PET_NAME}</h1><CsvButton kind="pet_event" /></span>
        <span className="muted small">{p.at ? `checked ${relative(p.at.toISOString())}` : ""}</span>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        {QUICK.map((q) => (
          <button key={q.label} className="primary" onClick={() => void quick(q)} disabled={busy === q.label} aria-label={`${q.label} ${PET_NAME}`}>
            {q.label}
          </button>
        ))}
        {!adding && (
          <button className="ghost" onClick={() => setAdding(true)}>
            Add event
          </button>
        )}
      </div>
      {flash && <div className="ok">{flash}</div>}
      {err && <div className="error">{err}</div>}
      {!s && p.error && <div className={p.unavailable ? "muted small" : "error"}>{p.unavailable ? "Pet summary is not available on this hub." : p.error}</div>}

      {adding && (
        <form
          className="card col"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="pe-type">Type</label>
              <select id="pe-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as PetType })}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pe-date">Date</label>
              <input id="pe-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
            <div style={{ width: 100 }}>
              <label htmlFor="pe-cost">Cost</label>
              <input id="pe-cost" type="number" step="0.01" min={0} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
            </div>
            <div>
              <label htmlFor="pe-next">Next due</label>
              <input id="pe-next" type="date" value={form.next_due} onChange={(e) => setForm({ ...form, next_due: e.target.value })} />
            </div>
          </div>
          <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="Note" />
          <div className="row">
            <button className="primary" type="submit" disabled={!form.date}>
              Add
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <div className="muted small">A next due date gets a reminder the day before, from the hub.</div>
        </form>
      )}

      {s && (
        <>
          <div className="grid2" style={{ marginTop: 10 }}>
            <CustodyCard now={handoff} legacy={custody ?? null} onFlash={setFlash} onError={setErr} />
            <div className="card">
              <h3>Next due</h3>
              {!s.next_due.length && !s.plans?.length && <div className="muted small">nothing due</div>}
              <div className="list">
                {s.next_due.map((e) => {
                  const f = e.fields as PetF;
                  return (
                    <div key={e.id} className="row between">
                      <span>
                        <span className="chip static">{f.type}</span> {f.note ?? ""}
                      </span>
                      <span className="small">{f.next_due ? `${fmtDate(f.next_due)}, ${relative(f.next_due)}` : ""}</span>
                    </div>
                  );
                })}
                {/* Straight from the calendar: plans that name him, a vet or a groomer. */}
                {(s.plans ?? []).map((p) => {
                  const at = p.all_day ? `${p.start}T12:00:00` : p.start;
                  return (
                    <div key={p.id} className="row between">
                      <span><span className="chip static">calendar</span> {p.title}</span>
                      <span className="small">{`${fmtDate(at)}, ${relative(at)}`}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <h3 style={{ marginTop: 16 }}>Last 30 days ({s.events_30d.length})</h3>
          {!s.events_30d.length && <div className="muted small">no events yet</div>}
          <div className="list">{s.events_30d.slice().sort((a, b) => (String(a.fields.at) > String(b.fields.at) ? -1 : 1)).map(event)}</div>
          <div className="muted small" style={{ marginTop: 8 }}>
            Last event {s.events_30d.length ? fmtDateTime(s.events_30d.map((e) => String(e.fields.at)).sort().pop()) : "none"}.
          </div>
        </>
      )}
    </div>
  );
}

const weekday = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const daysUntil = (iso: string) => {
  const d = new Date(iso);
  const n = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`;
};
const cycleWords = (d: number) => (d % 7 === 0 ? (d === 7 ? "every week" : `every ${d / 7} weeks`) : `every ${d} days`);

/**
 * Where the pet is, from the last handoff you logged. One tap logs the next one on the day it really happens;
 * the next handoff is predicted from the cycle (a week unless changed) and can be moved by hand.
 */
function CustodyCard({ now, legacy, onFlash, onError }: {
  now: ReturnType<typeof custodyNow>;
  legacy: { with_me_now: boolean | null; next_handoff: string | null } | null;
  onFlash: (s: string) => void;
  onError: (s: string) => void;
}) {
  const PET_NAME = usePetName();
  const [busy, setBusy] = useState(false);
  const log = async (withMe: boolean) => {
    setBusy(true);
    try {
      const cycle = now?.cycleDays ?? DEFAULT_CYCLE_DAYS;
      const at = new Date().toISOString();
      await createEntity("pet_event", { pet: PET_NAME, type: "custody", at, with: withMe ? "me" : "other", cycle_days: cycle, next_due: nextHandoffFrom(at, cycle), note: withMe ? "Picked up" : "Dropped off at the other home" });
      onFlash(withMe ? `${PET_NAME} is with you` : `${PET_NAME} is at the other home`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const setCycle = async (days: number) => {
    if (!now) return;
    await updateEntity(now.handoff as never, { cycle_days: days, next_due: nextHandoffFrom(String(now.handoff.fields.at), days) });
  };
  const setNext = async (date: string) => {
    if (!now || !date) return;
    const time = new Date(now.next);
    const d = new Date(`${date}T00:00:00`);
    d.setHours(time.getHours(), time.getMinutes());
    await updateEntity(now.handoff as never, { next_due: d.toISOString() });
  };

  if (!now) {
    return (
      <div className="card">
        <h3>Custody</h3>
        {legacy?.with_me_now != null && <div className="big">{custodyLabel(legacy.with_me_now)}</div>}
        <div className="small" style={{ margin: "6px 0" }}>Where is {PET_NAME} right now? Tap it on the day the pet changes hands and the next handoff is predicted a week out (change the cycle after), with a reminder the day before.</div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void log(true)}>With me</button>
          <button disabled={busy} onClick={() => void log(false)}>At the other home</button>
        </div>
      </div>
    );
  }
  const nextLocal = (() => {
    const d = new Date(now.next);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  return (
    <div className="card">
      <h3>Custody</h3>
      <div className="big">{now.withMe ? "With you" : "At the other home"}</div>
      <div className="muted small">since {weekday(now.since)}, next handoff {weekday(now.next)} ({daysUntil(now.next)}), {cycleWords(now.cycleDays)}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={() => void log(!now.withMe)}>
          {now.withMe ? "Dropped him off" : "Picked him up"}
        </button>
      </div>
      <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <label className="small row" style={{ gap: 6 }}>
          Repeats
          <select value={now.cycleDays} onChange={(e) => void setCycle(Number(e.target.value))} aria-label="Handoff cycle">
            {[7, 14, 21, 28].concat([7, 14, 21, 28].includes(now.cycleDays) ? [] : [now.cycleDays]).map((d) => (
              <option key={d} value={d}>{cycleWords(d)}</option>
            ))}
          </select>
        </label>
        <label className="small row" style={{ gap: 6 }}>
          Next handoff
          <input type="date" value={nextLocal} onChange={(e) => void setNext(e.target.value)} aria-label="Next handoff date" />
        </label>
      </div>
    </div>
  );
}
