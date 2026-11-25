import ICAL from "ical.js";
import { eventTimes, type EventTimes } from "./calendar-ics.js";

/**
 * Invitations in iCalendar (RFC 5545) and iTIP (RFC 5546), for Invitations (CONTRACT.md section 3): reading an
 * invitation (an event in an iCloud calendar, or a METHOD:REQUEST or METHOD:CANCEL that came by mail), changing the
 * owner's answer in an event while leaving every other line as it was, and writing the METHOD:REPLY that calendar apps
 * send (iMIP, RFC 6047).
 *
 * Reading goes through ical.js (folded lines, time zones, repeating events). Changing and writing work on the text's
 * own lines, so what the hub does not mean to change stays byte for byte.
 */

export type PartStat = "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | "DELEGATED";
export interface Person { address: string; name?: string }
export interface Attendee extends Person { partstat: string; rsvp: boolean }

/** What the hub reads of one invitation. */
export interface InviteEvent {
  method: string | null;
  uid: string;
  sequence: number;
  /** DTSTAMP, as an instant; null when it has none. */
  stamp: string | null;
  /** Set when the object holds only one occurrence of a repeating event (RECURRENCE-ID), as written. */
  recurrence_id: string | null;
  organizer: Person | null;
  attendees: Attendee[];
  status: string | null;
  repeats: boolean;
  /** Title, times and place: of the next occurrence for a repeating event, else of the event. */
  times: EventTimes;
}

const DAY = 86_400_000;

function componentOf(data: string): ICAL.Component | null {
  try {
    const jcal: unknown = ICAL.parse(data);
    return Array.isArray(jcal) && typeof jcal[0] === "string" ? new ICAL.Component(jcal as unknown as ICAL.Component["jCal"]) : null;
  } catch { return null; }
}

/** An address as kept: lowercase, without `mailto:`; null when it is not one. */
export function addressOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s) && s.length <= 254 ? s : null;
}

const paramText = (p: ICAL.Property, name: string) => {
  const v = p.getParameter(name);
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
};

function personOf(p: ICAL.Property): Person | null {
  const address = addressOf(p.getFirstValue()) ?? addressOf(paramText(p, "email"));
  if (!address) return null;
  const name = paramText(p, "cn").slice(0, 200);
  return name && name.toLowerCase() !== address ? { address, name } : { address };
}

/** Another address the attendee is known by (iCloud writes EMAIL= beside an address of its own). */
function addressesOf(p: ICAL.Property): string[] {
  return [addressOf(p.getFirstValue()), addressOf(paramText(p, "email"))].filter((x): x is string => !!x);
}

/**
 * One invitation's object: METHOD (null in a calendar), and of its main VEVENT (the one without RECURRENCE-ID, else
 * the first) the UID, SEQUENCE, DTSTAMP, organizer, attendees, status, and the times of the next occurrence ending
 * after `now` (within a year) for a repeating one. Null when it holds no event with a UID and a start.
 */
