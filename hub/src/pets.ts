import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { eventSpan, localDateOf, mondayOf, ruleAppliesOnWeek } from "./planner.js";
import { reminderTimeFor } from "./watches.js";
import { linkedTask, syncLinkedTask } from "./reminders.js";

/**
 * Module 4, animals. A `pet_event` with `next_due` owns one reminder, `<pet>: <type> due`, planned one day
 * before `next_due` at 09:00 local with friction `none` (the same shape as a watch's renewal reminder).
 * Custody comes from handoffs: the newest `custody` event with `with` (`me` or `other`) says where the pet is
 * since then, and `cycle_days` (see `cycleIn`; a week when nothing says otherwise) predicts the next handoff, which becomes that event's `next_due`
 * and so a reminder the day before. Logging a new handoff on whatever day it really happens resets the cycle.
 * Without any handoff logged, the older `info` plan rule titled `<pet> week` (alternating weeks) still answers.
 */

const DAY_MS = 24 * 3600_000;

export interface Custody {
  with_me_now: boolean | null;
  next_handoff: string | null;
  /** When the current stretch started (the last handoff), when known. */
  since?: string | null;
  cycle_days?: number | null;
  /** The custody event that answers, when custody comes from handoffs. */
  handoff_id?: string | null;
}

export const DEFAULT_CYCLE_DAYS = 7;
export interface PetPlan { id: string; title: string; start: string; all_day: boolean }
export interface PetSummary { pet: string; events_30d: Entity[]; next_due: Entity[]; custody: Custody; plans: PetPlan[] }

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Word edges for any script (\b knows only a-z, digits and _).
const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
const CARE = word("vets?|veterinar\\p{L}*|groom\\p{L}*");

/**
 * A calendar title about the pet: it names them, a vet or a groomer. A name with no Latin letters used to leave an
 * empty choice in the pattern, which matched every title. Chinese and Japanese titles have no spaces between words,
 * so a name in those scripts is found anywhere in the title.
 */
export function petPlanTitle(title: string, pet: string): boolean {
  if (CARE.test(title)) return true;
  const name = pet.trim().replace(/\s+/g, " ");
  if (!name) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)) return title.toLowerCase().includes(name.toLowerCase());
  return word(reEscape(name)).test(title);
}

/**
 * What is on the owner's calendar for the pet in the next 60 days (the monthly heartworm chewable, a vet visit): read from
 * the personal calendar each time, so it is never a second copy to keep in step.
 */
export function petPlans(store: Store, pet: string, now: Date = new Date()): PetPlan[] {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + 60 * DAY_MS);
  return store.list({ kind: "event", space: "personal", limit: 100000 })
    .filter((e) => petPlanTitle(String(e.fields.title ?? ""), pet))
    .map((e) => ({ e, span: eventSpan(e) }))
    .filter((x) => x.span && x.span.end > from && x.span.start < to)
    .sort((a, b) => a.span!.start.getTime() - b.span!.start.getTime())
    .slice(0, 10)
    .map(({ e, span }) => ({ id: e.id, title: String(e.fields.title ?? ""), start: e.fields.all_day === true ? String(e.fields.start).slice(0, 10) : span!.start.toISOString(), all_day: e.fields.all_day === true }));
}

const sameName = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** The task a pet event owns (its reminder). */
export function petReminder(store: Store, ev: Entity): Entity | null {
  return linkedTask(store, ev);
}

/** Make the event's task match `next_due`: create, move, or delete it. Returns the task or null. */
export function syncPetReminder(store: Store, ev: Entity): Entity | null {
  if (ev.kind !== "pet_event") return null;
  const due = typeof ev.fields.next_due === "string" ? ev.fields.next_due : "";
  if (ev.deleted_at || !due || Number.isNaN(localDateOf(due).getTime())) {
    const existing = petReminder(store, ev);
    if (existing) store.patch(existing.id, { deleted_at: ev.deleted_at ?? new Date().toISOString() });
    return null;
  }
  const title = ev.fields.type === "custody" ? `${String(ev.fields.pet ?? "")} handoff tomorrow` : `${String(ev.fields.pet ?? "")}: ${String(ev.fields.type ?? "")} due`;
  return syncLinkedTask(store, ev, { title, remind_at: reminderTimeFor(due, 1), friction: "none" });
}

/** Handoffs (custody events that say where the pet went) for one pet, newest first. */
export function handoffs(store: Store, pet: string): Entity[] {
  return store.list({ kind: "pet_event", limit: 100000 })
    .filter((e) => e.fields.type === "custody" && (e.fields.with === "me" || e.fields.with === "other") && sameName(e.fields.pet, pet) && Number.isFinite(new Date(String(e.fields.at)).getTime()))
    .sort((a, b) => new Date(String(b.fields.at)).getTime() - new Date(String(a.fields.at)).getTime());
}

const ownCycle = (ev: Entity): number | null => (typeof ev.fields.cycle_days === "number" && ev.fields.cycle_days >= 1 ? Math.round(ev.fields.cycle_days) : null);
const atMs = (ev: Entity) => new Date(String(ev.fields.at)).getTime();

/**
 * A handoff's cycle: its own `cycle_days`, else the nearest older handoff's, else the whole days since the handoff
 * before it (1 to 60), else DEFAULT_CYCLE_DAYS. A handoff the assistant or the Watch logs carries no cycle, and it
 * keeps the rhythm already on record instead of falling back to the default. `all` is every handoff, newest first.
 */
export function cycleIn(ev: Entity, all: Entity[]): number {
  const own = ownCycle(ev);
  if (own) return own;
  const t = atMs(ev);
  const older = all.filter((o) => o.id !== ev.id && atMs(o) < t);
  for (const o of older) { const c = ownCycle(o); if (c) return c; }
  if (older[0]) {
    const gap = Math.round((t - atMs(older[0])) / DAY_MS);
    if (gap >= 1 && gap <= 60) return gap;
  }
  return DEFAULT_CYCLE_DAYS;
}

