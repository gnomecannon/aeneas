import { notifyWith } from "./notifyGate";

/** Thin wrapper around Tauri APIs. Every call is a no-op in a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** The Android app (Tauri on Android): one window, no tray, widget or global shortcut. */
export const isAndroid = isTauri && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
/** The Windows app (Tauri on a desktop): tray, Now and next widget, global Capture shortcut, start at login. */
export const isWindowsApp = isTauri && !isAndroid;

export async function windowLabel(): Promise<string> {
  if (!isTauri) return "main";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/** Opens or closes the Now and next widget, a small window that stays on top. It comes back after a restart if it was open. */
export async function setWidget(open: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_widget", { open });
}

/**
 * The global Capture shortcut on this computer: "Control+Shift+Space" (the default, as on the Mac), the other choices
 * in CAPTURE_SHORTCUTS, or "off". Null in a browser.
 */
export const CAPTURE_SHORTCUTS: { value: string; label: string }[] = [
  { value: "Control+Shift+Space", label: "Ctrl+Shift+Space" },
  { value: "Control+Shift+K", label: "Ctrl+Shift+K" },
  { value: "Alt+Shift+Space", label: "Alt+Shift+Space" },
  { value: "off", label: "Off" },
];

export async function getCaptureShortcut(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_capture_shortcut");
}

/** Registers the chosen shortcut (or none) and keeps it for the next start. Throws when another app holds it. */
export async function setCaptureShortcut(shortcut: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_capture_shortcut", { shortcut });
}

export async function getWidget(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<boolean>("get_widget")) ?? false;
}

export async function onWidgetChanged(cb: (open: boolean) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<boolean>("widget-changed", (e) => cb(e.payload));
}

