import type { Entity } from "@everythingapp/shared";
import { invitationList, nowIso, OwnerAnswer } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";
import { DavConflict, DavRefused, getEvent, icloudHost, putEvent, type DavLogin } from "./imports/caldav.js";
import { PARTSTAT, replyIcs, withPartstat } from "./ical-invite.js";
import { dropInvitation, mailInviteRow, markDeclined, ownerAddresses } from "./invitations-take.js";
import { buildMessage } from "./mail-compose.js";
import { INBOX_SOURCES } from "./mail-inbox.js";
import { onOutboxChange, outboxItem, queueMessage, retrySend, takeBack } from "./mail-outbox.js";

/**
 * Invitations (CONTRACT.md section 3): the list, and answering. Each invitation is answered the way Calendar answers
 * it, through where it came from: in the iCloud calendar the hub keeps in step (iCloud then tells the organizer), or
 * by the reply mail calendar apps send, from the mailbox it came to, through the Mail screen's outbox with its Undo.
 * An invitation only Apple Calendar holds is answered there (EventKit cannot change an answer).
 *
 * The owner's press on Accept, Maybe or Decline (or their yes to the assistant's answer_invitation) is the only thing
 * that answers. Finding invitations is invitations-take.ts; the iCalendar is ical-invite.ts.
 */

const DAY_MS = 86_400_000;
const ICLOUD_ROOT = "https://caldav.icloud.com/";

type Answer = "accepted" | "tentative" | "declined";
export interface AnswerResult { invitation: Entity; outbox?: { id: string; state: "waiting"; send_at: string } }

function invitationOf(hub: Hub, id: string): Entity {
  const e = hub.store.get(id);
  if (!e || e.kind !== "invitation" || e.deleted_at) throw new StoreError(404, "This invitation is not here any more.");
  return e;
}

/** `GET /invitations`: one per UID, the pending by start, those answered in the last 7 days. Work ones left out on asking. */
export function listInvitations(hub: Hub, opts: { now?: Date; noWork?: boolean } = {}): { pending: Entity[]; answered: Entity[]; count: number } {
  const all = hub.store.list({ kind: "invitation", limit: 5000 }).filter((e) => !(opts.noWork && e.space === "work"));
  return invitationList(all, opts.now ?? new Date());
}

