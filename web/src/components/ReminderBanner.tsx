import { useCallback, useEffect, useRef, useState } from "react";
import { useEntities } from "../sync/hooks";
import { dueReminders, hasReminder, type DueReminder } from "../lib/reminders";
import { ackReminder, snoozeReminder } from "../sync/actions";
import { notify } from "../tauri/bridge";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { useEscape } from "../lib/keys";

/** Tasks whose reminder time has passed, every 30 s from the local copy: a banner, and a Windows notification under Tauri. */
export function ReminderBanner() {
  const reminders = useEntities("task", hasReminder);
  const [due, setDue] = useState<DueReminder[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const notified = useRef(new Set<string>());
  const [err, setErr] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = dueReminders(reminders);
      setDue(d);
      for (const r of d) {
        if (!notified.current.has(r.key)) {
          notified.current.add(r.key);
          void notify("Reminder", String(r.entity.fields.title ?? ""), `/tasks?focus=${r.entity.id}`);
        }
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [reminders]);

  const visible = due.filter((d) => !dismissed.has(d.key));
  const firstKey = visible[0]?.key;
  useEscape(
    useCallback(() => {
      if (firstKey) setDismissed((d) => new Set([...d, firstKey]));
    }, [firstKey]),
  );
  if (!visible.length) return null;
  const first = visible[0];
  const f = first.entity.fields as { title: string; friction: string };

  const snooze = async (minutes: number) => {
    setErr("");
    let reason: string | undefined;
    if (f.friction !== "none") {
      const r = window.prompt("Reason to snooze");
      if (r === null) return;
      reason = r;
    }
    try {
      await snoozeReminder(first.entity, new Date(Date.now() + minutes * 60_000).toISOString(), reason);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="banner" role="status">
      <div className="grow">
        <strong>{f.title}</strong> <span className="muted small">{fmtDateTime(first.at)}</span>
        {visible.length > 1 && <span className="muted small"> and {visible.length - 1} more</span>}
        {err && <div className="error">{err}</div>}
      </div>
      <button className="small primary" onClick={() => ackReminder(first.entity).catch((e) => setErr(String(e.message ?? e)))} aria-label={`Done: ${f.title}`}>
        Done
      </button>
      <button className="small" onClick={() => snooze(10)} aria-label={`Snooze ${f.title} for 10 minutes`}>
        10m
      </button>
      <button className="small" onClick={() => snooze(60)} aria-label={`Snooze ${f.title} for 1 hour`}>
        1h
      </button>
      <button className="small ghost" onClick={() => go(`/tasks?focus=${first.entity.id}`)}>
        Open
      </button>
      <button className="small ghost" onClick={() => setDismissed(new Set([...dismissed, first.key]))} aria-label="Hide this reminder banner">
        Hide
      </button>
    </div>
  );
}
