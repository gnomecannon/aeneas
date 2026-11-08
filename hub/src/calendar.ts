import type { Entity } from "@everythingapp/shared";
import { pendingReminders } from "./reminders.js";
import type { Hub } from "./hub.js";

/**
 * An iCalendar feed of the personal plan, for subscribing from any calendar app (Apple Calendar, Google, Outlook):
 * scheduled task blocks, personal events, pending reminders and renewal due dates, from 30 days back to 180 ahead.
 * Work items are left out: they already come from the work calendar.
 */

const DAY = 86_400_000;

// A bare carriage return would end the line in the feed: it is a line break like \n.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r\n?|\n/g, "\\n").replace(/([,;])/g, "\\$1");
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/**
 * The local day of an all-day item: a date alone, or a UTC midnight (how all-day events are stored), is that date;
 * anything else is the local day of that moment. Read as an instant, "2026-11-10" was Nov 9 in New York.
 */
/**
 * A midnight with any offset is that date: an all-day plan written in October as "2026-11-05T00:00-04:00" (the
 * offset the model knew) is Nov 5 after the clock change too, where read as an instant it began Nov 4.
 */
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const dayOf = (iso: string): string => {
  const m = MIDNIGHT.exec(iso);
  if (m) return m[1];
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** The day after, by the calendar (not 24 hours, which the clock change makes 23 or 25). */
const dayAfter = (d: string): string => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
};
const ical = (d: string) => d.replace(/-/g, "");

/** Lines folded at 75 octets as RFC 5545 asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 75;
    while (Buffer.byteLength(rest.slice(0, n)) > 75) n--;
    out.push(rest.slice(0, n));
    rest = ` ${rest.slice(n)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

interface Item { uid: string; title: string; start: string; end?: string; allDay?: boolean; note?: string; updated: string }

export function calendarFeed(hub: Hub, now: Date = new Date()): string {
  const from = new Date(now.getTime() - 30 * DAY).toISOString();
  const to = new Date(now.getTime() + 180 * DAY).toISOString();
  const within = (iso: unknown) => typeof iso === "string" && iso >= from && iso <= to;
  const personal = (e: Entity) => e.space !== "work";
  const items: Item[] = [];

  for (const t of hub.store.list({ kind: "task", limit: 1_000_000 }).filter(personal)) {
    const b = t.fields.block as { start?: string; end?: string } | undefined;
    if (b?.start && b.end && within(b.start)) items.push({ uid: t.id, title: `${t.fields.status === "done" ? "Done: " : ""}${String(t.fields.title)}`, start: b.start, end: b.end, note: t.fields.notes as string | undefined, updated: t.updated_at });
  }
  for (const e of hub.store.list({ kind: "event", limit: 1_000_000 }).filter(personal)) {
    if (!within(e.fields.start)) continue;
    items.push({ uid: e.id, title: String(e.fields.title), start: String(e.fields.start), end: String(e.fields.end), allDay: !!e.fields.all_day, note: e.fields.location as string | undefined, updated: e.updated_at });
  }
  for (const { t, eff } of pendingReminders(hub.store)) {
    if (!within(eff) || !personal(t)) continue;
    items.push({ uid: `${t.id}-remind`, title: `Reminder: ${String(t.fields.title)}`, start: eff, end: new Date(new Date(eff).getTime() + 15 * 60_000).toISOString(), updated: t.updated_at });
  }
  for (const t of hub.store.list({ kind: "task", limit: 1_000_000 }).filter(personal)) {
    if (t.fields.status === "done" || typeof t.fields.due !== "string" || !within(t.fields.due)) continue;
    // A due date with no time is a day, not 7 PM the evening before.
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.fields.due)) items.push({ uid: `${t.id}-due`, title: `Due: ${String(t.fields.title)}`, start: t.fields.due, allDay: true, updated: t.updated_at });
    else items.push({ uid: `${t.id}-due`, title: `Due: ${String(t.fields.title)}`, start: t.fields.due, end: new Date(new Date(t.fields.due).getTime() + 15 * 60_000).toISOString(), updated: t.updated_at });
  }
  for (const w of hub.modules.on("renewals") ? hub.store.list({ kind: "watch", limit: 1_000_000 }) : []) {
    if (!within(w.fields.due)) continue;
    items.push({ uid: w.id, title: `Renewal due: ${String(w.fields.title)}`, start: String(w.fields.due), allDay: true, note: w.fields.notes as string | undefined, updated: w.updated_at });
  }

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EverythingApp//Plan//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Aeneas", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const i of items) {
    // An item whose time cannot be read ("2026-11-08 evening") is left out; it made the whole feed answer 500.
    if (Number.isNaN(Date.parse(i.start)) && !MIDNIGHT.test(i.start)) continue;
    lines.push("BEGIN:VEVENT", `UID:${i.uid}@everythingapp`, `DTSTAMP:${stamp(Number.isNaN(Date.parse(i.updated)) ? new Date().toISOString() : i.updated)}`, `SUMMARY:${esc(i.title)}`);
    if (i.allDay) {
      // The end date is the day after the last day; an event's stored end at a midnight is already that day.
      const first = dayOf(i.start);
      let after = dayAfter(first);
      if (i.end && !Number.isNaN(Date.parse(i.end))) {
        const local = new Date(i.end);
        // A date alone is the exclusive end too (2026-11-07 to 2026-11-08 is one day).
        const endsAtMidnight = MIDNIGHT.test(i.end) || (local.getHours() === 0 && local.getMinutes() === 0);
        const last = endsAtMidnight ? dayOf(i.end) : dayAfter(dayOf(i.end));
        if (last > first) after = last;
      }
      lines.push(`DTSTART;VALUE=DATE:${ical(first)}`, `DTEND;VALUE=DATE:${ical(after)}`);
    } else {
      lines.push(`DTSTART:${stamp(i.start)}`, `DTEND:${stamp(i.end && !Number.isNaN(Date.parse(i.end)) ? i.end : i.start)}`);
    }
    if (i.note) lines.push(`DESCRIPTION:${esc(i.note)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
