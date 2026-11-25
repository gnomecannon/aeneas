import { useEffect, useState } from "react";
import { aeneasAlerts, type AppleReminderAlerts, type Entity } from "@everythingapp/shared";
import type { AlertInfo } from "../sync/api";
import { engine } from "../sync/engine";

/**
 * Which kinds of alert are on (GET /modules, `alerts`): one setting for every device, each kind switched on its own
 * in Settings, Notifications. The hub holds back a switched-off kind, so most alerts need nothing here; this is for
 * the alerts this app makes itself from its own copy (the reminder banner) and for the settings page. Kept for the
 * next visit, refreshed on open and whenever a device changes a switch. A kind not known counts as on, and so does
 * every kind on a hub too old to list them.
 *
 * Beside them, the two switches for tasks also in Apple Reminders (`apple_reminder_alerts`, hubs since 1.0.19): with
 * Alert from Aeneas off, the banner leaves out a task tied to an Apple Reminders item. Null on an older hub: every
 * task alerts, and Settings shows no section for them.
 */
const KEY = "ea-alerts";
const APPLE_KEY = "ea-apple-reminder-alerts";
let cached: AlertInfo[] | null = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as AlertInfo[] | null; } catch { return null; }
})();
let cachedApple: AppleReminderAlerts | null = (() => {
  try { return JSON.parse(localStorage.getItem(APPLE_KEY) ?? "null") as AppleReminderAlerts | null; } catch { return null; }
})();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let subscribed = false;

function keep(list: AlertInfo[], apple: AppleReminderAlerts | null): void {
  cached = list;
  cachedApple = apple;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    if (apple) localStorage.setItem(APPLE_KEY, JSON.stringify(apple)); else localStorage.removeItem(APPLE_KEY);
  } catch { /* private window */ }
  listeners.forEach((f) => f());
}

export function refreshAlerts(): Promise<void> {
  const c = engine.client;
  if (!subscribed) { subscribed = true; engine.onAlerts(keep); }
  if (!c) return Promise.resolve();
  loading ??= c.modules().then((r) => { if (Array.isArray(r.alerts)) keep(r.alerts, r.apple_reminder_alerts ?? null); }).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}

/** Switch kinds of alert on or off for every device; the answer becomes the list. */
export async function setAlerts(changes: Record<string, boolean>): Promise<AlertInfo[]> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const r = await c.setAlerts(changes);
  keep(r.alerts, r.apple_reminder_alerts ?? null);
  return r.alerts;
}

/** Switch Alert from Aeneas or Alert from Apple Reminders for every device; the answer becomes the setting. */
export async function setAppleReminderAlerts(change: { aeneas?: boolean; apple?: boolean }): Promise<AppleReminderAlerts | null> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const r = await c.setAppleReminderAlerts(change);
  keep(r.alerts, r.apple_reminder_alerts ?? null);
  return r.apple_reminder_alerts ?? null;
}

/** Whether a kind of alert is on in a list (a kind the list does not have is on, and so is every kind with no list). */
export function alertOn(list: AlertInfo[] | null, kind: string): boolean {
  const a = list?.find((x) => x.id === kind);
  return a ? a.on : true;
}

/** The switches to list: every kind whose module is on (a kind of no module always shows). */
export function shownAlerts(list: AlertInfo[] | null, moduleOn: (id: string | undefined) => boolean): AlertInfo[] {
  return (list ?? []).filter((a) => moduleOn(a.module));
}

/**
 * The tasks this app alerts for itself (the banner, and the Windows notification with it): every task, except one
 * tied to an Apple Reminders item while Alert from Aeneas is off. Apple's Reminders app alerts for that one, if its
 * own switch is on.
 */
export function tasksAlertingHere<T extends Pick<Entity, "fields">>(tasks: T[], apple: AppleReminderAlerts | null): T[] {
  return apple && !apple.aeneas ? tasks.filter((t) => aeneasAlerts(t.fields, apple)) : tasks;
}

/** The line under Alert from Apple Reminders while it is off but waits for devices to update; null when nothing waits. */
export function appleAlarmsWaiting(apple: AppleReminderAlerts | null): string | null {
  if (!apple || apple.apple || !apple.apple_alarms || !apple.waiting.length) return null;
  const names = apple.waiting.map((w) => (w.version ? `${w.name} (${w.version})` : w.name)).join(", ");
  return `Apple Reminders keeps its alerts until every iPhone, iPad and Mac runs ${apple.needs} or later. Still to update: ${names}.`;
}

/** The alert list (null until known, or on an older hub) and a checker; rerenders when any switch changes. */
export function useAlerts(): { list: AlertInfo[] | null; on: (kind: string) => boolean; apple: AppleReminderAlerts | null } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    void refreshAlerts();
    return () => { listeners.delete(f); };
  }, []);
  const list = cached;
  return { list, on: (kind) => alertOn(list, kind), apple: cachedApple };
}