export function readInvite(data: string, now: Date = new Date()): InviteEvent | null {
  const cal = componentOf(data);
  if (!cal) return null;
  for (const tz of cal.getAllSubcomponents("vtimezone")) { try { ICAL.TimezoneService.register(tz); } catch { /* floating */ } }
  const vevents = cal.getAllSubcomponents("vevent");
  const main = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  if (!main) return null;
  const ev = new ICAL.Event(main, { strictExceptions: true });
  if (!ev.uid || !ev.startDate) return null;
  for (const ex of vevents) if (ex !== main && ex.hasProperty("recurrence-id")) { try { ev.relateException(ex); } catch { /* another event's */ } }
  const method = cal.getFirstPropertyValue("method");
  const seq = Number(main.getFirstPropertyValue("sequence") ?? 0);
  const stamp = main.getFirstPropertyValue("dtstamp");
  const org = main.getFirstProperty("organizer");
  const attendees: Attendee[] = [];
  for (const p of main.getAllProperties("attendee")) {
    const who = personOf(p);
    if (!who) continue;
    const rsvp = paramText(p, "rsvp").toUpperCase() === "TRUE";
    attendees.push({ ...who, partstat: (paramText(p, "partstat") || "NEEDS-ACTION").toUpperCase(), rsvp });
  }
  const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/\s+/g, " ").trim();
  let times = eventTimes(text(ev.summary), text(ev.location) || undefined, ev.startDate, ev.endDate);
  const repeats = ev.isRecurring();
  if (repeats) {
    const it = ev.iterator();
    let next: ICAL.Time | null;
    let guard = 0;
    const until = now.getTime() + 365 * DAY;
    while ((next = it.next()) && guard++ < 3000) {
      const d = ev.getOccurrenceDetails(next);
      if (d.startDate.toJSDate().getTime() > until) break;
      const o = eventTimes(text(d.item.summary), text(d.item.location) || undefined, d.startDate, d.endDate);
      if (Date.parse(o.end) > now.getTime()) { times = o; break; }
    }
  }
  const rid = main.getFirstProperty("recurrence-id");
  return {
    method: typeof method === "string" ? method.toUpperCase() : null,
    uid: String(ev.uid).slice(0, 1000),
    sequence: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0,
    stamp: stamp instanceof ICAL.Time ? stamp.toJSDate().toISOString() : null,
    recurrence_id: rid ? rid.toICALString() : null,
    organizer: org ? personOf(org) : null,
    attendees,
    status: typeof main.getFirstPropertyValue("status") === "string" ? String(main.getFirstPropertyValue("status")).toUpperCase() : null,
    repeats,
    times,
  };
}

/** The attendee that is one of the owner's addresses, or null. Checks the EMAIL parameter too. */
export function ownerAttendee(data: string, inv: InviteEvent, owner: Set<string>): Attendee | null {
  const direct = inv.attendees.find((a) => owner.has(a.address));
  if (direct) return direct;
  // An attendee written under another address, with the owner's in EMAIL=.
  const cal = componentOf(data);
  const main = cal?.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id")) ?? cal?.getAllSubcomponents("vevent")[0];
  for (const p of main?.getAllProperties("attendee") ?? []) {
    if (addressesOf(p).some((a) => owner.has(a))) {
      const who = personOf(p);
      if (who) return { ...who, partstat: (paramText(p, "partstat") || "NEEDS-ACTION").toUpperCase(), rsvp: paramText(p, "rsvp").toUpperCase() === "TRUE" };
    }
  }
  return null;
}

/** The owner organizes it: an invitation they sent, never one to answer. */
export const ownerOrganizes = (inv: InviteEvent, owner: Set<string>) => !!inv.organizer && owner.has(inv.organizer.address);

// ---------------------------------------------------------------------------------------------------------------------
// Lines

/** A logical line of the text: the physical lines it was written as (folded ones after the first), and its unfolded text. */
interface Logical { raw: string[]; text: string }

/** The text's logical lines and the line end it uses (CRLF unless it has none). */
function logicalLines(data: string): { lines: Logical[]; eol: string; trailing: boolean } {
  const eol = data.includes("\r\n") ? "\r\n" : "\n";
  const physical = data.split(/\r?\n/);
  const trailing = physical.length > 1 && physical[physical.length - 1] === "";
  if (trailing) physical.pop();
  const lines: Logical[] = [];
  for (const p of physical) {
    if ((p.startsWith(" ") || p.startsWith("\t")) && lines.length) {
      const l = lines[lines.length - 1];
      l.raw.push(p);
      l.text += p.slice(1);
    } else lines.push({ raw: [p], text: p });
  }
  return { lines, eol, trailing };
}

/** Folded at 75 octets (RFC 5545 3.1), never inside a character; each next line starts with a space. */
export function fold(line: string, eol = "\r\n"): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of Array.from(line)) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 75) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(eol);
}

