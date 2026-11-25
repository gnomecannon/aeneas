import { readListChoices } from "./taskLists.js";

/**
 * What Today shows and in what order: one setting for every device, `today` in the feel setting (CONTRACT.md, Feel).
 * The hub checks it with `readToday`; the web client draws and edits Today by it. The Apple apps carry the same rules
 * in EACore `TodayParts.swift`, and tests on both sides keep the two and the contract the same.
 */

/**
 * Every part of Today, by id, in the order Today has by default. `now` is the line at the top (what is on now or next,
 * and the free time): it is drawn above the cards whenever it is shown, so its place in `order` changes nothing. Tech
 * is drawn only while it has something to show (its modules on and something watched), whatever the setting says.
 */
export const TODAY_PARTS = ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"] as const;
export type TodayPart = (typeof TODAY_PARTS)[number];
/** The parts drawn as cards: every part but the line at the top. */
export type TodayCard = Exclude<TodayPart, "now">;
/** The line at the top. */
export const TODAY_TOP = "now";
/** The cards in their default order. */
export const TODAY_CARDS: readonly TodayCard[] = TODAY_PARTS.filter((p): p is TodayCard => p !== TODAY_TOP);
/** How many ids each list may hold: room for parts a newer app may add. */
export const TODAY_MAX_IDS = 40;

export interface TodaySetting {
  /** The parts in the order chosen. A part left out goes in its default place; an id this build does not know is skipped. */
  order: string[];
  /** The parts not drawn. */
  hidden: string[];
  /**
   * Which Reminders lists fill the To do card (gnomecannon/aeneas#28): absent or null is every list, as before; else the
   * keys of the lists chosen, and `none` for the tasks in no list (taskLists.ts). A body that leaves it out keeps the
   * choice the hub has, so an app from before it changes nothing about it; null asks for every list again.
   */
  todo_lists?: string[] | null;
}

/** Today as it was before it could be changed: every part shown, in the default order. */
export const DEFAULT_TODAY: TodaySetting = { order: [...TODAY_PARTS], hidden: [] };

/** A fresh copy of the default, safe to change. */
export function defaultToday(): TodaySetting {
  return { order: [...TODAY_PARTS], hidden: [] };
}

/** A part id as the setting takes it: a letter, then letters, digits, `_` or `-`, 40 at most. It need not be one this build knows. */
export function isTodayId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v);
}

function isPart(id: string): id is TodayPart {
  return (TODAY_PARTS as readonly string[]).includes(id);
}

/**
 * The setting from an unknown value (a request, a file, a cached copy), or null when it breaks a rule: `order` and
 * `hidden` are each a list of at most 40 part ids, each named once in its list; `todo_lists`, when there, is null or a
 * choice of lists (`readListChoices`: at most 300, each a list key or `none`, each named once). An id this build does
 * not know is kept: a newer app may have put it there, and it is only skipped when Today is drawn.
 */
export function readToday(raw: unknown): TodaySetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const lists: string[][] = [];
  for (const list of [r.order, r.hidden]) {
    if (!Array.isArray(list) || list.length > TODAY_MAX_IDS || !list.every(isTodayId) || new Set(list).size !== list.length) return null;
    lists.push([...list]);
  }
  const out: TodaySetting = { order: lists[0], hidden: lists[1] };
  if (r.todo_lists === null) out.todo_lists = null;
  else if (r.todo_lists !== undefined) {
    const chosen = readListChoices(r.todo_lists);
    if (!chosen) return null;
    out.todo_lists = chosen;
  }
  return out;
}

/** The setting from an unknown value, the default when it is absent or breaks a rule. */
export function todayOrDefault(raw: unknown): TodaySetting {
  return readToday(raw) ?? defaultToday();
}

/**
 * Every part in the order chosen: the line at the top first, wherever `order` puts it, then the cards `order` names, in
 * its order, and each card it leaves out in its default place, right after the card before it in the default order
 * (first, for the first card). Ids this build does not know are skipped.
 */
