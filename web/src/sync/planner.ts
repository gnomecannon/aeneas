/**
 * Planner actions and the offline fallbacks. Scheduling goes through the hub (`/planner/schedule`,
 * 409 on a conflict unless forced); with the hub unreachable the same rules run against the local
 * copy and the block is written through the normal entity path, so a plan made on the train still
 * lands in the outbox.
 */
import type { Entity } from "@everythingapp/shared";
import { taskAlertAt } from "@everythingapp/shared";
import { db } from "./db";
import { engine } from "./engine";
import { HubError } from "./api";
import { createEntity, updateEntity } from "./edits";
import { HOUR } from "../lib/time";
import {
  addDays,
  blockOf,
  buildDigest,
  commitmentsFor,
  daySpan,
  findConflict,
  freeSlots,
  localDate,
  mondayOf,
  overlaps,
  parseDue,
  parseLocalDate,
  reminderOnDate,
  spanOf,
  watchesDueSoon,
  type Block,
  type Conflict,
  type PlannerDay,
  type PlannerToday,
  type PlannerWeek,
  type Span,
} from "../lib/planner";

const isNetworkError = (e: unknown) => !(e instanceof HubError);

async function liveOf(kinds: string[]): Promise<Entity[]> {
  const rows = await db.entities.where("kind").anyOf(kinds).toArray();
  return rows.filter((e) => !e.deleted_at);
}

function localBlocks(tasks: Entity[], exceptTaskId?: string): Block[] {
  return tasks
    .filter((t) => t.id !== exceptTaskId && t.fields.status !== "done")
    .map(blockOf)
    .filter((b): b is Block => !!b);
}

export async function localConflict(taskId: string, span: Span): Promise<Conflict | null> {
  const [tasks, events, rules] = await Promise.all([liveOf(["task"]), liveOf(["event"]), liveOf(["plan_rule"])]);
  const busy: Conflict[] = localBlocks(tasks, taskId).map((b) => ({ kind: "block", title: b.title, start: b.start, end: b.end }));
  // All-day events are markers, as on the hub: they never clash and never take free time.
  for (const e of events) if (e.fields.all_day !== true) busy.push({ kind: "event", title: String(e.fields.title ?? ""), ...spanOf(e) });
  for (let d = parseLocalDate(localDate(new Date(span.start))); d.toISOString() < span.end; d = addDays(d, 1))
    for (const c of commitmentsFor(rules, d)) if (c.type !== "preference") busy.push({ kind: c.type === "blackout" ? "blackout" : "commitment", title: c.title, start: c.start, end: c.end });
  return findConflict(span, busy.sort((a, b) => (a.start < b.start ? -1 : 1)));
}

