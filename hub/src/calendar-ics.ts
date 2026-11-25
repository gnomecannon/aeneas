import ICAL from "ical.js";

/**
 * Calendar events as iCalendar (RFC 5545), for calendar sync: what one event on a calendar server means to the hub, and
 * the text the hub writes back. Writing an existing event changes only its title, times and place; everything else in
 * it (notes, alerts, invitees, its time zone) stays as the server had it.
 *
 * The hub's event fields: a timed event's start and end are instants (ISO, UTC); an all-day one's are UTC midnights of
 * its first day and of the day after its last (`2026-11-20T00:00:00.000Z` to `2026-11-21T00:00:00.000Z`).
 */

export interface EventTimes {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
}

export interface ParsedObject {
  uid: string;
  /** A single event, or the first of a repeating one. */
  master: EventTimes & { modified?: string };
  /** The occurrences of a repeating event inside the window asked for; absent for a single event. */
  occurrences?: EventTimes[];
}

const DAY = 86_400_000;
const MAX_OCCURRENCES = 500;

function registerZones(comp: ICAL.Component) {
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch { /* a zone it cannot read: times in it count as floating */ }
  }
}

const dateOnly = (t: ICAL.Time) => `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
const midnight = (d: string) => `${d}T00:00:00.000Z`;
const addDays = (d: string, n: number) => new Date(Date.parse(midnight(d)) + n * DAY).toISOString().slice(0, 10);

function times(title: string, location: string | undefined, start: ICAL.Time, end: ICAL.Time | null): EventTimes {
  if (start.isDate) {
    const first = dateOnly(start);
    let after = end?.isDate ? dateOnly(end) : addDays(first, 1);
    if (after <= first) after = addDays(first, 1);
    return { title, start: midnight(first), end: midnight(after), all_day: true, ...(location ? { location } : {}) };
  }
  const s = start.toJSDate();
  const e = end ? end.toJSDate() : s;
  return { title, start: s.toISOString(), end: (e < s ? s : e).toISOString(), all_day: false, ...(location ? { location } : {}) };
}

/** An event's title, place and times as the hub keeps them, from ical.js times (Invitations reads them the same way). */
export const eventTimes = times;

const textOf = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/\s+/g, " ").trim();

/**
 * One calendar object. Null when it holds no event the hub can use (no UID, no start, or not iCalendar). Repeating
 * events are expanded from `from` to `to`, moved and cancelled occurrences included.
 */
/**
 * One calendar object's text as a component, or null when it is not one: text ical.js cannot read, and also what it
 * reads without a complaint but as no component or several (an empty or blank object, two VCALENDARs one after the
 * other), which threw later and stopped the whole calendar sync for one odd event (2026-11-22).
 */
function componentOf(data: string): ICAL.Component | null {
  try {
    const jcal: unknown = ICAL.parse(data);
    return Array.isArray(jcal) && typeof jcal[0] === "string" ? new ICAL.Component(jcal as unknown as ICAL.Component["jCal"]) : null;
  } catch { return null; }
}

export function parseObject(data: string, from: Date, to: Date): ParsedObject | null {
  const comp = componentOf(data);
  if (!comp) return null;
  registerZones(comp);
  const vevents = comp.getAllSubcomponents("vevent");
  const masterComp = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  if (!masterComp) return null;
  const ev = new ICAL.Event(masterComp, { strictExceptions: true });
  if (!ev.uid || !ev.startDate) return null;
  for (const ex of vevents) if (ex !== masterComp && ex.hasProperty("recurrence-id")) { try { ev.relateException(ex); } catch { /* another event's */ } }
  const lm = masterComp.getFirstPropertyValue("last-modified");
  const master = {
    ...times(textOf(ev.summary), textOf(ev.location) || undefined, ev.startDate, ev.endDate),
    ...(lm instanceof ICAL.Time ? { modified: lm.toJSDate().toISOString() } : {}),
  };
  if (!ev.isRecurring()) return { uid: ev.uid, master };
  const occurrences: EventTimes[] = [];
  const it = ev.iterator();
  let next: ICAL.Time | null;
  let guard = 0;
  while ((next = it.next()) && guard++ < 5000) {
    const d = ev.getOccurrenceDetails(next);
    const s = d.startDate.toJSDate();
    if (s >= to) break;
    const o = times(textOf(d.item.summary), textOf(d.item.location) || undefined, d.startDate, d.endDate);
    if (Date.parse(o.end) <= from.getTime()) continue;
    occurrences.push(o);
    if (occurrences.length >= MAX_OCCURRENCES) break;
  }
  return { uid: ev.uid, master, occurrences };
}

/** The wall time of an instant in an IANA zone, as iCalendar writes it (20261118T090000), or null for an unknown zone. */
export function wallTime(iso: string, zone: string): string | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
  } catch { return null; }
}


/** Set DTSTART or DTEND: a date for an all-day event; for a timed one the zone it already had when that is a real one, else UTC. */
function setTime(vevent: ICAL.Component, name: "dtstart" | "dtend", iso: string, allDay: boolean, zone: string | null) {
  vevent.removeAllProperties(name);
  const p = new ICAL.Property(name, vevent);
  if (allDay) {
    p.resetType("date");
    p.setValue(ICAL.Time.fromDateString(iso.slice(0, 10)));
  } else {
    const wall = zone ? wallTime(iso, zone) : null;
    if (wall && zone) {
      p.setParameter("tzid", zone);
      p.setValue(ICAL.Time.fromData({ year: +wall.slice(0, 4), month: +wall.slice(4, 6), day: +wall.slice(6, 8), hour: +wall.slice(9, 11), minute: +wall.slice(11, 13), second: +wall.slice(13, 15), isDate: false }));
    } else {
      p.setValue(ICAL.Time.fromDateTimeString(new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z")));
    }
  }
  vevent.addProperty(p);
}

/** A new single event. */
export function newEventIcs(uid: string, f: EventTimes, now: Date = new Date()): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("version", "2.0");
  cal.updatePropertyWithValue("prodid", "-//Aeneas//Hub//EN");
  const ev = new ICAL.Component("vevent", cal);
  ev.updatePropertyWithValue("uid", uid);
  ev.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  ev.updatePropertyWithValue("summary", f.title);
  setTime(ev, "dtstart", f.start, f.all_day, null);
  setTime(ev, "dtend", f.end, f.all_day, null);
  if (f.location) ev.updatePropertyWithValue("location", f.location);
  cal.addSubcomponent(ev);
  return cal.toString();
}

/**
 * An existing event with the hub's title, times and place: only the single event (or the first of a repeating one,
 * which the hub never writes) changes; its other properties stay. Null when the text is not an event.
 */
export function updatedEventIcs(data: string, f: EventTimes, now: Date = new Date()): string | null {
  const cal = componentOf(data);
  if (!cal) return null;
  const ev = cal.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
  if (!ev) return null;
  const zoneOf = (name: string) => {
    const z = ev.getFirstProperty(name)?.getParameter("tzid");
    return typeof z === "string" && wallTime(now.toISOString(), z) ? z : null;
  };
  const zone = zoneOf("dtstart");
  const hadEnd = ev.hasProperty("dtend");
  ev.updatePropertyWithValue("summary", f.title);
  setTime(ev, "dtstart", f.start, f.all_day, zone);
  ev.removeAllProperties("duration");
  setTime(ev, "dtend", f.end, f.all_day, hadEnd ? zoneOf("dtend") ?? zone : zone);
  if (f.location) ev.updatePropertyWithValue("location", f.location); else ev.removeAllProperties("location");
  const stampNow = ICAL.Time.fromJSDate(now, true);
  ev.updatePropertyWithValue("dtstamp", stampNow);
  ev.updatePropertyWithValue("last-modified", stampNow);
  const seq = Number(ev.getFirstPropertyValue("sequence") ?? 0);
  ev.updatePropertyWithValue("sequence", Number.isFinite(seq) ? seq + 1 : 1);
  return cal.toString();
}