export function todayOrder(s: TodaySetting): TodayPart[] {
  const cards: TodayCard[] = [];
  for (const id of s.order) if (isPart(id) && id !== TODAY_TOP && !cards.includes(id)) cards.push(id);
  TODAY_CARDS.forEach((c, i) => {
    if (cards.includes(c)) return;
    cards.splice(i === 0 ? 0 : cards.indexOf(TODAY_CARDS[i - 1]) + 1, 0, c);
  });
  return [TODAY_TOP, ...cards];
}

/** The parts drawn, in their order: every part not hidden. */
export function todayShown(s: TodaySetting): TodayPart[] {
  return todayOrder(s).filter((p) => !s.hidden.includes(p));
}

/** Whether the line at the top is drawn. */
export function todayShowsTop(s: TodaySetting): boolean {
  return !s.hidden.includes(TODAY_TOP);
}

/** The cards drawn, in their order (Tech still only while it has something to show). */
export function todayCards(s: TodaySetting): TodayCard[] {
  return todayShown(s).filter((p): p is TodayCard => p !== TODAY_TOP);
}

/** Every card in its order, the hidden ones too: the list the editor shows. */
export function todayCardOrder(s: TodaySetting): TodayCard[] {
  return todayOrder(s).filter((p): p is TodayCard => p !== TODAY_TOP);
}

/** Whether the setting draws Today as the default does: every part shown, the cards in their default order. */
export function isDefaultToday(s: TodaySetting): boolean {
  return todayCardOrder(s).join() === TODAY_CARDS.join() && !TODAY_PARTS.some((p) => s.hidden.includes(p));
}

/**
 * The setting with the cards in a new order. The line at the top is written first; a card left out of `cards` goes in
 * its default place. Ids this build does not know stay in `order`, each after the part it followed, so a part a newer
 * app added keeps its place.
 */
export function todayWithOrder(s: TodaySetting, cards: readonly TodayCard[]): TodaySetting {
  const parts = todayOrder({ order: [TODAY_TOP, ...cards], hidden: [] });
  const after = new Map<string | null, string[]>();
  let last: string | null = null;
  let room = TODAY_MAX_IDS - TODAY_PARTS.length;
  for (const id of s.order) {
    if (isPart(id)) last = id;
    else if (room-- > 0) after.set(last, [...(after.get(last) ?? []), id]);
  }
  const order = [...(after.get(null) ?? [])];
  for (const p of parts) order.push(p, ...(after.get(p) ?? []));
  return { ...keepTodo(s), order, hidden: [...s.hidden] };
}

/** Move a card to a place among the cards (0 is the first). A place past the end is the last. */
export function todayMove(s: TodaySetting, card: TodayCard, to: number): TodaySetting {
  const cards = todayCardOrder(s).filter((c) => c !== card);
  cards.splice(Math.max(0, Math.min(Math.trunc(to) || 0, cards.length)), 0, card);
  return todayWithOrder(s, cards);
}

/** Show or hide a part. */
export function todayWithShown(s: TodaySetting, part: TodayPart, shown: boolean): TodaySetting {
  const hidden = s.hidden.filter((id) => id !== part);
  if (!shown && hidden.length < TODAY_MAX_IDS) hidden.push(part);
  return { ...keepTodo(s), order: [...s.order], hidden };
}

/** The To do card's lists as a setting carries them: `{}` when it says nothing, so an edit never adds a choice. */
function keepTodo(s: TodaySetting): Pick<TodaySetting, "todo_lists"> {
  return s.todo_lists === undefined ? {} : { todo_lists: s.todo_lists && [...s.todo_lists] };
}

/** The lists chosen for the To do card, or null for every list. */
export function todayTodoLists(s: TodaySetting): string[] | null {
  return s.todo_lists ?? null;
}

/** The setting with the To do card's lists chosen: null for every list, else the choice (taskLists.ts). */
export function todayWithTodoLists(s: TodaySetting, chosen: readonly string[] | null): TodaySetting {
  return { order: [...s.order], hidden: [...s.hidden], todo_lists: chosen && [...chosen] };
}
