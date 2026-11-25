/**
 * Which calendars the Week screen shows. The setting is one for every device,
 * `hidden_calendars` in the feel setting (CONTRACT.md, Feel): the hub checks it with `readHiddenCalendars`; the web
 * client draws the Week screen and its Calendars list by these rules. The Apple apps carry the same rules in EACore
 * `CalendarViews.swift`, and tests on both sides keep the two and the contract the same.
 */
import { eventCalendarKey, type CalendarColor } from "./index.js";

/** The key that stands for events on no calendar: made in Aeneas and kept only here. */
export const NO_CALENDAR = "aeneas";
/** How many keys the setting may hold: every calendar the feel setting keeps (200), with room for older keys. */
export const HIDDEN_CALENDARS_MAX = 300;
/** The longest key, as the feel setting's calendars and an event's `calendar_key` take it. */
export const CALENDAR_KEY_MAX = 300;

/** A calendar key as the setting takes it: 1 to 300 characters, no control characters. */
export function isCalendarKey(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length >= 1 && v.length <= CALENDAR_KEY_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * The setting from an unknown value (a request, a file, a cached copy), or null when it breaks a rule: a list of at most
 * 300 calendar keys, each named once. A key no calendar has any more is kept: it hides nothing.
 */
export function readHiddenCalendars(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > HIDDEN_CALENDARS_MAX || !raw.every(isCalendarKey) || new Set(raw).size !== raw.length) return null;
  return [...raw];
}

/** The calendar an event is on, for the setting: its calendar's key, or `aeneas` when it is on none. */
export function calendarKeyOf(fields: Record<string, unknown>): string {
  return eventCalendarKey(fields) ?? NO_CALENDAR;
}

/** Whether Week shows an event: its calendar is not one of the hidden ones. */
export function calendarShown(fields: Record<string, unknown>, hidden: readonly string[] | undefined): boolean {
  return !hidden?.length || !hidden.includes(calendarKeyOf(fields));
}

/** One row of the Calendars list. */
export interface CalendarRow {
  key: string;
  name: string;
  account: string;
  /** The color its events are drawn in (the owner's choice, else its own); null for the theme's accent. */
  color: string | null;
  shown: boolean;
}
export interface CalendarGroup {
  account: string;
  calendars: CalendarRow[];
}

/** The group events on no calendar are listed under, last. */
export const NO_CALENDAR_ACCOUNT = "Aeneas";
export const NO_CALENDAR_NAME = "Made in Aeneas";

/**
 * A calendar's name and account from its key alone, for one the feel setting does not list (an event brought in by an
 * older app): `apple:<account>/<calendar>`, `apple:<calendar>` (older apps), `icloud:<address>`, `work:m365`.
 */
export function calendarNameFromKey(key: string): { name: string; account: string } {
  if (key === NO_CALENDAR) return { name: NO_CALENDAR_NAME, account: NO_CALENDAR_ACCOUNT };
  if (key === "work:m365") return { name: "Microsoft 365", account: "Work" };
  if (key.startsWith("icloud:")) return { name: "iCloud calendar", account: "iCloud" };
  if (key.startsWith("apple:")) {
    const rest = key.slice("apple:".length);
    const slash = rest.indexOf("/");
    if (slash > 0 && slash < rest.length - 1) return { name: rest.slice(slash + 1), account: rest.slice(0, slash) };
    return { name: rest || key, account: "Apple Calendar" };
  }
  return { name: key, account: "Other" };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);

/**
 * The Calendars list: every calendar the events here are on, and every hidden one the feel setting still lists, grouped
 * by account. Names, accounts and colors come from the feel setting's `calendars`, else from the key. Groups are in
 * name order with Aeneas (events on no calendar) last; calendars in name order inside each.
 */
export function calendarGroups(calendars: readonly CalendarColor[] | undefined, eventKeys: Iterable<string>, hidden: readonly string[] | undefined): CalendarGroup[] {
  const known = new Map((calendars ?? []).map((c) => [c.key, c]));
  const keys = new Set<string>(eventKeys);
  for (const k of hidden ?? []) if (known.has(k)) keys.add(k);
  const groups = new Map<string, CalendarRow[]>();
  for (const key of keys) {
    const c = known.get(key);
    const from = calendarNameFromKey(key);
    const account = key === NO_CALENDAR ? NO_CALENDAR_ACCOUNT : c?.account?.trim() || from.account;
    const row: CalendarRow = { key, name: c?.name?.trim() || from.name, account, color: c?.chosen ?? c?.color ?? null, shown: !(hidden ?? []).includes(key) };
    groups.set(account, [...(groups.get(account) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([account, rows]) => ({ account, calendars: rows.sort((a, b) => byName(a.name, b.name) || byName(a.key, b.key)) }))
    .sort((a, b) => (a.account === NO_CALENDAR_ACCOUNT ? 1 : 0) - (b.account === NO_CALENDAR_ACCOUNT ? 1 : 0) || byName(a.account, b.account));
}

/** The setting with one calendar shown or hidden; the order of the rest stays. */
export function withCalendarShown(hidden: readonly string[] | undefined, key: string, shown: boolean): string[] {
  const rest = (hidden ?? []).filter((k) => k !== key);
  return shown ? rest : [...rest, key].slice(-HIDDEN_CALENDARS_MAX);
}
