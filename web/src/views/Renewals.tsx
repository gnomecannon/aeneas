import { taskAlertAt } from "@everythingapp/shared";
import { useCallback, useEffect, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { renewWatch } from "../sync/planner";
import { daysLeft, fmtDaysLeft, groupWatches, isDateOnly, localDate, parseDue } from "../lib/planner";
import { fmtDate, fmtDateTime, relative } from "../lib/time";
import { useEscape } from "../lib/keys";

const CATEGORIES = ["cert", "subscription", "prescription", "insurance", "rma", "warranty", "domain", "other"] as const;
type Category = (typeof CATEGORIES)[number];
type WatchF = {
  title: string;
  category: Category;
  due: string;
  lead_days?: number;
  repeat?: string;
  probe_url?: string;
  cost?: number;
  url?: string;
  notes?: string;
  reminder_id?: string;
  last_probe?: string;
  last_probe_error?: string;
  renewed_at?: string;
  autopay?: boolean;
};

const EMPTY = { title: "", category: "subscription" as Category, due: "", lead_days: "7", repeat: "", probe_url: "", cost: "", url: "", notes: "", autopay: false };

/** A date input value from a due that may be a date or a datetime. */
function dueInput(due?: string): string {
  if (!due) return "";
  return isDateOnly(due) ? due : localDate(parseDue(due));
}

function num(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? null : n;
}

/** Fields for the create form and for an edit, the same shape the hub validates. Empty optionals are omitted (create) or cleared (edit). */
function toFields(f: typeof EMPTY, clearing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { title: f.title.trim(), category: f.category, due: f.due, lead_days: num(f.lead_days) ?? 7, autopay: f.autopay };
  const opt = (k: string, v: unknown) => {
    if (v === "" || v === null || v === undefined) {
      if (clearing) out[k] = null;
    } else out[k] = v;
  };
  opt("repeat", f.repeat.trim());
  opt("probe_url", f.probe_url.trim());
  opt("cost", num(f.cost));
  opt("url", f.url.trim());
  opt("notes", f.notes.trim());
  return out;
}

function WatchForm({ value, onChange, idPrefix }: { value: typeof EMPTY; onChange: (v: typeof EMPTY) => void; idPrefix: string }) {
  const set = (k: Exclude<keyof typeof EMPTY, "autopay">) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="col">
      <input placeholder="What renews or expires" value={value.title} onChange={set("title")} aria-label="Title" />
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={value.autopay} onChange={(e) => onChange({ ...value, autopay: e.target.checked })} style={{ width: "auto" }} />
        Pays itself (autopay): no reminder, and the date moves on by itself
      </label>
      <div className="row">
        <div className="grow">
          <label htmlFor={id("cat")}>Category</label>
          <select id={id("cat")} value={value.category} onChange={set("category")}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label htmlFor={id("due")}>Due</label>
          <input id={id("due")} type="date" value={value.due} onChange={set("due")} />
        </div>
        <div style={{ width: 90 }}>
          <label htmlFor={id("lead")}>Lead days</label>
          <input id={id("lead")} type="number" min={0} value={value.lead_days} onChange={set("lead_days")} />
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <label htmlFor={id("rep")}>Repeat</label>
          <input id={id("rep")} placeholder="every 1 years" value={value.repeat} onChange={set("repeat")} />
        </div>
        <div style={{ width: 110 }}>
          <label htmlFor={id("cost")}>Cost</label>
          <input id={id("cost")} type="number" step="0.01" min={0} value={value.cost} onChange={set("cost")} />
        </div>
      </div>
      <div>
        <label htmlFor={id("probe")}>Probe URL (cert expiry is read from it daily)</label>
        <input id={id("probe")} placeholder="https://host.tailnet" value={value.probe_url} onChange={set("probe_url")} autoCapitalize="off" />
      </div>
      <div>
        <label htmlFor={id("url")}>Where to renew or cancel</label>
        <input id={id("url")} placeholder="https://" value={value.url} onChange={set("url")} autoCapitalize="off" />
      </div>
      <div>
        <label htmlFor={id("notes")}>Notes</label>
        <textarea id={id("notes")} rows={2} value={value.notes} onChange={set("notes")} />
      </div>
    </div>
  );
}

