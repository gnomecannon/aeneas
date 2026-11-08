import { useCallback, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import type { FoodPick } from "../sync/api";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { mealForTime, type Meal } from "../lib/body";
import { useEscape } from "../lib/keys";

const MODES = ["delivery", "restaurant", "grab", "home"] as const;
type Mode = (typeof MODES)[number];
const TAGS = ["protein", "plant", "sushi", "spicy", "sweet-sauce", "tomato", "fried", "cheap"];
type FoodF = { name: string; kind: Mode; items?: string[]; tags?: string[]; avoid?: boolean; rating?: number; cost?: number; last_picked?: string; times_picked?: number; notes?: string };

const EMPTY = { name: "", kind: "delivery" as Mode, items: "", tags: [] as string[], avoid: false, rating: "", cost: "" };
type Form = typeof EMPTY;

function toFields(f: Form): Record<string, unknown> {
  const rating = Number(f.rating);
  const cost = Number(f.cost);
  return {
    name: f.name.trim(),
    kind: f.kind,
    items: f.items.split(",").map((s) => s.trim()).filter(Boolean),
    tags: f.tags,
    avoid: f.avoid,
    rating: f.rating.trim() && rating >= 1 && rating <= 5 ? Math.round(rating) : null,
    cost: f.cost.trim() && Number.isFinite(cost) ? cost : null,
  };
}

function OptionForm({ value, onChange, idPrefix }: { value: Form; onChange: (v: Form) => void; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="col">
      <input placeholder="Name" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} aria-label="Name" />
      <div className="row">
        <div>
          <label htmlFor={id("kind")}>Kind</label>
          <select id={id("kind")} value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as Mode })}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 90 }}>
          <label htmlFor={id("rating")}>Rating 1 to 5</label>
          <input id={id("rating")} type="number" min={1} max={5} value={value.rating} onChange={(e) => onChange({ ...value, rating: e.target.value })} />
        </div>
        <div style={{ width: 100 }}>
          <label htmlFor={id("cost")}>Cost</label>
          <input id={id("cost")} type="number" step="0.01" min={0} value={value.cost} onChange={(e) => onChange({ ...value, cost: e.target.value })} />
        </div>
      </div>
      <div>
        <label htmlFor={id("items")}>What to order, comma separated</label>
        <input id={id("items")} value={value.items} onChange={(e) => onChange({ ...value, items: e.target.value })} />
      </div>
      <div className="chips" role="group" aria-label="Tags">
        {TAGS.map((t) => {
          const on = value.tags.includes(t);
          return (
            <button key={t} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onChange({ ...value, tags: on ? value.tags.filter((x) => x !== t) : [...value.tags, t] })}>
              {t}
            </button>
          );
        })}
      </div>
      <label style={{ color: "inherit", fontSize: 15 }}>
        <input type="checkbox" checked={value.avoid} onChange={(e) => onChange({ ...value, avoid: e.target.checked })} /> Avoid, never pick
      </label>
    </div>
  );
}

