import { plainError } from "../lib/errors";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { datePhrase, datesSoon, peopleInPlans, plansToday, startedTask, taskInLists, todayCards, todayShowsTop, todayTodoLists, type Entity } from "@everythingapp/shared";
import { useHubPoll } from "../sync/useHubPoll";
import { usePoll } from "../lib/usePoll";
import { localToday, scheduleTask, unscheduleTask, conflictMessage, renewWatch } from "../sync/planner";
import { useEntities } from "../sync/hooks";
import { db } from "../sync/db";
import { timeline, parseLocalDate, daySpan, overlaps, spanOf, fmtDue, wholeDay, type PlannerToday, type TimelineItem } from "../lib/planner";
import { fmtTime, relative } from "../lib/time";
import { StartedCard } from "../components/StartedCard";
import { useModules } from "../lib/modules";
import { Timeline } from "../components/Timeline";
import { TaskPicker } from "../components/TaskPicker";
import { createEntity, updateEntity } from "../sync/edits";
import { SOURCE, ackReminder, completeTask, snoozeFor } from "../sync/actions";
import { DIARY_DAY_START, diaryToday, followUpsDue, regularMeds } from "../lib/today";
import { freeLine, needsYou, nowLine, nowWords, openTasks, soFar, todayColumns, todayNumbers, tomorrowLines, type Need, type TodaySection } from "../lib/todayBoard";
import { dueReminders, hasReminder } from "../lib/reminders";
import { TONE_DOT, lookTone, needsALook, techLight, watchedLine, type Look, type Tone } from "../lib/tech";
import type { OpsData } from "../lib/ops";
import type { SensorRow } from "../sync/api";
import { AckControl, ProposeFix } from "./Ops";
import { useLocalDate } from "../lib/useLocalDate";
import { useFeel } from "../feel/store";
import { TODAY_TEXT } from "./settings/TodayParts";
import { useSourceLists } from "../lib/sources";

/** How many rows a card shows before it links to the rest. */
const TODO_SHOWN = 6;
const SOFAR_SHOWN = 10;

/** The time now, read again every half minute and when the window shows: the Next line counts minutes. */
function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = setInterval(tick, everyMs);
    const onShow = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onShow); };
  }, [everyMs]);
  return now;
}

