import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { taskAlertAt } from "@everythingapp/shared";
import { useHubPoll } from "../sync/useHubPoll";
import { conflictMessage, localWeek, scheduleTask, unscheduleTask } from "../sync/planner";
import { useEntities } from "../sync/hooks";
import { db } from "../sync/db";
import {
  addDays,
  atMinutes,
  DAY_END,
  DAY_START,
  fmtDayLabel,
  gridPlacement,
  hhmmToMinutes,
  hourRows,
  localDate,
  minutesAtFraction,
  mondayOf,
  parseLocalDate,
  timeline,
  type PlannerDay,
  type PlannerWeek,
} from "../lib/planner";
import { fmtTime, HOUR, relative } from "../lib/time";
import { go } from "../lib/router";
import { linkFor } from "../lib/links";
import { useMediaQuery } from "../lib/useMediaQuery";
import { Timeline } from "../components/Timeline";
import { TaskPicker } from "../components/TaskPicker";

const DRAG_TYPE = "application/x-ea-task";
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Pending = { taskId: string; start: string; hours: number };

function dragPayload(e: DragEvent): { task_id: string; hours: number } | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData("text/plain");
    const p = JSON.parse(raw);
    return p && typeof p.task_id === "string" ? { task_id: p.task_id, hours: Number(p.hours) || 3 } : null;
  } catch {
    return null;
  }
}

function startDrag(e: DragEvent, task_id: string, hours: number) {
  const payload = JSON.stringify({ task_id, hours });
  e.dataTransfer.setData(DRAG_TYPE, payload);
  e.dataTransfer.setData("text/plain", payload);
  e.dataTransfer.effectAllowed = "move";
}