/** Schedule a block. Throws HubError 409 with `detail` = the conflict unless `force`. */
export async function scheduleTask(taskId: string, start: string, hours = 3, force = false): Promise<Entity> {
  if (engine.client) {
    try {
      const t = await engine.client.plannerSchedule(taskId, start, hours, force);
      await engine.absorb([t]);
      return t;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  const task = await db.entities.get(taskId);
  if (!task || task.kind !== "task") throw new HubError(404, "task not found");
  const span = { start: new Date(start).toISOString(), end: new Date(new Date(start).getTime() + hours * HOUR).toISOString() };
  const conflict = await localConflict(taskId, span);
  if (conflict && !force) throw new HubError(409, `conflicts with ${conflict.title}`, conflict);
  return updateEntity(task, { block: span, status: task.fields.status === "doing" ? "doing" : "scheduled" });
}

export async function unscheduleTask(task: Entity): Promise<Entity> {
  if (engine.client) {
    try {
      const t = await engine.client.plannerUnschedule(task.id);
      await engine.absorb([t]);
      return t;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  const next = (await liveOf(["task"])).filter((t) => t.fields.status === "next");
  const maxOrder = Math.max(0, ...next.map((t) => Number(t.fields.order) || 0));
  return updateEntity(task, { block: null, status: "next", order: task.fields.status === "next" ? task.fields.order : maxOrder + 1 });
}

/** Mark a watch renewed. Hub only: the roll-forward and the reminder re-plan are the hub's job. */
export async function renewWatch(w: Entity): Promise<Entity> {
  const c = engine.client;
  if (!c) throw new Error("Needs the hub.");
  const out = await c.watchRenewed(w.id);
  await engine.absorb([out]);
  if (out.fields.reminder_id) await engine.refetch(String(out.fields.reminder_id)).catch(() => undefined);
  return out;
}

/** Close an activity with an `end` log of the same value. Through the hub when it answers, else the entity path. */
export async function stopActivity(value: string | number, source: string): Promise<Entity> {
  if (engine.client) {
    try {
      const l = await engine.client.log({ type: "activity", value, note: "end" });
      await engine.absorb([l]);
      return l;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  return createEntity("log", { type: "activity", value, at: new Date().toISOString(), note: "end", source });
}

// ---------- offline fallbacks, same shapes as the hub routes ----------
function dayFrom(date: Date, tasks: Entity[], events: Entity[], rules: Entity[], reminders: Entity[], watches: Entity[], minHours = 3): PlannerDay {
  const d = daySpan(date);
  const blocks = localBlocks(tasks).filter((b) => overlaps(b, d)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const evs = events.filter((e) => overlaps(spanOf(e), d));
  const commitments = commitmentsFor(rules, date);
  const rems = reminders.filter((r) => reminderOnDate(r, date)).sort((a, b) => ((taskAlertAt(a.fields) ?? "") < (taskAlertAt(b.fields) ?? "") ? -1 : 1));
  const ds = localDate(date);
  const watches_due = watches.filter((w) => w.fields.due && localDate(parseDue(String(w.fields.due))) === ds);
  const busy: Span[] = [...blocks, ...evs.filter((e) => e.fields.all_day !== true).map(spanOf), ...commitments.filter((c) => c.type !== "preference")];
  return { date: ds, blocks, events: evs, commitments, reminders: rems, watches_due, free_slots: freeSlots(date, busy, minHours) };
}

export async function localToday(): Promise<PlannerToday> {
  const at = new Date();
  // Reminders are tasks with a reminder time, so the task list serves both.
  const [tasks, events, rules, watches, captures] = await Promise.all([liveOf(["task"]), liveOf(["event"]), liveOf(["plan_rule"]), liveOf(["watch"]), liveOf(["capture"])]);
  const day = dayFrom(at, tasks, events, rules, tasks, watches);
  const doing = tasks.filter((t) => t.fields.status === "doing").sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  const next = tasks.filter((t) => t.fields.status === "next").sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  const now = doing[0] ?? next[0] ?? null;
  const base = {
    now,
    blocks: day.blocks,
    commitments: day.commitments,
    reminders_due: day.reminders,
    watches_due_soon: watchesDueSoon(watches, at),
    captures_unprocessed: captures.filter((c) => !c.fields.processed).length,
    free_slots: day.free_slots,
  };
  return { date: day.date, next: doing.length ? next : next.slice(1), ...base, digest: buildDigest(base, at) };
}

export async function localWeek(start: string): Promise<PlannerWeek> {
  const mon = mondayOf(parseLocalDate(start));
  const [tasks, events, rules, watches] = await Promise.all([liveOf(["task"]), liveOf(["event"]), liveOf(["plan_rule"]), liveOf(["watch"])]);
  const days: PlannerDay[] = [];
  for (let i = 0; i < 7; i++) days.push(dayFrom(addDays(mon, i), tasks, events, rules, tasks, watches));
  return { start: localDate(mon), days };
}

/** Message for a 409 from schedule: what it hit and when. */
export function conflictMessage(e: unknown): string | null {
  if (!(e instanceof HubError) || e.status !== 409) return null;
  // The hub sends `{ error: "conflict", conflict: { type, title, start, end } }`.
  const raw = e.detail as { conflict?: Partial<Conflict> & { type?: string } } & Partial<Conflict> & { type?: string } | undefined;
  const d = raw?.conflict ?? raw;
  if (d?.title && d.start && d.end) {
    const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `Overlaps ${d.type ?? d.kind ?? "something"}: ${d.title}, ${t(d.start)} to ${t(d.end)}.`;
  }
  return e.message || "Overlaps something already planned.";
}