/** Answer one (`POST /invitations/:id/answer`). */
export async function answerInvitation(hub: Hub, id: string, answer: unknown, now: Date = new Date()): Promise<AnswerResult> {
  const parsed = OwnerAnswer.safeParse(answer);
  if (!parsed.success) throw new StoreError(422, "answer is accepted, tentative or declined");
  const e = invitationOf(hub, id);
  switch (e.fields.answer_by) {
    case "caldav": return { invitation: await answerInCalendar(hub, e, parsed.data, now) };
    case "mail": return answerByMail(hub, e, parsed.data, now);
    default: throw new StoreError(409, "Answer this invitation in your calendar app. Aeneas cannot answer the invitations only Apple Calendar holds.");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// In the iCloud calendar

async function answerInCalendar(hub: Hub, e: Entity, answer: Answer, now: Date): Promise<Entity> {
  const from = e.fields.from as { account: string; calendar: string; href: string };
  const acct = (hub.connections.get().icloud ?? []).find((a) => a.email === from.account && a.calendar);
  if (!acct || !hub.modules.on("calendars")) throw new StoreError(409, `The hub no longer keeps ${from.account}'s calendars in step, so it cannot answer this invitation. Answer it in Calendar.`);
  if (acct.read_only) throw new StoreError(409, `${acct.email} is Read only, so Aeneas cannot answer in its calendars. Switch Read only off in Settings, Accounts, or answer in Calendar.`);
  if (acct.refused_at) throw new StoreError(409, `iCloud did not accept the app-specific password for ${acct.email}, so nothing was sent. Check it in Settings, Accounts.`);
  const login: DavLogin = { user: acct.email, pass: acct.password, root: ICLOUD_ROOT, allowed: icloudHost };
  const owner = ownerAddresses(hub);
  let written: { text: string; etag: string | null; url: string } | null = null;
  try {
    // Read again and changed once more when the event changed between the read and the write (If-Match).
    for (let attempt = 0; attempt < 2 && !written; attempt++) {
      const o = await getEvent(login, from.href);
      if (!o) {
        dropInvitation(hub, e.id);
        throw new StoreError(409, "This invitation is no longer in your calendar, so nothing was sent. It may have been cancelled.");
      }
      const text = withPartstat(o.data, owner, PARTSTAT[answer]);
      if (!text) {
        dropInvitation(hub, e.id);
        throw new StoreError(409, "You are no longer among this event's invitees, so nothing was sent.");
      }
      try { written = { text, etag: await putEvent(login, o.url, text, o.etag), url: o.url }; }
      catch (err) { if (!(err instanceof DavConflict)) throw err; }
    }
  } catch (err) {
    if (err instanceof DavRefused) throw new StoreError(409, `iCloud did not accept the app-specific password for ${acct.email}, so nothing was sent. Check it in Settings, Accounts.`);
    if (err instanceof StoreError && err.status !== 502) throw err;
    console.error(`[invitations] iCloud answer: ${errCode(err)}`);
    throw new StoreError(502, err instanceof StoreError && /could not be reached/.test(err.message)
      ? "iCloud could not be reached from the hub, so nothing was sent. Try again."
      : "iCloud did not take the answer, so nothing was sent. Try again later.");
  }
  if (!written) throw new StoreError(409, "The event kept changing in iCloud, so nothing was sent. Try again.");
  // The calendar sync's record takes the answered event, so it neither writes it again nor takes it for a change.
  hub.db.prepare("UPDATE caldav_events SET etag = ?, data = ?, url = ? WHERE account = ? AND uid = ? AND recurring = 0").run(written.etag, written.text, written.url, from.account, String(e.fields.uid));
  // Declined: the event (every occurrence of a repeating one) stays on its calendar, hidden, as Calendar does.
  markDeclined(hub, from.account, String(e.fields.uid), answer === "declined");
  console.log("[invitations] 1 answered in an iCloud calendar");
  return hub.store.patch(e.id, { answer, answered_at: now.toISOString() });
}

// ---------------------------------------------------------------------------------------------------------------------
// By mail

const SUBJECT: Record<Answer, string> = { accepted: "Accepted", tentative: "Maybe", declined: "Declined" };
const SAID: Record<Answer, string> = { accepted: "has accepted your invitation", tentative: "has answered maybe to your invitation", declined: "has declined your invitation" };

/** An event already on the owner's calendar with this UID: an iCloud one, an Apple Calendar one, or one added for it. */
function eventWithUid(hub: Hub, uid: string, added: string | null): Entity | null {
  if (added) { const a = hub.store.get(added); if (a && !a.deleted_at) return a; }
  for (const ev of hub.store.list({ kind: "event", limit: 100000 })) {
    const caldav = ev.fields.caldav as { uid?: string } | undefined;
    const apple = ev.fields.apple as { id?: string } | undefined;
    if (caldav?.uid === uid || apple?.id === uid) return ev;
  }
  return null;
}

function answerByMail(hub: Hub, e: Entity, answer: Answer, now: Date): AnswerResult {
  const row = mailInviteRow(hub, e.id);
  if (!row || !hub.modules.on("mail_inbox") || !INBOX_SOURCES.some((s) => s.accounts(hub).includes(row.account))) {
    throw new StoreError(409, "The mail this invitation came in is no longer on the hub, so it cannot be answered from here. Answer it in your mail app.");
  }
  const reply = e.fields.reply as { state?: string } | undefined;
  if (reply?.state === "waiting" || reply?.state === "sending") throw new StoreError(409, "Your last answer is still being sent. Undo it first, or wait until it is sent.");
  const mailbox = row.account.slice(row.account.indexOf(":") + 1);
  const ics = replyIcs(row.ics, mailbox.toLowerCase(), PARTSTAT[answer], now);
  if (!ics) throw new StoreError(409, "This invitation does not name your address, so Aeneas cannot answer it.");
  const name = hub.profile.get().name.trim();
  const owner = name && name !== "the owner" ? name : "";
  const title = String(e.fields.title ?? "").replace(/\s+/g, " ").trim() || "(no title)";
  const subject = `${SUBJECT[answer]}: ${title}`.slice(0, 200);
  const text = owner ? `${owner} ${SAID[answer]}: ${title}` : `${SUBJECT[answer]}: ${title}`;
  const { raw, message_id } = buildMessage({
    from: { name: owner, address: mailbox }, to: [row.organizer], subject, text,
    ...(row.message_id ? { in_reply_to: row.message_id, references: [row.message_id] } : {}),
    calendar: ics,
  }, now);
  // The same checks as Send (Read only, a sending server) and the same 10 seconds of Undo.
  const queued = queueMessage(hub, row.account, { raw, message_id, to: [row.organizer], subject, text }, now);
  // On the owner's calendar as Calendar adds an accepted invitation; nothing for Decline, and an earlier one taken out.
  let added = false;
  let eventId = typeof e.fields.event_id === "string" ? e.fields.event_id : null;
  if (answer === "declined") {
    if (row.added_event) {
      const ev = hub.store.get(row.added_event);
      if (ev && !ev.deleted_at) hub.store.patch(ev.id, { deleted_at: now.toISOString() });
      hub.mailDb.prepare("UPDATE mail_invites SET added_event = NULL WHERE id = ?").run(e.id);
      if (eventId === row.added_event) eventId = null;
    }
  } else {
    const there = eventWithUid(hub, String(e.fields.uid), row.added_event);
    if (there) eventId = there.id;
    else {
      const f = e.fields;
      const ev = hub.store.create("event", { title, start: f.start, end: f.end, all_day: f.all_day === true, ...(typeof f.location === "string" && f.location ? { location: f.location } : {}) }, "personal");
      hub.mailDb.prepare("UPDATE mail_invites SET added_event = ? WHERE id = ?").run(ev.id, e.id);
      eventId = ev.id;
      added = true;
    }
  }
  const invitation = hub.store.patch(e.id, {
    answer, answered_at: now.toISOString(), event_id: eventId,
    reply: { outbox: queued.id, state: "waiting", answer, was: String(e.fields.answer ?? "needs_action"), send_at: queued.send_at, ...(added ? { added_event: true } : {}) },
  });
  console.log("[invitations] 1 answer waits in the outbox");
  return { invitation, outbox: { id: queued.id, state: "waiting", send_at: queued.send_at } };
}

/** Undo (`POST /invitations/:id/undo`): the reply taken back, the answer as it was, the event this answer added taken out. */
export function undoAnswer(hub: Hub, id: string): { invitation: Entity } {
  const e = invitationOf(hub, id);
  const reply = e.fields.reply as { outbox: string; state: string; was: string; added_event?: boolean } | undefined;
  if (!reply || reply.state === "sent") throw new StoreError(reply ? 409 : 404, reply ? "It was sent already." : "There is no answer to take back.");
  try { takeBack(hub, reply.outbox); } catch (err) { if (!(err instanceof StoreError && err.status === 404)) throw err; }
  const row = mailInviteRow(hub, id);
  let eventId = typeof e.fields.event_id === "string" ? e.fields.event_id : null;
  if (reply.added_event && row?.added_event) {
    const ev = hub.store.get(row.added_event);
    if (ev && !ev.deleted_at) hub.store.patch(ev.id, { deleted_at: nowIso() });
    hub.mailDb.prepare("UPDATE mail_invites SET added_event = NULL WHERE id = ?").run(id);
    if (eventId === row.added_event) eventId = null;
  }
  const was = reply.was === "accepted" || reply.was === "tentative" || reply.was === "declined" ? reply.was : "needs_action";
  return { invitation: hub.store.patch(id, { answer: was, reply: null, event_id: eventId, ...(was === "needs_action" ? { answered_at: null } : {}) }) };
}

/** Try again (`POST /invitations/:id/retry`): the outbox's Try again for an answer that was not sent. */
export function retryAnswer(hub: Hub, id: string): { invitation: Entity } {
  const e = invitationOf(hub, id);
  const reply = e.fields.reply as Record<string, unknown> | undefined;
  if (!reply) throw new StoreError(404, "There is no answer to send again.");
  const item = retrySend(hub, String(reply.outbox));
  const { error: _e, ...rest } = reply;
  return { invitation: hub.store.patch(id, { reply: { ...rest, state: item.state, send_at: item.send_at } }) };
}

/** The reply's state follows its mail through the outbox. */
function followOutbox(hub: Hub, outboxId: string): void {
  const e = hub.store.list({ kind: "invitation", limit: 5000 }).find((x) => (x.fields.reply as { outbox?: string } | undefined)?.outbox === outboxId);
  if (!e) return;
  const reply = e.fields.reply as Record<string, unknown>;
  const item = outboxItem(hub, outboxId);
  if (!item) return; // taken back: undoAnswer writes the invitation itself
  const { error: _e, ...rest } = reply;
  const next = { ...rest, state: item.state, send_at: item.send_at, ...(item.state === "failed" && item.error ? { error: item.error } : {}) };
  if (JSON.stringify(next) !== JSON.stringify(reply)) hub.store.patch(e.id, { reply: next });
}

// ---------------------------------------------------------------------------------------------------------------------
// Keeping the list

/**
 * Every 10 minutes and when a module is switched: an invitation a day past its event's end goes; one from iCloud or mail whose
 * account, calendar sync or mailbox is gone goes with it; requests kept for invitations that are gone go too.
 */
export function sweepInvitations(hub: Hub, now: Date = new Date()): number {
  const icloud = new Set((hub.connections.get().icloud ?? []).filter((a) => a.calendar).map((a) => a.email));
  const calendarsOn = hub.modules.on("calendars");
  const mailOn = hub.modules.on("mail_inbox");
  const shownMail = new Set(mailOn ? INBOX_SOURCES.flatMap((s) => s.accounts(hub)).map((a) => a.slice(a.indexOf(":") + 1).toLowerCase()) : []);
  let n = 0;
  for (const e of hub.store.list({ kind: "invitation", limit: 5000 })) {
    const from = e.fields.from as { kind?: string; account?: string; mailbox?: string } | undefined;
    const old = Date.parse(String(e.fields.end ?? e.fields.start)) < now.getTime() - DAY_MS;
    // The demo hub's made-up invitations name accounts it never links (sample-world.ts): only their end removes them.
    const orphan = e.fields.sample !== true && ((from?.kind === "icloud" && (!calendarsOn || !icloud.has(String(from.account))))
      || (from?.kind === "mail" && (!shownMail.has(String(from.mailbox).toLowerCase()) || !mailInviteRow(hub, e.id))));
    if ((old || orphan) && dropInvitation(hub, e.id)) n++;
  }
  try {
    for (const r of hub.mailDb.prepare("SELECT id FROM mail_invites").all() as { id: string }[]) {
      const e = hub.store.get(r.id);
      if (!e || e.deleted_at) hub.mailDb.prepare("DELETE FROM mail_invites WHERE id = ?").run(r.id);
    }
  } catch (e) { console.error(`[invitations] ${errCode(e)}`); }
  if (n) console.log(`[invitations] ${n} gone (ended, or their account no longer linked)`);
  return n;
}

/** At app start: the outbox's changes reach the invitations, and a module switched sweeps the list. */
export function installInvitations(hub: Hub): void {
  onOutboxChange(hub, (id) => { try { followOutbox(hub, id); } catch (e) { console.error(`[invitations] ${errCode(e)}`); } });
  hub.modules.onChange(() => { try { sweepInvitations(hub); } catch (e) { console.error(`[invitations] ${errCode(e)}`); } });
}

/** A minute after start, then every 10 minutes (an account unlinked takes its invitations with it soon after). */
export function startInvitationsJob(hub: Hub): () => void {
  const tick = () => { try { sweepInvitations(hub); } catch (e) { console.error(`[invitations] ${errCode(e)}`); } };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 10 * 60_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
