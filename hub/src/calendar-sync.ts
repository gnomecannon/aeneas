import type { Entity } from "@everythingapp/shared";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";
import { stableId } from "./imports/util.js";
import { appPassword, mailUsed, REFUSED, type ICloudAccount } from "./imports/icloud.js";
import { DavConflict, DavRefused, deleteEvent, discoverCalendars, getEvent, icloudHost, listEvents, putEvent, type DavLogin } from "./imports/caldav.js";
import { newEventIcs, parseObject, updatedEventIcs, type EventTimes } from "./calendar-ics.js";

/**
 * Calendar sync on the hub (`calendars` module): the iCloud calendars the owner chooses are kept in step with the
 * app's personal events, both ways, without any device. It is the hub's version of what the Apple apps do with Apple
 * Calendar, and while it runs the Apple apps leave personal events to it (`active` on the module, read by the apps).
 *
 * - Single events in a chosen calendar, from 30 days back to a year ahead, become personal events linked to it
 *   (`caldav`); after that, edits and deletions on either side reach the other. When both changed, the newer wins.
 *   An event already linked to Apple Calendar by a device (same calendar id) is linked, not copied.
 * - Personal events made in the app (by hand or by the assistant) are added to the calendar chosen for new events.
 * - Repeating events come in as occurrences from 7 days back to 90 days ahead (`source: caldav`), never written back,
 *   as the Apple apps do with theirs; the phone's own copies of the same occurrences are removed.
 * - Work-space events never leave the hub. A calendar that is no longer chosen is left as it was, its events too.
 *
 * Only title, start, end, all-day and place are synced. Everything else in a server event (notes, alerts, invitees, its
 * time zone) stays as it is there. The hub talks only to iCloud's calendar servers (caldav.ts), with the account's
 * app-specific password, the same one Mail receipts uses for that address.
 */

export interface CalendarConf {
  /** The account's calendars, as last found. */
  calendars: { url: string; name: string; color?: string; writable: boolean }[];
  /** The ones kept in step. */
  chosen: string[];
  /** Where events made in the app go; null keeps them in the app. */
  target: string | null;
  last_sync?: string;
  last_error?: string | null;
}

const DAY = 86_400_000;
const SINGLE_BACK = 30 * DAY;
const SINGLE_AHEAD = 365 * DAY;
const OCC_BACK = 7 * DAY;
const OCC_AHEAD = 90 * DAY;
const ICLOUD_ROOT = "https://caldav.icloud.com/";

const loginOf = (a: ICloudAccount): DavLogin => ({ user: a.email, pass: a.password, root: ICLOUD_ROOT, allowed: icloudHost });

// ---------------------------------------------------------------------------------------------------------------------
// Comparable fields

const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const dayOf = (iso: string): string | null => {
  const m = MIDNIGHT.exec(iso);
  if (m) return m[1];
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const minute = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? "" : new Date(Math.floor(t / 60_000) * 60_000).toISOString(); };

