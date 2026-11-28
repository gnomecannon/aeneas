/** The notification plugin's calls that decide and send (`@tauri-apps/plugin-notification`), apart so the rule is testable. */
export interface NotifyApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(o: { title: string; body: string }): void;
}

/**
 * Sends a system notification only once the system allows it, and asks only when `ask` is set: by the place where the
 * person turns notifications on (Settings, Notifications). Asking from any notification made Windows and Android
 * prompt at launch, for a reminder that was already due; without permission the app's own banner is the alert.
 * `before` runs just before sending (the screen a click opens). True when it was sent.
 */
export async function notifyWith(n: NotifyApi, title: string, body: string, ask = false, before?: () => Promise<void>): Promise<boolean> {
  let ok = await n.isPermissionGranted();
  if (!ok && ask) ok = (await n.requestPermission()) === "granted";
  if (!ok) return false;
  await before?.();
  n.sendNotification({ title, body });
  return true;
}
