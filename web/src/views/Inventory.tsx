import { useCallback, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { useEscape } from "../lib/keys";
import { INVENTORY_CATEGORIES, type InventoryCategory, type InventoryF } from "../lib/creative";
import { CsvButton } from "../components/CsvButton";

const EMPTY = { name: "", category: "component" as InventoryCategory, qty: "1", unit: "", location: "", tags: "" };
type Form = typeof EMPTY;

function toFields(f: Form): Record<string, unknown> {
  const qty = Number(f.qty);
  return {
    name: f.name.trim(),
    category: f.category,
    qty: Number.isFinite(qty) && f.qty.trim() ? qty : 1,
    unit: f.unit.trim() || null,
    location: f.location.trim() || null,
    tags: f.tags.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function fromEntity(e: Entity): Form {
  const f = e.fields as InventoryF;
  return { name: f.name ?? "", category: f.category ?? "other", qty: f.qty != null ? String(f.qty) : "1", unit: f.unit ?? "", location: f.location ?? "", tags: (f.tags ?? []).join(", ") };
}

function ItemForm({ value, onChange, idPrefix }: { value: Form; onChange: (v: Form) => void; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="col">
      <input placeholder="Name" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} aria-label="Name" />
      <div className="row">
        <div>
          <label htmlFor={id("cat")}>Category</label>
          <select id={id("cat")} value={value.category} onChange={(e) => onChange({ ...value, category: e.target.value as InventoryCategory })}>
            {INVENTORY_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div style={{ width: 80 }}>
          <label htmlFor={id("qty")}>Qty</label>
          <input id={id("qty")} type="number" inputMode="decimal" min={0} value={value.qty} onChange={(e) => onChange({ ...value, qty: e.target.value })} />
        </div>
        <div style={{ width: 90 }}>
          <label htmlFor={id("unit")}>Unit</label>
          <input id={id("unit")} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value })} placeholder="pcs" />
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <label htmlFor={id("loc")}>Location</label>
          <input id={id("loc")} value={value.location} onChange={(e) => onChange({ ...value, location: e.target.value })} placeholder="bin, shelf, drawer" />
        </div>
        <div className="grow">
          <label htmlFor={id("tags")}>Tags, comma separated</label>
          <input id={id("tags")} value={value.tags} onChange={(e) => onChange({ ...value, tags: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

/** Parts, gear and materials on hand, grouped by category. Parts lists on projects are checked against the names here. */
export function Inventory() {
  const items = useEntities("inventory");
  const initial = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("q") ?? "";
  const [q, setQ] = useState(initial);
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

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (e: Entity) => {
      if (!needle) return true;
      const f = e.fields as InventoryF;
      return [f.name, f.location ?? "", ...(f.tags ?? [])].join(" ").toLowerCase().includes(needle);
    };
    const out: Array<{ category: InventoryCategory; items: Entity[] }> = [];
    for (const c of INVENTORY_CATEGORIES) {
      const list = items.filter((e) => (e.fields as InventoryF).category === c && hit(e)).sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
      if (list.length) out.push({ category: c, items: list });
    }
    return out;
  }, [items, q]);

  const add = async () => {
    if (!form.name.trim()) return;
    const fields = toFields(form);
    if (fields.unit === null) delete fields.unit;
    if (fields.location === null) delete fields.location;
    await createEntity("inventory", fields);
    setForm({ ...EMPTY, category: form.category });
    setAdding(false);
  };

  const save = async (e: Entity) => {
    if (!edit || !edit.name.trim()) return;
    await updateEntity(e, toFields(edit));
    setOpen(null);
  };

  return (
    <div className="inventory">
      <div className="row between">
        <span className="title-row"><h1 style={{ margin: 0 }}>Inventory</h1><CsvButton kind="inventory" /></span>
        <div className="row">
          <a href="#/projects" className="small">
            projects
          </a>
          {!adding && (
            <button className="small primary" onClick={() => setAdding(true)}>
              Add
            </button>
          )}
        </div>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, location, tag" aria-label="Search inventory" style={{ marginTop: 10 }} />
      {adding && (
        <form
          className="card col"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <ItemForm value={form} onChange={setForm} idPrefix="new" />
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
      {!items.length && <div className="empty">Nothing in the inventory yet.</div>}
      {items.length > 0 && !groups.length && <div className="empty">No match.</div>}
      {groups.map((g) => (
        <section key={g.category} style={{ marginTop: 14 }}>
          <h2 style={{ textTransform: "capitalize" }}>
            {g.category} <span className="muted small" style={{ fontWeight: 400 }}>{g.items.length}</span>
          </h2>
          <div className="list">
            {g.items.map((e) => {
              const f = e.fields as InventoryF;
              const isOpen = open === e.id;
              return (
                <div key={e.id} className="item">
                  <div className="body">
                    <div className="row">
                      <span className="t grow">{f.name}</span>
                      <span className="mono">
                        {f.qty ?? 1}
                        {f.unit ? ` ${f.unit}` : ""}
                      </span>
                    </div>
                    <div className="meta">
                      {f.location && <span>{f.location}</span>}
                      {f.tags && f.tags.length > 0 && <span>{f.tags.map((t) => `#${t}`).join(" ")}</span>}
                      <button
                        className="ghost small"
                        onClick={() => {
                          if (isOpen) setOpen(null);
                          else {
                            setOpen(e.id);
                            setEdit(fromEntity(e));
                          }
                        }}
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Close" : "Edit"} ${f.name}`}
                      >
                        {isOpen ? "less" : "edit"}
                      </button>
                    </div>
                    {isOpen && edit && (
                      <div className="col" style={{ marginTop: 8 }}>
                        <ItemForm value={edit} onChange={setEdit} idPrefix={`i-${e.id.slice(0, 8)}`} />
                        <div className="row">
                          <button className="small primary" onClick={() => void save(e)} disabled={!edit.name.trim()}>
                            Save
                          </button>
                          <button className="small ghost" onClick={() => setOpen(null)}>
                            Cancel
                          </button>
                          <button className="small ghost danger" onClick={() => confirm("Delete this item") && softDelete(e).then(() => setOpen(null))}>
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
        </section>
      ))}
    </div>
  );
}
