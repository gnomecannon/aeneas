import { plainError } from "../lib/errors";
import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type { Entity, TaskGroup } from "@everythingapp/shared";
import { NO_LIST as NO_LIST_KEY, completeTaskPatch, listChosen, reopenTaskPatch, restoreTaskPatch, taskAlertAt, taskInLists, undoPatch } from "@everythingapp/shared";
import { useSourceLists, useTaskGroups } from "../lib/sources";
import { TASK_GROUP_TEXT, TaskGroupEditor } from "../components/TaskGroupEditor";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete, moveToSpace } from "../sync/edits";
import { engine } from "../sync/engine";
import { fmtDateTime, fromLocalInput, HOUR, toLocalInput } from "../lib/time";
import { useEscape } from "../lib/keys";
import { CsvButton } from "../components/CsvButton";
import { LinkedItem } from "../components/LinkedItem";
import { DraftInput, DraftTextarea } from "../components/DraftField";
import { snoozeReminder } from "../sync/actions";
import { dueFromInput, dueInputValue, fmtDue, isOverdue } from "../lib/planner";

const STATUSES = ["doing", "next", "inbox", "scheduled", "parked"] as const;
const ALL = [...STATUSES, "done"] as const;
type Status = (typeof ALL)[number];
type TaskF = {
  title: string; notes?: string; status: Status; order: number; due?: string; block?: { start: string; end: string }; parked_reason?: string; project_id?: string;
  remind_at?: string; repeat?: string; friction?: "none" | "reason"; snoozed_until?: string; linked_id?: string; apple?: { list_title?: string };
};

const SECTION_TITLE: Record<string, string> = { doing: "Doing", next: "Next", inbox: "Inbox", scheduled: "Scheduled and reminders", parked: "Set aside" };
/** Each status in words. "parked" is stored as it always was; on screen it is Set aside, which says what it does. */
export const STATUS_LABEL: Record<Status, string> = { doing: "Doing", next: "Next", inbox: "Inbox", scheduled: "Scheduled", parked: "Set aside", done: "Done" };

