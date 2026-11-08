import { useEffect, useState } from "react";
import { PeoplePage, usePeopleSummary } from "./settings/People";
import { hubLabel, useHubIdentity } from "../lib/hubIdentity";
import { HubClient, normalizeHubUrl } from "../sync/api";
import { db, META, setMeta, type RejectedEdit } from "../sync/db";
import { engine } from "../sync/engine";
import { useMeta, useSyncState } from "../sync/hooks";
import { CAPTURE_SHORTCUTS, autostartEnabled, getCaptureShortcut, getWidget, isAndroid, isTauri, isWindowsApp, notificationsAllowed, notify, onWidgetChanged, setAutostart, setCaptureShortcut, setWidget, setupFilePath } from "../tauri/bridge";
import { applySetupFile, type SetupFileResult } from "../tauri/setupFile";
import { checkForUpdate, manifestCheck, promptInstall, shellVersion, subscribePwa, type PwaState } from "../pwa";
import { fmtDateTime } from "../lib/time";
import { useFeel } from "../feel/store";
import { AppColors, AppThemeEditor, ThemeHome, themeSummaries } from "./settings/Theme";
import { PaletteEditor, TapEffects } from "./settings/TapEffects";
import { NoteSounds } from "./settings/NoteSounds";
import { NavRow, SubPage, Toggle, errorText } from "./settings/common";
import { ImportPage } from "./settings/Import";
import { ModulesPage, modulesSummary } from "./settings/Modules";
import { useModules } from "../lib/modules";
import { ConnectionsPage, connectionsSummary, useConnections } from "./settings/Connections";
import { DevicesList, PairDevice } from "./settings/Devices";
import { MachinesSettings, RetentionSettings } from "./settings/HubPrivacy";
import { keyKind } from "./Setup";
import { saveBlob } from "../lib/download";
import { localDate } from "../lib/planner";

const SETUP_STATE: Record<SetupFileResult["state"], string> = {
  "not-desktop": "only on the desktop app",
  missing: "no file found",
  incomplete: "file found but incomplete",
  applied: "applied",
  "applied-unverified": "applied, hub not verified yet",
  error: "could not read",
};

/**
 * Settings: a short menu, each row opening its own page (`#/settings/<page>`), so the back button and the phone's
 * "‹ Settings" link work. Theme has its own menu of three.
 */
