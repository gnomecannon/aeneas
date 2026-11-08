import { useMemo } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { useTodayReminders } from "../sync/useTodayReminders";
import { updateEntity } from "../sync/edits";
import { fmtDateTime, fmtTime, HOUR } from "../lib/time";
import { go } from "../lib/router";
import { completeTaskPatch, taskAlertAt } from "@everythingapp/shared";

type TaskF = { title: string; notes?: string; status: string; order: number; due?: string; block?: { start: string; end: string }; parked_reason?: string };

export function pickCurrent(tasks: Entity[]): { current: Entity | null; next: Entity[] } {
  const doing = tasks.filter((t) => t.fields.status === "doing").sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  if (doing.length) return { current: doing[0], next };
  if (next.length) return { current: next[0], next: next.slice(1) };
  return { current: null, next: [] };
}

/** The one-task card with Done, Start block, Skip and Park. Reused at the top of Today. */
export function NowCard({ showNext = true }: { showNext?: boolean } = {}) {
  const tasks = useEntities("task", (e) => e.fields.status === "doing" || e.fields.status === "next");
  const { current, next } = useMemo(() => pickCurrent(tasks), [tasks]);

  const done = () => current && updateEntity(current, completeTaskPatch(current.fields));
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
          {f.due && <div className="small muted">due {fmtDateTime(f.due)}</div>}
          <div className="actions">
            <button className="primary" onClick={done}>
              Done
            </button>
            {f.status !== "doing" && <button onClick={startBlock}>Start block</button>}
            <button onClick={skip}>Skip</button>
            <button onClick={park}>Park</button>
          </div>
        </div>
      ) : (
        <div className="card big">
          <div className="title">Nothing queued</div>
          <p className="muted">Move a task to next in Tasks, or sort Unsorted Info.</p>
          <div className="actions">
            <button onClick={() => go("/tasks")}>Tasks</button>
            <button onClick={() => go("/capture")}>Capture</button>
          </div>
        </div>
      )}
      {showNext && next.length > 0 && (
        <details>
          <summary>Up next ({next.length})</summary>
          <div className="list">
            {next.slice(0, 3).map((t) => (
              <div key={t.id} className="item">
                <div className="body">
                  <div className="t">{String(t.fields.title)}</div>
                  {!!t.fields.due && <div className="meta">due {fmtDateTime(t.fields.due as string)}</div>}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

export function Now() {
  const { items: today, source: todaySource } = useTodayReminders();
  const unprocessed = useEntities("capture", (e) => !e.fields.processed).length;

  return (
    <div>
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
      <NowCard />
    </div>
  );
}
