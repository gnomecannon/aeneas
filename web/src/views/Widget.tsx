import { useEffect, useMemo, useState } from "react";
import { startedTask, type Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { useHubPoll } from "../sync/useHubPoll";
import { localToday, stopActivity } from "../sync/planner";
import { SOURCE, completeTask } from "../sync/actions";
import { daySpan, overlaps, parseLocalDate, spanOf, timeline, type PlannerToday } from "../lib/planner";
import { freeLine, nowLine, nowWords } from "../lib/todayBoard";
import { closeCurrentWindow, openCaptureWindow, showMainWindow } from "../tauri/bridge";

/** The running activity: the newest activity log, unless it is an "end" log. Same rule as the Apple app. */
export function runningActivity(logs: Entity[]): { name: string; start: string } | null {
  const acts = logs.filter((l) => l.fields.type === "activity").sort((a, b) => (String(a.fields.at) < String(b.fields.at) ? -1 : 1));
  const last = acts[acts.length - 1];
  if (!last || last.fields.note === "end") return null;
  return { name: String(last.fields.value ?? ""), start: String(last.fields.at) };
}

/** "1:05:09" or "4:12" since `start`. */
export function elapsed(start: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(start)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/**
 * The Windows widget: a small window that stays on top. The Next line (packages/shared `nextLine.ts`, the same words
 * as Today's top line): the task you started, with Done, else what is on now or next with a time today, else the free
 * time; under a started task, what is on or next. Then a running activity with its timer and Stop, and Capture. It
 * showed the Now task (the first task in Next when none was started) until 2026-11-25. Drag it by the top line; it
 * reopens where it was left.
 */
export function Widget() {
  const poll = useHubPoll<PlannerToday>((c) => c.plannerToday(), localToday, []);
  const tasks = useEntities("task", (e) => e.fields.status !== "done" && e.fields.status !== "dropped");
  const events = useEntities("event");
  const logs = useEntities("log", (e) => e.fields.type === "activity");
  const inbox = useEntities("capture", (e) => !e.fields.processed).length;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const started = useMemo(() => startedTask(tasks), [tasks]);
  const activity = useMemo(() => runningActivity(logs), [logs]);
  const minute = Math.floor(now / 60_000);
  const t = poll.data;
  const items = useMemo(() => {
    if (!t) return [];
    const day = daySpan(parseLocalDate(t.date));
    const onDay = events.filter((e) => overlaps(spanOf(e), day));
    return timeline({ blocks: t.blocks, commitments: t.commitments, events: onDay, reminders: t.reminders_due, free_slots: t.free_slots }, new Date(minute * 60_000));
  }, [t, events, minute]);
  const at = new Date(minute * 60_000);
  const line = nowWords(nowLine(items, at, started), freeLine(items, at));
  // Under the task you started: what is on now or next, when anything is.
  const then = started ? nowWords(nowLine(items, at), null) : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const done = async () => {
    if (!started) return;
    setBusy(true);
    try {
      await completeTask(started);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!activity) return;
    setBusy(true);
    try {
      await stopActivity(activity.name, SOURCE);
    } finally {
      setBusy(false);
    }
  };
  const detail = [line.when, line.aside].filter(Boolean).join(", ");

  return (
    <div className="widget">
      <div className="widget-bar" data-tauri-drag-region="">
        <span className="muted small" data-tauri-drag-region="">
          {line.label}
        </span>
        <span className="widget-tools">
          <button type="button" className="link small" onClick={() => void showMainWindow("/today")} title="Open the app on Today">
            Open
          </button>
          <button type="button" className="link small" onClick={() => void closeCurrentWindow()} aria-label="Close the widget" title="Close">
            {"×"}
          </button>
        </span>
      </div>
      <div className="widget-task">
        <span className="widget-title" title={line.text}>
          {line.title}
        </span>
        {started && (
          <button type="button" className="primary small" onClick={() => void done()} disabled={busy}>
            Done
          </button>
        )}
      </div>
      {detail && <div className="widget-line muted small">{detail}</div>}
      {activity && (
        <div className="widget-line">
          <span className="grow">
            {activity.name} <span className="mono">{elapsed(activity.start, now)}</span>
          </span>
          <button type="button" className="small" onClick={() => void stop()} disabled={busy}>
            Stop
          </button>
        </div>
      )}
      {then && then.label !== "Today" && <div className="widget-line muted small">{then.text}</div>}
      <div className="widget-foot">
        <button type="button" className="small" onClick={() => void openCaptureWindow()}>
          Capture
        </button>
        {inbox > 0 && (
          <button type="button" className="link small" onClick={() => void showMainWindow("/inbox")}>
            {inbox} to sort
          </button>
        )}
      </div>
    </div>
  );
}
