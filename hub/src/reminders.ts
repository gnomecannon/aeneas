import { completeTaskPatch, nowIso, taskAlertAt } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Store } from "./store.js";
import type { Bus } from "./bus.js";
import { StoreError } from "./store.js";
import { stableId } from "./imports/util.js";
import { errCode } from "./logsafe.js";

/*
 * Reminders are tasks (since 2026-10-28): a task with `remind_at` notifies at that time, `repeat` moves it on when
 * it is done, and `friction: "reason"` asks why on every snooze. The older `reminder` kind is turned into tasks
 * once at start (migrateRemindersToTasks) and nothing writes it any more.
 */

/** One pass of the reminder loop. Fires every due reminder time of an open task exactly once. Returns fired ids. */
export function reminderTick(store: Store, bus: Bus, now: Date = new Date()): string[] {
  const nowStr = now.toISOString();
  const fired: string[] = [];
  for (const t of store.list({ kind: "task" })) {
    const eff = taskAlertAt(t.fields);
    if (!eff || eff > nowStr) continue;
    const firedList = Array.isArray(t.fields.fired) ? (t.fields.fired as string[]) : [];
    if (firedList.includes(eff)) continue;
    store.patchSilent(t.id, { fired: [...firedList.slice(-20), eff] });
    bus.emit("notify", { id: t.id, kind: "reminder", title: String(t.fields.title ?? ""), at: eff, friction: String(t.fields.friction ?? "none") });
    fired.push(t.id);
  }
  return fired;
}

export function startReminderLoop(store: Store, bus: Bus, intervalMs: number): () => void {
  const run = () => {
    // An older app may still write the old reminder kind; it becomes a task on the next tick.
    try { migrateRemindersToTasks(store); reminderTick(store, bus); } catch (e) { console.error(`[reminders] tick failed: ${errCode(e)}`); }
  };
  run();
  const t = setInterval(run, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

function taskWithReminder(store: Store, id: string): Entity {
  const t = store.get(id);
  if (!t || t.deleted_at || t.kind !== "task") throw new StoreError(404, "task not found");
  return t;
}

export interface SnoozeOpts { until: string; reason?: string }

/** Snooze a task's reminder with friction enforcement. Throws 422 when a reason is required and missing. */
export async function snoozeReminder(store: Store, id: string, opts: SnoozeOpts): Promise<Entity> {
  const t = taskWithReminder(store, id);
  if (!opts.until || Number.isNaN(new Date(opts.until).getTime())) throw new StoreError(422, "until must be an ISO datetime");
  const friction = String(t.fields.friction ?? "none");
  const reason = (opts.reason ?? "").trim();
  if (friction !== "none" && !reason) {
    throw new StoreError(422, "this reminder requires a typed reason to snooze");
  }
  const log = Array.isArray(t.fields.snooze_log) ? t.fields.snooze_log : [];
  const entry = { at: nowIso(), until: opts.until, reason };
  return store.patch(id, { snoozed_until: opts.until, snooze_log: [...log, entry] });
}

/** Done from a notification. A repeating task moves to its next time and stays open; anything else is done. */
export function ackReminder(store: Store, id: string, now: Date = new Date()): Entity {
  const t = taskWithReminder(store, id);
  return store.patch(id, completeTaskPatch(t.fields, now));
}

/** The task an item (renewal, pet event, job application) owns: by its `reminder_id`, else by the task's `linked_id`. */
export function linkedTask(store: Store, owner: Entity): Entity | null {
  const byId = typeof owner.fields.reminder_id === "string" ? store.get(owner.fields.reminder_id) : null;
  if (byId && byId.kind === "task" && !byId.deleted_at) return byId;
  return store.list({ kind: "task", limit: 100000 }).find((t) => t.fields.linked_id === owner.id) ?? null;
}

export interface LinkedWant { title: string; remind_at: string; friction: "none" | "reason"; due?: string; repeat?: string }

/**
 * Make the task an item owns match `want`: create it, move it (a new time reopens a finished one and clears a
 * snooze, so the new plan fires), or with `want` null delete it and clear the item's `reminder_id`.
 */
export function syncLinkedTask(store: Store, owner: Entity, want: LinkedWant | null, deletedAt?: string): Entity | null {
  const existing = linkedTask(store, owner);
  if (!want) {
    if (existing) store.patch(existing.id, { deleted_at: deletedAt ?? nowIso() });
    if (owner.fields.reminder_id !== undefined && !owner.deleted_at) store.patch(owner.id, { reminder_id: null });
    return null;
  }
  const fields: Record<string, unknown> = { ...want, linked_id: owner.id };
  if (!existing) {
    const made = store.create("task", { ...fields, status: "scheduled", order: Date.now() });
    store.patch(owner.id, { reminder_id: made.id });
    return made;
  }
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (existing.fields[k] !== v) diff[k] = v;
  if (diff.remind_at !== undefined) {
    diff.snoozed_until = null;
    if (existing.fields.status === "done") { diff.status = "scheduled"; diff.done_at = null; }
  }
  const synced = Object.keys(diff).length ? store.patch(existing.id, diff) : existing;
  if (owner.fields.reminder_id !== existing.id) store.patch(owner.id, { reminder_id: existing.id });
  return synced;
}

/** The task id an older reminder becomes. Stable, so every device and a rerun agree. */
export const taskIdForReminder = (reminderId: string) => stableId(`task-from-reminder:${reminderId}`);

/**
 * Turns every live `reminder` into a task with the same title, time, repeat, friction, snoozes and link, then
 * deletes the reminder. Items pointing at a reminder (`reminder_id`) are pointed at the task. Finished one-off
 * reminders become done tasks. Safe to run on every start: once done there is nothing left to move.
 */
export function migrateRemindersToTasks(store: Store): number {
  const reminders = store.list({ kind: "reminder", limit: 1_000_000 });
  if (!reminders.length) return 0;
  const owners = ["watch", "pet_event", "application"].flatMap((k) => store.list({ kind: k, limit: 1_000_000 }));
  const now = nowIso();
  let n = 0;
  for (const r of reminders) {
    const f = r.fields;
    const id = taskIdForReminder(r.id);
    const finished = !!f.acknowledged_at && !f.repeat;
    const fields: Record<string, unknown> = {
      title: String(f.title ?? "Reminder"),
      status: finished ? "done" : "scheduled",
      order: Date.parse(r.created_at) || Date.now(),
    };
    if (typeof f.at === "string") fields.remind_at = f.at;
    for (const k of ["repeat", "friction", "snoozed_until", "snooze_log", "fired", "linked_id"]) if (f[k] !== undefined && f[k] !== null) fields[k] = f[k];
    if (finished) fields.done_at = String(f.acknowledged_at);
    if (!store.get(id)) store.create("task", fields, r.space, id);
    for (const o of owners) if (o.fields.reminder_id === r.id) store.patch(o.id, { reminder_id: id });
    store.patch(r.id, { deleted_at: now });
    n++;
  }
  console.log(`[reminders] ${n} reminder(s) became tasks`);
  return n;
}

/** Open tasks with a reminder time, each with when it notifies next (counting a snooze), soonest first. */
export function pendingReminders(store: Store): Array<{ t: Entity; eff: string }> {
  const out: Array<{ t: Entity; eff: string }> = [];
  for (const t of store.list({ kind: "task", limit: 1_000_000 })) {
    const eff = taskAlertAt(t.fields);
    if (eff) out.push({ t, eff });
  }
  return out.sort((a, b) => a.eff.localeCompare(b.eff));
}