/** An event's synced fields in one form: instants to the minute, an all-day one as UTC midnights (end exclusive). */
export function snapOf(f: Record<string, unknown>): EventTimes | null {
  const title = typeof f.title === "string" ? f.title.trim() : "";
  const start = typeof f.start === "string" ? f.start : "";
  const end = typeof f.end === "string" && f.end ? f.end : start;
  const location = typeof f.location === "string" && f.location.trim() ? f.location.trim() : undefined;
  if (!start) return null;
  if (f.all_day === true) {
    const first = dayOf(start);
    if (!first) return null;
    let after = dayOf(end) ?? first;
    if (after <= first) after = new Date(Date.parse(`${first}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    return { title, start: `${first}T00:00:00.000Z`, end: `${after}T00:00:00.000Z`, all_day: true, ...(location ? { location } : {}) };
  }
  const s = minute(start);
  const e = minute(end);
  if (!s) return null;
  return { title, start: s, end: e && e >= s ? e : s, all_day: false, ...(location ? { location } : {}) };
}

/** The same title, start and kind: an app event and its copy before they were linked. */
const sameWhen = (a: EventTimes | null, b: EventTimes) => !!a && a.title === b.title && a.start === b.start && a.all_day === b.all_day;
const same = (a: EventTimes | null, b: EventTimes | null) => !!a && !!b && a.title === b.title && a.start === b.start && a.end === b.end && a.all_day === b.all_day && (a.location ?? "") === (b.location ?? "");

// ---------------------------------------------------------------------------------------------------------------------
// State

interface Row { entity_id: string; account: string; calendar: string; url: string; uid: string; etag: string | null; data: string | null; snap: string; recurring: number }

function rows(hub: Hub, account: string): Row[] {
  return hub.db.prepare("SELECT * FROM caldav_events WHERE account = ?").all(account) as Row[];
}
function saveRow(hub: Hub, r: Row) {
  hub.db.prepare("INSERT OR REPLACE INTO caldav_events (entity_id, account, calendar, url, uid, etag, data, snap, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.entity_id, r.account, r.calendar, r.url, r.uid, r.etag, r.data, r.snap, r.recurring);
}
function dropRow(hub: Hub, entityId: string) { hub.db.prepare("DELETE FROM caldav_events WHERE entity_id = ?").run(entityId); }

/** Writes the sync itself makes, which must not start another sync. */
let syncing = 0;
export const syncWriting = () => syncing > 0;

function write<T>(f: () => T): T {
  syncing++;
  try { return f(); } finally { syncing--; }
}

/** The event fields a server event gives (null clears a place the server no longer has). */
function fieldsFrom(t: EventTimes, had?: Entity): Record<string, unknown> {
  return {
    title: t.title || "(no title)", start: t.start, end: t.end, all_day: t.all_day,
    ...(t.location ? { location: t.location } : had?.fields.location ? { location: null } : {}),
  };
}

/** Made in the app (by hand or by the assistant) rather than imported. */
const madeInApp = (e: Entity) => !e.fields.source || e.fields.source === "manual";
const appleId = (e: Entity) => { const a = e.fields.apple as { id?: string } | undefined; return a?.id || null; };
const caldavOf = (e: Entity) => e.fields.caldav as { account: string; calendar: string; uid: string; from_caldav?: boolean } | undefined;

// ---------------------------------------------------------------------------------------------------------------------
// One run

export interface SyncResult { account: string; added: number; changed: number; deleted: number; written: number; occurrences: number; error?: string }

interface Remote { calendar: string; url: string; etag: string | null; data: string; uid: string; times: EventTimes; modified?: string }

/** Keep one account's chosen calendars and the app's personal events in step. */
export async function syncAccount(hub: Hub, email: string, now: Date = new Date()): Promise<SyncResult> {
  const out: SyncResult = { account: email, added: 0, changed: 0, deleted: 0, written: 0, occurrences: 0 };
  const acct = (hub.connections.get().icloud ?? []).find((a) => a.email === email);
  const conf = acct?.calendar;
  if (!acct || !conf) return out;
  if (acct.refused_at) return { ...out, error: REFUSED };
  const login = loginOf(acct);
  try {
    // The list of calendars, again each run: one added or renamed in iCloud shows, and addresses stay current.
    const found = await discoverCalendars(login);
    const calendars = found.map(({ ctag: _c, ...c }) => c);
    const chosen = conf.chosen.filter((u) => calendars.some((c) => c.url === u));
    // A Read only account (Internet Accounts) is read and never written: no calendar of it takes an edit or a new event.
    const ro = acct.read_only === true;
    const target = !ro && conf.target && chosen.includes(conf.target) && calendars.find((c) => c.url === conf.target)?.writable ? conf.target : null;
    saveConf(hub, email, { calendars });
    // Their colors for Theme, Calendar colors, under the key events name them by (icloud:<calendar address>).
    try {
      const shown = calendars.filter((c) => chosen.includes(c.url)).map((c) => ({ key: `icloud:${c.url}`, name: c.name.slice(0, 120) || "Calendar", account: email, ...(c.color ? { color: c.color } : {}) }));
      if (shown.length) hub.feel.reportCalendars(shown, now);
    } catch (e) { console.error(`[calendars] colors not kept: ${errCode(e)}`); }
    const writable = new Set(ro ? [] : calendars.filter((c) => c.writable).map((c) => c.url));

    // Everything in the chosen calendars, read before anything is written.
    const singles = new Map<string, Remote>();
    const repeating: { calendar: string; url: string; uid: string; occurrences: EventTimes[] }[] = [];
    const from = new Date(now.getTime() - SINGLE_BACK);
    const to = new Date(now.getTime() + SINGLE_AHEAD);
    for (const cal of chosen) {
      for (const o of await listEvents(login, cal, from, to)) {
        const p = parseObject(o.data, new Date(now.getTime() - OCC_BACK), new Date(now.getTime() + OCC_AHEAD));
        if (!p) continue;
        if (p.occurrences) repeating.push({ calendar: cal, url: o.url, uid: p.uid, occurrences: p.occurrences });
        else singles.set(p.uid, { calendar: cal, url: o.url, etag: o.etag, data: o.data, uid: p.uid, times: p.master, modified: p.master.modified });
      }
    }

    const state = rows(hub, email);
    const linked = new Set<string>();
    // 1. Events linked before.
    for (const row of state.filter((r) => !r.recurring)) {
      linked.add(row.uid);
      const e = hub.store.get(row.entity_id);
      if (!e) { dropRow(hub, row.entity_id); continue; }
      if (!chosen.includes(row.calendar)) continue; // left as it was while its calendar is not chosen
      let r = singles.get(row.uid) ?? null;
      if (!r && !e.deleted_at) {
        // Outside the window now, or deleted there: ask for it by its address.
        const o = await getEvent(login, row.url);
        const p = o ? parseObject(o.data, now, now) : null;
        if (!o || !p) {
          write(() => hub.store.patch(e.id, { deleted_at: nowIso() }));
          dropRow(hub, e.id);
          out.deleted++;
          continue;
        }
        r = { calendar: row.calendar, url: o.url, etag: o.etag, data: o.data, uid: row.uid, times: p.master, modified: p.master.modified };
      }
      if (e.deleted_at) {
        // Deleted in the app: deleted there too, even when it was outside the window read (by the address kept).
        if (writable.has(row.calendar)) {
          try { await deleteEvent(login, r?.url ?? row.url, r?.etag ?? row.etag); out.written++; } catch (err) { if (!(err instanceof DavConflict)) throw err; continue; }
        }
        dropRow(hub, e.id);
        continue;
      }
      if (!r) continue;
      const ef = snapOf(e.fields);
      const af = r.times;
      const prev = JSON.parse(row.snap) as EventTimes;
      if (same(ef, af)) { saveRow(hub, { ...row, url: r.url, etag: r.etag, data: r.data, snap: JSON.stringify(af) }); continue; }
      const appChanged = !same(prev, ef);
      const serverChanged = !same(prev, af);
      let appWins = appChanged && !serverChanged ? true : serverChanged && !appChanged ? false : (e.updated_at >= (r.modified ?? ""));
      if (appWins && !writable.has(row.calendar)) appWins = false;
      if (appWins && ef) {
        const ics = updatedEventIcs(r.data, ef, now);
        if (!ics) continue;
        try {
          const etag = await putEvent(login, r.url, ics, r.etag);
          saveRow(hub, { ...row, url: r.url, etag, data: ics, snap: JSON.stringify(ef) });
          out.written++;
        } catch (err) { if (!(err instanceof DavConflict)) throw err; }
      } else {
        write(() => hub.store.patch(e.id, fieldsFrom(af, e)));
        saveRow(hub, { ...row, url: r.url, etag: r.etag, data: r.data, snap: JSON.stringify(af) });
        out.changed++;
      }
    }

    // 2. Server events the hub has no link for: an app event that is already their copy, or a new personal event.
    const events = hub.store.list({ kind: "event", space: "personal", includeDeleted: true });
    const byApple = new Map(events.filter((e) => appleId(e)).map((e) => [appleId(e)!, e]));
    for (const r of singles.values()) {
      if (linked.has(r.uid)) continue;
      const adoptId = stableId(`caldav-event:${email}:${r.uid}`);
      const twin = byApple.get(r.uid)
        ?? events.find((e) => e.id === r.uid || e.id === adoptId)
        ?? events.find((e) => !e.deleted_at && madeInApp(e) && !caldavOf(e) && !appleId(e) && sameWhen(snapOf(e.fields), r.times));
      const link = { account: email, calendar: r.calendar, uid: r.uid };
      if (twin) {
        if (twin.deleted_at) continue; // deleted in the app: not brought back
        if (caldavOf(twin) && caldavOf(twin)!.account !== email) continue;
        write(() => hub.store.patch(twin.id, { ...fieldsFrom(r.times, twin), caldav: { ...link, ...(caldavOf(twin)?.from_caldav ? { from_caldav: true } : {}) } }));
        saveRow(hub, { entity_id: twin.id, account: email, calendar: r.calendar, url: r.url, uid: r.uid, etag: r.etag, data: r.data, snap: JSON.stringify(r.times), recurring: 0 });
        out.changed++;
        continue;
      }
      write(() => hub.store.create("event", { ...fieldsFrom(r.times), caldav: { ...link, from_caldav: true } }, "personal", adoptId));
      saveRow(hub, { entity_id: adoptId, account: email, calendar: r.calendar, url: r.url, uid: r.uid, etag: r.etag, data: r.data, snap: JSON.stringify(r.times), recurring: 0 });
      out.added++;
    }

    // 3. Events made in the app that no calendar has yet go to the calendar chosen for them.
    if (target) {
      const horizon = now.getTime() - OCC_BACK;
      for (const e of hub.store.list({ kind: "event", space: "personal" })) {
        if (!madeInApp(e) || caldavOf(e) || appleId(e)) continue;
        const f = snapOf(e.fields);
        if (!f || !f.title || Date.parse(f.end) < horizon) continue;
        const uid = e.id;
        const url = new URL(`${uid}.ics`, target.endsWith("/") ? target : `${target}/`).toString();
        const ics = newEventIcs(uid, f, now);
        try {
          const etag = await putEvent(login, url, ics, null);
          write(() => hub.store.patch(e.id, { caldav: { account: email, calendar: target, uid } }));
          saveRow(hub, { entity_id: e.id, account: email, calendar: target, url, uid, etag, data: ics, snap: JSON.stringify(f), recurring: 0 });
          out.written++;
        } catch (err) { if (!(err instanceof DavConflict)) throw err; }
      }
    }

    // 4. Occurrences of repeating events, read only.
    const keep = new Set<string>();
    const occFrom = now.getTime() - OCC_BACK;
    for (const rep of repeating) {
      for (const o of rep.occurrences) {
        const id = stableId(`caldav-occ:${email}:${rep.uid}:${o.start}`);
        keep.add(id);
        const fields = { ...fieldsFrom(o), source: "caldav", external_id: `${rep.uid}|${o.start}`, caldav: { account: email, calendar: rep.calendar, uid: rep.uid } };
        const cur = hub.store.get(id);
        if (!cur) { write(() => hub.store.create("event", fields, "personal", id)); out.occurrences++; }
        else if (cur.deleted_at || !same(snapOf(cur.fields), o)) write(() => hub.store.patch(id, { ...fields, ...(cur.deleted_at ? { deleted_at: null } : {}) }));
        saveRow(hub, { entity_id: id, account: email, calendar: rep.calendar, url: rep.url, uid: rep.uid, etag: null, data: null, snap: JSON.stringify(o), recurring: 1 });
      }
    }
    for (const row of state.filter((r) => r.recurring && !keep.has(r.entity_id))) {
      const e = hub.store.get(row.entity_id);
      const snap = JSON.parse(row.snap) as EventTimes;
      // Gone from a calendar that was read: cancelled. Aged out, or in a calendar not chosen any more: forgotten.
      if (e && !e.deleted_at && chosen.includes(row.calendar) && Date.parse(snap.end) >= occFrom) { write(() => hub.store.patch(e.id, { deleted_at: nowIso() })); out.deleted++; }
      if (!chosen.includes(row.calendar) && e && !e.deleted_at) write(() => hub.store.patch(e.id, { deleted_at: nowIso() }));
      dropRow(hub, row.entity_id);
    }
    // The phone's own copies of the same occurrences (from before the hub synced this calendar).
    const occKeys = new Set([...keep].map((id) => hub.store.get(id)).filter((e): e is Entity => !!e).map((e) => `${e.fields.title}|${e.fields.start}`));
    for (const e of hub.store.list({ kind: "event", space: "personal" })) {
      if (e.fields.source === "eventkit" && occKeys.has(`${e.fields.title}|${snapOf(e.fields)?.start}`)) write(() => hub.store.patch(e.id, { deleted_at: nowIso() }));
    }

    saveConf(hub, email, { last_sync: nowIso(), last_error: null });
    return out;
  } catch (e) {
    if (e instanceof DavRefused) {
      hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a) { a.refused_at = nowIso(); a.last_error = REFUSED; } });
      saveConf(hub, email, { last_error: REFUSED });
      hub.modules.notify();
      return { ...out, error: REFUSED };
    }
    const msg = e instanceof StoreError ? e.message : "Calendar sync stopped on an error; the hub tries again later.";
    if (!(e instanceof StoreError)) console.error(`[calendars] ${errCode(e)}`);
    saveConf(hub, email, { last_error: msg });
    return { ...out, error: msg };
  }
}

function saveConf(hub: Hub, email: string, fields: Partial<CalendarConf>) {
  hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a?.calendar) Object.assign(a.calendar, fields); });
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounts, choices and the view

export interface CalendarAccountView {
  email: string;
  /** Mail receipts reads this account too. */
  mail: boolean;
  /** Read only (Internet Accounts): the hub reads its calendars and writes none of them, so new events stay in the app. */
  read_only: boolean;
  calendars: { url: string; name: string; color?: string; writable: boolean; chosen: boolean }[];
  target: string | null;
  last_sync: string | null;
  last_error: string | null;
}

export function calendarView(hub: Hub): { accounts: CalendarAccountView[]; active: boolean } {
  const accounts = (hub.connections.get().icloud ?? []).filter((a) => a.calendar).map((a) => ({
    email: a.email, mail: a.mail !== false, read_only: a.read_only === true,
    calendars: a.calendar!.calendars.map((c) => ({ ...c, chosen: a.calendar!.chosen.includes(c.url) })),
    // Kept while Read only is on, and used again when it is switched off; meanwhile new events stay in the app.
    target: a.read_only ? null : a.calendar!.target, last_sync: a.calendar!.last_sync ?? null, last_error: a.calendar!.last_error ?? null,
  }));
  return { accounts, active: calendarSyncActive(hub) };
}

/** Whether the hub keeps personal events in step with a calendar: the Apple apps then leave them to it. */
export function calendarSyncActive(hub: Hub): boolean {
  if (!hub.modules.on("calendars")) return false;
  try {
    return (hub.connections.get().icloud ?? []).some((a) => a.calendar && !a.refused_at && a.calendar.chosen.length > 0);
  } catch { return false; }
}

/**
 * Start calendar sync for an iCloud address: an account Mail receipts already uses needs no password; another needs
 * an app-specific password, checked with iCloud by finding its calendars.
 */
export async function linkCalendarAccount(hub: Hub, body: Record<string, unknown>): Promise<ReturnType<typeof calendarView>> {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError(422, "email is the address of the Apple Account (iCloud)");
  const prev = (hub.connections.get().icloud ?? []).find((a) => a.email === email);
  const given = body.password === undefined || body.password === "" ? null : appPassword(body.password);
  if (body.password && !given) throw new StoreError(422, "password is an app-specific password made at account.apple.com (16 letters, like abcd-efgh-ijkl-mnop), not your Apple Account password");
  const password = given ?? prev?.password;
  if (!password) throw new StoreError(422, "this address is not linked yet: give its app-specific password, made at account.apple.com");
  let found;
  try { found = await discoverCalendars({ user: email, pass: password, root: ICLOUD_ROOT, allowed: icloudHost }); }
  catch (e) { if (e instanceof DavRefused) throw new StoreError(422, "iCloud did not accept this address and app-specific password. Check both, or make a new app-specific password at account.apple.com."); throw e; }
  const calendars = found.map(({ ctag: _c, ...c }) => c);
  hub.connections.update((c) => {
    const list = (c.icloud ??= []);
    let a = list.find((x) => x.email === email);
    if (!a) { a = { email, password, linked_at: nowIso(), mail: false }; list.push(a); }
    if (given) Object.assign(a, { password: given, refused_at: null, last_error: null });
    a.calendar = { calendars, chosen: a.calendar?.chosen ?? [], target: a.calendar?.target ?? null, last_sync: a.calendar?.last_sync, last_error: null };
  });
  hub.modules.notify();
  return calendarView(hub);
}

/** Choose the calendars kept in step and the one new events go to. */
export function chooseCalendars(hub: Hub, email: string, body: Record<string, unknown>): ReturnType<typeof calendarView> {
  const a = (hub.connections.get().icloud ?? []).find((x) => x.email === email);
  if (!a?.calendar) throw new StoreError(404, "calendar sync is not set up for that address");
  const urls = new Set(a.calendar.calendars.map((c) => c.url));
  const chosen = body.chosen === undefined ? a.calendar.chosen : Array.isArray(body.chosen) ? [...new Set(body.chosen.filter((u): u is string => typeof u === "string"))] : null;
  if (!chosen || chosen.some((u) => !urls.has(u))) throw new StoreError(422, "chosen is a list of this account's calendar addresses");
  let target = body.target === undefined ? a.calendar.target : body.target;
  if (target !== null && (typeof target !== "string" || !urls.has(target))) throw new StoreError(422, "target is one of this account's calendar addresses, or null");
  if (target && !a.calendar.calendars.find((c) => c.url === target)?.writable) throw new StoreError(422, "that calendar cannot be written to; choose another for new events");
  if (target && a.read_only && body.target !== undefined) throw new StoreError(422, `${email} is Read only, so new events cannot go to its calendars. Switch Read only off in Settings, Connections first.`);
  // A calendar taken out of the list stops taking new events; one picked for new events is kept in step.
  if (body.target === undefined && target && !chosen.includes(target)) target = null;
  if (target && !chosen.includes(target)) chosen.push(target);
  hub.connections.update((c) => { const x = c.icloud?.find((y) => y.email === email); if (x?.calendar) Object.assign(x.calendar, { chosen, target }); });
  hub.modules.notify();
  return calendarView(hub);
}

/**
 * Stop calendar sync for an address. Its events stay in the app as they are (no longer linked to anything that
 * changes them); the occurrences of repeating events go. The password goes too unless Mail receipts or the Mail
 * screen still reads the address (mailUsed: either one keeps it).
 */
export function unlinkCalendarAccount(hub: Hub, email: string): ReturnType<typeof calendarView> & { message: string } {
  const a = (hub.connections.get().icloud ?? []).find((x) => x.email === email);
  if (!a?.calendar) throw new StoreError(404, "calendar sync is not set up for that address");
  for (const row of rows(hub, email)) {
    const e = hub.store.get(row.entity_id);
    if (e && !e.deleted_at) write(() => hub.store.patch(e.id, row.recurring ? { deleted_at: nowIso() } : { caldav: null }));
    dropRow(hub, row.entity_id);
  }
  const keepMail = mailUsed(a);
  hub.connections.update((c) => {
    if (keepMail) { const x = c.icloud?.find((y) => y.email === email); if (x) delete x.calendar; }
    else c.icloud = (c.icloud ?? []).filter((y) => y.email !== email);
  });
  hub.modules.notify();
  return { ...calendarView(hub), message: keepMail
    ? "Calendar sync stopped. Its events stay in the app. Mail still reads this address, so its password stays on the hub."
    : "Calendar sync stopped and the password is deleted from the hub. Its events stay in the app. To end the password itself, revoke it at account.apple.com, under Sign-In and Security, App-Specific Passwords." };
}

// ---------------------------------------------------------------------------------------------------------------------
// When it runs

let running: Promise<SyncResult[]> | null = null;
let queued: Promise<SyncResult[]> | null = null;

/** Sync every account now: one run at a time, and a request during a run gets the run after it (one for all such requests). */
export function syncCalendarsNow(hub: Hub, opts: { owner?: boolean } = {}): Promise<SyncResult[]> {
  if (running) {
    queued ??= running.catch(() => undefined).then(() => { queued = null; return syncCalendarsNow(hub, opts); });
    return queued;
  }
  running = runAll(hub, opts).finally(() => { running = null; });
  return running;
}

async function runAll(hub: Hub, opts: { owner?: boolean }): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  if (!hub.modules.on("calendars")) return out;
  if (opts.owner) {
    // Sync now from the owner tries an address iCloud refused once more, as Read now does for mail.
    hub.connections.update((c) => { for (const a of c.icloud ?? []) if (a.calendar && a.refused_at) a.refused_at = null; });
  }
  for (const a of hub.connections.get().icloud ?? []) if (a.calendar) out.push(await syncAccount(hub, a.email));
  for (const r of out) if (r.added || r.changed || r.deleted || r.written) console.log(`[calendars] ${r.added} added, ${r.changed} changed, ${r.deleted} deleted, ${r.written} written to the calendar`);
  return out;
}

/** Every 5 minutes, and 10 seconds after a personal event changes in the app. */
export function startCalendarJob(hub: Hub, everyMs = 5 * 60_000): () => void {
  let soon: NodeJS.Timeout | null = null;
  const kick = () => { void syncCalendarsNow(hub).catch((e) => console.error(`[calendars] ${errCode(e)}`)); };
  hub.store.afterWrite((e) => {
    if (syncWriting() || e.kind !== "event" || e.space !== "personal" || e.fields.source === "caldav" || e.fields.source === "eventkit") return;
    if (!calendarSyncActive(hub) || soon) return;
    soon = setTimeout(() => { soon = null; kick(); }, 10_000);
    soon.unref();
  });
  const first = setTimeout(kick, 60_000);
  first.unref();
  const timer = setInterval(kick, everyMs);
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); if (soon) clearTimeout(soon); };
}