/** Brings the main window forward, optionally on a screen. In a browser it just changes the screen. */
export async function showMainWindow(path?: string): Promise<void> {
  if (!isTauri) {
    if (path) window.location.hash = path;
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("show_main_window", { path: path ?? null });
}

export async function openCaptureWindow(): Promise<void> {
  if (!isTauri) {
    window.location.hash = "/capture";
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_capture_window");
}

/**
 * A screen in a window of its own (for a second monitor), without the sidebar. On Windows a new app window;
 * in a browser a popup window.
 */
export async function openWindow(path: string, title: string): Promise<void> {
  if (!isTauri) {
    const sep = path.includes("?") ? "&" : "?";
    window.open(`${window.location.pathname}#${path}${sep}pop=1`, "_blank", "popup,width=560,height=720");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_window", { path, title });
}

export async function closeCurrentWindow(): Promise<void> {
  if (!isTauri) {
    window.close();
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export async function onNavigate(cb: (path: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("navigate", (e) => cb(e.payload));
}

export async function hideCurrentWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

/**
 * Native notification, sent only once Windows or Android allows it (notifyGate.ts): nothing here asks, so the app never
 * prompts at launch; `ask` is for Settings, Notifications, where the person turns them on. True when it was sent.
 * Clicking a Windows toast starts the app again; the running copy catches that second start, comes forward and opens
 * `path` (the screen the notification is about) if it was sent in the last 15 minutes.
 */
export async function notify(title: string, body: string, path?: string, { ask = false }: { ask?: boolean } = {}): Promise<boolean> {
  if (!isTauri) return false;
  const n = await import("@tauri-apps/plugin-notification");
  return notifyWith(n, title, body, ask, path ? async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_notify_target", { path }).catch(() => {});
  } : undefined);
}

/** Whether Windows lets the app show notifications. `ask` requests it when not granted yet. Null outside the desktop app. */
export async function notificationsAllowed(ask = false): Promise<boolean | null> {
  if (!isTauri) return null;
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok && ask) ok = (await n.requestPermission()) === "granted";
  return ok;
}

/**
 * Saving a newer app's installer in the app (src-tauri/src/appupdate.rs), piece by piece so a phone never holds the
 * whole file: begin, then each piece, then finish, which checks it against the release key and starts it. Finish
 * answers "installing" on Windows (the app quits and the new one opens), "prompted" on Android (Android's own install
 * prompt is up), or "permission" (Android first asks whether Aeneas may install apps). Each throws with the reason.
 */
export const appUpdateFile = {
  async begin(platform: string, version: string): Promise<void> {
    if (!isTauri) throw new Error("Only the Windows and Android apps install updates.");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_begin", { platform, version });
  },
  async piece(bytes: Uint8Array): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_chunk", { b64: toBase64(bytes) });
  },
  async finish(signature: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("update_finish", { signature });
  },
};

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Runs a command a helper sent through the hub on this computer (src-tauri/src/helper.rs). Windows and desktop apps only. */
export async function runHelperCommand(command: string, timeoutS: number): Promise<{ exit_code: number; output: string }> {
  if (!isTauri || isAndroid) throw new Error("only the Windows app runs commands for a helper");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ exit_code: number; output: string }>("run_helper_command", { command, timeoutS });
}

/** Signs in to another device in the home over SSH and runs a command there, for a helper (src-tauri/src/helper.rs). */
export async function sshHelperCommand(job: { ip: string; port: number; username: string; password: string; host_key?: string }, command: string, timeoutS: number): Promise<{ exit_code: number; output: string; host_key: string }> {
  if (!isTauri || isAndroid) throw new Error("only the Windows app signs in to other devices for a helper");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("ssh_helper_command", { ip: job.ip, port: job.port, username: job.username, password: job.password, command, timeoutS, hostKey: job.host_key ?? null });
}

/** The devices on this device's home network (src-tauri/src/helper.rs): about 20 seconds. Windows and Android apps. */
export async function scanHomeNetwork(): Promise<{ network: string; devices: { name: string; ip: string; open: number[]; kind: string }[] }> {
  if (!isTauri) throw new Error("only the Windows and Android apps look for devices");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("scan_home_network");
}

/** Open a web page in the system browser (Steam sign-in). In a browser tab it opens a new tab. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const o = await import("@tauri-apps/plugin-opener");
  await o.openUrl(url);
}

export async function autostartEnabled(): Promise<boolean> {
  if (!isTauri) return false;
  const a = await import("@tauri-apps/plugin-autostart");
  return a.isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  if (!isTauri) return;
  const a = await import("@tauri-apps/plugin-autostart");
  if (on) await a.enable();
  else await a.disable();
}

/** Shape of <appConfigDir>/config.json, the zero-typing setup file. */
export interface SetupFile {
  hub_url?: string;
  token?: string;
  device_name?: string;
}

export const SETUP_FILE = "config.json";

/** Resolved path of the setup file, for display. Empty in a browser. */
export async function setupFilePath(): Promise<string> {
  if (!isTauri) return "";
  const { appConfigDir, join } = await import("@tauri-apps/api/path");
  return join(await appConfigDir(), SETUP_FILE);
}

/** Reads the setup file; null when it does not exist. Throws on unreadable or malformed JSON. */
export async function readSetupFile(): Promise<SetupFile | null> {
  if (!isTauri) return null;
  const fs = await import("@tauri-apps/plugin-fs");
  const opts = { baseDir: fs.BaseDirectory.AppConfig };
  if (!(await fs.exists(SETUP_FILE, opts))) return null;
  const text = await fs.readTextFile(SETUP_FILE, opts);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("config.json is not an object");
  return parsed as SetupFile;
}

/** Rewrites the setup file without its token field. */
export async function stripSetupToken(): Promise<void> {
  if (!isTauri) return;
  const fs = await import("@tauri-apps/plugin-fs");
  const opts = { baseDir: fs.BaseDirectory.AppConfig };
  const current = await readSetupFile();
  if (!current || !("token" in current)) return;
  const { token: _token, ...rest } = current;
  await fs.writeTextFile(SETUP_FILE, JSON.stringify(rest, null, 2) + "\n", opts);
}

/**
 * Pairing links (`everythingapp://setup?...`, from a QR code scanned with the camera or a link clicked) and a new
 * device's join code (`everythingapp://join?...`, CONTRACT, Devices) that open the Windows or Android app, now and
 * while it runs: `cb` gets the route (`/setup?...` or `/join?...`). Other links are ignored.
 */
export async function onSetupLink(cb: (route: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const take = (urls: string[] | null | undefined) => {
    for (const u of urls ?? []) {
      const route = appLinkRoute(u);
      if (route) { cb(route); return; }
    }
  };
  take(await getCurrent().catch(() => null));
  return onOpenUrl(take);
}

/** The app's route for one of its own links, or null for any other link. */
export function appLinkRoute(url: string): string | null {
  const m = /^everythingapp:\/\/(setup|join)\?(.+)$/i.exec(url.trim());
  return m ? `/${m[1].toLowerCase()}?${m[2]}` : null;
}

/** The QR code a new device shows while it waits for a join (src-tauri/src/join.rs). */
export interface JoinOffer { session: number; node: string; relay: string; secret: string; link: string }

/**
 * Starts waiting for a join (or keeps waiting with a new secret): `onLink` gets the pairing link once a hub's join
 * checks out. Throws with a plain sentence when the endpoint cannot reach a relay. Windows and Android apps only.
 */
export async function startJoin(name: string, platform: "windows" | "android", onLink: (link: string) => void): Promise<JoinOffer> {
  if (!isTauri) throw new Error("Only the Aeneas app can join a hub this way.");
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const onJoin = new Channel<{ kind: "joined"; link: string }>();
  onJoin.onmessage = (ev) => { if (ev.kind === "joined") onLink(ev.link); };
  return invoke<JoinOffer>("join_start", { name, platform, onJoin });
}

/** A new secret and QR code on the endpoint already waiting (every 5 minutes). Throws when none waits. */
export async function renewJoin(): Promise<JoinOffer> {
  if (!isTauri) throw new Error("Only the Aeneas app can join a hub this way.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<JoinOffer>("join_renew");
}

/** Stops waiting for a join, unless a newer start or renewal than `session` came since. */
export async function stopJoin(session?: number): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("join_stop", { session: session ?? null });
}
