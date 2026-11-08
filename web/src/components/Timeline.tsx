import type { TimelineItem } from "../lib/planner";
import { fmtTime } from "../lib/time";
import { linkFor } from "../lib/links";

/**
 * One day as a vertical list in time order: blocks, commitments (blackouts hatched), events,
 * reminders inline at their times, free slots as faint rows with a schedule button, and the
 * current time marker. Used by Today and by Week on phones.
 */
export function Timeline({ items, onSchedule, onUnschedule, scheduleLabel = "Schedule here" }: { items: TimelineItem[]; onSchedule?: (start: string, hours: number) => void; onUnschedule?: (taskId: string) => void; scheduleLabel?: string }) {
  if (!items.length) return <div className="muted small">Nothing planned.</div>;
  return (
    <div className="timeline">
      {items.map((it) => {
        switch (it.kind) {
          case "now":
            return (
              <div key={it.key} className="tl-now" aria-label={`Now, ${fmtTime(it.start)}`}>
                <span className="time">{fmtTime(it.start)}</span>
                <span className="line" />
              </div>
            );
          case "reminder":
            return (
              <div key={it.key} className="tl-item reminder">
                <span className="time">{fmtTime(it.start)}</span>
                <span>
                  <span className="dot" aria-hidden="true" /> <a href={linkFor("reminder", it.id)}>{it.title}</a>
                </span>
              </div>
            );
          case "block":
            return (
              <div key={it.key} className={`tl-item block ${it.status}`}>
                <span className="time">
                  {fmtTime(it.start)}
                  <br />
                  {fmtTime(it.end)}
                </span>
                <span className="body">
                  <a href={linkFor("task", it.task_id)} className="t">
                    {it.title}
                  </a>
                  <span className="meta">
                    <span>{it.status}</span>
                    {onUnschedule && (
                      <button className="ghost small" onClick={() => onUnschedule(it.task_id)} aria-label={`Unschedule ${it.title}`}>
                        unschedule
                      </button>
                    )}
                  </span>
                </span>
              </div>
            );
          case "commitment":
            return (
              <div key={it.key} className={`tl-item ${it.type}`}>
                <span className="time">
                  {fmtTime(it.start)}
                  <br />
                  {fmtTime(it.end)}
                </span>
                <span className="body">
                  <span className="t">{it.title}</span>
                  <span className="meta">{it.type}</span>
                </span>
              </div>
            );
          case "event":
            return (
              <div key={it.key} className="tl-item event">
                <span className="time">
                  {it.all_day ? "All day" : (
                    <>
                      {fmtTime(it.start)}
                      <br />
                      {fmtTime(it.end)}
                    </>
                  )}
                </span>
                <span className="body">
                  <span className="t">{it.title}</span>
                  <span className="meta">event{it.location ? `, ${it.location}` : ""}</span>
                </span>
              </div>
            );
          case "free":
            return (
              <div key={it.key} className="tl-item free">
                <span className="time">
                  {fmtTime(it.start)}
                  <br />
                  {fmtTime(it.end)}
                </span>
                <span className="body row between">
                  <span className="muted">free, {Math.floor(it.hours)} h</span>
                  {onSchedule && (
                    <button className="small" onClick={() => onSchedule(it.start, 3)} aria-label={`${scheduleLabel}, ${fmtTime(it.start)}`}>
                      {scheduleLabel}
                    </button>
                  )}
                </span>
              </div>
            );
        }
      })}
    </div>
  );
}
