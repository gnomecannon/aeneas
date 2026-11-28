import fs from "node:fs";
import path from "node:path";
import { inAppleReminders, type AppleReminderAlerts } from "@everythingapp/shared";
import type { ModuleId } from "./modules.js";
import type { Hub } from "./hub.js";
import { waitingDevices } from "./sources.js";
import { errCode } from "./logsafe.js";

/**
 * Alerts, each optional on its own (since 2026-11-20). Every `notify` event the hub announces has a kind (bus.ts), and
 * the owner can switch each kind off without touching the others or the module it belongs to: reminders without the
 * morning summary, machine alerts without sensor ones, the Mail screen without new-mail alerts.
 *
 * One setting for every device, in `<data>/alerts.json`: `{ "<kind>": false }` for the kinds switched off (a kind
 * missing from the file is on, so a new kind of alert starts on, as its module's own switch already decides whether
 * it exists at all). The hub holds back a switched-off kind where alerts leave it, the `/live` stream (app.ts), so no
 * device shows it, whatever its app's version. Apps that plan alerts themselves (a reminder's local notification on
 * an Apple device, the reminder banner in the web app) read the list from `GET /modules` and plan none for a kind
 * that is off. What the hub does with an event for itself (a sensor's line in a machine's history) is not an alert
 * and goes on.
 *
 * Tasks that are also in Apple Reminders (since 1.0.19) can alert from both: Aeneas, and Apple's Reminders app through
 * the alarm the iPhone and Mac write on the item. The same file holds two more switches for them,
 * `"apple_reminder_alerts": { "aeneas": false, "apple": false }` for the ones switched off: Alert from Aeneas
 * (off: no Aeneas alert for a task tied to an Apple item, held back here and by the apps) and Alert from Apple
 * Reminders (off: updated apps write those items with no alarm with a time and take such alarms off). The second takes
 * effect only once every iPhone, iPad and Mac runs 1.0.19 or later, since an older app reads an item with no alarm as
 * one with no reminder time and would take the time off the task.
 */
export interface AlertKind { id: string; title: string; summary: string; module: ModuleId | null }

/** In the order Settings lists them. `module`: the module the alert belongs to; apps leave it out while that is off. */
export const ALERT_KINDS: AlertKind[] = [
  { id: "reminder", title: "Reminders", summary: "A reminder's time has come.", module: "notifications" },
  { id: "digest", title: "Morning summary", summary: "Today's plan, once each morning.", module: "notifications" },
  { id: "activity", title: "Activity check-ins", summary: "You have been on one activity for a long stretch: still on it?", module: null },
  { id: "mail", title: "New mail", summary: "New mail on the Mail screen. Whose mail alerts you, and how much an alert says, is set on the Mail screen.", module: "mail_inbox" },
  { id: "monitor", title: "Machines and services", summary: "A machine, service or backup went down, or came back.", module: "homelab" },
  { id: "sensor", title: "Sensor readings", summary: "A reading went out of its bounds, stopped coming, or came back.", module: "sensors" },
  { id: "disk", title: "Hub disk space", summary: "The disk with the hub's data is almost full.", module: null },
  { id: "connection", title: "Accounts and connections", summary: "An account or service stopped signing in or syncing, once when it happens.", module: null },
  { id: "quiz", title: "Recall quiz", summary: "The day's quiz questions are ready.", module: "quiz" },
];
const KNOWN = new Set(ALERT_KINDS.map((k) => k.id));

/** The key, in the file and in the API, of the two switches for tasks also in Apple Reminders. */
export const APPLE_REMINDER_ALERTS = "apple_reminder_alerts";
/** The first app version that writes Apple Reminders items without an alarm when asked, and reads them back. */
export const APPLE_ALARMS_MIN_VERSION = "1.0.19";
export interface AppleReminderChoices { aeneas: boolean; apple: boolean }

export interface AlertView { id: string; title: string; summary: string; module?: ModuleId; on: boolean }

interface Stored { kinds: Record<string, boolean>; apple: Partial<Record<keyof AppleReminderChoices, false>> }

export class AlertStore {
  private cache: Stored | null = null;
  private listeners = new Set<() => void>();
  /** The Apple Reminders switches as the devices were last told (`tellIfChanged`). */
  private told: string | null = null;

  constructor(private file: string) {}