/** Tied to an Apple Reminders item (not only named for a list it is yet to be added to). */
export function tiedToApple(t: Entity): boolean {
  const id = (t.fields.apple as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "";
}

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

/**
 * Tasks by status. The selector at the top shows Personal, Work (while the work space is on) or one of the owner's
 * groups (gnomecannon/aeneas#26): a group shows the tasks of the lists in it, from both spaces, and changes nothing
 * about where they are kept. New group and Edit group beside it make and change them for every device.
 */
export function Tasks({ focus }: { focus?: string | null } = {}) {
  const allTasks = useEntities("task");
  const taskGroups = useTaskGroups();
  const sourceLists = useSourceLists();
  /** "personal", "work" or "group:<id>". */
  const [spacePref, setSpacePref] = useState(() => readPref("ea.tasks.space", "personal"));
  const [listFilter, setListFilter] = useState(() => readPref("ea.tasks.list", ""));
  // Whether the hub's work space is on (Settings, Accounts, Work); offline, whether any work task is here.
  const [workOn, setWorkOn] = useState<boolean | null>(null);
  useEffect(() => {
    engine.client?.workSpace().then((w) => setWorkOn(w.enabled), () => setWorkOn(null));
  }, []);
  const hasWork = allTasks.some((t) => t.space === "work");
  const workShown = workOn ?? hasWork;
  // A group deleted on another device leaves Personal showing.
  const group = spacePref.startsWith("group:") ? taskGroups.find((g) => `group:${g.id}` === spacePref) ?? null : null;
  const space = !group && workShown && spacePref === "work" ? "work" : "personal";
  const [editingGroup, setEditingGroup] = useState<{ group: TaskGroup | null } | null>(null);
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
  const inGroup = useMemo(() => (group ? taskInLists(group.lists, sourceLists) : null), [group, sourceLists]);
  const inSpace = useMemo(() => allTasks.filter((t) => (inGroup ? inGroup(t.fields) : t.space === space)), [allTasks, space, inGroup]);
  // In a group: its lists that are on, with tasks or not.
  const groupLists = useMemo(() => (group ? sourceLists.filter((l) => l.on && listChosen(group.lists, l)) : []), [group, sourceLists]);
  const listTitles = useMemo(
    () => [...new Set([...groupLists.map((l) => l.title), ...inSpace.map(listOf).filter((x): x is string => !!x)])].sort((a, b) => a.localeCompare(b)),
    [inSpace, groupLists],
  );
  // A focused task (from a link) is shown even when it is outside the chosen list.
  const tasks = useMemo(
    () => inSpace.filter((t) => t.id === focus || listFilter === "" || (listFilter === NO_LIST ? !listOf(t) : listOf(t) === listFilter)),
    [inSpace, listFilter, focus],
  );
  const openIn = (match: (t: Entity) => boolean) => inSpace.filter((t) => t.fields.status !== "done" && match(t)).length;
  const looseCount = openIn((t) => !listOf(t));
  // Where a new task goes: the list chosen below. In a group with All chosen, nowhere when the group holds the tasks in
  // no list, else its first list, so the task shows in the group; its space is that list's.
  const newList = listFilter && listFilter !== NO_LIST
    ? listFilter
    : group && !listFilter && !group.lists.includes(NO_LIST_KEY) ? (groupLists.map((l) => l.title).sort((a, b) => a.localeCompare(b))[0] ?? null) : null;
  const newSpace = group ? (groupLists.find((l) => l.title === newList)?.space ?? "personal") : space;
  const projects = useEntities("project", (e) => e.fields.status !== "done");
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, String(p.fields.name)])), [projects]);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEscape(useCallback(() => setOpen(null), []));
  // The last Done, Not done, Delete or move, for its Undo bar (gone after a few seconds, or with the next one).
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const h = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(h);
  }, [undo]);
  const canMove = workShown;

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
      await createEntity("task", { title: t, status: "scheduled", order: Date.now(), remind_at: at, friction: "none", ...inList }, newSpace);
    } else {
      const nextOnes = allTasks.filter((x) => x.fields.status === "next");
      const maxOrder = Math.max(0, ...nextOnes.map((x) => x.fields.order as number));
      await createEntity("task", { title: t, status: "next", order: maxOrder + 1, ...inList }, newSpace);
    }
    setTitle("");
    setRemindAt("");
  };

  const named = (t: Entity) => String(t.fields.title ?? "").slice(0, 40);
  /** Write an edit and offer its Undo, which writes back what the edit changed. */
  const editWithUndo = (t: Entity, edit: Record<string, unknown>, text: string) => {
    const back = undoPatch(t.fields, edit);
    void updateEntity(t, edit);
    setUndo({ text, run: () => void updateEntity(t, back) });
  };

  const setStatus = (t: Entity, status: Status) => {
    // Done on a repeating task moves its reminder and deadline on instead of finishing it.
    if (status === "done") return editWithUndo(t, completeTaskPatch(t.fields), `Done: ${named(t)}`);
    if (t.fields.status === "done" && status === "next") return reopen(t);
    const extra: Record<string, unknown> = {};
    if (status === "parked") {
      const reason = window.prompt("Why set it aside?");
      if (reason === null) return;
      extra.parked_reason = reason;
    }
    if (status === "next") {
      const maxOrder = Math.max(0, ...tasks.filter((x) => x.fields.status === "next").map((x) => x.fields.order as number));
      extra.order = maxOrder + 1;
    }
    void updateEntity(t, { status, ...extra });
  };

  /** Not done: back in Next, at its end. */
  const reopen = (t: Entity) =>
    editWithUndo(t, reopenTaskPatch(tasks.filter((x) => x.fields.status === "next").map((x) => x.fields.order as number)), `Back in Next: ${named(t)}`);

  const remove = (t: Entity) => {
    void softDelete(t);
    if (open === t.id) setOpen(null);
    setUndo({ text: `Deleted: ${named(t)}`, run: () => void updateEntity(t, restoreTaskPatch(t)) });
  };

  /**
   * To the other space, keeping the task as it is. A list it was only named for goes (lists belong to one account);
   * a personal task in an Apple Reminders list leaves that list, as work tasks stay out of personal lists.
   */
  const moveSpace = (t: Entity) => {
    const to = t.space === "work" ? "personal" : "work";
    void moveToSpace(t, to, t.fields.apple && !tiedToApple(t) ? { apple: null } : {});
    if (open === t.id) setOpen(null);
    setUndo({ text: `Moved to ${to === "work" ? "Work" : "Personal"}: ${named(t)}`, run: () => void moveToSpace(t, t.space, t.fields.apple && !tiedToApple(t) ? { apple: t.fields.apple } : {}) });
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
      alert(plainError(e));
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
  // Personal, Work while it is on, and each group; New group once there are lists to put in one.
  const choices = 1 + (workShown ? 1 : 0) + taskGroups.length;
  const canGroup = taskGroups.length > 0 || sourceLists.some((l) => l.on);

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
          <DraftInput item={t} field="title" className="inline-edit t" aria-label="Title" />
          <div className="meta">
            {alert && (
              <span className={alertLate ? "error" : ""} title={f.snoozed_until ? `snoozed from ${fmtDateTime(f.remind_at)}` : "reminder"}>
                remind {fmtDateTime(alert)}
                {f.snoozed_until && f.remind_at && f.snoozed_until > f.remind_at ? " (snoozed)" : ""}
              </span>
            )}
            {f.repeat && <span>{repeatLabel(f.repeat)}</span>}
            {f.due && <span className={f.status !== "done" && isOverdue(f.due) ? "error" : ""}>due {fmtDue(f.due)}</span>}
            {f.linked_id && <LinkedItem id={f.linked_id} />}
            {!listFilter && f.apple?.list_title && f.apple.list_title !== "Reminders" && <span title="Apple Reminders list">{f.apple.list_title} list</span>}
            {f.block && <span>block {fmtDateTime(f.block.start)}</span>}
            {f.parked_reason && f.status === "parked" && <span>set aside: {f.parked_reason}</span>}
            {f.project_id && projectName.has(f.project_id) && (
              <a href={`#/projects/${f.project_id}`} title="Open the project">
                {projectName.get(f.project_id)}
              </a>
            )}
            {f.notes && !isOpen && <span>notes</span>}
            {f.status === "done" && (
              <button className="small" onClick={() => reopen(t)} aria-label={`Not done: ${f.title}`}>
                Not done
              </button>
            )}
            <button className="ghost small" onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Edit"} ${f.title}`}>
              {isOpen ? "close" : "edit"}
            </button>
          </div>
          {isOpen && (
            <div className="col" style={{ marginTop: 8 }}>
              <DraftTextarea item={t} field="notes" rows={3} placeholder="Notes" aria-label="Notes" />
              <div className="row">
                <div className="grow">
                  <label htmlFor={`st-${t.id}`}>Status</label>
                  <select id={`st-${t.id}`} value={f.status} onChange={(e) => setStatus(t, e.target.value as Status)}>
                    {ALL.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
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
                  <input id={`due-${t.id}`} type="datetime-local" value={dueInputValue(f.due)} onChange={(e) => updateEntity(t, { due: dueFromInput(e.target.value, f.due) })} />
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
                {f.status !== "parked" && f.status !== "done" && (
                  <button className="small" onClick={() => setStatus(t, "parked")} title="Out of Next and Now until you bring it back, with the reason">
                    Set aside
                  </button>
                )}
                {canMove && !(t.space === "work" && tiedToApple(t)) && (
                  <button className="small" onClick={() => moveSpace(t)}>
                    Move to {t.space === "work" ? "Personal" : "Work"}
                  </button>
                )}
                <button className="small ghost danger" onClick={() => remove(t)}>
                  Delete
                </button>
              </div>
              {t.space === "work" && tiedToApple(t) && <div className="muted small">In a work Reminders account, so it stays in Work.</div>}
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
        {(choices > 1 || canGroup) && (
          <div className="scope-row">
            {choices > 1 && (
              <div className="seg" role="tablist" aria-label={TASK_GROUP_TEXT.show}>
                <ScopeTab title={TASK_GROUP_TEXT.personal} on={!group && space === "personal"} onClick={() => chooseSpace("personal")} />
                {workShown && <ScopeTab title={TASK_GROUP_TEXT.work} on={!group && space === "work"} onClick={() => chooseSpace("work")} />}
                {taskGroups.map((g) => <ScopeTab key={g.id} title={g.name} on={group?.id === g.id} onClick={() => chooseSpace(`group:${g.id}`)} />)}
              </div>
            )}
            {canGroup && (
              <button type="button" className="small ghost" onClick={() => setEditingGroup({ group: null })} aria-expanded={editingGroup?.group === null}>
                {TASK_GROUP_TEXT.newGroup}
              </button>
            )}
            {group && (
              <button type="button" className="small ghost" onClick={() => setEditingGroup({ group })} aria-expanded={editingGroup?.group?.id === group.id}>
                {TASK_GROUP_TEXT.editGroup}
              </button>
            )}
          </div>
        )}
        {editingGroup && (
          <TaskGroupEditor
            key={editingGroup.group?.id ?? "new"}
            group={editingGroup.group}
            groups={taskGroups}
            lists={sourceLists}
            onDone={(saved) => {
              setEditingGroup(null);
              if (saved) chooseSpace(`group:${saved.id}`);
              else if (saved === null) chooseSpace("personal");
            }}
          />
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
      {group ? (
        <div className="muted small">{TASK_GROUP_TEXT.note}</div>
      ) : workShown && (
        <div className="muted small">Work holds tasks you add under Work, tasks from work Reminders accounts and captures that start with "work:". The rest are Personal. To move one, open it with edit.</div>
      )}
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
      {!tasks.length && <div className="empty">{group && !group.lists.length ? TASK_GROUP_TEXT.empty : "No tasks."}</div>}
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
      {undo && (
        <div className="undo-bar" role="status">
          <span>{undo.text}</span>
          <button type="button" onClick={() => { const run = undo.run; setUndo(null); run(); }}>Undo</button>
        </div>
      )}
    </div>
  );
}

function ScopeTab({ title, on, onClick }: { title: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={on} className={on ? "on" : ""} onClick={onClick}>
      {title}
    </button>
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