export function Renewals({ focus }: { focus?: string | null } = {}) {
  const watches = useEntities("watch");
  const reminders = useEntities("task", (e) => !!e.fields.linked_id);
  const [form, setForm] = useState({ ...EMPTY });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [edit, setEdit] = useState<typeof EMPTY | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEscape(
    useCallback(() => {
      setOpen(null);
      setAdding(false);
    }, []),
  );

  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    document.getElementById(`watch-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, watches.length > 0]);

  useEffect(() => {
    const w = open ? watches.find((x) => x.id === open) : undefined;
    if (!w) return setEdit(null);
    const f = w.fields as WatchF;
    setEdit({
      title: f.title ?? "",
      category: f.category ?? "other",
      due: dueInput(f.due),
      lead_days: String(f.lead_days ?? 7),
      repeat: f.repeat ?? "",
      probe_url: f.probe_url ?? "",
      cost: f.cost != null ? String(f.cost) : "",
      url: f.url ?? "",
      notes: f.notes ?? "",
      autopay: !!f.autopay,
    });
    // Only when the opened watch changes; typing into the editor must not be overwritten by a sync echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = async () => {
    if (!form.title.trim() || !form.due) return;
    await createEntity("watch", toFields(form, false));
    setForm({ ...EMPTY });
    setAdding(false);
  };

  const save = async (w: Entity) => {
    if (!edit || !edit.title.trim() || !edit.due) return;
    await updateEntity(w, toFields(edit, true));
    setOpen(null);
  };

  const renewed = async (w: Entity) => {
    setErr((e) => ({ ...e, [w.id]: "" }));
    setBusy(w.id);
    try {
      await renewWatch(w);
    } catch (e) {
      setErr((x) => ({ ...x, [w.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const reminderState = (f: WatchF): string => {
    const r = f.reminder_id ? reminders.find((x) => x.id === f.reminder_id) : undefined;
    if (!r) return "reminder: set by the hub on sync";
    const at = taskAlertAt(r.fields);
    return at ? `reminder ${fmtDateTime(at)}` : "renewed";
  };

  const render = (w: Entity) => {
    const f = w.fields as WatchF;
    const d = daysLeft(f.due);
    const isOpen = open === w.id;
    const probe = f.probe_url || f.category === "cert";
    return (
      <div key={w.id} id={`watch-${w.id}`} className={`item watch ${d < 0 ? "overdue" : ""}`}>
        <div className="body">
          <div className="row">
            <span className="chip static">{f.category}</span>
            <span className="t grow">{f.title}</span>
            <span className={`small ${d < 0 ? "error" : d <= (f.lead_days ?? 7) ? "warn" : "muted"}`}>
              {fmtDate(parseDue(f.due).toISOString())}, {fmtDaysLeft(d)}
            </span>
          </div>
          <div className="meta">
            {f.cost != null && <span>{f.cost} cost</span>}
            <span>{f.lead_days ?? 7} d lead</span>
            {f.repeat && <span>{f.repeat}</span>}
            <span>{f.autopay ? "autopay, no reminder" : reminderState(f)}</span>
            {probe && (
              <span className={f.last_probe_error ? "error" : ""}>
                {f.last_probe_error ? `probe failed ${f.last_probe ? relative(f.last_probe) : ""}: ${f.last_probe_error}` : f.last_probe ? `probed ${relative(f.last_probe)}` : "not probed yet"}
              </span>
            )}
            {f.renewed_at && <span>renewed {fmtDate(f.renewed_at)}</span>}
            {f.url && (
              <a href={f.url} target="_blank" rel="noreferrer">
                open site
              </a>
            )}
            <button className="ghost small" onClick={() => setOpen(isOpen ? null : w.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Edit"} ${f.title}`}>
              {isOpen ? "less" : "edit"}
            </button>
          </div>
          {f.notes && !isOpen && <div className="muted small">{f.notes}</div>}
          {err[w.id] && <div className="error">{err[w.id]}</div>}
          {!f.autopay && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="small primary" onClick={() => void renewed(w)} disabled={busy === w.id} aria-label={`Mark ${f.title} renewed`}>
                Renewed
              </button>
            </div>
          )}
          {isOpen && edit && (
            <div className="col" style={{ marginTop: 8 }}>
              <WatchForm value={edit} onChange={setEdit} idPrefix={`w-${w.id.slice(0, 8)}`} />
              <div className="row">
                <button className="small primary" onClick={() => void save(w)} disabled={!edit.title.trim() || !edit.due}>
                  Save
                </button>
                <button className="small ghost" onClick={() => setOpen(null)}>
                  Cancel
                </button>
                <button className="small ghost danger" onClick={() => confirm("Delete this watch") && softDelete(w).then(() => setOpen(null))}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const g = groupWatches(watches);
  const section = (label: string, items: Entity[]) =>
    items.length > 0 && (
      <section style={{ marginTop: 16 }}>
        <h3>
          {label} ({items.length})
        </h3>
        <div className="list">{items.map(render)}</div>
      </section>
    );

  return (
    <div className="renewals">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Renewals</h1>
        {!adding && (
          <button className="small primary" onClick={() => setAdding(true)}>
            Add
          </button>
        )}
      </div>
      {adding && (
        <form
          className="card col"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <WatchForm value={form} onChange={setForm} idPrefix="new" />
          <div className="row">
            <button className="primary" type="submit" disabled={!form.title.trim() || !form.due}>
              Add
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <div className="muted small">Saved locally first. The hub links the Renew reminder when it sees the watch.</div>
        </form>
      )}
      {!watches.length && <div className="empty">Nothing watched yet. Certificates, subscriptions, prescriptions, insurance, RMA windows, warranties, domains.</div>}
      {section("Overdue", g.overdue)}
      {section("Next 30 days", g.soon)}
      {section("Later", g.later)}
    </div>
  );
}