/** An element's own width, kept current as the window is resized; measured before the first paint. */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The day as a status board, in the order its owner asked every report to take: at the top the Next line (the task
 * you started, else what is on now and how long it has left); then Tech's light as one folded line and what needs you (actions only, numbered, each with its
 * button), the schedule (what is left), things to do, today so far (what is done and was said), and what is coming
 * that needs nothing from you. One column on a phone, up to five across a wide window (lib/todayBoard.ts). That is the
 * default: Theme, Today (`today` in the feel setting, one for every device) hides parts and puts the cards in another
 * order, which fills the columns; Edit Today at the bottom opens it.
 *
 * The day is drawn once, as the Schedule card's list: a strip of it across the top said the same again
 * (gnomecannon/aeneas#15). Capturing is the Capture screen's, one press away on every screen; a box for it here said
 * that again (gnomecannon/aeneas#21). A charge on autopay pays itself, so Today does not list it (#14).
 * The plan is GET /planner/today, refreshed every 60 s while visible and on change events; the local copy supplies
 * the same shape when the hub is unreachable.
 */
export function Today() {
  const poll = useHubPoll<PlannerToday>((c) => c.plannerToday(), localToday, []);
  const { on } = useModules();
  const setting = useFeel().today;
  const t = poll.data;
  const now = useNow();
  // What today holds is worked out again when the day changes with the screen open, not only when the items do:
  // yesterday's meds showed as taken after midnight. The diary's day starts at 4 AM.
  const today = useLocalDate();
  const diaryDay = useLocalDate(DIARY_DAY_START);
  const events = useEntities("event");
  const apps = useEntities("application", (e) => !!e.fields.next_at);
  const allTasks = useEntities("task");
  // Logs of the last nine days: today's numbers and words, and which meds are regular.
  const logs = useEntities("log", (e) => Date.parse(String(e.fields.at ?? "")) > Date.now() - 9 * 86_400_000, [today]);
  const people = useEntities("person");
  const facts = useEntities("fact", (e) => !!e.fields.person_id || !!e.fields.person);
  const diaryNotes = useEntities("note", (e) => String(e.fields.path ?? "").startsWith("Diary/"));
  const diary = useMemo(() => diaryToday(diaryNotes, new Date()), [diaryNotes, diaryDay]);
  const followUps = useMemo(() => (on("jobs") ? followUpsDue(apps, new Date()) : []), [apps, today, on]);
  const dates = useMemo(() => datesSoon(people, new Date(), 14), [people, today]);
  const meds = useMemo(() => (on("health") ? regularMeds(logs, new Date()) : []), [logs, today, on]);

  // Tech: the same list and light as the Overview's, so the two never disagree. Its card is folded each time Today
  // opens: the state is the screen's own, never saved.
  const techOn = on("homelab"), sensorsOn = on("sensors");
  const ops = usePoll<OpsData | null>((c) => (techOn ? c.ops() : Promise.resolve(null)), 60_000);
  const sens = usePoll<SensorRow[]>((c) => (sensorsOn ? c.sensors() : Promise.resolve([])), 60_000);
  const looks = useMemo(
    () => needsALook(ops.data?.things ?? [], ops.data?.monitors ?? [], ops.data?.incidents_open ?? [], sens.data ?? [], ops.data?.hub_backup ?? []),
    [ops.data, sens.data],
  );
  const light = (techOn && ops.data) || (sensorsOn && sens.data) ? techLight(looks, ops.data?.things ?? [], ops.data?.monitors ?? [], sens.data ?? []) : null;
  const watched = watchedLine(ops.data?.things ?? [], ops.data?.monitors ?? [], sens.data ?? []);
  const [techOpen, setTechOpen] = useState(false);

  const [slot, setSlot] = useState<{ start: string; hours: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [force, setForce] = useState<{ taskId: string; start: string; hours: number } | null>(null);
  const [rowErr, setRowErr] = useState<{ key: string; text: string } | null>(null);

  const todayEvents = useMemo(() => (t ? events.filter((e) => overlaps(spanOf(e), daySpan(parseLocalDate(t.date)))) : []), [t, events]);
  const items = useMemo(
    () => (t ? timeline({ blocks: t.blocks, commitments: t.commitments, events: todayEvents, reminders: t.reminders_due, free_slots: t.free_slots }, now) : []),
    [t, todayEvents, now],
  );
  const seeing = useMemo(() => {
    if (!t || !people.length) return [];
    return peopleInPlans(people, facts, plansToday(todayEvents, t.reminders_due, allTasks.filter((x) => x.fields.status === "doing" || !!x.fields.due), new Date()));
  }, [t, people, facts, todayEvents, allTasks]);

  const due = useMemo(() => dueReminders(allTasks.filter(hasReminder), now), [allTasks, now]);
  const needs = useMemo(
    () => needsYou({ reminders: due, watches: on("renewals") ? t?.watches_due_soon ?? [] : [], followUps, meds, unsorted: t?.captures_unprocessed ?? 0, now }),
    [due, t, followUps, meds, now, on],
  );
  // To do holds the tasks of the lists chosen for it (Theme, Today, Lists in To do), or of every list.
  const sourceLists = useSourceLists();
  const todoLists = todayTodoLists(setting);
  const todoKey = todoLists?.join("\n") ?? null;
  const inTodo = useMemo(() => (todoLists ? taskInLists(todoLists, sourceLists) : null), [todoKey, sourceLists]);
  const onlyTodo = useCallback((e: Entity) => !inTodo || inTodo(e.fields), [inTodo]);
  const todoTasks = useMemo(() => (inTodo ? allTasks.filter(onlyTodo) : allTasks), [allTasks, inTodo, onlyTodo]);
  const open = useMemo(() => openTasks(todoTasks), [todoTasks]);
  // The task you started, among To do's lists, gets the card with its buttons; never the first task in Next.
  const current = useMemo(() => startedTask(todoTasks), [todoTasks]);
  const rest = open.filter((x) => x.id !== current?.id);
  // The line at the top follows the task you started whatever its list.
  const started = useMemo(() => startedTask(allTasks), [allTasks]);
  const done = useMemo(() => soFar({ diary, tasks: allTasks, logs, now }), [diary, allTasks, logs, now]);
  const numbers = useMemo(() => (on("health") ? todayNumbers(logs, now) : []), [logs, now, on]);
  const tomorrow = useMemo(() => tomorrowLines(events, now), [events, now]);
  const line = useMemo(() => nowWords(nowLine(items, now, started), null), [items, now, started]);
  const free = useMemo(() => freeLine(items, now), [items, now]);
  const allDay = todayEvents.filter((e) => e.fields.all_day === true);
  // A rule for the whole day (a custody week) is named with them: it has no time to stand at in the list.
  const dayRules = items.filter((it): it is Extract<TimelineItem, { kind: "commitment" }> => it.kind === "commitment" && wholeDay(it));
  const left = items.filter((it) => (it.kind === "event" && !it.all_day) || it.kind === "block" || it.kind === "reminder").filter((it) => Date.parse("end" in it ? it.end : it.start) > now.getTime()).length;

  const schedule = async (taskId: string, start: string, hours: number, forced = false) => {
    setBusy(true);
    setErr(null);
    try {
      await scheduleTask(taskId, start, hours, forced);
      setSlot(null);
      setForce(null);
      await poll.reload();
    } catch (e) {
      const c = conflictMessage(e);
      setErr(c ?? (plainError(e)));
      if (c) setForce({ taskId, start, hours });
    } finally {
      setBusy(false);
    }
  };

  const unschedule = useCallback(
    async (taskId: string) => {
      const task = await db.entities.get(taskId);
      if (!task) return;
      await unscheduleTask(task);
      await poll.reload();
    },
    [poll],
  );

  const closePicker = useCallback(() => {
    setSlot(null);
    setErr(null);
    setForce(null);
  }, []);

  /** Runs a row's button; what goes wrong is said under that row. */
  const act = (key: string, fn: () => Promise<unknown>) => {
    setRowErr(null);
    void fn().then(() => poll.reload()).catch((e) => setRowErr({ key, text: plainError(e) }));
  };

  const needActions = (n: Need): ReactNode => {
    switch (n.kind) {
      case "reminder":
        return (
          <>
            <button className="small primary" onClick={() => act(n.key, () => ackReminder(n.reminder.entity))} aria-label={`Done: ${n.title}`}>Done</button>
            <button className="small" onClick={() => act(n.key, () => snoozeFor(n.reminder.entity, 10))} aria-label={`Snooze ${n.title} for 10 minutes`}>10 min</button>
            <button className="small" onClick={() => act(n.key, () => snoozeFor(n.reminder.entity, 60))} aria-label={`Snooze ${n.title} for 1 hour`}>1 h</button>
            <a className="small" href={`#/tasks?focus=${n.reminder.entity.id}`}>Open</a>
          </>
        );
      case "renewal":
        return (
          <>
            <button className="small primary" onClick={() => act(n.key, () => renewWatch(n.watch))} aria-label={`Mark ${String(n.watch.fields.title)} renewed`}>Renewed</button>
            <a className="small" href={`#/renewals?focus=${n.watch.id}`}>Open</a>
          </>
        );
      case "followup":
        return <a className="small" href={`#/lists/jobs/${n.app.id}`}>Open</a>;
      case "med":
        return (
          <button className="small primary" onClick={() => act(n.key, () => createEntity("log", { type: "med", value: n.med, at: new Date().toISOString(), source: SOURCE }))} title={`Log ${n.med} as taken now`}>
            Took {n.med}
          </button>
        );
      case "unsorted":
        return <a className="small" href="#/inbox">Sort them</a>;
    }
  };

  const sections: Record<TodaySection, ReactNode> = {
    // Tech is one line until pressed, at the top of the card after it (lib/todayBoard.ts `todaySlots`).
    tech: light && (
      <TechCard light={light} looks={looks} watched={watched} open={techOpen} onToggle={() => setTechOpen((o) => !o)} onChanged={async () => { await ops.reload(); }} />
    ),
    needs: (
      <section className={`card tcard needs${needs.length ? " has" : ""}`} aria-label="Needs you">
        <h2>Needs you {needs.length > 0 && <span className="count" aria-label={`${needs.length} waiting`}>{needs.length}</span>}</h2>
        {needs.length === 0 ? (
          <p className="today-clear"><span className="dot up" aria-hidden="true" /> Nothing needs you right now.</p>
        ) : (
          <ol className="need-list">
            {needs.map((n, i) => (
              <li key={n.key} className={`need ${n.kind}${(n.kind === "renewal" && n.overdue) || (n.kind === "followup" && n.late) ? " late" : ""}`}>
                <span className="num" aria-hidden="true">{i + 1}</span>
                <div className="need-body">
                  <div className="need-title">{n.title}</div>
                  {n.detail && <div className="need-detail">{n.detail}</div>}
                  <div className="need-actions">{needActions(n)}</div>
                  {rowErr?.key === n.key && <div className="error" role="alert">{rowErr.text}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    ),
    schedule: (
      <section className="card tcard schedule" aria-label="Schedule">
        <h2>Schedule {left > 0 && <span className="count quiet">{left} left</span>}</h2>
        {(allDay.length > 0 || dayRules.length > 0) && (
          <ul className="allday">
            {allDay.map((e) => <li key={e.id}><span className="muted small">All day</span> {String(e.fields.title ?? "")}</li>)}
            {dayRules.map((c) => <li key={c.key}><span className="muted small">All day</span> {c.title} <span className="muted small">{c.type}</span></li>)}
          </ul>
        )}
        {slot && (
          <TaskPicker title={`Schedule at ${fmtTime(slot.start)}, 3 h`} onPick={(task) => void schedule(task.id, slot.start, slot.hours)} onClose={closePicker} busy={busy} error={err} />
        )}
        {force && slot && (
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="small" onClick={() => void schedule(force.taskId, force.start, force.hours, true)} disabled={busy}>Schedule anyway</button>
          </div>
        )}
        {/* All-day plans are named above. Free time that has ended is not offered (a plan answered this morning still lists it). */}
        {t && <Timeline items={items.filter((it) => !(it.kind === "event" && it.all_day) && !(it.kind === "commitment" && wholeDay(it)) && !(it.kind === "free" && Date.parse(it.end) <= now.getTime()))} onSchedule={(start, hours) => setSlot({ start, hours })} onUnschedule={unschedule} />}
        {seeing.length > 0 && (
          <div className="people-today" aria-label="People in today's plans">
            <h3>People today</h3>
            {seeing.map((p) => (
              <a key={p.id} href={`#/people/${p.id}`} className="person-today">
                <span>
                  <strong>{p.name}</strong> <span className="muted small">{p.plans.map((x) => `${x.title}${x.at ? `, ${fmtTime(x.at)}` : ""}`).join("; ")}</span>
                </span>
                {p.notes.map((note) => <span key={note} className="small">{note}</span>)}
              </a>
            ))}
          </div>
        )}
      </section>
    ),
    todo: (
      <section className="card tcard todo" aria-label="To do">
        <h2>To do {open.length > 0 && <span className="count quiet">{open.length} open</span>}</h2>
        {current && <StartedCard task={current} />}
        {rest.length > 0 && (
          <ul className="todo-list">
            {rest.slice(0, TODO_SHOWN).map((task) => {
              const title = String(task.fields.title ?? "");
              return (
                <li key={task.id} className="todo-row">
                  <button type="button" className="todo-check" aria-label={`Done: ${title}`} title="Done" onClick={() => act(`todo:${task.id}`, () => completeTask(task))} />
                  <a href={`#/tasks?focus=${task.id}`} className="todo-title">
                    {title}
                    {typeof task.fields.due === "string" && task.fields.due && <span className="muted small"> due {fmtDue(task.fields.due)}</span>}
                  </a>
                  <button type="button" className="small ghost" aria-label={`Start ${title}`} title="Make this the thing you are doing now" onClick={() => act(`todo:${task.id}`, () => updateEntity(task, { status: "doing" }))}>Start</button>
                </li>
              );
            })}
          </ul>
        )}
        {open.length === 0 && (todoLists?.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>{TODAY_TEXT.noneChosen} <a href="#/settings/theme/today">{TODAY_TEXT.edit}</a></p>
        ) : (
          <p className="today-clear"><span className="dot up" aria-hidden="true" /> No open tasks.</p>
        ))}
        {rest.length > TODO_SHOWN && <a href="#/tasks" className="small more">All {open.length} in Tasks</a>}
        {rowErr?.key.startsWith("todo:") && <div className="error" role="alert">{rowErr.text}</div>}
      </section>
    ),
    sofar: (
      <section className="card tcard sofar" aria-label="Today so far">
        <h2>Today so far {done.length > 0 && <span className="count quiet">{done.length}</span>}</h2>
        {numbers.length > 0 && (
          <dl className="today-numbers" aria-label="Logged today">
            {numbers.map((n) => <div key={n.type}><dt>{n.label}</dt><dd>{n.value}</dd></div>)}
          </dl>
        )}
        {done.length > 0 ? (
          <ol className="sofar-list">
            {done.slice(-SOFAR_SHOWN).map((r) => (
              <li key={r.key} className={`sofar-row ${r.kind}`}>
                {/* "Yesterday" above the time for a line from before midnight, so the column keeps its width. */}
                <span className="time">{r.day && <span className="day">{r.day} </span>}{r.clock}</span>
                <span className="text">{r.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>Nothing recorded yet today.</p>
        )}
        {diary && (done.length > SOFAR_SHOWN || diary.lines.length > 0) && (
          <a href={`#/notes/${diary.id}`} className="small more">{done.length > SOFAR_SHOWN ? `All ${done.length}: open today's diary` : "Open today's diary"}</a>
        )}
      </section>
    ),
    coming: (
      <section className="card tcard coming" aria-label="Coming up">
        <h2>Coming up</h2>
        {tomorrow.lines.length > 0 && (
          <>
            <h3>Tomorrow</h3>
            <ul className="coming-list">
              {tomorrow.lines.map((l) => <li key={l.key}><span className="when">{l.time}</span><span className="what">{l.title}</span></li>)}
              {tomorrow.more > 0 && <li><span className="when" /><a href="#/week" className="small">{tomorrow.more} more</a></li>}
            </ul>
          </>
        )}
        {dates.length > 0 && (
          <>
            <h3>Dates</h3>
            <ul className="coming-list">
              {dates.slice(0, 5).map((d) => <li key={`${d.id}:${d.label}:${d.date}`}><a href={`#/people/${d.id}`} className="what">{datePhrase(d)}</a></li>)}
            </ul>
          </>
        )}
        {tomorrow.lines.length === 0 && dates.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nothing coming up in the next two weeks.</p>}
      </section>
    ),
  };

  const [wrap, width] = useWidth<HTMLDivElement>();
  // The cards the setting shows, in its order; Tech only while it has something to show.
  const cards = todayCards(setting).filter((c) => c !== "tech" || !!light);
  const columns = todayColumns(width, cards);
  const dateWords = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="today" ref={wrap}>
      <header className="today-head">
        <div className="today-title">
          <h1>Today</h1>
          <span className="today-date">{dateWords}</span>
        </div>
        <div className="today-meta">
          <span className="muted small">
            {poll.source === "local" ? "local copy, hub unreachable" : poll.at ? `checked ${relative(poll.at.toISOString())}` : ""}
            {poll.busy ? ", loading" : ""}
          </span>
        </div>
      </header>
      {!t && poll.error && <div className={poll.unavailable ? "muted small" : "error"}>{poll.unavailable ? "The planner is not available on this hub." : poll.error}</div>}
      {t && todayShowsTop(setting) && (
        <>
          {/* The Next line (packages/shared nextLine.ts): the same words as the widgets, the Watch and the menu bar. */}
          <p className="today-now" role="status" aria-label={line.text}>
            {line.lead}<strong>{line.title}</strong>{line.when && ` ${line.when}`}{line.aside && <span className="aside">{line.aside}</span>}
          </p>
          {free && <p className="today-free">{free}</p>}
        </>
      )}
      {cards.length === 0 ? (
        <p className="today-none muted">{TODAY_TEXT.none} <a href="#/settings/theme/today">{TODAY_TEXT.edit}</a></p>
      ) : (
        <>
          <div className="today-cols" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
            {columns.map((col, i) => (
              <div key={i} className="today-col">
                {col.map((s) => <Fragment key={s}>{sections[s]}</Fragment>)}
              </div>
            ))}
          </div>
          <a className="small today-edit" href="#/settings/theme/today">{TODAY_TEXT.edit}</a>
        </>
      )}
    </div>
  );
}

/**
 * Tech on Today: one line with a dot in the light's color (green, yellow, red or grey), "Tech" and what the light
 * says. A press on the line opens it: what needs a look, each with Propose a fix, Acknowledge and Open as Needs you
 * had them, then the acknowledged ones, then Open Tech and what is watched.
 */
function TechCard({ light, looks, watched, open, onToggle, onChanged }: {
  light: { tone: Tone; label: string; detail: string };
  looks: Look[];
  watched: string;
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <section className={`card tcard tech tone-${light.tone}`} aria-label="Tech">
      <h2>
        <button type="button" className="tech-line" aria-expanded={open} aria-controls={open ? "today-tech" : undefined} aria-label={`Tech, ${light.label}`} title={light.detail || undefined} onClick={onToggle}>
          <span className={`dot ${TONE_DOT[light.tone]}`} aria-hidden="true" />
          <span>Tech</span>
          <span className="tech-label">{light.label}</span>
          <span className="chev" aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id="today-tech">
          {looks.length > 0 && (
            <ul className="tech-looks">
              {/* needsALook lists the ones not yet acknowledged first. */}
              {looks.map((l) => (
                <li key={l.key} className={`tech-look${l.acknowledged ? " acked" : ""}`}>
                  <span className={`dot ${TONE_DOT[lookTone(l)]}`} aria-hidden="true" />
                  <div className="need-body">
                    <div className="need-title">{l.title}</div>
                    {l.detail && <div className="need-detail">{l.detail}</div>}
                    {/* Acknowledged: when, and the note; the buttons that settle it are for the ones not acknowledged. */}
                    {l.acknowledged && l.incident && <AckControl inc={l.incident} onChanged={onChanged} />}
                    <div className="need-actions">
                      {!l.acknowledged && (l.monitorId || l.sensor) && <ProposeFix monitorId={l.monitorId} sensor={l.sensor} />}
                      {!l.acknowledged && l.incident && <AckControl inc={l.incident} onChanged={onChanged} />}
                      <a className="small" href={l.thing ? `#/hosts/${encodeURIComponent(l.thing)}` : "#/ops"}>Open</a>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="tech-foot">
            <a href="#/ops" className="small">Open Tech</a>
            {watched && <span className="muted small">{watched}</span>}
          </p>
        </div>
      )}
    </section>
  );
}
