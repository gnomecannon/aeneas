import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { updateEntity } from "../sync/edits";
import { completeTask } from "../sync/actions";
import { fmtTime, HOUR } from "../lib/time";
import { fmtDue } from "../lib/planner";

type TaskF = { title: string; notes?: string; status: string; order: number; due?: string; block?: { start: string; end: string } };

/**
 * The task you started, on Today's To do card, with Done, Start block, Skip and Set aside. Only a task you started
 * (status doing, packages/shared `startedTask`) gets it: the first task in Next used to, as "Now", which is how a gift
 * idea captured as an undated task showed up as the thing to do now. Start block is offered while no block of it is
 * under way.
 */
export function StartedCard({ task }: { task: Entity }) {
  const nextTasks = useEntities("task", (e) => e.fields.status === "next");
  const f = task.fields as TaskF;
  const now = Date.now();
  const blockOn = !!f.block && Date.parse(f.block.start) <= now && Date.parse(f.block.end) > now;

  const done = () => void completeTask(task);
  const park = () => {
    const reason = window.prompt("Why set it aside?");
    if (reason === null) return;
    void updateEntity(task, { status: "parked", parked_reason: reason, block: null });
  };
  // Back to the end of Next: it is no longer the task you are on.
  const skip = () => {
    const maxOrder = Math.max(0, ...nextTasks.map((t) => t.fields.order as number).filter((n) => Number.isFinite(n)));
    void updateEntity(task, { status: "next", order: maxOrder + 1, block: null });
  };
  const startBlock = () => {
    const start = new Date();
    const end = new Date(start.getTime() + 3 * HOUR);
    void updateEntity(task, { status: "doing", block: { start: start.toISOString(), end: end.toISOString() } });
  };

  return (
    <div className="card big">
      <div className="muted small">{blockOn ? `Doing, block until ${fmtTime(f.block!.end)}` : "Doing"}</div>
      <div className="title">{f.title}</div>
      {f.notes && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{f.notes}</p>}
      {f.due && <div className="small muted">due {fmtDue(f.due)}</div>}
      <div className="actions">
        <button className="primary" onClick={done}>
          Done
        </button>
        {!blockOn && <button onClick={startBlock}>Start block</button>}
        <button onClick={skip} title="Back to the end of Next">Skip</button>
        <button onClick={park} title="Out of Next until you bring it back, with the reason">Set aside</button>
      </div>
    </div>
  );
}
