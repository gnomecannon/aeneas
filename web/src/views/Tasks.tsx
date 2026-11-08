import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { completeTaskPatch, taskAlertAt } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { fmtDateTime, fromLocalInput, HOUR, toLocalInput } from "../lib/time";
import { useEscape } from "../lib/keys";
import { CsvButton } from "../components/CsvButton";
import { LinkedItem } from "../components/LinkedItem";
import { snoozeReminder } from "../sync/actions";

const STATUSES = ["doing", "next", "inbox", "scheduled", "parked"] as const;
const ALL = [...STATUSES, "done"] as const;
type Status = (typeof ALL)[number];
type TaskF = {
  title: string; notes?: string; status: Status; order: number; due?: string; block?: { start: string; end: string }; parked_reason?: string; project_id?: string;
  remind_at?: string; repeat?: string; friction?: "none" | "reason"; snoozed_until?: string; linked_id?: string; apple?: { list_title?: string };
};

const SECTION_TITLE: Record<string, string> = { doing: "Doing", next: "Next", inbox: "Inbox", scheduled: "Scheduled and reminders", parked: "Parked" };

/** Repeat choices; anything else typed in Custom is kept as written. */
export const REPEATS = [
  { label: "No repeat", value: "" },
  { label: "Every day", value: "every 1 days" },
  { label: "Every weekday", value: "every 1 weeks on mon,tue,wed,thu,fri" },
  { label: "Every week", value: "every 1 weeks" },
  { label: "Every 2 weeks", value: "every 2 weeks" },
  { label: "Every month", value: "every 1 months" },
  { label: "Every year", value: "every 1 years" },
];

/** "every 1 weeks" as its label, or the rule itself when it is a custom one. */
export function repeatLabel(r?: string): string {
  return REPEATS.find((x) => x.value === r)?.label.toLowerCase() ?? (r ?? "");
}

function byOrder(a: Entity, b: Entity) {
  return (a.fields.order as number) - (b.fields.order as number);
}

/** Reorders `next` so that `id` moves by `delta` places; returns the writes to make. */
export function moveWithin(next: Entity[], id: string, delta: number): Array<{ task: Entity; order: number }> {
  const sorted = next.slice().sort(byOrder);
  const from = sorted.findIndex((x) => x.id === id);
  if (from < 0) return [];
  const to = Math.max(0, Math.min(sorted.length - 1, from + delta));
  if (to === from) return [];
  const moved = sorted.splice(from, 1)[0];
  sorted.splice(to, 0, moved);
  return sorted.map((x, i) => ({ task: x, order: i + 1 })).filter((w) => (w.task.fields.order as number) !== w.order);
}

/** The Apple Reminders list a task is in, by name (list ids differ from device to device). */
export function listOf(t: Entity): string | null {
  const l = (t.fields.apple as { list_title?: string } | undefined)?.list_title;
  return l ? l : null;
}

const NO_LIST = "\u0001none";
function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