/** Seven columns, rows are hours from day start to day end. Items are placed by percent of the day span. */
function WeekGrid({ week, onDrop, onPlus, onUnschedule }: { week: PlannerWeek; onDrop: (taskId: string, start: string, hours: number) => void; onPlus: (start: string, hours: number) => void; onUnschedule: (taskId: string) => void }) {
  const rows = hourRows();
  const [over, setOver] = useState<string | null>(null);
  const todayStr = localDate(new Date());
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const a = hhmmToMinutes(DAY_START);
  const b = hhmmToMinutes(DAY_END);
  const nowTop = nowMin >= a && nowMin <= b ? ((nowMin - a) / (b - a)) * 100 : null;

  const dropOn = (day: PlannerDay) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(null);
    const p = dragPayload(e);
    if (!p) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const start = atMinutes(parseLocalDate(day.date), minutesAtFraction(y)).toISOString();
    onDrop(p.task_id, start, p.hours);
  };

  return (
    <div className="wk-grid" style={{ ["--rows" as string]: rows.length }}>
      <div className="wk-corner" />
      {week.days.map((d, i) => {
        const date = parseLocalDate(d.date);
        return (
          <div key={d.date} className={`wk-head ${d.date === todayStr ? "today" : ""}`}>
            <div>
              <span className="muted">{DAY_SHORT[i]}</span> {date.getDate()}
            </div>
            {d.events.filter((e) => e.fields.all_day === true).map((e) => (
              <a key={e.id} href={linkFor("event", e.id)} className="wk-allday small" title={`${String(e.fields.title)}, all day`}>
                {String(e.fields.title)}
              </a>
            ))}
            {d.watches_due.map((w) => (
              <a key={w.id} href={`#/renewals?focus=${w.id}`} className="wk-watch small" title={`Renewal due: ${String(w.fields.title)}`}>
                renew: {String(w.fields.title)}
              </a>
            ))}
          </div>
        );
      })}
      <div className="wk-gutter" aria-hidden="true">
        {rows.map((h, i) => (
          <span key={h} style={{ top: `${(i / rows.length) * 100}%` }}>
            {fmtTime(atMinutes(now, h * 60).toISOString()).replace(":00", "")}
          </span>
        ))}
      </div>
      {week.days.map((d) => {
        const date = parseLocalDate(d.date);
        const place = (s: { start: string; end: string }) => gridPlacement(s, date);
        return (
          <div
            key={d.date}
            className={`wk-col ${over === d.date ? "over" : ""} ${d.date === todayStr ? "today" : ""}`}
            role="group"
            aria-label={fmtDayLabel(date)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("text/plain")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== d.date) setOver(d.date);
              }
            }}
            onDragLeave={() => over === d.date && setOver(null)}
            onDrop={dropOn(d)}
          >
            {d.free_slots.map((s) => {
              const p = place(s);
              if (!p) return null;
              return (
                <div key={s.start} className="wk-item free" style={{ top: `${p.top}%`, height: `${p.height}%` }}>
                  <button className="plus" onClick={() => onPlus(s.start, 3)} aria-label={`Schedule a task at ${fmtTime(s.start)} on ${fmtDayLabel(date)}`} title={`Free ${Math.floor(s.hours)} h. Schedule here`}>
                    +
                  </button>
                </div>
              );
            })}
            {d.commitments.map((c) => {
              const p = place(c);
              if (!p) return null;
              return (
                <div key={`${c.rule_id}:${c.start}`} className={`wk-item ${c.type}`} style={{ top: `${p.top}%`, height: `${p.height}%` }} title={`${c.title}, ${c.type}, ${fmtTime(c.start)} to ${fmtTime(c.end)}`}>
                  {c.title}
                </div>
              );
            })}
            {/* All-day events are markers in the day's header, as calendars show them, not a block over the hours. */}
            {d.events.filter((e) => e.fields.all_day !== true).map((e) => {
              const p = place({ start: String(e.fields.start), end: String(e.fields.end) });
              if (!p) return null;
              return (
                <div key={e.id} className="wk-item event" style={{ top: `${p.top}%`, height: `${p.height}%` }} title={`${String(e.fields.title)}, ${fmtTime(String(e.fields.start))} to ${fmtTime(String(e.fields.end))}`}>
                  {String(e.fields.title)}
                </div>
              );
            })}
            {d.blocks.map((bl) => {
              const p = place(bl);
              if (!p) return null;
              const hours = (new Date(bl.end).getTime() - new Date(bl.start).getTime()) / HOUR;
              return (
                <div
                  key={`${bl.task_id}:${bl.start}`}
                  className={`wk-item block ${bl.status}`}
                  style={{ top: `${p.top}%`, height: `${p.height}%` }}
                  draggable
                  onDragStart={(e) => startDrag(e, bl.task_id, hours)}
                  role="link"
                  tabIndex={0}
                  aria-label={`${bl.title}, ${fmtTime(bl.start)} to ${fmtTime(bl.end)}. Open task`}
                  title={`${bl.title}, ${fmtTime(bl.start)} to ${fmtTime(bl.end)}. Drag to move`}
                  onClick={() => go(linkFor("task", bl.task_id).slice(1))}
                  onKeyDown={(e) => e.key === "Enter" && go(linkFor("task", bl.task_id).slice(1))}
                >
                  <span className="t">{bl.title}</span>
                  <span className="time">{fmtTime(bl.start)}</span>
                  <button
                    className="x"
                    aria-label={`Unschedule ${bl.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnschedule(bl.task_id);
                    }}
                  >
                    x
                  </button>
                </div>
              );
            })}
            {d.reminders.map((r) => {
              const at = taskAlertAt(r.fields) ?? "";
              const p = place({ start: at, end: new Date(new Date(at).getTime() + 60_000).toISOString() });
              if (!p) return null;
              return <a key={r.id} href={linkFor("reminder", r.id)} className="wk-dot" style={{ top: `${p.top}%` }} title={`${fmtTime(at)} ${String(r.fields.title)}`} aria-label={`Reminder ${String(r.fields.title)} at ${fmtTime(at)}`} />;
            })}
            {d.date === todayStr && nowTop != null && <div className="wk-now" style={{ top: `${nowTop}%` }} aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}

export function Week() {
  const desktop = useMediaQuery("(min-width: 768px)");
  const [start, setStart] = useState(() => localDate(mondayOf(new Date())));
  const poll = useHubPoll<PlannerWeek>((c) => c.plannerWeek(start), () => localWeek(start), [start]);
  const week = poll.data;
  const todayStr = localDate(new Date());
  const [dayIdx, setDayIdx] = useState(() => (new Date().getDay() + 6) % 7);
  const [picker, setPicker] = useState<{ start: string; hours: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; retry: Pending | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const unscheduled = useEntities("task", (e) => e.fields.status === "next" && !e.fields.block)
    .slice()
    .sort((a, b) => (a.fields.order as number) - (b.fields.order as number));

  useEffect(() => {
    // Moving to another week keeps the same weekday selected on the phone layout.
    if (start === localDate(mondayOf(new Date()))) setDayIdx((new Date().getDay() + 6) % 7);
  }, [start]);

  const schedule = useCallback(
    async (taskId: string, startIso: string, hours: number, force = false) => {
      setBusy(true);
      setMsg(null);
      try {
        await scheduleTask(taskId, startIso, hours, force);
        setPicker(null);
        await poll.reload();
      } catch (e) {
        const c = conflictMessage(e);
        setMsg({ text: c ?? (e instanceof Error ? e.message : String(e)), retry: c ? { taskId, start: startIso, hours } : null });
      } finally {
        setBusy(false);
      }
    },
    [poll],
  );

  const unschedule = useCallback(
    async (taskId: string) => {
      const task = await db.entities.get(taskId);
      if (!task) return;
      setMsg(null);
      try {
        await unscheduleTask(task);
        await poll.reload();
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : String(e), retry: null });
      }
    },
    [poll],
  );

  const mon = parseLocalDate(start);
  const sun = addDays(mon, 6);
  const sameMonth = mon.getMonth() === sun.getMonth();
  const title = `${fmtDayLabel(mon).slice(4)} to ${sameMonth ? sun.getDate() : fmtDayLabel(sun).slice(4)}`;
  const shift = (weeks: number) => setStart(localDate(addDays(mon, 7 * weeks)));

  const day = week?.days[dayIdx];
  const phoneItems = useMemo(() => (day ? timeline({ ...day, reminders: day.reminders }, day.date === todayStr ? new Date() : null) : []), [day, todayStr]);

  return (
    <div className={`week ${desktop ? "desktop" : "phone"}`}>
      <div className="wk-bar row between">
        <div className="row">
          <button className="small" onClick={() => shift(-1)} aria-label="Previous week">
            &lt;
          </button>
          <strong>{title}</strong>
          <button className="small" onClick={() => shift(1)} aria-label="Next week">
            &gt;
          </button>
          <button className="small ghost" onClick={() => setStart(localDate(mondayOf(new Date())))} disabled={start === localDate(mondayOf(new Date()))}>
            This week
          </button>
        </div>
        <div className="row">
          <span className="muted small">
            {poll.source === "local" ? "local copy, hub unreachable" : poll.at ? `checked ${relative(poll.at.toISOString())}` : ""}
            {poll.busy ? ", loading" : ""}
          </span>
          <a href="#/plan-rules" className="small">
            Rules
          </a>
        </div>
      </div>
      {!week && poll.error && <div className={poll.unavailable ? "muted small" : "error"}>{poll.unavailable ? "The planner is not available on this hub." : poll.error}</div>}
      {msg && (
        <div className="row conflict" role="alert">
          <span className="error">{msg.text}</span>
          {msg.retry && (
            <button className="small" disabled={busy} onClick={() => void schedule(msg.retry!.taskId, msg.retry!.start, msg.retry!.hours, true)}>
              Schedule anyway
            </button>
          )}
          <button className="small ghost" onClick={() => setMsg(null)} aria-label="Dismiss this message">
            Dismiss
          </button>
        </div>
      )}
      {picker && <TaskPicker title={`Schedule at ${fmtTime(picker.start)} ${fmtDayLabel(new Date(picker.start))}, 3 h`} onPick={(t) => void schedule(t.id, picker.start, picker.hours)} onClose={() => setPicker(null)} busy={busy} />}
      {week && desktop && (
        <div className="wk-layout">
          <WeekGrid week={week} onDrop={(id, s, h) => void schedule(id, s, h)} onPlus={(s, h) => setPicker({ start: s, hours: h })} onUnschedule={(id) => void unschedule(id)} />
          <aside className="wk-side" aria-label="Unscheduled next tasks">
            <h3>Unscheduled next ({unscheduled.length})</h3>
            {!unscheduled.length && <div className="muted small">Nothing waiting.</div>}
            <div className="list">
              {unscheduled.slice(0, 12).map((t: Entity) => (
                <div key={t.id} className="item drag" draggable onDragStart={(e) => startDrag(e, t.id, 3)} title="Drag onto a day to schedule 3 h">
                  <span className="grip" aria-hidden="true">
                    ::
                  </span>
                  <div className="body">
                    <a href={linkFor("task", t.id)} className="t">
                      {String(t.fields.title)}
                    </a>
                  </div>
                </div>
              ))}
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Drag a task onto the grid, or press + in a free slot. Blackouts are hatched, commitments grey.
            </div>
          </aside>
        </div>
      )}
      {week && !desktop && (
        <>
          <div className="wk-days" role="tablist" aria-label="Day">
            {week.days.map((d, i) => {
              const date = parseLocalDate(d.date);
              return (
                <button key={d.date} role="tab" aria-selected={i === dayIdx} className={`chip ${i === dayIdx ? "on" : ""} ${d.date === todayStr ? "today" : ""}`} onClick={() => setDayIdx(i)}>
                  {DAY_SHORT[i]} {date.getDate()}
                </button>
              );
            })}
          </div>
          {day && (
            <>
              <div className="row between" style={{ margin: "8px 0" }}>
                <strong>{fmtDayLabel(parseLocalDate(day.date))}</strong>
                <span className="muted small">
                  {day.blocks.length} {day.blocks.length === 1 ? "block" : "blocks"}, {day.free_slots.length} free
                </span>
              </div>
              {day.watches_due.length > 0 && (
                <div className="strip">
                  <span className="muted">Renewal due</span>
                  {day.watches_due.map((w) => (
                    <a key={w.id} href={`#/renewals?focus=${w.id}`}>
                      {String(w.fields.title)}
                    </a>
                  ))}
                </div>
              )}
              <Timeline items={phoneItems} onSchedule={(s, h) => setPicker({ start: s, hours: h })} onUnschedule={(id) => void unschedule(id)} scheduleLabel="Schedule" />
            </>
          )}
        </>
      )}
    </div>
  );
}