export function Settings({ parts, params }: { parts: string[]; params: URLSearchParams }) {
  const [a, b, c] = parts;
  if (a === "theme") {
    if (b === "colors" && c) return <AppThemeEditor key={c} id={c} />;
    if (b === "colors") return <AppColors />;
    if (b === "taps" && c) return <PaletteEditor key={`${c}-${params.get("from") ?? ""}`} id={c} from={params.get("from")} />;
    if (b === "taps") return <TapEffects />;
    if (b === "sounds") return <NoteSounds />;
    return <ThemeHome />;
  }
  if (a === "connection") return <Connection />;
  if (a === "connections") return <ConnectionsPage />;
  if (a === "notifications") return <Notifications />;
  if (a === "work") return <WorkSpace />;
  if (a === "planner") return <Planner />;
  if (a === "data") return <Data />;
  if (a === "import") return <ImportPage />;
  if (a === "modules") return <ModulesPage />;
  if (a === "windows" && isWindowsApp) return <WindowsApp />;
  if (a === "about") return <About />;
  if (a === "people") return <PeoplePage />;
  return <SettingsHome />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function SettingsHome() {
  const f = useFeel();
  const hubUrl = useMeta<string>(META.hubUrl) ?? "";
  const sync = useSyncState();
  const rejected = useMeta<RejectedEdit[]>(META.rejected) ?? [];
  const [work, setWork] = useState<string>("");
  const [widget, setWidgetState] = useState(false);
  const [auto, setAuto] = useState(false);
  const t = themeSummaries(f);
  const [links] = useConnections();
  const { list: modules } = useModules();
  const people = usePeopleSummary();

  useEffect(() => {
    engine.client?.workSpace().then(
      (w) => setWork(w.enabled ? `On, ${w.events} events and ${w.tasks} tasks` : "Off"),
      () => setWork(""),
    );
    if (!isWindowsApp) return;
    void getWidget().then(setWidgetState);
    void autostartEnabled().then(setAuto);
  }, []);

  const connection = hubUrl ? `${hostOf(hubUrl)}, ${sync.status}${sync.outbox ? `, ${sync.outbox} queued` : ""}` : "Not set up";
  const windows = [widget ? "Now widget open" : "", auto ? "starts on login" : ""].filter(Boolean).join(", ") || "Now widget, start on login, setup file";

  return (
    <div className="settings-page col">
      <h1>Settings</h1>
      <nav className="list" aria-label="Settings">
        <NavRow href="/settings/theme" title="Theme" summary={`${t.colors}, ${t.taps === "Off" ? "shapes off" : t.taps.split(",")[0]}, ${t.sounds === "Off" ? "notes off" : t.sounds.split(",")[0]}`} />
        <NavRow
          href="/settings/connection"
          title="Connection"
          summary={connection}
          extra={rejected.length ? <span className="badge" aria-label={`${rejected.length} refused edits`}>{rejected.length}</span> : undefined}
        />
        <NavRow href="/welcome" title="Set up" summary="Your name, the model, what to use, passwords, pairing another device" />
        <NavRow href="/settings/modules" title="Modules" summary={modulesSummary(modules)} />
        {people && <NavRow href="/settings/people" title="People on this machine" summary={people} />}
        <NavRow href="/settings/import" title="Bring your data in" summary="ChatGPT, Google Takeout, Obsidian and other notes, text" />
        <NavRow href="/settings/connections" title="Connections" summary={connectionsSummary(links)} />
        <NavRow href="/settings/notifications" title="Notifications" summary={isWindowsApp ? "Windows notifications and banners" : "Banners while the app is open"} />
        <NavRow href="/settings/work" title="Work space" summary={work || (engine.client ? "Work calendar and tasks" : "Hub not configured")} />
        <NavRow href="/settings/planner" title="Planner" summary="Plan rules, week and renewals" />
        <NavRow href="/settings/data" title="Data" summary="Export notes, clear this device" />
        {isWindowsApp && <NavRow href="/settings/windows" title="Windows app" summary={windows} />}
        <NavRow href="/settings/about" title="About" summary={isWindowsApp ? "Versions and keyboard shortcuts" : "Install, updates and keyboard shortcuts"} />
      </nav>
    </div>
  );
}

function Connection() {
  const hubUrl = useMeta<string>(META.hubUrl) ?? "";
  const token = useMeta<string>(META.token) ?? "";
  const deviceName = useMeta<string>(META.deviceName) ?? "";
  const deviceId = useMeta<string>(META.deviceId);
  const sync = useSyncState();
  const [hub, setHub] = useState(hubUrl);
  const [tok, setTok] = useState(token);
  const [showTok, setShowTok] = useState(false);
  const [name, setName] = useState(deviceName);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setHub(hubUrl), [hubUrl]);
  useEffect(() => setTok(token), [token]);
  useEffect(() => setName(deviceName), [deviceName]);

  const test = async () => {
    setMsg(null);
    try {
      const h = await new HubClient({ hubUrl: hub, token: tok }).health();
      setMsg({ ok: true, text: `hub ${h.version}, seq ${h.db_seq}` });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  const save = async () => {
    const changedHub = normalizeHubUrl(hub) !== hubUrl;
    await setMeta(META.hubUrl, normalizeHubUrl(hub));
    await setMeta(META.token, tok.trim());
    await setMeta(META.deviceName, name.trim());
    if (changedHub) {
      // A different hub is a different dataset: drop the cached copy and the device id,
      // keep the outbox so unsent edits still reach the new hub.
      await db.meta.delete(META.deviceId);
      await setMeta(META.seq, 0);
      await db.entities.clear();
    }
    await engine.restart();
    setMsg({ ok: true, text: "saved" });
  };

  return (
    <SubPage path="/settings/connection">
      <div className="card col">
        <h2>Hub</h2>
        <div>
          <label htmlFor="hub">Hub URL</label>
          <input id="hub" value={hub} onChange={(e) => setHub(e.target.value)} autoCapitalize="off" />
        </div>
        <div className="small">
          {keyKind(token) === "own" ? "This device signs in with its own key. Removing it in Devices below, on any device, ends that key."
            : keyKind(token) === "main" ? "This device still uses the hub's main key. It is traded for a key of its own at the next sync."
            : "Not paired."}
        </div>
        <div>
          <label htmlFor="nm">Device name</label>
          <input id="nm" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <details>
          <summary className="small">The key this device uses</summary>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input id="tok" aria-label="Key" type={showTok ? "text" : "password"} value={tok} onChange={(e) => setTok(e.target.value)} autoCapitalize="off" autoComplete="off" spellCheck={false} />
            <button type="button" className="small" onClick={() => setShowTok(!showTok)} aria-pressed={showTok}>
              {showTok ? "Hide" : "Show"}
            </button>
          </div>
        </details>
        {msg && (
          <div className={msg.ok ? "ok" : "error"} role="status">
            {msg.text}
          </div>
        )}
        <div className="row">
          <button onClick={test} disabled={!hub.trim()}>
            Test
          </button>
          <button className="primary" onClick={save} disabled={!hub.trim() || !tok.trim()}>
            Save
          </button>
        </div>
      </div>
      <div className="card col">
        <h2>Devices</h2>
        <DevicesList />
      </div>
      <div className="card col">
        <h2>Pair another device</h2>
        <PairDevice />
      </div>
      <div className="card col">
        <h2>What the hub keeps</h2>
        <RetentionSettings />
      </div>
      <div className="card col">
        <h2>Machines</h2>
        <MachinesSettings />
      </div>
      <div className="card col">
        <h2>Sync</h2>
        <dl className="facts">
          <dt>status</dt>
          <dd>
            {sync.status}, live {sync.live ? "on" : "off"}
          </dd>
          <dt>position</dt>
          <dd>seq {sync.seq}</dd>
          <dt>waiting to send</dt>
          <dd>{sync.outbox}</dd>
          {deviceId && (
            <>
              <dt>device</dt>
              <dd className="mono">{deviceId.slice(0, 8)}</dd>
            </>
          )}
          {sync.lastError && (
            <>
              <dt>last error</dt>
              <dd className="error">{sync.lastError}</dd>
            </>
          )}
        </dl>
        <div className="row">
          <button onClick={() => engine.restart()}>Reconnect</button>
        </div>
        <RejectedEdits />
      </div>
    </SubPage>
  );
}

/** Edits the hub refused. The hub's copy replaced them, so they are listed here instead of disappearing. */
function RejectedEdits() {
  const log = useMeta<RejectedEdit[]>(META.rejected) ?? [];
  if (!log.length) return null;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="error small">
        The hub refused {log.length === 1 ? "1 edit" : `${log.length} edits`}. Its own copy was kept; what you changed is below.
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {log.slice().reverse().map((r, i) => (
          <li key={`${r.id}-${r.at}-${i}`}>
            <strong>{r.title || r.kind}</strong> {fmtDateTime(r.at)}: {r.reason}
            <div className="muted"><code>{JSON.stringify(r.fields).slice(0, 200)}</code></div>
          </li>
        ))}
      </ul>
      <div><button className="small" onClick={() => void setMeta(META.rejected, [])}>Clear</button></div>
    </div>
  );
}

function Notifications() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void notificationsAllowed().then(setAllowed).catch(() => setAllowed(false));
  }, []);
  return (
    <SubPage path="/settings/notifications">
      <div className="card col">
        <h2>What alerts you</h2>
        <ul className="small plain-list">
          <li>Reminders when they are due, with Ack and Snooze</li>
          <li>Check-ins on a long activity</li>
          <li>Sensors that leave their range and come back</li>
          <li>Monitors that go down or come back up</li>
          <li>The morning digest and the evening recall quiz</li>
        </ul>
        <div className="muted small">
          {isWindowsApp ? "They show as banners in the app and as Windows notifications." : "In a browser they show as banners at the top of the app while it is open."} When each reminder fires and how hard it is to snooze are set on the reminder itself.
        </div>
      </div>
      {isTauri && (
        <div className="card col">
          <h2>{isAndroid ? "Android notifications" : "Windows notifications"}</h2>
          <div className="small">{allowed === null ? "Checking" : allowed ? "Allowed." : "Not allowed yet."}</div>
          <div className="row">
            {allowed === false && (
              <button onClick={() => void notificationsAllowed(true).then(setAllowed)}>Allow notifications</button>
            )}
            <button
              onClick={() => {
                void notify("Aeneas", "Notifications work.", "/settings/notifications").then(() => setMsg("Sent."));
              }}
            >
              Send a test
            </button>
          </div>
          {msg && <div className="muted small">{msg}</div>}
        </div>
      )}
    </SubPage>
  );
}

