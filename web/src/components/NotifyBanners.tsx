import { plainError } from "../lib/errors";
import { useCallback, useEffect, useState } from "react";
import { engine, type NotifyEvent } from "../sync/engine";
import { db } from "../sync/db";
import { stopActivity } from "../sync/planner";
import { SOURCE } from "../sync/actions";
import { isAndroid, isTauri, notify, openExternal } from "../tauri/bridge";
import { APP_VERSION, RELEASES_URL, compareVersions, versionNotice } from "../lib/appUpdate";
import { installFromHub, selfPlatform, type InstallStep } from "../lib/appInstall";
import { useHubVersion } from "../lib/hubIdentity";
import { useEntity, useMeta } from "../sync/hooks";
import { META } from "../sync/db";
import type { AppUpdateAsk } from "../sync/api";
import { useEscape } from "../lib/keys";
import { go } from "../lib/router";
import { fixPath } from "../lib/connectionProblems";

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
          void notify("Still on it?", n.title, "/today");
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
      setErr(plainError(e));
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

/**
 * Disk banner: a `notify` of kind `disk` says the disk with the hub's data is almost full (once, then once a day while
 * it stays low). Every hub sends it, whatever modules are on: a full disk stops the hub saving anything.
 */
export function DiskBanner() {
  const [n, setN] = useState<NotifyEvent | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "disk") return;
        setN(ev);
        void notify("Hub disk", ev.title);
      }),
    [],
  );
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  return (
    <div className="banner sensor" role="status">
      <div className="grow">
        <strong>{n.title}</strong>
      </div>
      <button className="small" onClick={() => setN(null)} aria-label="Dismiss the disk alert">
        Dismiss
      </button>
    </div>
  );
}

/**
 * A connection broke (`notify` of kind `connection`, once when it happens: a mailbox's password refused, an ended
 * sign-in, Steam's key refused): what broke, and one button to the page with the fix. Every hub sends it, whatever
 * modules are on; the hub lists only connections of modules that are on.
 */
