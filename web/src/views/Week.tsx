import { plainError } from "../lib/errors";
import { fixPath, problemsFor } from "../lib/connectionProblems";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { calendarGroups, calendarKeyOf, calendarShown, taskAlertAt, withCalendarShown, type CalendarGroup } from "@everythingapp/shared";
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
import {
  CALENDAR_VIEWS,
  eventsByDay,
  isCalendarView,
  monthGrid,
  monthName,
  periodTitle,
  periodWord,
  searchEvents,
  shiftAnchor,
  VIEW_NAMES,
  WEEKDAY_SHORT,
  yearGrid,
  type CalendarView,
  type DayGroup,
  eventLanes,
  type EventLane,
} from "../lib/calendarViews";
import { fmtTime, HOUR, relative } from "../lib/time";
import { go, useRoute } from "../lib/router";
import { linkFor } from "../lib/links";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useLocalDate } from "../lib/useLocalDate";
import { Timeline } from "../components/Timeline";
import { TaskPicker } from "../components/TaskPicker";
import { updateFeel, useFeel } from "../feel/store";
import { eventColorStyle } from "../lib/eventColor";
import { INVITE_TEXTS, inviteFace, inviteWhen, invitationList } from "../lib/invitations";
import { organizerName, type OwnerAnswer } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { unreachableLine } from "../lib/lastSynced";

const DRAG_TYPE = "application/x-ea-task";
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Pending = { taskId: string; start: string; hours: number };

