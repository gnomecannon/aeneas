import { useMemo, type ReactNode } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { useTodayReminders } from "../sync/useTodayReminders";
import { updateEntity } from "../sync/edits";
import { fmtTime, HOUR } from "../lib/time";
import { fmtDue } from "../lib/planner";
import { go } from "../lib/router";
import { taskAlertAt } from "@everythingapp/shared";
import { completeTask } from "../sync/actions";
import { useMediaQuery } from "../lib/useMediaQuery";
import { openTasks } from "../lib/todayBoard";

type TaskF = { title: string; notes?: string; status: string; order: number; due?: string; block?: { start: string; end: string }; parked_reason?: string };

export function pickCurrent(tasks: Entity[]): { current: Entity | null; next: Entity[] } {
  const doing = tasks.filter((t) => t.fields.status === "doing").sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  if (doing.length) return { current: doing[0], next };
  if (next.length) return { current: next[0], next: next.slice(1) };
  return { current: null, next: [] };
}

/**
 * The one-task card with Done, Start block, Skip and Park. Reused in Today's To do, which passes `whenEmpty` (what to
 * show when nothing is being done or next; null for nothing): Today lists the open tasks itself.
 */
export function NowCard({ showNext = true, whenEmpty }: { showNext?: boolean; whenEmpty?: ReactNode } = {}) {
  const tasks = useEntities("task", (e) => e.fields.status === "doing" || e.fields.status === "next");
  const { current, next } = useMemo(() => pickCurrent(tasks), [tasks]);

  const done = () => current && completeTask(current);
  const park = () => {
    if (!current) return;
    const reason = window.prompt("Why park it");
    if (reason === null) return;
    void updateEntity(current, { status: "parked", parked_reason: reason });
  };
  const skip = () => {
    if (!current) return;
    const maxOrder = Math.max(0, ...tasks.filter((t) => t.fields.status === "next").map((t) => t.fields.order as number));
    void updateEntity(current, { status: "next", order: maxOrder + 1 });
  };
  const startBlock = () => {
    if (!current) return;
    const start = new Date();
    const end = new Date(start.getTime() + 3 * HOUR);
    void updateEntity(current, { status: "doing", block: { start: start.toISOString(), end: end.toISOString() } });
  };

  const f = current?.fields as TaskF | undefined;
  const blockActive = f?.block && new Date(f.block.end) > new Date();

  return (
    <>
      {current && f ? (
        <div className="card big">
          <div className="muted small">{f.status === "doing" ? (blockActive ? `block until ${fmtTime(f.block!.end)}` : "doing") : "next"}</div>
          <div className="title">{f.title}</div>
          {f.notes && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{f.notes}</p>}
          {f.due && <div className="small muted">due {fmtDue(f.due)}</div>}
          <div className="actions">
            <button className="primary" onClick={done}>
              Done
            </button>
            {f.status !== "doing" && <button onClick={startBlock}>Start block</button>}
            <button onClick={skip}>Skip</button>
            <button onClick={park}>Park</button>
          </div>
        </div>
      ) : whenEmpty !== undefined ? (
        whenEmpty
      ) : (
        <NothingDoing />
      )}
      {showNext && next.length > 0 && (
        <details>
          <summary>Up next ({next.length})</summary>
          <div className="list">
            {next.slice(0, 3).map((t) => (
              <div key={t.id} className="item">
                <div className="body">
                  <div className="t">{String(t.fields.title)}</div>
                  {!!t.fields.due && <div className="meta">due {fmtDue(t.fields.due as string)}</div>}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/**
 * With no task doing or next: the open tasks to pick from, each with Start, as Today's To do offers them. Tasks from
 * Reminders and captures arrive in the Inbox, so for someone who never sorts them into Next this card used to say
 * "Nothing queued" every day. With no open task at all it says what to do about that.
 */
function NothingDoing() {
  const all = useEntities("task");
  const open = useMemo(() => openTasks(all), [all]);
  if (!open.length) {
    return (
      <div className="card big">
        <div className="title">Nothing is next</div>
        <p className="muted">Capture something, or add a task in Tasks.</p>
        <div className="actions">
          <button onClick={() => go("/capture")}>Capture</button>
          <button onClick={() => go("/tasks")}>Tasks</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card big">
      <div className="title">Nothing is being done</div>
      <p className="muted">{open.length === 1 ? "Start your open task:" : `Start one of your ${open.length} open tasks:`}</p>
      <ul className="todo-list">
        {open.slice(0, 6).map((task) => {
          const title = String(task.fields.title ?? "");
          return (
            <li key={task.id} className="todo-row">
              <a href={`#/tasks?focus=${task.id}`} className="todo-title">
                {title}
                {typeof task.fields.due === "string" && task.fields.due && <span className="muted small"> due {fmtDue(task.fields.due)}</span>}
              </a>
              <button type="button" className="small" aria-label={`Start ${title}`} onClick={() => void updateEntity(task, { status: "doing" })}>
                Start
              </button>
            </li>
          );
        })}
      </ul>
      {open.length > 6 && (
        <a href="#/tasks" className="small more">
          All {open.length} in Tasks
        </a>
      )}
    </div>
  );
}

/**
 * The single current task. On a wide window (1100 px or more) the task's card keeps a width of 720 px at the left, and
 * what is due today, what waits in Unsorted Info and what is up next sit beside it, up next always open; the card and
 * the strips used to be stretched across the whole window. Narrower, the strips are over the card and up next folds
 * away under it, as before.
 */
export function Now() {
  const { items: today, source: todaySource } = useTodayReminders();
  const unprocessed = useEntities("capture", (e) => !e.fields.processed).length;
  const tasks = useEntities("task", (e) => e.fields.status === "doing" || e.fields.status === "next");
  const { next } = useMemo(() => pickCurrent(tasks), [tasks]);
  const wide = useMediaQuery("(min-width: 1100px)");

  const strips = (
    <>
      {today.length > 0 && (
        <div className="strip" title={todaySource === "hub" ? "due within 12 h, from the hub" : "due today, computed locally"}>
          <span className="muted">{todaySource === "hub" ? "Due" : "Today"}</span>
          {today.map((r) => (
            <span key={r.id}>
              {fmtTime(taskAlertAt(r.fields))} {String(r.fields.title)}
            </span>
          ))}
          <a href="#/tasks" className="small" style={{ marginLeft: "auto" }}>
            all
          </a>
        </div>
      )}
      {unprocessed > 0 && (
        <div className="strip">
          <a href="#/inbox">
            <span className="badge">{unprocessed}</span> waiting in Unsorted Info
          </a>
        </div>
      )}
    </>
  );

  return (
    <div>
      <h1>Now</h1>
      {wide ? (
        <div className="now-cols">
          <div>
            <NowCard showNext={false} />
          </div>
          <aside>
            {strips}
            {next.length > 0 && (
              <section className="card">
                <h2>Up next ({next.length})</h2>
                <div className="list rows">
                  {next.slice(0, 12).map((t) => (
                    <div key={t.id} className="item">
                      <div className="body">
                        <div className="t">{String(t.fields.title)}</div>
                        {!!t.fields.due && <div className="meta">due {fmtDue(t.fields.due as string)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
                {next.length > 12 && (
                  <a href="#/tasks" className="small">
                    All {next.length} in Tasks
                  </a>
                )}
              </section>
            )}
          </aside>
        </div>
      ) : (
        <div className="now-stack">
          {strips}
          <NowCard />
        </div>
      )}
    </div>
  );
}
