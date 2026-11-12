/** Thin wrapper around Tauri APIs. Every call is a no-op in a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** The Android app (Tauri on Android): one window, no tray, widget or global shortcut. */
export const isAndroid = isTauri && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
/** The Windows app (Tauri on a desktop): tray, Now widget, global Capture shortcut, start at login. */
export const isWindowsApp = isTauri && !isAndroid;

export async function windowLabel(): Promise<string> {
  if (!isTauri) return "main";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/** Opens or closes the Now widget, a small window that stays on top. It comes back after a restart if it was open. */
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
 * Native notification. Clicking a Windows toast starts the app again; the running copy catches that second start,
 * comes forward and opens `path` (the screen the notification is about) if it was sent in the last 15 minutes.
 */
export async function notify(title: string, body: string, path?: string): Promise<void> {
  if (!isTauri) return;
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === "granted";
  if (!ok) return;
  if (path) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_notify_target", { path }).catch(() => {});
  }
  n.sendNotification({ title, body });
}

/** Whether Windows lets the app show notifications. `ask` requests it when not granted yet. Null outside the desktop app. */
export async function notificationsAllowed(ask = false): Promise<boolean | null> {
  if (!isTauri) return null;
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok && ask) ok = (await n.requestPermission()) === "granted";
  return ok;
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
 * Pairing links (`everythingapp://setup?...`, from a QR code scanned with the camera or a link clicked) that open the
 * Windows or Android app, now and while it runs: `cb` gets the setup route (`/setup?...`). Other links are ignored.
 */
export async function onSetupLink(cb: (route: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const take = (urls: string[] | null | undefined) => {
    for (const u of urls ?? []) {
      const m = /^everythingapp:\/\/setup\?(.+)$/i.exec(u.trim());
      if (m) { cb(`/setup?${m[1]}`); return; }
    }
  };
  take(await getCurrent().catch(() => null));
  return onOpenUrl(take);
}