export function ConnectionBanner() {
  const [n, setN] = useState<NotifyEvent | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "connection") return;
        setN(ev);
        void notify(ev.name || "Connections", ev.title, fixPath({ fix: ev.fix ?? "connections", account: ev.account }));
      }),
    [],
  );
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  return (
    <div className="banner sensor" role="status">
      <div className="grow">
        <strong>{n.title}</strong>
      </div>
      <button
        className="small primary"
        onClick={() => {
          setN(null);
          go(fixPath({ fix: n.fix ?? "connections", account: n.account }));
        }}
      >
        {n.button || "Open"}
      </button>
      <button className="small" onClick={() => setN(null)} aria-label="Dismiss the connection alert">
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

/** New mail: a `notify` of kind `mail` (sender and subject, or a count, as the owner chose) with a link to Mail. */
export function MailToast() {
  const [n, setN] = useState<NotifyEvent | null>(null);
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "mail") return;
        setN(ev);
        void notify("Mail", ev.title, "/mail");
      }),
    [],
  );
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => setN(null), 12_000);
    return () => clearTimeout(t);
  }, [n]);
  useEscape(useCallback(() => setN(null), []));
  if (!n) return null;
  return (
    <div className="toast mail" role="status" aria-live="polite">
      <span className="grow">{n.title}</span>
      <button className="small primary" onClick={() => { setN(null); go("/mail"); }}>Open Mail</button>
      <button className="small ghost" onClick={() => setN(null)} aria-label="Dismiss">✕</button>
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

type MonitorNote = { name: string; down: boolean; text: string; incident?: string };

/**
 * Monitor banners: one per monitor (a second alert replaced the first, and its Acknowledge with it). A red one stays
 * until that monitor is back or it is dismissed; a green one goes by itself after 8 seconds. With Acknowledge and Ops.
 */
export function MonitorBanner() {
  const [items, setItems] = useState<MonitorNote[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  useEffect(
    () =>
      engine.onNotify((ev: NotifyEvent) => {
        if (ev.kind !== "monitor") return;
        const line = monitorLine(ev);
        const name = ev.name ?? ev.title ?? "monitor";
        setItems((xs) => [...xs.filter((x) => x.name !== name), { name, ...line, incident: line.down ? ev.incident_id : undefined }].slice(-4));
        void notify(line.down ? "Monitor down" : "Monitor up", line.text, "/ops");
      }),
    [],
  );
  useEffect(() => {
    if (!items.some((x) => !x.down)) return;
    const t = setTimeout(() => setItems((xs) => xs.filter((x) => x.down)), 8000);
    return () => clearTimeout(t);
  }, [items]);
  useEscape(useCallback(() => setItems([]), []));
  if (!items.length) return null;
  const drop = (name: string) => setItems((xs) => xs.filter((x) => x.name !== name));
  const ack = async (n: MonitorNote) => {
    if (!engine.client || !n.incident) return;
    setBusy(n.name);
    setErrs((e) => ({ ...e, [n.name]: "" }));
    try {
      const out = await engine.client.incidentAck(n.incident);
      await engine.absorb([out]).catch(() => undefined);
      drop(n.name);
    } catch (e) {
      setErrs((x) => ({ ...x, [n.name]: plainError(e) }));
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      {items.map((n) => (
        <div key={n.name} className={`banner monitor ${n.down ? "down" : "up"}`} role={n.down ? "alert" : "status"}>
          <strong className="grow">
            {n.text}
            {errs[n.name] && <div className="error small">{errs[n.name]}</div>}
          </strong>
          {n.incident && engine.client && (
            <button className="small" onClick={() => void ack(n)} disabled={busy === n.name}>
              {busy === n.name ? "Acknowledging" : "Acknowledge"}
            </button>
          )}
          <button
            className="small primary"
            onClick={() => {
              setItems([]);
              go("/ops");
            }}
          >
            Ops
          </button>
          <button className="small" onClick={() => drop(n.name)} aria-label={`Dismiss the alert for ${n.name}`}>
            Dismiss
          </button>
        </div>
      ))}
    </>
  );
}

/** Seconds an update asked for from another device waits before it starts, with Not now. */
const ASKED_WAIT_S = 15;

/**
 * A newer Aeneas app is out (the hub runs a later release than this app): the Windows and Android apps say so once for
 * each newer version, with Update app, which installs the hub's copy. An update the owner asked for from another device
 * (the assistant, or Settings there) starts by itself after 15 seconds unless someone presses Not now; on Android only
 * while the app is on screen, since Android's own prompt needs someone there.
 */
export function AppUpdateBanner() {
  const hubVersion = useHubVersion();
  const notice = versionNotice(APP_VERSION, hubVersion, isTauri);
  const me = useEntity(useMeta<string>(META.deviceId));
  const ask = (me?.fields.app_update ?? null) as AppUpdateAsk | null;
  const canSelf = !!selfPlatform();
  const asked = canSelf && !!ask && !ask.declined_at && compareVersions(ask.version, APP_VERSION) === 1;
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem(APP_UPDATE_KEY); } catch { return null; } });
  const [step, setStep] = useState<InstallStep | null>(null);
  const [wait, setWait] = useState<number | null>(null);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [declinedFor, setDeclinedFor] = useState<string | null>(null);
  const shown = notice?.kind === "app-older" && !!hubVersion && dismissed !== hubVersion;
  const dismiss = useCallback(() => {
    if (!hubVersion) return;
    try { localStorage.setItem(APP_UPDATE_KEY, hubVersion); } catch { /* private window */ }
    setDismissed(hubVersion);
  }, [hubVersion]);
  const run = useCallback(async () => {
    setWait(null);
    if (engine.client) await installFromHub(engine.client, setStep);
  }, []);
  const notNow = useCallback(async () => {
    setWait(null);
    if (ask) setDeclinedFor(ask.requested_at);
    try { await engine.client?.declineAppUpdate(); } catch { /* offline: the ask stays, and comes back next start */ }
  }, [ask]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // An ask arrives: the wait starts (once for each ask).
  useEffect(() => {
    if (asked && ask && declinedFor !== ask.requested_at && step === null && wait === null) setWait(ASKED_WAIT_S);
  }, [asked, ask, declinedFor, step, wait]);
  useEffect(() => {
    if (wait === null) return;
    if (wait <= 0) { void run(); return; }
    if (isAndroid && !visible) return;
    const t = setTimeout(() => setWait((w) => (w === null ? null : w - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait, visible, run]);
  // Esc closes banners (Settings, Keyboard); for this one that is Dismiss, or Not now while an asked update waits.
  useEscape(useCallback(() => {
    if (wait !== null) void notNow();
    else if (shown && !step) dismiss();
  }, [wait, shown, step, notNow, dismiss]));

  const busy = step && (step.state === "preparing" || step.state === "downloading" || step.state === "installing");
  if (step) {
    return (
      <div className="banner sensor" role="status">
        <div className="grow">{step.text}</div>
        {step.state === "unavailable" && <button className="small" onClick={() => void openExternal(RELEASES_URL)}>Release page</button>}
        {step.state === "permission" && <button className="small" onClick={() => void run()}>Update app</button>}
        {!busy && <button className="small ghost" onClick={() => setStep(null)} aria-label="Close the update notice">Close</button>}
      </div>
    );
  }
  if (wait !== null && ask) {
    return (
      <div className="banner sensor" role="status">
        <div className="grow">
          {`Updating Aeneas to ${ask.version}${ask.by ? `, as asked from ${ask.by}` : ""}, `}
          {isAndroid && !visible ? "when the app is open." : `in ${wait} s.`}
        </div>
        <button className="small" onClick={() => void run()}>Update now</button>
        <button className="small ghost" onClick={() => void notNow()}>Not now</button>
      </div>
    );
  }
  if (!shown || !notice) return null;
  return (
    <div className="banner sensor" role="status">
      <div className="grow">{notice.text}</div>
      {canSelf
        ? <button className="small" onClick={() => void run()}>Update app</button>
        : <button className="small" onClick={() => void openExternal(RELEASES_URL)}>Get the new app</button>}
      <button className="small ghost" onClick={dismiss} aria-label="Dismiss the notice about a newer app">Dismiss</button>
    </div>
  );
}
const APP_UPDATE_KEY = "ea.appUpdate.dismissed";