  private read(): Stored {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      const kinds = Object.fromEntries(Object.entries(raw).filter(([k, v]) => KNOWN.has(k) && typeof v === "boolean")) as Record<string, boolean>;
      const a = raw[APPLE_REMINDER_ALERTS] as Record<string, unknown> | undefined;
      const apple: Stored["apple"] = {};
      if (a && typeof a === "object" && !Array.isArray(a)) {
        if (a.aeneas === false) apple.aeneas = false;
        if (a.apple === false) apple.apple = false;
      }
      this.cache = { kinds, apple };
    } catch (e) {
      // No file is the start: every kind on. A damaged one is left on disk to mend and counts as every kind on, so
      // no alert goes missing over it.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[alerts] alerts.json could not be read (${errCode(e)}); every kind of alert counts as on`);
      this.cache = { kinds: {}, apple: {} };
    }
    return this.cache;
  }

  /** Whether alerts of this kind go to devices. A kind the hub does not list is on. */
  on(kind: string): boolean { return this.read().kinds[kind] !== false; }

  /** The owner's two switches for tasks also in Apple Reminders, as chosen (both on until switched off). */
  appleChoices(): AppleReminderChoices {
    const a = this.read().apple;
    return { aeneas: a.aeneas !== false, apple: a.apple !== false };
  }

  list(): AlertView[] {
    return ALERT_KINDS.map((k) => ({ id: k.id, title: k.title, summary: k.summary, ...(k.module ? { module: k.module } : {}), on: this.on(k.id) }));
  }

  /**
   * Switch kinds on or off: `{ "<kind>": true|false }`, and the switches for tasks also in Apple Reminders:
   * `{ "apple_reminder_alerts": { "aeneas"?: true|false, "apple"?: true|false } }`. Anything unknown or not true or
   * false refuses the whole body, and nothing is saved.
   */
  set(changes: Record<string, unknown>): AlertView[] {
    const cur = this.read();
    const next: Stored = { kinds: { ...cur.kinds }, apple: { ...cur.apple } };
    for (const [k, v] of Object.entries(changes)) {
      if (k === APPLE_REMINDER_ALERTS) {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${k} must be { aeneas, apple }, each true or false`);
        for (const [which, on] of Object.entries(v as Record<string, unknown>)) {
          if (which !== "aeneas" && which !== "apple") throw new Error(`${k}: unknown switch ${which.slice(0, 40)}; it has aeneas and apple`);
          if (typeof on !== "boolean") throw new Error(`${k}.${which} must be true or false`);
          if (on) delete next.apple[which]; else next.apple[which] = false;
        }
        continue;
      }
      if (!KNOWN.has(k)) throw new Error(`unknown kind of alert: ${k.slice(0, 40)}`);
      if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      if (v) delete next.kinds[k]; else next.kinds[k] = false;
    }
    const file: Record<string, unknown> = { ...next.kinds };
    if (Object.keys(next.apple).length) file[APPLE_REMINDER_ALERTS] = next.apple;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = next;
    this.emit();
    return this.list();
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  /** Tell the devices again when the Apple Reminders switches, as they see them, are not what they were last told:
   * a device updated, paired or removed can let Alert from Apple Reminders off take effect, or hold it back. */
  tellIfChanged(view: AppleReminderAlerts): void {
    const text = JSON.stringify(view);
    if (text === this.told) return;
    this.told = text;
    this.emit();
  }

  private emit(): void {
    for (const f of this.listeners) { try { f(); } catch (e) { console.error(`[alerts] a listener failed: ${errCode(e)}`); } }
  }
}

/**
 * The switches for tasks also in Apple Reminders as devices see them. Alert from Apple Reminders off takes effect
 * (`apple_alarms: false`) only while no iPhone, iPad or Mac on this hub runs an app older than 1.0.19 (`waiting`).
 */
export function appleReminderAlerts(hub: Hub): AppleReminderAlerts {
  const c = hub.alerts.appleChoices();
  const waiting = c.apple ? [] : waitingDevices(hub, APPLE_ALARMS_MIN_VERSION);
  return { aeneas: c.aeneas, apple: c.apple, apple_alarms: c.apple || waiting.length > 0, waiting, needs: APPLE_ALARMS_MIN_VERSION };
}

/** What `GET /modules`, `PUT /modules/alerts` and the `modules` event on `/live` carry beside the module switches. */
export function alertsBody(hub: Hub): { alerts: AlertView[]; apple_reminder_alerts: AppleReminderAlerts } {
  return { alerts: hub.alerts.list(), apple_reminder_alerts: appleReminderAlerts(hub) };
}

/** After a device was paired, removed or renamed, or said which version it runs. */
export function alertsChanged(hub: Hub): void {
  try { hub.alerts.tellIfChanged(appleReminderAlerts(hub)); } catch (e) { console.error(`[alerts] ${errCode(e)}`); }
}

/**
 * Whether a `notify` event goes to the devices: its kind is on, and a reminder for a task tied to an Apple Reminders
 * item is held back while Alert from Aeneas is off (Apple's Reminders app alerts for it, if that is on).
 */
export function alertGoesOut(hub: Hub, e: { kind: string; id?: string }): boolean {
  if (!hub.alerts.on(e.kind)) return false;
  if (e.kind !== "reminder" || !e.id || hub.alerts.appleChoices().aeneas) return true;
  const t = hub.store.get(e.id);
  return !t || !inAppleReminders(t.fields);
}
