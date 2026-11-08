import { useCallback, useState } from "react";
import { usePetName } from "../lib/profile";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { WEEKDAYS, type Weekday } from "../lib/planner";
import { useEscape } from "../lib/keys";

type RuleType = "blackout" | "commitment" | "preference" | "info";
type RuleF = { title: string; type: RuleType; days: Weekday[]; start: string; end: string; alternating_anchor?: string; note?: string; active?: boolean };

const EMPTY: RuleF = { title: "", type: "commitment", days: [], start: "09:00", end: "10:00", active: true };
const HELP: Record<RuleType, string> = {
  blackout: "never plan here",
  commitment: "fixed, shown on the grid",
  preference: "plan here first",
  info: "shown, never blocks (custody weeks)",
};

function DayChips({ value, onChange, name }: { value: Weekday[]; onChange: (d: Weekday[]) => void; name: string }) {
  return (
    <div className="chips" role="group" aria-label={`Days for ${name || "the rule"}`}>
      {WEEKDAYS.map((d) => {
        const on = value.includes(d);
        return (
          <button key={d} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)))}>
            {d}
          </button>
        );
      })}
    </div>
  );
}

function RuleForm({ value, onChange, idPrefix }: { value: RuleF; onChange: (v: RuleF) => void; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="col">
      <input placeholder="Title" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} aria-label="Title" />
      <div className="row">
        <div>
          <label htmlFor={id("type")}>Type</label>
          <select id={id("type")} value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as RuleType })}>
            <option value="blackout">blackout</option>
            <option value="commitment">commitment</option>
            <option value="preference">preference</option>
            <option value="info">info</option>
          </select>
        </div>
        <div>
          <label htmlFor={id("start")}>Start</label>
          <input id={id("start")} type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
        </div>
        <div>
          <label htmlFor={id("end")}>End</label>
          <input id={id("end")} type="time" value={value.end === "24:00" ? "23:59" : value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
        </div>
        <span className="muted small">{HELP[value.type]}</span>
      </div>
      <DayChips value={value.days} onChange={(days) => onChange({ ...value, days })} name={value.title} />
      <div className="row">
        <div>
          <label htmlFor={id("anchor")}>Alternating weeks from</label>
          <input id={id("anchor")} type="date" value={value.alternating_anchor ?? ""} onChange={(e) => onChange({ ...value, alternating_anchor: e.target.value || undefined })} />
        </div>
        <span className="muted small">Set a date and the rule holds every other week, counted from that week. Leave empty for every week.</span>
      </div>
      <div>
        <label htmlFor={id("note")}>Note</label>
        <input id={id("note")} value={value.note ?? ""} onChange={(e) => onChange({ ...value, note: e.target.value || undefined })} />
      </div>
      <label style={{ color: "inherit", fontSize: 15 }}>
        <input type="checkbox" checked={value.active !== false} onChange={(e) => onChange({ ...value, active: e.target.checked })} /> Active
      </label>
    </div>
  );
}

const valid = (r: RuleF) => !!r.title.trim() && r.days.length > 0 && /^\d{2}:\d{2}$/.test(r.start) && /^\d{2}:\d{2}$/.test(r.end) && r.start < r.end;

function toFields(r: RuleF): Record<string, unknown> {
  return {
    title: r.title.trim(),
    type: r.type,
    days: r.days,
    start: r.start,
    end: r.end === "23:59" ? "24:00" : r.end,
    alternating_anchor: r.alternating_anchor || null,
    note: r.note?.trim() || null,
    active: r.active !== false,
  };
}

/** Standing constraints for the block planner: blackouts, commitments and preferences by weekday. */
export function PlanRules() {
  const rules = useEntities("plan_rule").slice().sort((a, b) => String(a.fields.title).localeCompare(String(b.fields.title)));
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<RuleF>({ ...EMPTY });
  const [open, setOpen] = useState<string | null>(null);
  const pet = usePetName();
  const [edit, setEdit] = useState<RuleF | null>(null);
  useEscape(
    useCallback(() => {
      setOpen(null);
      setAdding(false);
    }, []),
  );

  const openRule = (r: Entity) => {
    const f = r.fields as RuleF;
    setOpen(r.id);
    setEdit({ title: f.title ?? "", type: f.type ?? "commitment", days: f.days ?? [], start: f.start ?? "09:00", end: f.end ?? "10:00", alternating_anchor: f.alternating_anchor, note: f.note, active: f.active !== false });
  };

  const add = async () => {
    if (!valid(form)) return;
    const fields = toFields(form);
    if (fields.alternating_anchor === null) delete fields.alternating_anchor;
    if (fields.note === null) delete fields.note;
    await createEntity("plan_rule", fields);
    setForm({ ...EMPTY });
    setAdding(false);
  };

  const save = async (r: Entity) => {
    if (!edit || !valid(edit)) return;
    await updateEntity(r, toFields(edit));
    setOpen(null);
  };

  return (
    <div className="plan-rules">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Plan rules</h1>
        <div className="row">
          <a href="#/week" className="small">
            Week
          </a>
          {!adding && (
            <button className="small primary" onClick={() => setAdding(true)}>
              Add
            </button>
          )}
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        The planner never schedules inside a blackout, shows commitments as fixed, and prefers preferences. Info rules are only shown, like a custody week: title it "{pet} week", all days, 00:00 to 24:00, with an alternating anchor.
      </p>
      {adding && (
        <form
          className="card col"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <RuleForm value={form} onChange={setForm} idPrefix="new" />
          <div className="row">
            <button className="primary" type="submit" disabled={!valid(form)}>
              Add
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!rules.length && <div className="empty">No rules yet. Add a blackout for the hours that are never yours, and commitments for fixed things.</div>}
      <div className="list">
        {rules.map((r) => {
          const f = r.fields as RuleF;
          const isOpen = open === r.id;
          return (
            <div key={r.id} className={`item rule ${f.active === false ? "off" : ""}`}>
              <div className="body">
                <div className="row">
                  <span className={`chip static ${f.type}`}>{f.type}</span>
                  <span className="t grow">{f.title}</span>
                  <span className="muted small mono">
                    {f.start} to {f.end}
                  </span>
                </div>
                <div className="meta">
                  <span>{(f.days ?? []).join(" ")}</span>
                  {f.alternating_anchor && <span>every other week from {f.alternating_anchor}</span>}
                  {f.active === false && <span>inactive</span>}
                  {f.note && <span>{f.note}</span>}
                  <button className="ghost small" onClick={() => (isOpen ? setOpen(null) : openRule(r))} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Edit"} ${f.title}`}>
                    {isOpen ? "less" : "edit"}
                  </button>
                </div>
                {isOpen && edit && (
                  <div className="col" style={{ marginTop: 8 }}>
                    <RuleForm value={edit} onChange={setEdit} idPrefix={`r-${r.id.slice(0, 8)}`} />
                    <div className="row">
                      <button className="small primary" onClick={() => void save(r)} disabled={!valid(edit)}>
                        Save
                      </button>
                      <button className="small ghost" onClick={() => setOpen(null)}>
                        Cancel
                      </button>
                      <button className="small ghost danger" onClick={() => confirm("Delete this rule") && softDelete(r).then(() => setOpen(null))}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