interface Parsed { name: string; params: { name: string; value: string }[]; value: string }

/** `NAME;P1=a;P2="b:c":value`, with quoted parameter values; null when it is not a property line. */
function parseLine(text: string): Parsed | null {
  let i = 0;
  const nameEnd = text.search(/[;:]/);
  if (nameEnd <= 0) return null;
  const name = text.slice(0, nameEnd);
  i = nameEnd;
  const params: { name: string; value: string }[] = [];
  while (text[i] === ";") {
    i++;
    const eq = text.indexOf("=", i);
    if (eq < 0) return null;
    const pname = text.slice(i, eq);
    i = eq + 1;
    let value = "";
    // A parameter may hold a list (a,b); each value quoted or not.
    for (;;) {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (close < 0) return null;
        value += text.slice(i, close + 1);
        i = close + 1;
      } else {
        const m = /^[^;:,"]*/.exec(text.slice(i))![0];
        value += m;
        i += m.length;
      }
      if (text[i] === ",") { value += ","; i++; continue; }
      break;
    }
    params.push({ name: pname, value });
  }
  if (text[i] !== ":") return null;
  return { name, params, value: text.slice(i + 1) };
}

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const writeLine = (p: Parsed) => `${p.name}${p.params.map((x) => `;${x.name}=${x.value}`).join("")}:${p.value}`;