/** One switch for the sealed work space. Off erases every work event and task on every device and stops the import. */
function WorkSpace() {
  const [st, setSt] = useState<{ enabled: boolean; events: number; tasks: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => engine.client?.workSpace().then(setSt, (e) => setMsg(errorText(e)));
  useEffect(() => { void load(); }, []);
  const set = async (on: boolean) => {
    if (!engine.client) return;
    if (!on && !confirm("Turn off and erase the work space? Every work event and work task is erased from the hub and every device, and the work calendar stops importing.")) return;
    setBusy(true);
    try {
      const r = await engine.client.setWorkSpace(on);
      setMsg(on ? "Work space on." : `Erased ${r.erased} work items.`);
      await engine.cycle();
      await load();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SubPage path="/settings/work">
      <div className="card col">
        {st ? (
          <Toggle
            checked={st.enabled}
            disabled={busy}
            onChange={(on) => void set(on)}
            label="Keep work calendar and tasks"
            note={st.enabled ? `${st.events} work events and ${st.tasks} work tasks. Titles and times only; never sent to cloud AI.` : "Off. Nothing from work is kept or imported."}
          />
        ) : msg ? null : (
          <div className="muted small">{engine.client ? "Loading" : "Hub not configured."}</div>
        )}
        {msg && <div className="muted small">{msg}</div>}
      </div>
    </SubPage>
  );
}

function Planner() {
  return (
    <SubPage path="/settings/planner">
      <div className="small">Blackouts, commitments and preferences by weekday, including alternating custody weeks.</div>
      <nav className="list" aria-label="Planner">
        <NavRow href="/plan-rules" title="Plan rules" summary="Blackouts, commitments and preferences" />
        <NavRow href="/week" title="Week" summary="The plan for this week" />
        <NavRow href="/renewals" title="Renewals" summary="Things that expire and need renewing" />
      </nav>
    </SubPage>
  );
}


function Data() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const exportNotes = async () => {
    if (!engine.client) return;
    setBusy(true);
    setMsg(null);
    try {
      const blob = await engine.client.exportNotes();
      saveBlob(blob, `notes-${localDate(new Date())}.tar.gz`);
      setMsg({ ok: true, text: "Downloaded." });
    } catch (e) {
      setMsg({ ok: false, text: `Export failed: ${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!confirm("Clear all local data on this device. Hub data is not affected.")) return;
    engine.stop();
    await db.delete();
    window.location.reload();
  };
  return (
    <SubPage path="/settings/data">
      <div className="card col">
        <h2>Export notes</h2>
        <div className="small">Every note as markdown files in one .tar.gz download.</div>
        <div className="row">
          <button onClick={() => void exportNotes()} disabled={!engine.client || busy}>
            {busy ? "Exporting" : "Export all notes"}
          </button>
        </div>
        {msg && (
          <div className={msg.ok ? "ok" : "error"} role="status">
            {msg.text}
          </div>
        )}
      </div>
      <div className="card col">
        <h2>This device</h2>
        <div className="small">Removes the copy kept on this device. Everything on the hub stays.</div>
        <div className="row">
          <button className="danger" onClick={reset}>
            Clear local data
          </button>
        </div>
      </div>
    </SubPage>
  );
}

function WindowsApp() {
  const setupResult = useMeta<SetupFileResult>(META.setupFile);
  const [widget, setWidgetState] = useState(false);
  const [auto, setAuto] = useState(false);
  const [setupPath, setSetupPath] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [shortcut, setShortcutState] = useState<string>("Control+Shift+Space");
  const [shortcutErr, setShortcutErr] = useState("");

  useEffect(() => {
    void getCaptureShortcut().then((s) => { if (s) setShortcutState(s); }).catch(() => undefined);
    void getWidget().then(setWidgetState);
    void autostartEnabled().then(setAuto);
    void setupFilePath().then(setSetupPath).catch(() => setSetupPath("(unresolved)"));
    let un: (() => void) | undefined;
    void onWidgetChanged(setWidgetState).then((u) => (un = u));
    return () => un?.();
  }, []);

  const applyFile = async () => {
    setSetupBusy(true);
    try {
      const r = await applySetupFile();
      setMsg({ ok: r.state === "applied", text: `setup file ${SETUP_STATE[r.state]}${r.detail ? `: ${r.detail}` : ""}` });
    } finally {
      setSetupBusy(false);
    }
  };

  return (
    <SubPage path="/settings/windows">
      <div className="card col">
        <Toggle
          checked={widget}
          onChange={(v) => {
            setWidgetState(v);
            void setWidget(v);
          }}
          label="Now widget (a small window on top with the Now task, a running activity and Capture; also in the tray menu)"
        />
        <Toggle
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            void setAutostart(v);
            void setMeta(META.autostart, v);
          }}
          label="Start on login"
        />
        <label className="row small" style={{ margin: 0 }}>
          Capture from anywhere
          <select
            value={shortcut}
            aria-label="Capture shortcut"
            onChange={(e) => {
              const v = e.target.value;
              setShortcutErr("");
              setCaptureShortcut(v).then(() => setShortcutState(v), () => setShortcutErr("Another app already uses that shortcut. Pick another."));
            }}
          >
            {CAPTURE_SHORTCUTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {shortcutErr && <div className="error small">{shortcutErr}</div>}
      </div>
      <div className="card col">
        <h2>Setup file</h2>
        <div className="small">
          Read on startup when no hub is configured. Shape: <code>{'{ "hub_url": "...", "token": "...", "device_name": "..." }'}</code>. The token is removed from the file once the hub answers.
        </div>
        <div className="mono small" style={{ overflowWrap: "anywhere" }}>
          {setupPath || "resolving path"}
        </div>
        <div className="muted small">
          {setupResult ? `${SETUP_STATE[setupResult.state]} ${fmtDateTime(setupResult.at)}${setupResult.detail ? `: ${setupResult.detail}` : ""}` : "not read yet this session"}
        </div>
        {msg && (
          <div className={msg.ok ? "ok" : "error"} role="status">
            {msg.text}
          </div>
        )}
        <div className="row">
          <button onClick={applyFile} disabled={setupBusy}>
            Read setup file now
          </button>
        </div>
      </div>
    </SubPage>
  );
}

function About() {
  const [pwa, setPwa] = useState<PwaState | null>(null);
  const [shell, setShell] = useState<{ version: string; precache: number } | null>(null);
  const [manifest, setManifest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [hubVersion, setHubVersion] = useState("");
  const hubName = hubLabel(useHubIdentity());
  const [appMsg, setAppMsg] = useState("");

  useEffect(() => subscribePwa(setPwa), []);
  useEffect(() => {
    if (isTauri) return;
    void shellVersion().then(setShell);
    void manifestCheck().then(setManifest);
  }, [pwa?.registered]);
  useEffect(() => {
    engine.client?.health().then(
      (h) => setHubVersion(h.version ?? "unknown"),
      () => setHubVersion("not reachable"),
    );
  }, []);

  const install = async () => {
    const r = await promptInstall();
    setAppMsg(r === "accepted" ? "installed" : r === "dismissed" ? "install dismissed" : "install prompt not offered by this browser");
  };

  return (
    <SubPage path="/settings/about">
      {!isTauri && (
        <div className="card col">
          <h2>App</h2>
          <dl className="facts">
            <dt>mode</dt>
            <dd>{pwa?.standalone ? "installed, standalone" : "browser tab"}</dd>
            <dt>service worker</dt>
            <dd>
              {!pwa?.supported ? "not supported here" : pwa.error ? `error: ${pwa.error}` : !pwa.registered ? (import.meta.env.PROD ? "registering" : "off in dev builds") : shell ? `active, shell ${shell.version}, ${shell.precache} files cached` : "registered, takes over on next load"}
            </dd>
            <dt>manifest</dt>
            <dd className={manifest && !manifest.ok ? "error" : ""}>{manifest ? manifest.detail : "checking"}</dd>
            <dt>installable</dt>
            <dd>{pwa?.standalone ? "already installed" : pwa?.canInstall ? "yes" : "no prompt yet (use the browser menu, or Share then Add to Home Screen on iOS)"}</dd>
            <dt>hub</dt>
            <dd>{engine.client ? `${hubName ? `${hubName}, ` : ""}${hubVersion || "checking"}` : "not configured"}</dd>
          </dl>
          <div className="row">
            {pwa?.canInstall && (
              <button className="primary" onClick={install}>
                Install app
              </button>
            )}
            <button onClick={() => void checkForUpdate().then(() => setAppMsg("checked for a newer shell"))} disabled={!pwa?.registered}>
              Check for update
            </button>
          </div>
          {appMsg && (
            <div className="muted small" role="status">
              {appMsg}
            </div>
          )}
        </div>
      )}
      {isTauri && (
        <div className="card col">
          <h2>Versions</h2>
          <dl className="facts">
            <dt>hub</dt>
            <dd>{engine.client ? `${hubName ? `${hubName}, ` : ""}${hubVersion || "checking"}` : "not configured"}</dd>
          </dl>
        </div>
      )}
      <div className="card col">
        <h2>Keyboard</h2>
        <div className="muted small">
          On desktop: <kbd>t</kbd> today, <kbd>a</kbd> assistant, <kbd>c</kbd> capture, <kbd>n</kbd> now, <kbd>w</kbd> week, <kbd>/</kbd> search, <kbd>Esc</kbd> closes banners and editors, <kbd>Alt</kbd>+arrows reorder tasks.
        </div>
      </div>
    </SubPage>
  );
}
