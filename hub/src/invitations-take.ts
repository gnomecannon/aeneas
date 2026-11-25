import type { Entity } from "@everythingapp/shared";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { stableId } from "./imports/util.js";
import { quietly } from "./calendar-quiet.js";
import { answerOf, ownerAttendee, ownerOrganizes, readInvite, type InviteEvent } from "./ical-invite.js";

/**
 * Finding invitations (CONTRACT.md section 3, Invitations): in the iCloud calendars the hub keeps in step, from what
 * the calendar sync reads anyway (takeCalDavInvites), and in new Inbox mail (takeMailInvite). Each becomes an
 * `invitation` item every device syncs. Answering them is invitations.ts.
 */

export const icloudInviteId = (account: string, uid: string) => stableId(`invite:icloud:${account}:${uid}`);
export const mailInviteId = (mailbox: string, uid: string) => stableId(`invite:mail:${mailbox}:${uid}`);

/** The owner's addresses: every linked iCloud and mail account's, and those iCloud knows each iCloud account by. */
export function ownerAddresses(hub: Hub): Set<string> {
  const c = hub.connections.get();
  const out = new Set<string>();
  for (const a of c.icloud ?? []) {
    out.add(a.email.toLowerCase());
    for (const x of a.calendar?.addresses ?? []) out.add(x.toLowerCase());
  }
  for (const a of c.imap ?? []) out.add(a.email.toLowerCase());
  return out;
}

const ended = (inv: InviteEvent, now: Date) => Date.parse(inv.times.end) <= now.getTime();

/** The fields every source writes from an invitation's event. */
function eventFields(inv: InviteEvent, had?: Entity | null): Record<string, unknown> {
  const t = inv.times;
  return {
    title: t.title || "(no title)", start: t.start, end: t.end, all_day: t.all_day,
    ...(t.location ? { location: t.location.slice(0, 1000) } : had?.fields.location ? { location: null } : {}),
    ...(inv.organizer ? { organizer: inv.organizer } : had?.fields.organizer ? { organizer: null } : {}),
    uid: inv.uid, sequence: inv.sequence,
    ...(inv.repeats ? { repeats: true } : had?.fields.repeats ? { repeats: null } : {}),
  };
}

/** Only what differs from what is stored (a patch with nothing in it writes nothing). */
function diff(e: Entity, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const cur = e.fields[k];
    if (v === null ? cur !== undefined : JSON.stringify(cur) !== JSON.stringify(v)) out[k] = v;
  }
  if (e.deleted_at) out.deleted_at = null;
  return out;
}

/** Create the invitation, or bring it up to date. */
function put(hub: Hub, id: string, fields: Record<string, unknown>, space: "personal" | "work" = "personal"): Entity {
  const cur = hub.store.get(id);
  if (!cur) return hub.store.create("invitation", Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)), space, id);
  const d = diff(cur, fields);
  return Object.keys(d).length ? hub.store.patch(id, d) : cur;
}