/** A parameter value as iCalendar takes it: quoted when it holds `:`, `;` or `,`; quotes and line ends taken out. */
function paramValue(v: string): string {
  const s = v.replace(/["\u0000-\u001f\u007f]/g, " ").trim();
  return /[:;,]/.test(s) ? `"${s}"` : s;
}

/**
 * The object with the owner's answer: in every VEVENT, each ATTENDEE that is one of the owner's addresses gets
 * PARTSTAT set and RSVP=TRUE taken out, and iCloud's X-APPLE-NEEDS-REPLY line goes. Every other line is left exactly
 * as it was (a changed line is folded again). Null when no attendee is the owner.
 */
export function withPartstat(data: string, owner: Set<string>, partstat: PartStat): string | null {
  const { lines, eol, trailing } = logicalLines(data);
  let depth = 0;
  let inEvent = false;
  let changed = 0;
  const out: string[] = [];
  for (const l of lines) {
    const upper = l.text.toUpperCase();
    if (upper === "BEGIN:VEVENT") { inEvent = true; depth = 0; }
    else if (upper === "END:VEVENT") inEvent = false;
    else if (inEvent && upper.startsWith("BEGIN:")) depth++;
    else if (inEvent && upper.startsWith("END:")) depth--;
    if (inEvent && depth === 0) {
      const p = parseLine(l.text);
      const name = p?.name.toUpperCase();
      if (p && name === "X-APPLE-NEEDS-REPLY") continue;
      if (p && name === "ATTENDEE") {
        const addrs = [addressOf(p.value), addressOf(unquote(p.params.find((x) => x.name.toUpperCase() === "EMAIL")?.value ?? ""))];
        if (addrs.some((a) => a && owner.has(a))) {
          const params = p.params.filter((x) => !(x.name.toUpperCase() === "RSVP" && unquote(x.value).toUpperCase() === "TRUE"));
          const at = params.findIndex((x) => x.name.toUpperCase() === "PARTSTAT");
          if (at >= 0) params[at] = { name: params[at].name, value: partstat };
          else params.push({ name: "PARTSTAT", value: partstat });
          out.push(fold(writeLine({ ...p, params }), eol));
          changed++;
          continue;
        }
      }
    }
    out.push(l.raw.join(eol));
  }
  if (!changed || !out.length) return null;
  return out.join(eol) + (trailing ? eol : "");
}

/**
 * The answer calendar apps send to the organizer (METHOD:REPLY, RFC 5546 3.2.3): the request's own UID, SEQUENCE,
 * RECURRENCE-ID, DTSTART, DTEND or DURATION, SUMMARY and ORGANIZER lines (with the time zones they name), a new
 * DTSTAMP, and the one ATTENDEE with the new PARTSTAT and the CN the request gave it. Null when the request has no
 * VEVENT, or no ATTENDEE for that address.
 */
export function replyIcs(request: string, attendee: string, partstat: PartStat, now: Date = new Date()): string | null {
  const { lines } = logicalLines(request);
  const blocks: Logical[][] = [];
  const zones: Logical[][] = [];
  let cur: Logical[] | null = null;
  let zone: Logical[] | null = null;
  let depth = 0;
  for (const l of lines) {
    const upper = l.text.toUpperCase();
    if (upper === "BEGIN:VTIMEZONE") { zone = []; }
    if (zone) { zone.push(l); if (upper === "END:VTIMEZONE") { zones.push(zone); zone = null; } continue; }
    if (upper === "BEGIN:VEVENT") { cur = []; depth = 0; continue; }
    if (upper === "END:VEVENT") { if (cur) blocks.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (upper.startsWith("BEGIN:")) { depth++; continue; }
    if (upper.startsWith("END:")) { depth--; continue; }
    if (depth === 0) cur.push(l);
  }
  const main = blocks.find((b) => !b.some((l) => /^RECURRENCE-ID[;:]/i.test(l.text))) ?? blocks[0];
  if (!main) return null;
  const pick = (name: string) => main.filter((l) => parseLine(l.text)?.name.toUpperCase() === name).map((l) => l.text);
  const att = main.map((l) => parseLine(l.text)).find((p) => p?.name.toUpperCase() === "ATTENDEE"
    && [addressOf(p.value), addressOf(unquote(p.params.find((x) => x.name.toUpperCase() === "EMAIL")?.value ?? ""))].includes(attendee));
  if (!att) return null;
  const cn = att.params.find((x) => x.name.toUpperCase() === "CN");
  const attendeeLine = writeLine({ name: "ATTENDEE", params: [{ name: "PARTSTAT", value: partstat }, ...(cn ? [{ name: "CN", value: paramValue(unquote(cn.value)) }] : [])], value: `mailto:${attendee}` });
  const used = new Set<string>();
  for (const l of [...pick("DTSTART"), ...pick("DTEND"), ...pick("RECURRENCE-ID")]) {
    const tz = parseLine(l)?.params.find((x) => x.name.toUpperCase() === "TZID");
    if (tz) used.add(unquote(tz.value));
  }
  const zoneId = (z: Logical[]) => z.map((l) => parseLine(l.text)).find((p) => p?.name.toUpperCase() === "TZID")?.value ?? "";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const body = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Aeneas//Invitations//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    ...zones.filter((z) => used.has(zoneId(z))).flatMap((z) => z.map((l) => l.text)),
    "BEGIN:VEVENT",
    ...pick("UID").slice(0, 1),
    ...pick("SEQUENCE").slice(0, 1),
    ...pick("RECURRENCE-ID").slice(0, 1),
    `DTSTAMP:${stamp}`,
    ...pick("DTSTART").slice(0, 1),
    ...(pick("DTEND").length ? pick("DTEND").slice(0, 1) : pick("DURATION").slice(0, 1)),
    ...pick("SUMMARY").slice(0, 1),
    ...pick("ORGANIZER").slice(0, 1),
    attendeeLine,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return body.map((l) => fold(l)).join("\r\n") + "\r\n";
}

/** The owner's answer in iCalendar's words. */
export const PARTSTAT: Record<"accepted" | "tentative" | "declined", PartStat> = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };
/** iCalendar's answer in the app's words (anything else counts as not answered). */
export function answerOf(partstat: string): "needs_action" | "accepted" | "tentative" | "declined" {
  switch (partstat.toUpperCase()) {
    case "ACCEPTED": return "accepted";
    case "TENTATIVE": return "tentative";
    case "DECLINED": return "declined";
    default: return "needs_action";
  }
}