/** One decision at a time: the hub picks, this shows exactly one option. The list underneath is for upkeep only. */
export function Food() {
  const options = useEntities("food_option").slice().sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  const [snack, setSnack] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [budget, setBudget] = useState("");
  const [pick, setPick] = useState<FoodPick | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form>({ ...EMPTY });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form | null>(null);
  useEscape(
    useCallback(() => {
      setOpen(null);
      setAdding(false);
    }, []),
  );

  const meal: Meal = mealForTime(new Date(), snack);

  const ask = async (exclude: string[]) => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub.");
      return;
    }
    setBusy(true);
    setErr("");
    setDone(null);
    try {
      const b = Number(budget);
      const r = await c.foodPick({ meal, mode: mode ?? undefined, budget: budget.trim() && Number.isFinite(b) ? b : undefined, exclude });
      setPick(r);
      setExcluded(exclude);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const another = () => {
    const id = pick?.pick?.id;
    void ask(id ? [...excluded, id] : excluded);
  };

  const order = async () => {
    const c = engine.client;
    const p = pick?.pick;
    if (!c || !p) return;
    setBusy(true);
    setErr("");
    try {
      await c.foodPicked(p.id);
      setDone(String(p.fields.name));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openOption = (o: Entity) => {
    const f = o.fields as FoodF;
    setOpen(o.id);
    setEdit({ name: f.name ?? "", kind: f.kind ?? "delivery", items: (f.items ?? []).join(", "), tags: f.tags ?? [], avoid: !!f.avoid, rating: f.rating != null ? String(f.rating) : "", cost: f.cost != null ? String(f.cost) : "" });
  };

  const add = async () => {
    if (!form.name.trim()) return;
    const fields = toFields(form);
    if (fields.rating === null) delete fields.rating;
    if (fields.cost === null) delete fields.cost;
    await createEntity("food_option", fields);
    setForm({ ...EMPTY });
    setAdding(false);
  };

  const save = async (o: Entity) => {
    if (!edit || !edit.name.trim()) return;
    await updateEntity(o, toFields(edit));
    setOpen(null);
  };

  const p = pick?.pick;
  const pf = p ? (p.fields as FoodF) : null;
  const ru = pick?.runner_up ? (pick.runner_up.fields as FoodF) : null;

  return (
    <div className="food">
      <h1>Food</h1>
      <div className="card big">
        <div className="row">
          <span className="title" style={{ marginBottom: 0 }}>
            {meal === "snack" ? "Snack" : meal === "lunch" ? "Lunch" : "Dinner"}
          </span>
          <button type="button" className={`chip ${snack ? "on" : ""}`} aria-pressed={snack} onClick={() => setSnack((v) => !v)}>
            snack
          </button>
        </div>
        <div className="chips" style={{ marginTop: 8 }} role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m} type="button" className={`chip ${mode === m ? "on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(mode === m ? null : m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input type="number" inputMode="decimal" min={0} placeholder="Budget" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget" style={{ width: 110 }} />
          <button className="primary" onClick={() => void ask([])} disabled={busy}>
            Pick
          </button>
        </div>
        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        {pick && !p && (
          <div className="muted" style={{ marginTop: 12 }}>
            {pick.why || "Nothing fits. Add an option below."}
          </div>
        )}
        {p && pf && (
          <div className="pick" style={{ marginTop: 14 }}>
            {done ? (
              <div>
                <div className="title">{done}</div>
                <div className="ok">Ordered. Done for this meal.</div>
              </div>
            ) : (
              <>
                <div className="title">{pf.name}</div>
                {pf.items && pf.items.length > 0 && <div>{pf.items.join(", ")}</div>}
                {pf.notes && <div className="small">{pf.notes}</div>}
                <div className="muted small" style={{ marginTop: 4 }}>
                  {pick?.why}
                </div>
                <div className="muted small">
                  {pf.kind}
                  {pf.cost != null ? `, ${pf.cost}` : ""}
                </div>
                <div className="actions">
                  <button className="primary" onClick={() => void order()} disabled={busy}>
                    Order this
                  </button>
                  <button onClick={another} disabled={busy}>
                    Another
                  </button>
                </div>
                {ru && (
                  <div className="muted small faint" style={{ marginTop: 8 }}>
                    runner-up: {ru.name}
                    {ru.cost != null ? `, ${ru.cost}` : ""}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary>
          Options ({options.length})
        </summary>
        <div className="row" style={{ margin: "8px 0" }}>
          {!adding && (
            <button className="small primary" onClick={() => setAdding(true)}>
              Add
            </button>
          )}
        </div>
        {adding && (
          <form
            className="card col"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <OptionForm value={form} onChange={setForm} idPrefix="new" />
            <div className="row">
              <button className="primary" type="submit" disabled={!form.name.trim()}>
                Add
              </button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="list">
          {options.map((o) => {
            const f = o.fields as FoodF;
            const isOpen = open === o.id;
            return (
              <div key={o.id} className={`item ${f.avoid ? "off" : ""}`}>
                <div className="body">
                  <div className="row">
                    <span className="chip static">{f.kind}</span>
                    <span className="t grow">{f.name}</span>
                    {f.rating != null && <span className="muted small">{f.rating}/5</span>}
                    {f.cost != null && <span className="muted small">{f.cost}</span>}
                  </div>
                  <div className="meta">
                    {f.items && f.items.length > 0 && <span>{f.items.join(", ")}</span>}
                    {f.notes && <span>{f.notes}</span>}
                    {f.tags && f.tags.length > 0 && <span>{f.tags.join(" ")}</span>}
                    {f.avoid && <span className="warn">avoid</span>}
                    {f.times_picked ? <span>picked {f.times_picked}</span> : null}
                    <button className="ghost small" onClick={() => (isOpen ? setOpen(null) : openOption(o))} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Edit"} ${f.name}`}>
                      {isOpen ? "less" : "edit"}
                    </button>
                  </div>
                  {isOpen && edit && (
                    <div className="col" style={{ marginTop: 8 }}>
                      <OptionForm value={edit} onChange={setEdit} idPrefix={`o-${o.id.slice(0, 8)}`} />
                      <div className="row">
                        <button className="small primary" onClick={() => void save(o)} disabled={!edit.name.trim()}>
                          Save
                        </button>
                        <button className="small ghost" onClick={() => setOpen(null)}>
                          Cancel
                        </button>
                        <button className="small ghost danger" onClick={() => confirm("Delete this option") && softDelete(o).then(() => setOpen(null))}>
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
      </details>
    </div>
  );
}