/** Deleted, with the reason in the log only as a count. */
export function dropInvitation(hub: Hub, id: string): boolean {
  const e = hub.store.get(id);
  if (!e || e.deleted_at || e.kind !== "invitation") return false;
  hub.store.patch(id, { deleted_at: nowIso() });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// iCloud

interface CalDavRead { account: string; chosen: string[]; objects: { calendar: string; url: string; etag: string | null; data: string }[]; readAt: Date; now: Date }

/**
 * After a calendar sync read an account's chosen calendars: each event the owner is invited to (an ATTENDEE that is one
 * of their addresses, not organized by them, not cancelled, not ended) is an invitation, pending while that ATTENDEE
 * says NEEDS-ACTION; the answer given in Calendar elsewhere is taken; an invitation whose event is gone, cancelled or no
 * longer for the owner is deleted. The events the owner declined are marked `declined`.
 */
export function takeCalDavInvites(hub: Hub, r: CalDavRead): { found: number; gone: number } {
  const owner = ownerAddresses(hub);
  const seen = new Set<string>();
  const linked = new Map((hub.db.prepare("SELECT entity_id, uid FROM caldav_events WHERE account = ? AND recurring = 0").all(r.account) as { entity_id: string; uid: string }[]).map((x) => [x.uid, x.entity_id]));
  const declinedNow = new Map<string, boolean>();
  let found = 0;
  for (const o of r.objects) {
    const inv = readInvite(o.data, r.now);
    if (!inv) continue;
    const att = ownerAttendee(o.data, inv, owner);
    const eventId = linked.get(inv.uid);
    // The owner's answer on the event itself: a declined one is hidden in the app, as Calendar hides it.
    declinedNow.set(inv.uid, !!att && att.partstat === "DECLINED" && inv.status !== "CANCELLED");
    if (!att || ownerOrganizes(inv, owner) || inv.status === "CANCELLED" || ended(inv, r.now)) continue;
    const id = icloudInviteId(r.account, inv.uid);
    seen.add(id);
    const cur = hub.store.get(id);
    const answer = answerOf(att.partstat);
    // Only an invitation that waits is new to the list; one answered before Aeneas saw it is not.
    if ((!cur || cur.deleted_at) && answer !== "needs_action") continue;
    const fields: Record<string, unknown> = {
      ...eventFields(inv, cur), answer_by: "caldav",
      from: { kind: "icloud", account: r.account, calendar: o.calendar, href: o.url },
      ...(eventId ? { event_id: eventId } : cur?.fields.event_id ? { event_id: null } : {}),
    };
    // Answered in Aeneas after this read began: what was read is older than the answer and does not undo it.
    const answeredHere = typeof cur?.fields.answered_at === "string" && Date.parse(cur.fields.answered_at) >= r.readAt.getTime();
    if (!cur || (!answeredHere && cur.fields.answer !== answer)) {
      fields.answer = answer;
      fields.answered_at = answer === "needs_action" ? null : nowIso();
    }
    if (!cur) found++;
    put(hub, id, fields);
  }
  for (const [uid, declined] of declinedNow) markDeclined(hub, r.account, uid, declined);
  // Gone from a calendar that was read: cancelled, deleted, or no longer for the owner. Ended ones are left to the sweep.
  let gone = 0;
  for (const e of hub.store.list({ kind: "invitation" })) {
    const from = e.fields.from as { kind?: string; account?: string; calendar?: string } | undefined;
    if (from?.kind !== "icloud" || from.account !== r.account || seen.has(e.id) || !r.chosen.includes(String(from.calendar))) continue;
    if (Date.parse(String(e.fields.end)) <= r.now.getTime()) continue;
    if (dropInvitation(hub, e.id)) gone++;
  }
  if (found || gone) console.log(`[invitations] iCloud: ${found} new, ${gone} gone`);
  return { found, gone };
}

/**
 * The app's events for one iCloud event (the single event, or every occurrence of a repeating one) marked declined or
 * not, without starting a calendar sync: a declined event stays on its calendar and is hidden, as Calendar hides it.
 */
export function markDeclined(hub: Hub, account: string, uid: string, declined: boolean): void {
  for (const r of hub.db.prepare("SELECT entity_id FROM caldav_events WHERE account = ? AND uid = ?").all(account, uid) as { entity_id: string }[]) {
    const ev = hub.store.get(r.entity_id);
    if (ev && !ev.deleted_at && ev.kind === "event" && (ev.fields.declined === true) !== declined) quietly(() => hub.store.patch(ev.id, { declined: declined ? true : null }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mail

export interface MailInviteRow {
  id: string; account: string; uid: string; sequence: number; stamp: string | null; message: string; message_id: string | null;
  organizer: string; ics: string; added_event: string | null; made_at: string;
}
export const mailInviteRow = (hub: Hub, id: string) => hub.mailDb.prepare("SELECT * FROM mail_invites WHERE id = ?").get(id) as MailInviteRow | undefined;

/**
 * A new Inbox message's calendar part (mail-inbox.ts, at refresh). A METHOD:REQUEST to the mailbox's own address is
 * an invitation (a newer SEQUENCE, or the same and a later DTSTAMP, replaces the one kept); a METHOD:CANCEL from the
 * same organizer, no older, deletes it and the event Aeneas added for it. Anything else is passed over.
 */
export function takeMailInvite(hub: Hub, account: string, key: string, m: { calendar: string; message_id: string | null }, now: Date = new Date()): "invited" | "updated" | "cancelled" | null {
  const mailbox = account.slice(account.indexOf(":") + 1).toLowerCase();
  const inv = readInvite(m.calendar, now);
  if (!inv || (inv.method !== "REQUEST" && inv.method !== "CANCEL")) return null;
  const id = mailInviteId(mailbox, inv.uid);
  const kept = mailInviteRow(hub, id);
  if (inv.method === "CANCEL") {
    if (!kept || !inv.organizer || inv.organizer.address !== kept.organizer || inv.sequence < kept.sequence) return null;
    // Only a cancellation of the whole event: one of a repeating event's occurrences leaves the rest standing.
    if (inv.recurrence_id) return null;
    if (kept.added_event) { const ev = hub.store.get(kept.added_event); if (ev && !ev.deleted_at) hub.store.patch(ev.id, { deleted_at: nowIso() }); }
    dropInvitation(hub, id);
    hub.mailDb.prepare("DELETE FROM mail_invites WHERE id = ?").run(id);
    console.log("[invitations] mail: 1 cancelled by its organizer");
    return "cancelled";
  }
  const att = inv.attendees.find((a) => a.address === mailbox);
  if (!att || !inv.organizer || inv.organizer.address === mailbox || inv.status === "CANCELLED" || ended(inv, now) || inv.recurrence_id) return null;
  if (kept && (inv.sequence < kept.sequence || (inv.sequence === kept.sequence && (inv.stamp ?? "") <= (kept.stamp ?? "")))) return null;
  hub.mailDb.prepare(`INSERT INTO mail_invites (id, account, uid, sequence, stamp, message, message_id, organizer, ics, added_event, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account = excluded.account, sequence = excluded.sequence, stamp = excluded.stamp, message = excluded.message, message_id = excluded.message_id, organizer = excluded.organizer, ics = excluded.ics`)
    .run(id, account, inv.uid, inv.sequence, inv.stamp, key, m.message_id, inv.organizer.address, m.calendar, kept?.added_event ?? null, now.toISOString());
  const cur = hub.store.get(id);
  const fields: Record<string, unknown> = { ...eventFields(inv, cur), answer_by: "mail", from: { kind: "mail", mailbox, message: key } };
  // A new request that asks again (the organizer changed the time, say) waits for a new answer, as Calendar shows it.
  if (!cur || cur.deleted_at || att.partstat === "NEEDS-ACTION") Object.assign(fields, { answer: "needs_action", answered_at: null, ...(cur?.fields.reply ? { reply: null } : {}) });
  put(hub, id, fields);
  // The event Aeneas added for an earlier answer follows the organizer's change.
  if (kept?.added_event) {
    const ev = hub.store.get(kept.added_event);
    if (ev && !ev.deleted_at) {
      const t = inv.times;
      const d = diff(ev, { title: t.title || "(no title)", start: t.start, end: t.end, all_day: t.all_day, location: t.location ?? null });
      delete d.deleted_at;
      if (Object.keys(d).length) hub.store.patch(ev.id, d);
    }
  }
  console.log(`[invitations] mail: 1 ${kept ? "updated" : "new"}`);
  return kept ? "updated" : "invited";
}
