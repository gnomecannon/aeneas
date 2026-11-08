import { useCallback, useEffect, useState } from "react";
import { engine, type NotifyEvent } from "../sync/engine";
import { db } from "../sync/db";
import { stopActivity } from "../sync/planner";
import { SOURCE } from "../sync/actions";
import { notify } from "../tauri/bridge";
import { useEscape } from "../lib/keys";
import { go } from "../lib/router";

interface ActivityCheck {
  title: string;
  value: string;
  logId?: string;
  at: string;
}

/** "On Soldering for 3 h" from the hub's activity check-in: the activity name and hours. */
export function parseActivityTitle(title: string): { value: string; hours: number } | null {
  const m = /^On (.+) for (\d+(?:\.\d+)?) h$/.exec(title.trim());
  return m ? { value: m[1], hours: Number(m[2]) } : null;
}

/**
 * Activity check-in banner. On a `notify` of kind `activity` from /live: a non-blocking banner with
 * "Still on it" (dismiss) and "Stop" (an `end` log for the same activity). Under Tauri the shell also
 * fires a native notification.
 */
export function ActivityBanner() {
  const [check, setCheck] = useState<ActivityCheck | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      engine.onNotify((n: NotifyEvent) => {
        if (n.kind !== "activity") return;
        void (async () => {
          let value = parseActivityTitle(n.title)?.value ?? "";
          if (n.log_id) {
            const l = await db.entities.get(n.log_id).catch(() => undefined);
            if (l?.fields.value != null) value = String(l.fields.value);
          }
          setCheck({ title: n.title, value, logId: n.log_id, at: n.at ?? new Date().toISOString() });
          setErr("");
          void notify("Still on it?", n.title, "/now");
        })();
      }),
    [],
  );

  useEscape(useCallback(() => setCheck(null), []));
  if (!check) return null;

  const stop = async () => {
    setBusy(true);
    setErr("");
    try {
      await stopActivity(check.value, SOURCE);
      setCheck(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner activity" role="status">
      <div className="grow">
        <strong>{check.title}</strong> <span className="muted small">check-in</span>
        {err && <div className="error">{err}</div>}
      </div>
      <button className="small primary" onClick={() => setCheck(null)} aria-label={`Still on ${check.value}`}>
        Still on it
      </button>
      <button className="small" onClick={() => void stop()} disabled={busy || !check.value} aria-label={`Stop ${check.value}`}>
        Stop
      </button>
    </div>
  );
}

/** Sensor banner: a `notify` of kind `sensor` (a reading crossed a bound, or came back inside) with a link to Sensors. */
export function SensorBanner() {
  const [n, setN] = useState<NotifyEvent | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "sensor") return;
        setN(ev);
        void notify("Sensor", ev.title, "/sensors");
      }),
    [],
  );
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  const detail = n.name ? `${n.name}${n.value != null ? ` ${n.value}${n.unit ? ` ${n.unit}` : ""}` : ""}` : "";
  return (
    <div className="banner sensor" role="status">
      <div className="grow">
        <strong>{n.title}</strong> {detail && n.title !== detail && <span className="muted small">{detail}</span>}
      </div>
      <button
        className="small primary"
        onClick={() => {
          setN(null);
          go("/sensors");
        }}
      >
        Sensors
      </button>
      <button className="small" onClick={() => setN(null)} aria-label="Dismiss the sensor alert">
        Dismiss
      </button>
    </div>
  );
}

/** Digest toast: the first digest line and a link to Today; a native notification under Tauri. */
export function DigestToast() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(
    () =>
      engine.onNotify((n: NotifyEvent) => {
        if (n.kind !== "digest") return;
        const first = n.title.split("\n")[0];
        setLine(first);
        void notify("Today", first, "/today");
      }),
    [],
  );
  useEscape(useCallback(() => setLine(null), []));
  if (!line) return null;
  return (
    <div className="toast digest" role="status" aria-live="polite">
      <span className="grow">{line}</span>
      <button
        className="small primary"
        onClick={() => {
          setLine(null);
          go("/today");
        }}
      >
        Today
      </button>
      <button className="small ghost" onClick={() => setLine(null)} aria-label="Dismiss the digest">
        Later
      </button>
    </div>
  );
}

/** Quiz toast: a `notify` of kind `quiz` (tonight's recall quiz is ready) with a link to Quiz. */
export function QuizToast() {
  const [n, setN] = useState<NotifyEvent | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "quiz") return;
        setN(ev);
        void notify("Recall quiz", ev.title, "/quiz");
      }),
    [],
  );
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  return (
    <div className="toast quiz" role="status" aria-live="polite">
      <span className="grow">{n.title}</span>
      <button
        className="small primary"
        onClick={() => {
          setN(null);
          go("/quiz");
        }}
      >
        Start
      </button>
      <button className="small ghost" onClick={() => setN(null)} aria-label="Dismiss the quiz">
        Later
      </button>
    </div>
  );
}

/** "DOWN <name>: <error>" or "UP <name>" from a `notify` of kind `monitor`. */
export function monitorLine(n: Pick<NotifyEvent, "name" | "state" | "error" | "title">): { down: boolean; text: string } {
  const down = n.state === "down";
  const name = n.name ?? n.title ?? "monitor";
  return { down, text: down ? `DOWN ${name}${n.error ? `: ${n.error}` : ""}` : `UP ${name}` };
}

/** Monitor banner: red when a monitor goes down, green when it comes back, with a link to Ops. */
export function MonitorBanner() {
  const [n, setN] = useState<{ down: boolean; text: string } | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "monitor") return;
        const line = monitorLine(ev);
        setN(line);
        void notify(line.down ? "Monitor down" : "Monitor up", line.text, "/ops");
      }),
    [],
  );
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  return (
    <div className={`banner monitor ${n.down ? "down" : "up"}`} role={n.down ? "alert" : "status"}>
      <strong className="grow">{n.text}</strong>
      <button
        className="small primary"
        onClick={() => {
          setN(null);
          go("/ops");
        }}
      >
        Ops
      </button>
      <button className="small" onClick={() => setN(null)} aria-label="Dismiss the monitor alert">
        Dismiss
      </button>
    </div>
  );
}