/** Side by side in the day column when events overlap (eventLanes); full width otherwise, as before. */
function laneStyle(l: EventLane | undefined): CSSProperties {
  if (!l || l.lanes < 2) return {};
  return { left: `calc(2px + (100% - 4px) * ${l.lane} / ${l.lanes})`, right: "auto", width: `calc((100% - 4px) / ${l.lanes} - 2px)` };
}

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
  const feel = useFeel();
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
    <div className="wk-grid" style={{ ["--rows" as string]: rows.length, ["--days" as string]: week.days.length }}>
      <div className="wk-corner" />
      {week.days.map((d) => {
        const date = parseLocalDate(d.date);
        return (
          <div key={d.date} className={`wk-head ${d.date === todayStr ? "today" : ""}`}>
            <div>
              <span className="muted">{DAY_SHORT[(date.getDay() + 6) % 7]}</span> {date.getDate()}
            </div>
            {d.events.filter((e) => e.fields.all_day === true).map((e) => (
              <a key={e.id} href={linkFor("event", e.id)} className="wk-allday small" style={eventColorStyle(e.fields as Record<string, unknown>, feel.calendars)} title={`${String(e.fields.title)}, all day`}>
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
            {(() => {
              const timed = d.events.filter((e) => e.fields.all_day !== true).flatMap((e) => {
                const p = place({ start: String(e.fields.start), end: String(e.fields.end) });
                return p ? [{ e, p }] : [];
              });
              const lanes = eventLanes(timed.map(({ e, p }) => ({ id: e.id, start: p.top, end: p.top + p.height })));
              return timed.map(({ e, p }) => (
                <div key={e.id} className="wk-item event" style={{ top: `${p.top}%`, height: `${p.height}%`, ...laneStyle(lanes.get(e.id)), ...eventColorStyle(e.fields as Record<string, unknown>, feel.calendars) }} title={`${String(e.fields.title)}, ${fmtTime(String(e.fields.start))} to ${fmtTime(String(e.fields.end))}`}>
                  {String(e.fields.title)}
                </div>
              ));
            })()}
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
                    // Enter here unschedules only: it went on to the block, which opened the task too.
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.stopPropagation();
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


const VIEW_KEY = "ea.week.view";
/** Events a month cell shows before "N more": titles on a wide window, dots on a phone. */
const MONTH_FITS = 3;

function savedView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return isCalendarView(v) ? v : "week";
  } catch {
    return "week";
  }
}

/** The month grid: each day with its events, as titles on a wide window or dots on a phone. A day opens in Day. */
function MonthView({ year, month, events, todayStr, wide, onOpenDay }: { year: number; month: number; events: Entity[]; todayStr: string; wide: boolean; onOpenDay: (date: string) => void }) {
  const feel = useFeel();
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const byDay = useMemo(() => eventsByDay(events, { start: parseLocalDate(weeks[0][0].date), end: addDays(parseLocalDate(weeks[weeks.length - 1][6].date), 1) }), [events, weeks]);
  return (
    <div className={`mo-grid ${wide ? "wide" : "narrow"}`} role="grid" aria-label={periodTitle("month", new Date(year, month, 1))}>
      <div className="mo-row mo-names" role="row">
        {WEEKDAY_SHORT.map((d) => (
          <div key={d} className="mo-name" role="columnheader">
            {wide ? d : d.slice(0, 1)}
          </div>
        ))}
      </div>
      {weeks.map((w) => (
        <div key={w[0].date} className="mo-row" role="row">
          {w.map((d) => {
            const list = byDay.get(d.date) ?? [];
            const date = parseLocalDate(d.date);
            const shown = list.slice(0, MONTH_FITS);
            const more = list.length - shown.length;
            return (
              <button
                key={d.date}
                role="gridcell"
                className={`mo-cell${d.inMonth ? "" : " out"}${d.date === todayStr ? " today" : ""}`}
                onClick={() => onOpenDay(d.date)}
                aria-label={`${fmtDayLabel(date)}, ${list.length ? `${list.length} ${list.length === 1 ? "event" : "events"}` : "no events"}. Open the day`}
              >
                <span className="mo-num">{date.getDate()}</span>
                {wide ? (
                  <span className="mo-evs" aria-hidden="true">
                    {shown.map((e) => (
                      <span key={e.id} className={`mo-ev${e.fields.all_day === true ? " allday" : ""}`} style={eventColorStyle(e.fields as Record<string, unknown>, feel.calendars)}>
                        {e.fields.all_day === true ? "" : <span className="time">{fmtTime(String(e.fields.start)).replace(":00", "")}</span>}
                        {String(e.fields.title ?? "")}
                      </span>
                    ))}
                    {more > 0 && <span className="mo-more">{more} more</span>}
                  </span>
                ) : (
                  <span className="mo-dots" aria-hidden="true">
                    {shown.map((e) => (
                      <span key={e.id} className="mo-dot" style={eventColorStyle(e.fields as Record<string, unknown>, feel.calendars)} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Twelve small months; one opens in Month. */
function YearView({ year, todayStr, onOpenMonth }: { year: number; todayStr: string; onOpenMonth: (month: number) => void }) {
  const months = useMemo(() => yearGrid(year), [year]);
  const thisMonth = todayStr.slice(0, 7);
  return (
    <div className="yr-grid">
      {months.map((m) => {
        const key = `${year}-${String(m.month + 1).padStart(2, "0")}`;
        return (
          <button key={m.month} className={`yr-month${key === thisMonth ? " now" : ""}`} onClick={() => onOpenMonth(m.month)} aria-label={`${monthName(m.month)} ${year}. Open the month`}>
            <span className="yr-name">{monthName(m.month)}</span>
            <span className="yr-days" aria-hidden="true">
              {WEEKDAY_SHORT.map((d) => (
                <span key={d} className="yr-wd">
                  {d.slice(0, 1)}
                </span>
              ))}
              {m.weeks.flat().map((d) => (
                <span key={d.date} className={`yr-day${d.inMonth ? "" : " out"}${d.date === todayStr && d.inMonth ? " today" : ""}`}>
                  {d.inMonth ? Number(d.date.slice(8)) : ""}
                </span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Search results by day: today on first, then Earlier. */
function SearchResults({ query, events, allEvents, todayStr }: { query: string; events: Entity[]; allEvents: Entity[]; todayStr: string }) {
  const feel = useFeel();
  const today = parseLocalDate(todayStr);
  const r = useMemo(() => searchEvents(events, query, today), [events, query, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps
  const offCount = useMemo(() => (allEvents.length === events.length ? 0 : searchEvents(allEvents, query, today, 0).total - r.total), [allEvents, events, query, r.total, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = r.upcoming.reduce((n, g) => n + g.events.length, 0) + r.earlier.reduce((n, g) => n + g.events.length, 0);
  const dayLabel = (date: string) => {
    const d = parseLocalDate(date);
    const label = fmtDayLabel(d);
    return date === todayStr ? `Today, ${label}` : d.getFullYear() === today.getFullYear() ? label : `${label}, ${d.getFullYear()}`;
  };
  const group = (g: DayGroup) => (
    <section key={g.date} className="wk-found-day" aria-label={dayLabel(g.date)}>
      <h4>{dayLabel(g.date)}</h4>
      {g.events.map((e) => (
        <a key={e.id} href={linkFor("event", e.id)} className="wk-found" style={eventColorStyle(e.fields as Record<string, unknown>, feel.calendars)}>
          <span className="when">{e.fields.all_day === true ? "All day" : fmtTime(String(e.fields.start))}</span>
          <span className="what">
            <span className="t">{String(e.fields.title ?? "")}</span>
            {typeof e.fields.location === "string" && e.fields.location && <span className="muted small">{e.fields.location}</span>}
          </span>
        </a>
      ))}
    </section>
  );
  return (
    <div className="wk-search" role="region" aria-label="Search results" aria-live="polite">
      {!r.total && <div className="muted">No events match "{query.trim()}".</div>}
      {r.upcoming.map(group)}
      {r.earlier.length > 0 && <h3 className="wk-earlier">Earlier</h3>}
      {r.earlier.map(group)}
      {r.total > shown && <div className="muted small">{r.total - shown} more. Add a word to narrow it down.</div>}
      {offCount > 0 && <div className="muted small">{offCount} more in calendars that are off.</div>}
    </div>
  );
}

/** Which calendars Week shows: one choice for every device. */
function CalendarsPanel({ groups, hidden, onClose }: { groups: CalendarGroup[]; hidden: string[]; onClose: () => void }) {
  return (
    <section className="card wk-cals" aria-label="Calendars">
      <div className="row between">
        <h3>Calendars</h3>
        <div className="row">
          {hidden.length > 0 && (
            <button className="small ghost" onClick={() => updateFeel({ hidden_calendars: [] })}>
              Show all
            </button>
          )}
          <button className="small ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      {!groups.length && <div className="muted small">No calendars yet. Events brought in from Apple Calendar or iCloud show their calendars here. <a href="#/settings/accounts/add?kind=icloud">Add a calendar account</a></div>}
      {groups.map((g) => (
        <div key={g.account} className="wk-cal-group">
          <h4 className="muted small">{g.account}</h4>
          {g.calendars.map((c) => (
            <label key={c.key} className="toggle-row">
              <input type="checkbox" checked={c.shown} onChange={(e) => updateFeel({ hidden_calendars: withCalendarShown(hidden, c.key, e.target.checked) })} />
              <span className="wk-cal-dot" style={c.color ? ({ "--cal": c.color } as CSSProperties) : undefined} aria-hidden="true" />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="muted small">Unchecked calendars are hidden here in Week, on every device. Today and the assistant still see them.</div>
    </section>
  );
}

const ANSWERS: { answer: OwnerAnswer; label: string }[] = [
  { answer: "accepted", label: INVITE_TEXTS.accept },
  { answer: "tentative", label: INVITE_TEXTS.maybe },
  { answer: "declined", label: INVITE_TEXTS.decline },
];

/**
 * The invitations waiting for an answer, as Calendar's invitations list: each with Accept, Maybe and Decline (the hub
 * answers through where it came from), or a line saying to answer it in the calendar app; answered ones under
 * Answered, folded (CONTRACT.md, Invitations).
 */
function InvitationsPanel({ rows, onClose }: { rows: Entity[]; onClose: () => void }) {
  const { pending, answered } = useMemo(() => invitationList(rows, new Date()), [rows]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  // An answer stays on its row for two seconds, then the row moves to Answered.
  const [held, setHeld] = useState<Record<string, OwnerAnswer>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const [openAnswered, setOpenAnswered] = useState(false);
  const shown = [...pending, ...answered.filter((e) => held[e.id] && !pending.includes(e))];
  const act = async (e: Entity, fn: () => Promise<{ invitation: Entity }>, said?: OwnerAnswer) => {
    if (!engine.client) { setErrs((x) => ({ ...x, [e.id]: INVITE_TEXTS.offline })); return; }
    setBusy(e.id);
    setErrs((x) => ({ ...x, [e.id]: "" }));
    try {
      const out = await fn();
      await engine.absorb([out.invitation]).catch(() => undefined);
      if (said) {
        setHeld((h) => ({ ...h, [e.id]: said }));
        timers.current.push(window.setTimeout(() => setHeld((h) => { const { [e.id]: _gone, ...rest } = h; return rest; }), 2000));
      }
    } catch (err) {
      setErrs((x) => ({ ...x, [e.id]: plainError(err) }));
    } finally {
      setBusy(null);
    }
  };
  const row = (e: Entity, inAnswered: boolean) => {
    const f = e.fields;
    const face = inviteFace(e);
    const who = organizerName(f);
    return (
      <li key={e.id} className="wk-invite">
        <div className="wk-invite-body">
          <strong>{String(f.title ?? "")}</strong>
          {who && <span className="muted small">{who}</span>}
          <span className="small">{inviteWhen(f)}{f.repeats === true ? ", repeats" : ""}</span>
          {typeof f.location === "string" && f.location && <span className="muted small">{f.location}</span>}
        </div>
        {face.elsewhere ? (
          <div className="muted small">{INVITE_TEXTS.inCalendarApp}</div>
        ) : (
          <div className="row wk-invite-actions" role="group" aria-label={`Answer ${String(f.title ?? "")}`}>
            {ANSWERS.map((a) => (
              <button
                key={a.answer}
                className={`small${face.chosen === a.answer ? " primary" : ""}`}
                aria-pressed={face.chosen === a.answer}
                disabled={busy === e.id || face.locked}
                onClick={() => void act(e, () => engine.client!.answerInvitation(e.id, a.answer), a.answer)}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {held[e.id] && !face.reply && <div className="small" role="status">{INVITE_TEXTS.done[held[e.id]]}</div>}
        {face.reply && (
          <div className="row wk-invite-reply" role="status">
            <span className={face.reply.retry ? "error small" : "small"}>{face.reply.text}</span>
            {face.reply.retry && <button className="small" disabled={busy === e.id} onClick={() => void act(e, () => engine.client!.invitationAct(e.id, "retry"))}>{INVITE_TEXTS.retry}</button>}
            {face.reply.undo && <button className="small" disabled={busy === e.id} onClick={() => void act(e, () => engine.client!.invitationAct(e.id, "undo"))}>{INVITE_TEXTS.undo}</button>}
          </div>
        )}
        {inAnswered && face.chosen && <div className="muted small">{INVITE_TEXTS.state[face.chosen]}</div>}
        {errs[e.id] && <div className="error small" role="alert">{errs[e.id]}</div>}
      </li>
    );
  };
  const rest = answered.filter((e) => !held[e.id]);
  return (
    <section className="card wk-invites" aria-label={INVITE_TEXTS.title}>
      <div className="row between">
        <h3>{INVITE_TEXTS.title}</h3>
        <button className="small ghost" onClick={onClose}>
          Done
        </button>
      </div>
      {!shown.length && <div className="muted small">{INVITE_TEXTS.none}</div>}
      {shown.length > 0 && <ul className="wk-invite-list">{shown.map((e) => row(e, false))}</ul>}
      {rest.length > 0 && (
        <>
          <button className="small ghost" aria-expanded={openAnswered} onClick={() => setOpenAnswered((o) => !o)}>
            {INVITE_TEXTS.answered} ({rest.length})
          </button>
          {openAnswered && <ul className="wk-invite-list answered">{rest.map((e) => row(e, true))}</ul>}
        </>
      )}
    </section>
  );
}

export function Week() {
  const route = useRoute();
  const desktop = useMediaQuery("(min-width: 768px)");
  const feel = useFeel();
  const hidden = feel.hidden_calendars;
  const todayStr = useLocalDate();
  const [view, setViewState] = useState<CalendarView>(() => {
    const v = route.params.get("view");
    return isCalendarView(v) ? v : savedView();
  });
  const [anchor, setAnchor] = useState(() => {
    const d = route.params.get("date");
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(parseLocalDate(d).getTime()) ? d : localDate(new Date());
  });
  const [query, setQuery] = useState(() => route.params.get("q") ?? "");
  const [showCalendars, setShowCalendars] = useState(() => route.params.get("calendars") === "1");
  // Invitations (CONTRACT.md, Invitations): the button shows while one waits or was answered in the last 7 days.
  const inviteRows = useEntities("invitation");
  const invites = useMemo(() => invitationList(inviteRows, new Date()), [inviteRows]);
  const askedInvites = route.params.get("invitations") === "1";
  const [showInvites, setShowInvites] = useState(askedInvites);
  useEffect(() => { if (askedInvites) setShowInvites(true); }, [askedInvites]);
  const anchorDate = parseLocalDate(anchor);
  const start = localDate(mondayOf(anchorDate));
  const poll = useHubPoll<PlannerWeek>((c) => c.plannerWeek(start), () => localWeek(start), [start]);
  const [picker, setPicker] = useState<{ start: string; hours: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; retry: Pending | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const unscheduled = useEntities("task", (e) => e.fields.status === "next" && !e.fields.block)
    .slice()
    .sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  const allEvents = useEntities("event");
  const shownEvents = useMemo(() => (hidden.length ? allEvents.filter((e) => calendarShown(e.fields, hidden)) : allEvents), [allEvents, hidden]);
  // The week from the hub, without the events of calendars that are off.
  const week = useMemo(() => {
    const w = poll.data;
    if (!w || !hidden.length) return w;
    return { ...w, days: w.days.map((d) => ({ ...d, events: d.events.filter((e) => calendarShown(e.fields, hidden)) })) };
  }, [poll.data, hidden]);
  const groups = useMemo(() => {
    const keys = new Set(allEvents.map((e) => calendarKeyOf(e.fields)));
    for (const d of poll.data?.days ?? []) for (const e of d.events) keys.add(calendarKeyOf(e.fields));
    return calendarGroups(feel.calendars, keys, hidden);
  }, [allEvents, poll.data, feel.calendars, hidden]);

  const setView = (v: CalendarView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode: the view is not kept */
    }
  };

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
        setMsg({ text: c ?? plainError(e), retry: c ? { taskId, start: startIso, hours } : null });
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
        setMsg({ text: plainError(e), retry: null });
      }
    },
    [poll],
  );

  const shift = (n: number) => setAnchor(localDate(shiftAnchor(view, anchorDate, n)));
  const word = periodWord(view);
  const day = week?.days.find((d) => d.date === anchor);
  const dayIdx = week?.days.findIndex((d) => d.date === anchor) ?? -1;
  const phoneItems = useMemo(() => (day ? timeline({ ...day, reminders: day.reminders }, day.date === todayStr ? new Date() : null) : []), [day, todayStr]);
  const searching = query.trim().length > 0;
  const planned = view === "day" || view === "week";

  return (
    <div className={`week ${desktop ? "desktop" : "phone"}`}>
      <div className="wk-bar">
        <div className="seg wk-views" role="tablist" aria-label="View">
          {CALENDAR_VIEWS.map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {VIEW_NAMES[v]}
            </button>
          ))}
        </div>
        <div className="row wk-tools">
          <input type="search" className="wk-find" placeholder="Search events" aria-label="Search events" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {(invites.pending.length > 0 || invites.answered.length > 0 || showInvites) && (
            <button
              className={`small${showInvites ? " on" : ""}`}
              aria-expanded={showInvites}
              aria-label={invites.count ? `${INVITE_TEXTS.title}, ${invites.count} waiting` : INVITE_TEXTS.title}
              onClick={() => setShowInvites((s) => !s)}
            >
              {INVITE_TEXTS.title}
              {invites.count > 0 && <span className="badge wk-invite-badge" aria-hidden="true">{invites.count}</span>}
            </button>
          )}
          <button className={`small${showCalendars ? " on" : ""}`} aria-expanded={showCalendars} onClick={() => setShowCalendars((s) => !s)}>
            Calendars{hidden.length ? `, ${groups.flatMap((g) => g.calendars).filter((c) => !c.shown).length} off` : ""}
          </button>
        </div>
      </div>
      {/* A calendar account that stopped signing in or syncing: its events here stop changing, so Week says so. */}
      {problemsFor(poll.data?.connection_problems, "calendar").map((p) => (
        <div key={p.id} className="week-sync-problem" role="status">
          <span className="grow"><strong>{p.title}.</strong> {p.detail}</span>
          <button className="small primary" onClick={() => go(fixPath(p))}>{p.button}</button>
        </div>
      ))}
      {showInvites && <InvitationsPanel rows={inviteRows} onClose={() => { setShowInvites(false); if (askedInvites) go("/week"); }} />}
      {showCalendars && <CalendarsPanel groups={groups} hidden={hidden} onClose={() => setShowCalendars(false)} />}
      {searching ? (
        <SearchResults query={query} events={shownEvents} allEvents={allEvents} todayStr={todayStr} />
      ) : (
        <>
          <div className="row between wk-nav">
            <div className="row">
              <button className="small" onClick={() => shift(-1)} aria-label={`Previous ${word}`}>
                &lt;
              </button>
              <strong className="wk-title">{periodTitle(view, anchorDate, parseLocalDate(todayStr))}</strong>
              <button className="small" onClick={() => shift(1)} aria-label={`Next ${word}`}>
                &gt;
              </button>
              <button className="small ghost" onClick={() => setAnchor(todayStr)} disabled={anchor === todayStr}>
                Today
              </button>
            </div>
            {planned && (
              <div className="row">
                <span className="muted small">
                  {poll.source === "local" ? unreachableLine(engine.state.syncedAt) : poll.at ? `checked ${relative(poll.at.toISOString())}` : ""}
                  {poll.busy ? ", loading" : ""}
                </span>
                <a href="#/plan-rules" className="small">
                  Rules
                </a>
              </div>
            )}
          </div>
          {planned && !week && poll.error && <div className={poll.unavailable ? "muted small" : "error"}>{poll.unavailable ? "The planner is not available on this hub." : poll.error}</div>}
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
          {view === "week" && week && desktop && (
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
          {view === "day" && week && desktop && day && (
            <WeekGrid week={{ start: week.start, days: [day] }} onDrop={(id, s, h) => void schedule(id, s, h)} onPlus={(s, h) => setPicker({ start: s, hours: h })} onUnschedule={(id) => void unschedule(id)} />
          )}
          {planned && week && !desktop && (
            <>
              {view === "week" && (
                <div className="wk-days" role="tablist" aria-label="Day">
                  {week.days.map((d, i) => {
                    const date = parseLocalDate(d.date);
                    return (
                      <button key={d.date} role="tab" aria-selected={i === dayIdx} className={`chip ${i === dayIdx ? "on" : ""} ${d.date === todayStr ? "today" : ""}`} onClick={() => setAnchor(d.date)}>
                        {DAY_SHORT[i]} {date.getDate()}
                      </button>
                    );
                  })}
                </div>
              )}
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
          {view === "month" && (
            <MonthView
              year={anchorDate.getFullYear()}
              month={anchorDate.getMonth()}
              events={shownEvents}
              todayStr={todayStr}
              wide={desktop}
              onOpenDay={(d) => {
                setAnchor(d);
                setView("day");
              }}
            />
          )}
          {view === "year" && (
            <YearView
              year={anchorDate.getFullYear()}
              todayStr={todayStr}
              onOpenMonth={(m) => {
                const y = anchorDate.getFullYear();
                setAnchor(todayStr.startsWith(`${y}-${String(m + 1).padStart(2, "0")}`) ? todayStr : localDate(new Date(y, m, 1)));
                setView("month");
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
