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

const DAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/**
 * A repeat rule (contract section 2, `every 1 months`) in words: "every month", "every 2 weeks on Mon and Thu",
 * "every weekday", "every month on day 15". Anything it cannot read stays as written. The same words as EACore
 * `RepeatRule.words`.
 */
export function repeatWords(rule: string | undefined | null): string {
  const r = (rule ?? "").trim();
  const m = /^every (\d+) (minute|hour|day|week|month|year)s( on ([a-z0-9,]+))?$/.exec(r);
  if (!m) return r;
  const n = Number(m[1]);
  const every = n === 1 ? `every ${m[2]}` : `every ${n} ${m[2]}s`;
  const on = m[4];
  if (!on) return every;
  const days = on.split(",");
  if (m[2] === "week" && days.every((d) => d in DAY_NAMES)) {
    if (n === 1 && days.join(",") === "mon,tue,wed,thu,fri") return "every weekday";
    const names = days.map((d) => DAY_NAMES[d]);
    return `${every} on ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}`;
  }
  const day = /^day(\d{1,2})$/.exec(on);
  if (m[2] === "month" && day) return `${every} on day ${Number(day[1])}`;
  return r;
}