/** The local calendar day `days` after `at`, at the same local time of day. */
function addDays(at: string, days: number): Date {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), 0, 0);
}

/** The handoff a custody event predicts: its start plus its cycle. */
const predicted = (ev: Entity, all: Entity[]) => addDays(String(ev.fields.at), cycleIn(ev, all));
const sameTime = (a: unknown, b: Date) => typeof a === "string" && new Date(a).getTime() === b.getTime();

/**
 * Only the newest handoff predicts the next one: it gets `next_due` (start + cycle) unless one was set by hand,
 * and older handoffs lose theirs, so exactly one handoff reminder exists. An old alternating-week rule for the
 * same pet is turned off once a handoff is logged, since it would now disagree.
 *
 * `changed` is the write that called this, when there is one. When it moved the newest handoff's day or changed its
 * cycle, and its `next_due` was the predicted one (not set by hand), the prediction follows; once set it used to stay,
 * with its reminder, on the old date.
 */
export function syncHandoffs(hub: Hub, pet: string, changed?: { entity: Entity; prev: Entity | null; fields: string[] }): void {
  const all = handoffs(hub.store, pet);
  const [first, ...older] = all;
  if (!first) return;
  for (const o of older) if (o.fields.next_due) hub.store.patch(o.id, { next_due: null });
  // Read again: clearing an older one runs these hooks, which may already have set it.
  const newest = hub.store.get(first.id) ?? first;
  const moved = changed && changed.entity.id === newest.id && changed.prev && !changed.fields.includes("next_due")
    && (changed.fields.includes("at") || changed.fields.includes("cycle_days"))
    && sameTime(changed.prev.fields.next_due, predicted(changed.prev, all));
  const want = predicted(newest, all);
  if (!newest.fields.next_due || (moved && !sameTime(newest.fields.next_due, want))) hub.store.patch(newest.id, { next_due: want.toISOString() });
  const rule = custodyRule(hub, pet);
  if (rule) hub.store.patch(rule.id, { active: false });
}

export function installPetHooks(hub: Hub): void {
  hub.store.afterWrite((entity, prev, changed) => {
    if (entity.kind !== "pet_event" || !hub.modules.on("pet")) return;
    // A deleted handoff counts too: deleting a mistaken newest one gives the one before it back its prediction and
    // reminder (its next_due had been cleared, and nothing set it again, so no handoff reminder was left).
    const custody = entity.fields.type === "custody" || prev?.fields.type === "custody";
    if (custody && (entity.fields.with || prev?.fields.with)) syncHandoffs(hub, String(entity.fields.pet ?? prev?.fields.pet ?? ""), { entity, prev, fields: changed });
    syncPetReminder(hub.store, hub.store.get(entity.id) ?? entity);
  });
}

/** The active `info` rule titled `<pet> week`, or null. */
export function custodyRule(hub: Hub, pet: string): Entity | null {
  return hub.store.list({ kind: "plan_rule", limit: 10000 })
    .find((r) => r.fields.type === "info" && r.fields.active !== false && sameName(r.fields.title, `${pet} week`)) ?? null;
}

/**
 * Custody this week. With an anchor the pet is here on anchor-even weeks and the next Monday flips it;
 * a rule without an anchor means always here; no rule means unknown.
 */
export function custodyOf(hub: Hub, pet: string, now: Date = new Date()): Custody {
  const all = handoffs(hub.store, pet);
  const last = all.find((e) => new Date(String(e.fields.at)).getTime() <= now.getTime());
  if (last) {
    // Past the predicted handoff with nothing logged: assume it happened on schedule and keep alternating.
    const cycle = cycleIn(last, all);
    let since = String(last.fields.at);
    let here = last.fields.with === "me";
    let next = last.fields.next_due ? new Date(String(last.fields.next_due)) : addDays(since, cycle);
    while (next.getTime() <= now.getTime()) {
      since = next.toISOString();
      here = !here;
      next = addDays(since, cycle);
    }
    return { with_me_now: here, next_handoff: next.toISOString(), since, cycle_days: cycle, handoff_id: last.id };
  }
  const rule = custodyRule(hub, pet);
  if (!rule) return { with_me_now: null, next_handoff: null };
  const monday = mondayOf(now);
  if (typeof rule.fields.alternating_anchor !== "string") return { with_me_now: true, next_handoff: null };
  const here = ruleAppliesOnWeek(rule, monday);
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 0, 0, 0, 0);
  return { with_me_now: here, next_handoff: next.toISOString() };
}

export function petSummary(hub: Hub, pet: string, now: Date = new Date()): PetSummary {
  const events = hub.store.list({ kind: "pet_event", limit: 100000 }).filter((e) => sameName(e.fields.pet, pet));
  const since = now.getTime() - 30 * DAY_MS;
  const events_30d = events
    .filter((e) => { const t = new Date(String(e.fields.at ?? "")).getTime(); return Number.isFinite(t) && t >= since && t <= now.getTime() + DAY_MS; })
    .sort((a, b) => String(b.fields.at).localeCompare(String(a.fields.at)));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const next_due = events
    .filter((e) => { const t = localDateOf(e.fields.next_due).getTime(); return Number.isFinite(t) && t >= today; })
    .sort((a, b) => localDateOf(a.fields.next_due).getTime() - localDateOf(b.fields.next_due).getTime());
  const name = events[0] ? String(events[0].fields.pet) : pet;
  return { pet: name, events_30d, next_due, custody: custodyOf(hub, pet, now), plans: petPlans(hub.store, name, now) };
}
