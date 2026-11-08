import { useCallback, useMemo, useState } from "react";
import { useHubPoll } from "../sync/useHubPoll";
import { localToday, scheduleTask, unscheduleTask, conflictMessage } from "../sync/planner";
import { useEntities } from "../sync/hooks";
import { db } from "../sync/db";
import { daysLeft, fmtDaysLeft, timeline, parseLocalDate, daySpan, overlaps, spanOf, type PlannerToday } from "../lib/planner";
import { fmtTime, relative } from "../lib/time";
import { NowCard } from "./Now";
import { useModules } from "../lib/modules";
import { Timeline } from "../components/Timeline";
import { TaskPicker } from "../components/TaskPicker";
import { createEntity } from "../sync/edits";
import { SOURCE } from "../sync/actions";
import { diaryToday, followUpsDue, regularMeds } from "../lib/today";
import { datePhrase, datesSoon, peopleInPlans, plansToday } from "@everythingapp/shared";

/**
 * The day on one screen: the digest as plain lines, the Now card, then the timeline with the current
 * time marker, reminders at their times, a short renewals strip and free slots with Schedule here.
 * From GET /planner/today, refreshed every 60 s while visible and on change events; the local copy
 * supplies the same shape when the hub is unreachable.
 */
export function Today() {
  const poll = useHubPoll<PlannerToday>((c) => c.plannerToday(), localToday, []);
  const { on } = useModules();
  const t = poll.data;
  const events = useEntities("event");
  const apps = useEntities("application", (e) => !!e.fields.next_at);
  const medLogs = useEntities("log", (e) => e.fields.type === "med");
  const followUps = useMemo(() => followUpsDue(apps, new Date()), [apps]);
  const people = useEntities("person");
  const facts = useEntities("fact", (e) => !!e.fields.person_id || !!e.fields.person);
  const tasks = useEntities("task", (e) => e.fields.status === "doing" || !!e.fields.due);
  const dates = useMemo(() => datesSoon(people, new Date(), 14), [people]);
  const diaryNotes = useEntities("note", (e) => String(e.fields.path ?? "").startsWith("Diary/"));
  const diary = useMemo(() => diaryToday(diaryNotes, new Date()), [diaryNotes]);
  const meds = useMemo(() => regularMeds(medLogs, new Date()), [medLogs]);
  const [slot, setSlot] = useState<{ start: string; hours: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [force, setForce] = useState<{ taskId: string; start: string; hours: number } | null>(null);

  const items = useMemo(() => {
    if (!t) return [];
    const date = parseLocalDate(t.date);
    const d = daySpan(date);
    const todayEvents = events.filter((e) => overlaps(spanOf(e), d));
    return timeline({ blocks: t.blocks, commitments: t.commitments, events: todayEvents, reminders: t.reminders_due, free_slots: t.free_slots }, new Date());
  }, [t, events]);

  const seeing = useMemo(() => {
    if (!t || !people.length) return [];
    const now = new Date();
    const todayEvents = events.filter((e) => overlaps(spanOf(e), daySpan(parseLocalDate(t.date))));
    return peopleInPlans(people, facts, plansToday(todayEvents, t.reminders_due, tasks, now));
  }, [t, people, facts, events, tasks]);

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
      setErr(c ?? (e instanceof Error ? e.message : String(e)));
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

  return (
    <div className="today">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Today</h1>
        <span className="muted small">
          {poll.source === "local" ? "local copy, hub unreachable" : poll.at ? `checked ${relative(poll.at.toISOString())}` : ""}
          {poll.busy ? ", loading" : ""}
        </span>
      </div>
      {!t && poll.error && <div className={poll.unavailable ? "muted small" : "error"}>{poll.unavailable ? "The planner is not available on this hub." : poll.error}</div>}
      {t && digestBody(t.digest) && (
        <pre className="digest" aria-label="Digest">
          {digestBody(t.digest)}
        </pre>
      )}
      <NowCard showNext={false} />
      {on("renewals") && t && t.watches_due_soon.length > 0 && (
        <div className="strip" aria-label="Renewals due soon">
          <span className="muted">Renewals</span>
          {t.watches_due_soon.slice(0, 3).map((w) => {
            const d = daysLeft(String(w.fields.due));
            return (
              <a key={w.id} href={`#/renewals?focus=${w.id}`} className={d < 0 ? "error" : ""}>
                {String(w.fields.title)} {w.fields.autopay === true ? `autopay ${fmtDaysLeft(d)}` : fmtDaysLeft(d)}
              </a>
            );
          })}
          <a href="#/renewals" className="small" style={{ marginLeft: "auto" }}>
            all
          </a>
        </div>
      )}
      {seeing.length > 0 && (
        <div className="card people-today" aria-label="People in today's plans">
          <span className="muted">People today</span>
          {seeing.map((p) => (
            <a key={p.id} href={`#/people/${p.id}`} className="person-today">
              <span>
                <strong>{p.name}</strong> <span className="muted small">{p.plans.map((x) => `${x.title}${x.at ? `, ${fmtTime(x.at)}` : ""}`).join("; ")}</span>
              </span>
              {p.notes.map((n) => (
                <span key={n} className="small">{n}</span>
              ))}
            </a>
          ))}
        </div>
      )}
      {dates.length > 0 && (
        <div className="strip" aria-label="Dates coming up">
          <span className="muted">Dates</span>
          {dates.slice(0, 5).map((d) => (
            <a key={`${d.id}:${d.label}:${d.date}`} href={`#/people/${d.id}`} className={d.days === 0 ? "primary" : ""}>{datePhrase(d)}</a>
          ))}
        </div>
      )}
      {on("health") && meds.length > 0 && (
        <div className="strip" aria-label="Meds today">
          <span className="muted">Meds</span>
          {meds.map((m) =>
            m.takenAt ? (
              <span key={m.name} className="muted">
                {m.name} {fmtTime(m.takenAt)}
              </span>
            ) : (
              <button key={m.name} type="button" className="small" onClick={() => void createEntity("log", { type: "med", value: m.name, at: new Date().toISOString(), source: SOURCE })} title={`Log ${m.name} as taken now`}>
                Took {m.name}
              </button>
            ),
          )}
        </div>
      )}
      {on("jobs") && followUps.length > 0 && (
        <div className="strip" aria-label="Job follow-ups due">
          <span className="muted">Follow up</span>
          {followUps.slice(0, 3).map((a) => {
            const late = Date.parse(String(a.fields.next_at)) < Date.now();
            return (
              <a key={a.id} href={`#/lists/jobs/${a.id}`} className={late ? "error" : ""}>
                {String(a.fields.company)}
                {a.fields.next_step ? `: ${String(a.fields.next_step)}` : ""}
              </a>
            );
          })}
          {followUps.length > 3 && (
            <a href="#/lists/jobs" className="small" style={{ marginLeft: "auto" }}>
              all {followUps.length}
            </a>
          )}
        </div>
      )}
      {slot && (
        <TaskPicker
          title={`Schedule at ${fmtTime(slot.start)}, 3 h`}
          onPick={(task) => void schedule(task.id, slot.start, slot.hours)}
          onClose={closePicker}
          busy={busy}
          error={err}
        />
      )}
      {force && slot && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="small" onClick={() => void schedule(force.taskId, force.start, force.hours, true)} disabled={busy}>
            Schedule anyway
          </button>
        </div>
      )}
      {t && (
        <>
          <h3 style={{ marginTop: 4 }}>Timeline</h3>
          <Timeline items={items} onSchedule={(start, hours) => setSlot({ start, hours })} onUnschedule={unschedule} />
        </>
      )}
      {diary && diary.lines.length > 0 && (
        <section aria-label="Today so far" style={{ marginTop: 12 }}>
          <div className="row between">
            <h3 style={{ margin: 0 }}>Today so far</h3>
            <a href={`#/notes/${diary.id}`} className="small">{diary.lines.length > 6 ? `all ${diary.lines.length}` : "open"}</a>
          </div>
          <div className="list">
            {diary.lines.slice(-6).map((l, i) => (
              <div key={i} className="item">
                <div className="body"><span className="muted" style={{ fontVariantNumeric: "tabular-nums", marginRight: 10 }}>{l.time}</span>{l.text}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      {t && t.captures_unprocessed > 0 && (
        <div className="strip" style={{ marginTop: 12 }}>
          <a href="#/inbox">
            <span className="badge">{t.captures_unprocessed}</span> waiting in Unsorted Info
          </a>
        </div>
      )}
    </div>
  );
}

/** The digest without its "Now" line: the Now card right below already says what is queued. */
export function digestBody(digest: string): string {
  return digest
    .split("\n")
    .map((l) => l.replace(/\s*(Now: [^.]*(\.|$)|Nothing queued\.?)/, "").trim())
    // The People line is for the morning notification; the People section below shows the same people and dates.
    .filter((l) => l && !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}\.?$/.test(l) && !l.startsWith("People:"))
    .join("\n");
}