export function Tasks({ focus }: { focus?: string | null } = {}) {
  const allTasks = useEntities("task");
  const [spacePref, setSpacePref] = useState(() => readPref("ea.tasks.space", "personal"));
  const [listFilter, setListFilter] = useState(() => readPref("ea.tasks.list", ""));
  const hasWork = allTasks.some((t) => t.space === "work");
  const space = hasWork && spacePref === "work" ? "work" : "personal";
  const chooseSpace = (v: string) => {
    setSpacePref(v);
    writePref("ea.tasks.space", v);
    setListFilter("");
    writePref("ea.tasks.list", "");
  };
  const chooseList = (v: string) => {
    setListFilter(v);
    writePref("ea.tasks.list", v);
  };
  const inSpace = useMemo(() => allTasks.filter((t) => t.space === space), [allTasks, space]);
  const listTitles = useMemo(() => [...new Set(inSpace.map(listOf).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [inSpace]);
  // A focused task (from a link) is shown even when it is outside the chosen list.
  const tasks = useMemo(
    () => inSpace.filter((t) => t.id === focus || listFilter === "" || (listFilter === NO_LIST ? !listOf(t) : listOf(t) === listFilter)),
    [inSpace, listFilter, focus],
  );
  const openIn = (match: (t: Entity) => boolean) => inSpace.filter((t) => t.fields.status !== "done" && match(t)).length;
  const looseCount = openIn((t) => !listOf(t));
  const newList = listFilter && listFilter !== NO_LIST ? listFilter : null;
  const projects = useEntities("project", (e) => e.fields.status !== "done");
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, String(p.fields.name)])), [projects]);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEscape(useCallback(() => setOpen(null), []));

  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    document.getElementById(`task-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, tasks.length > 0]);

  const move = (t: Entity, delta: number) => {
    for (const w of moveWithin(
      tasks.filter((x) => x.fields.status === "next"),
      t.id,
      delta,
    ))
      void updateEntity(w.task, { order: w.order });
  };

  const onItemKey = (t: Entity) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || t.fields.status !== "next") return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      move(t, e.key === "ArrowUp" ? -1 : 1);
    }
  };

  const add = async () => {
    const t = title.trim();
    if (!t) return;
    const at = fromLocalInput(remindAt);
    // Made inside a list: the iPhone adds it to that Reminders list.
    const inList = newList ? { apple: { id: "", list: "", list_title: newList } } : {};
    if (at) {
      // With a reminder time it waits in Scheduled and notifies then, instead of joining Next.
      await createEntity("task", { title: t, status: "scheduled", order: Date.now(), remind_at: at, friction: "none", ...inList }, space);
    } else {
      const nextOnes = allTasks.filter((x) => x.fields.status === "next");
      const maxOrder = Math.max(0, ...nextOnes.map((x) => x.fields.order as number));
      await createEntity("task", { title: t, status: "next", order: maxOrder + 1, ...inList }, space);
    }
    setTitle("");
    setRemindAt("");
  };

  const setStatus = (t: Entity, status: Status) => {
    // Done on a repeating task moves its reminder and deadline on instead of finishing it.
    if (status === "done") return void updateEntity(t, completeTaskPatch(t.fields));
    const extra: Record<string, unknown> = {};
    if (status === "parked") {
      const reason = window.prompt("Why park it");
      if (reason === null) return;
      extra.parked_reason = reason;
    }
    if (status === "next") {
      const maxOrder = Math.max(0, ...tasks.filter((x) => x.fields.status === "next").map((x) => x.fields.order as number));
      extra.order = maxOrder + 1;
    }
    void updateEntity(t, { status, ...extra });
  };

  const snooze = async (t: Entity, minutes: number) => {
    let until: string;
    if (minutes < 0) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      until = d.toISOString();
    } else until = new Date(Date.now() + minutes * 60_000).toISOString();
    let reason: string | undefined;
    if (t.fields.friction === "reason") {
      const r = window.prompt("Why snooze it");
      if (r === null) return;
      reason = r;
    }
    try {
      await snoozeReminder(t, until, reason);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const dropOn = (target: Entity) => {
    if (!drag || drag === target.id) return;
    const next = tasks.filter((x) => x.fields.status === "next").sort(byOrder);
    const from = next.findIndex((x) => x.id === drag);
    const to = next.findIndex((x) => x.id === target.id);
    if (from < 0 || to < 0) return;
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    next.forEach((x, i) => {
      if ((x.fields.order as number) !== i + 1) void updateEntity(x, { order: i + 1 });
    });
  };

  const dnd = (t: Entity) =>
    t.fields.status === "next"
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            setDrag(t.id);
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setOver(t.id);
          },
          onDragLeave: () => setOver(null),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            dropOn(t);
            setDrag(null);
            setOver(null);
          },
          onDragEnd: () => {
            setDrag(null);
            setOver(null);
          },
        }
      : {};

  const nextCount = tasks.filter((x) => x.fields.status === "next").length;

  const renderTask = (t: Entity) => {
    const f = t.fields as TaskF;
    const isOpen = open === t.id;
    const nextSorted = f.status === "next" ? tasks.filter((x) => x.fields.status === "next").sort(byOrder) : [];
    const pos = nextSorted.findIndex((x) => x.id === t.id);
    const alert = taskAlertAt(f);
    const alertLate = !!alert && Date.parse(alert) <= Date.now();
    return (
      <div key={t.id} id={`task-${t.id}`} className={`item ${drag === t.id ? "dragging" : ""} ${over === t.id ? "over" : ""}`} {...dnd(t)} onKeyDown={onItemKey(t)}>
        {f.status === "next" && (
          <div className="reorder" role="group" aria-label={`Reorder ${f.title}`}>
            <span className="grip" aria-hidden="true" title="Drag to reorder, or Alt+Arrow keys">
              ::
            </span>
            <button className="ghost small" aria-label={`Move ${f.title} up`} title="Move up (Alt+Up)" disabled={pos <= 0} onClick={() => move(t, -1)}>
              <span aria-hidden="true">&#9650;</span>
            </button>
            <button className="ghost small" aria-label={`Move ${f.title} down`} title="Move down (Alt+Down)" disabled={pos >= nextCount - 1} onClick={() => move(t, 1)}>
              <span aria-hidden="true">&#9660;</span>
            </button>
          </div>
        )}
        <div className="body">
          <input className="inline-edit t" value={f.title} onChange={(e) => updateEntity(t, { title: e.target.value })} aria-label="Title" />
          <div className="meta">
            {alert && (
              <span className={alertLate ? "error" : ""} title={f.snoozed_until ? `snoozed from ${fmtDateTime(f.remind_at)}` : "reminder"}>
                remind {fmtDateTime(alert)}
                {f.snoozed_until && f.remind_at && f.snoozed_until > f.remind_at ? " (snoozed)" : ""}
              </span>
            )}
            {f.repeat && <span>{repeatLabel(f.repeat)}</span>}
            {f.due && <span className={f.status !== "done" && Date.parse(f.due) < Date.now() ? "error" : ""}>due {fmtDateTime(f.due)}</span>}
            {f.linked_id && <LinkedItem id={f.linked_id} />}
            {!listFilter && f.apple?.list_title && f.apple.list_title !== "Reminders" && <span title="Apple Reminders list">{f.apple.list_title} list</span>}
            {f.block && <span>block {fmtDateTime(f.block.start)}</span>}
            {f.parked_reason && f.status === "parked" && <span>parked: {f.parked_reason}</span>}
            {f.project_id && projectName.has(f.project_id) && (
              <a href={`#/projects/${f.project_id}`} title="Open the project">
                {projectName.get(f.project_id)}
              </a>
            )}
            {f.notes && !isOpen && <span>notes</span>}
            <button className="ghost small" onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details for ${f.title}`}>
              {isOpen ? "less" : "more"}
            </button>
          </div>
          {isOpen && (
            <div className="col" style={{ marginTop: 8 }}>
              <textarea rows={3} placeholder="Notes" value={f.notes ?? ""} onChange={(e) => updateEntity(t, { notes: e.target.value })} aria-label="Notes" />
              <div className="row">
                <div className="grow">
                  <label htmlFor={`st-${t.id}`}>Status</label>
                  <select id={`st-${t.id}`} value={f.status} onChange={(e) => setStatus(t, e.target.value as Status)}>
                    {ALL.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grow">
                  <label htmlFor={`ls-${t.id}`}>List</label>
                  <select
                    id={`ls-${t.id}`}
                    value={listOf(t) ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      const link = (t.fields.apple as Record<string, unknown> | undefined) ?? { id: "", list: "" };
                      void updateEntity(t, { apple: { ...link, list_title: v } });
                    }}
                  >
                    {!listOf(t) && <option value="">{t.space === "work" ? "None" : "Default list"}</option>}
                    {listTitles.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grow">
                  <label htmlFor={`pr-${t.id}`}>Project</label>
                  <select id={`pr-${t.id}`} value={f.project_id ?? ""} onChange={(e) => updateEntity(t, { project_id: e.target.value || null })}>
                    <option value="">None</option>
                    {projects
                      .slice()
                      .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {String(p.fields.name)}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="grow">
                  <label htmlFor={`due-${t.id}`}>Due</label>
                  <input id={`due-${t.id}`} type="datetime-local" value={toLocalInput(f.due)} onChange={(e) => updateEntity(t, { due: fromLocalInput(e.target.value) ?? null })} />
                </div>
              </div>
              <div className="row">
                <div className="grow">
                  <label htmlFor={`ra-${t.id}`}>Remind at</label>
                  <input
                    id={`ra-${t.id}`}
                    type="datetime-local"
                    value={toLocalInput(f.remind_at)}
                    onChange={(e) => {
                      const at = fromLocalInput(e.target.value) ?? null;
                      void updateEntity(t, { remind_at: at, snoozed_until: null, ...(at && f.status === "inbox" ? { status: "scheduled" } : {}) });
                    }}
                  />
                </div>
                <div className="grow">
                  <label htmlFor={`rp-${t.id}`}>Repeat</label>
                  <select id={`rp-${t.id}`} value={REPEATS.some((r) => r.value === (f.repeat ?? "")) ? (f.repeat ?? "") : "custom"} onChange={(e) => {
                    if (e.target.value === "custom") {
                      const r = window.prompt("Repeat rule, like: every 3 days, or every 1 weeks on mon,thu", f.repeat ?? "");
                      if (r !== null) void updateEntity(t, { repeat: r.trim() || null });
                      return;
                    }
                    void updateEntity(t, { repeat: e.target.value || null });
                  }}>
                    {REPEATS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                    <option value="custom">{REPEATS.some((r) => r.value === (f.repeat ?? "")) ? "Custom" : `Custom: ${f.repeat}`}</option>
                  </select>
                </div>
              </div>
              {f.remind_at && (
                <div className="row">
                  <label className="row small" style={{ gap: 6 }}>
                    <input type="checkbox" checked={f.friction === "reason"} onChange={(e) => updateEntity(t, { friction: e.target.checked ? "reason" : "none" })} />
                    Ask why when I snooze it
                  </label>
                  {alertLate && (
                    <>
                      <button className="small" onClick={() => snooze(t, 60)}>Snooze 1h</button>
                      <button className="small" onClick={() => snooze(t, -1)}>Tomorrow 9:00</button>
                    </>
                  )}
                </div>
              )}
              <div className="row">
                <div className="grow">
                  <label htmlFor={`bs-${t.id}`}>Block start</label>
                  <input
                    id={`bs-${t.id}`}
                    type="datetime-local"
                    value={toLocalInput(f.block?.start)}
                    onChange={(e) => {
                      const s = fromLocalInput(e.target.value);
                      if (!s) return void updateEntity(t, { block: null });
                      void updateEntity(t, { block: { start: s, end: new Date(new Date(s).getTime() + 3 * HOUR).toISOString() } });
                    }}
                  />
                </div>
                <div className="grow">
                  <label htmlFor={`be-${t.id}`}>Block end</label>
                  <input
                    id={`be-${t.id}`}
                    type="datetime-local"
                    value={toLocalInput(f.block?.end)}
                    disabled={!f.block}
                    onChange={(e) => {
                      const end = fromLocalInput(e.target.value);
                      if (f.block && end) void updateEntity(t, { block: { start: f.block.start, end } });
                    }}
                  />
                </div>
              </div>
              <div className="row">
                {f.status !== "doing" && (
                  <button className="small" onClick={() => setStatus(t, "doing")}>
                    Do now
                  </button>
                )}
                {f.status !== "next" && (
                  <button className="small" onClick={() => setStatus(t, "next")}>
                    Next
                  </button>
                )}
                {f.status !== "done" && (
                  <button className="small" onClick={() => setStatus(t, "done")}>
                    Done
                  </button>
                )}
                {f.status !== "parked" && (
                  <button className="small" onClick={() => setStatus(t, "parked")}>
                    Park
                  </button>
                )}
                <button className="small ghost danger" onClick={() => confirm("Delete this task") && softDelete(t)}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Scheduled ones (reminders among them) read best by when they notify.
  const byAlert = (a: Entity, b: Entity) => (taskAlertAt(a.fields) ?? "9") < (taskAlertAt(b.fields) ?? "9") ? -1 : 1;
  const groups = STATUSES.map((s) => ({ s, items: tasks.filter((t) => t.fields.status === s).sort(s === "scheduled" ? byAlert : byOrder) })).filter((g) => g.items.length);
  const done = tasks.filter((t) => t.fields.status === "done").sort((a, b) => (String(a.fields.done_at) > String(b.fields.done_at) ? -1 : 1));

  return (
    <div>
      <span className="title-row"><h1 style={{ margin: 0 }}>Tasks</h1><CsvButton kind="task" /></span>
      <div className="task-scope">
        {hasWork && (
          <div className="seg" role="tablist" aria-label="Space">
            {(["personal", "work"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={space === v} className={space === v ? "on" : ""} onClick={() => chooseSpace(v)}>
                {v === "personal" ? "Personal" : "Work"}
              </button>
            ))}
          </div>
        )}
        {listTitles.length > 0 && (
          <div className="list-chips" role="tablist" aria-label="Lists">
            <ListChip title="All" count={openIn(() => true)} on={!listFilter} onClick={() => chooseList("")} />
            {listTitles.map((l) => (
              <ListChip key={l} title={l} count={openIn((t) => listOf(t) === l)} on={listFilter === l} onClick={() => chooseList(l)} />
            ))}
            {looseCount > 0 && <ListChip title="No list" count={looseCount} on={listFilter === NO_LIST} onClick={() => chooseList(NO_LIST)} />}
          </div>
        )}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="grow" placeholder={newList ? `New task in ${newList}` : "New task, goes to next"} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New task" />
        <input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} aria-label="Remind me at (optional)" title="Remind me at (optional)" />
        <button className="primary" type="submit" disabled={!title.trim()}>
          Add
        </button>
      </form>
      {!tasks.length && <div className="empty">No tasks.</div>}
      {nextCount > 1 && <div className="muted small">Reorder next with the arrows, by dragging, or with Alt+Up and Alt+Down on a row.</div>}
      {groups.map((g) => (
        <section key={g.s} style={{ marginTop: 16 }}>
          <h3>
            {SECTION_TITLE[g.s] ?? g.s} ({g.items.length})
          </h3>
          <div className="list">{g.items.map(renderTask)}</div>
        </section>
      ))}
      {done.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary>Done ({done.length})</summary>
          <div className="list">{done.slice(0, 50).map(renderTask)}</div>
        </details>
      )}
    </div>
  );
}

function ListChip({ title, count, on, onClick }: { title: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={on} className={`list-chip${on ? " on" : ""}`} onClick={onClick} aria-label={`${title}, ${count} open`}>
      <span>{title}</span>
      {count > 0 && <span className="n">{count}</span>}
    </button>
  );
}
