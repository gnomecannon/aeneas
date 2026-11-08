import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { updateEntity } from "../sync/edits";
import { stopActivity } from "../sync/planner";
import { SOURCE } from "../sync/actions";
import { fmtTime, isoNow } from "../lib/time";
import { pickCurrent } from "./Now";
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

/** The next scheduled block later today, from the tasks' blocks. */
export function nextBlock(tasks: Entity[], now: Date): { title: string; start: string } | null {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  let best: { title: string; start: string } | null = null;
  for (const t of tasks) {
    const b = t.fields.block as { start: string; end: string } | undefined;
    if (!b || t.fields.status === "done") continue;
    const s = Date.parse(b.start);
    if (s <= now.getTime() || s > end.getTime()) continue;
    if (!best || s < Date.parse(best.start)) best = { title: String(t.fields.title), start: b.start };
  }
  return best;
}

/**
 * The Now widget (Windows): a small window that stays on top. The Now task with Done, a running activity with
 * its timer and Stop, the next block today, and Capture. Drag it by the top line; it reopens where it was left.
 */
export function Widget() {
  const tasks = useEntities("task", (e) => e.fields.status !== "done" && e.fields.status !== "dropped");
  const logs = useEntities("log", (e) => e.fields.type === "activity");
  const inbox = useEntities("capture", (e) => !e.fields.processed).length;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const { current } = useMemo(() => pickCurrent(tasks), [tasks]);
  const activity = useMemo(() => runningActivity(logs), [logs]);
  const next = useMemo(() => nextBlock(tasks, new Date(now)), [tasks, Math.floor(now / 60_000)]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const block = current?.fields.block as { start: string; end: string } | undefined;
  const blockEnd = block && Date.parse(block.end) > now ? block.end : null;

  const done = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await updateEntity(current, { status: "done", done_at: isoNow() });
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

  return (
    <div className="widget">
      <div className="widget-bar" data-tauri-drag-region="">
        <span className="muted small" data-tauri-drag-region="">
          {current?.fields.status === "doing" ? "Doing" : "Now"}
          {blockEnd ? `, block until ${fmtTime(blockEnd)}` : ""}
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
        <span className="widget-title" title={current ? String(current.fields.title) : undefined}>
          {current ? String(current.fields.title) : "Nothing is next"}
        </span>
        {current && (
          <button type="button" className="primary small" onClick={() => void done()} disabled={busy}>
            Done
          </button>
        )}
      </div>
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
      {next && (
        <div className="widget-line muted small">
          Next {fmtTime(next.start)}: {next.title}
        </div>
      )}
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
