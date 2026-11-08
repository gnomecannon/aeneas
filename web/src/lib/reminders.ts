import type { Entity } from "@everythingapp/shared";
import { taskAlertAt } from "@everythingapp/shared";

/*
 * Reminders are tasks with a reminder time (`remind_at`); a snooze moves when it notifies. These read them from
 * the local copy for banners, Today and the offline planner.
 */

export interface DueReminder {
  entity: Entity;
  at: string;
  key: string;
}

/** When a task notifies next, counting a snooze. Null when it has no reminder, is done or deleted. */
export function alertAt(t: Entity): string | null {
  if (t.deleted_at || t.kind !== "task") return null;
  return taskAlertAt(t.fields);
}

/** Only tasks that have a reminder time. For useEntities filters. */
export const hasReminder = (t: Entity) => typeof t.fields.remind_at === "string" && t.fields.status !== "done";

/** Open tasks whose reminder time has passed, oldest first. */
export function dueReminders(tasks: Entity[], now = new Date()): DueReminder[] {
  const out: DueReminder[] = [];
  for (const t of tasks) {
    const at = alertAt(t);
    if (!at || new Date(at) > now) continue;
    out.push({ entity: t, at, key: `${t.id}:${at}` });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function isDueToday(t: Entity, now = new Date()): boolean {
  const at = alertAt(t);
  if (!at) return false;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const d = new Date(at);
  return d >= start && d < end;
}
