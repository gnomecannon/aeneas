import type { CSSProperties } from "react";
import type { Ribbon } from "../lib/todayBoard";
import { linkFor } from "../lib/links";
import { useFeel } from "../feel/store";
import { eventColorStyle } from "../lib/eventColor";

/**
 * The day as one strip across the window (lib/todayBoard.ts `dayRibbon`): hour marks, each thing with a time at its
 * place (events in their calendar's color, blocks in the accent, fixed hours hatched), free time as a dashed outline
 * that schedules a task when pressed, reminders as dots, the time that has passed shaded, and a line at now.
 * A picture of what the Schedule card lists: the card is what a screen reader reads, so the strip is one image to it.
 */
export function DayRibbon({ ribbon, onFree }: { ribbon: Ribbon; onFree?: (start: string) => void }) {
  const feel = useFeel();
  const things = ribbon.segs.filter((s) => s.kind !== "free");
  const label = things.length
    ? `The day from ${fmt(ribbon.start)} to ${fmt(ribbon.end)}: ${things.map((s) => `${s.title}, ${s.when}`).join("; ")}`
    : `The day from ${fmt(ribbon.start)} to ${fmt(ribbon.end)}: nothing with a time`;
  return (
    <div className="ribbon" role="img" aria-label={label} style={{ "--lanes": ribbon.lanes } as CSSProperties}>
      <div className="ribbon-hours" aria-hidden="true">
        {ribbon.hours.map((h, i) => h.label && <span key={i} className="ribbon-label" style={{ left: `${h.left}%` }}>{h.label}</span>)}
      </div>
      <div className="ribbon-track" aria-hidden="true">
        {ribbon.hours.map((h, i) => <span key={i} className="ribbon-tick" style={{ left: `${h.left}%` }} />)}
        {ribbon.segs.map((s) => {
          const style: CSSProperties = { left: `${s.left}%`, width: `${s.width}%`, ...({ "--lane": s.lane } as CSSProperties) };
          const tip = `${s.title}, ${s.when}`;
          if (s.kind === "free") {
            return onFree && !s.past ? (
              <button key={s.key} type="button" tabIndex={-1} className="ribbon-seg free" style={style} title={`${tip}. Schedule a task here`} onClick={() => onFree(s.item.start)}>
                <span>{s.title}</span>
              </button>
            ) : (
              <span key={s.key} className="ribbon-seg free" style={style} title={tip}><span>{s.title}</span></span>
            );
          }
          const color = s.item.kind === "event" && s.item.fields ? eventColorStyle(s.item.fields, feel.calendars) : undefined;
          const cls = `ribbon-seg ${s.kind}${s.item.kind === "commitment" ? ` ${s.item.type}` : ""}${s.item.kind === "block" ? ` ${s.item.status}` : ""}${s.past ? " past" : ""}`;
          const href = s.item.kind === "block" ? linkFor("task", s.item.task_id) : s.item.kind === "event" ? linkFor("event", s.item.id) : null;
          return href ? (
            <a key={s.key} href={href} tabIndex={-1} className={cls} style={{ ...style, ...color }} title={tip}><span>{s.title}</span></a>
          ) : (
            <span key={s.key} className={cls} style={{ ...style, ...color }} title={tip}><span>{s.title}</span></span>
          );
        })}
        {ribbon.dots.map((d) => (
          <a key={d.key} href={linkFor("reminder", d.id)} tabIndex={-1} className={`ribbon-dot${d.past ? " past" : ""}`} style={{ left: `${d.left}%` }} title={d.title} />
        ))}
        {ribbon.now !== null && <span className="ribbon-past" style={{ width: `${ribbon.now}%` }} />}
        {ribbon.now !== null && <span className="ribbon-now" style={{ left: `${ribbon.now}%` }} />}
      </div>
    </div>
  );
}

const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric" });
