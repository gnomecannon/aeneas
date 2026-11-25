import crypto from "node:crypto";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { buildMessage, foldedHeader } from "./mail-compose.js";
import { composeMail, composedFiles, exclusive, listInFolder, refreshMail, saveDraftRaw, sourceOf, trashOldDraft, unsubscribeMail, type DraftResult } from "./mail-inbox.js";
import { noSendingServer, readOnly, readOnlyText } from "./imports/icloud.js";
import { mailboxLabel } from "./mail-filer.js";
import { errCode } from "./logsafe.js";

/**
 * Sending mail from the Mail screen (since 2026-11-24, CONTRACT.md Mail): the outbox. Send puts the mail here, built
 * by the same code as a draft (mail-inbox.ts composeMail, mail-compose.ts buildMessage: the same recipients, headers,
 * thread and files), and it waits SEND_DELAY_MS, the screen's Undo, before the hub hands it to the account's sending
 * server (icloud.ts sendICloud, smtp.ts).
 *
 * - Only the owner sends: the route is the Mail screen's, closed to the assistant's tools (ai/api-guard.ts) like all
 *   of `/mail`, and the assistant has no tool that writes mail.
 * - Kept in `mail.sqlite` with the rest of the mail (never backed up or synced), the message itself sealed with the
 *   hub's sign-ins key (secretbox.ts) while it waits; deleted with its mailbox and the module, its message cleared once
 *   it is sent and filed.
 * - Sent once, never twice: a mail is claimed (`waiting` to `sending`) in one statement before the hub connects, and
 *   marked `sent` the moment the server answers that it has it, before the connection is closed. A hub that stops while
 *   a mail waits sends it at the next start (at once when its time has passed). A hub that stops while a mail is being
 *   sent cannot know whether the server got it: that mail is never sent again by itself, but shows as not sent, saying
 *   so, for the owner to look in Sent and try again (Try again sends the same message, with the same Message-ID, which
 *   Gmail and most mail servers take as the same mail).
 * - Never lost: a mail the server refuses (the password, a recipient, a server that does not answer) stays here,
 *   `failed`, with the hub's words for why, until the owner takes it back into the writing box (Undo, Edit), tries
 *   again, saves it as a draft, or discards it.
 * - A Bcc (only ever an edited draft's own) is sent but never written into the message, so the copy in Sent has none.
 * - Once sent: the copy goes into the folder marked `\Sent` with `\Seen` (not on Gmail, which files it itself), an
 *   edited draft's old version goes to Trash, and a refresh is started, which puts a reply in its thread.
 * Logs hold counts and error codes only.
 */

/** How long a mail waits before it is sent: the screen's Undo. */
export const SEND_DELAY = 10_000;
let delayMs = SEND_DELAY;
/** For tests: a shorter wait (null puts it back). */
export function setSendDelay(ms: number | null) { delayMs = ms ?? SEND_DELAY; }

export type OutboxState = "waiting" | "sending" | "sent" | "failed";
interface Row {
  id: string; account: string; state: OutboxState; send_at: string; made_at: string; message_id: string; rcpt: string; bcc: string | null;
  to_list: string; subject: string; text: string; files: string | null; raw: string | null; replaces: string | null; error: string | null;
  refused: string | null; sent_at: string | null; filed: number;
}
/** One mail in the outbox as the screen sees it: never its words, files or Bcc. */
export interface OutboxItem { id: string; mailbox: string; to: string[]; subject: string; state: OutboxState; send_at: string; sent_at?: string; error?: string; refused?: string[] }

/** What Send answers: the mail as it will go (as a preview shows it), with its place in the outbox. */
export type SendResult = Omit<DraftResult, "saved" | "id" | "bcc"> & { id: string; send_at: string; state: "waiting" };

/** Said for a mail the hub was sending when it stopped. */
export const STOPPED_WHILE_SENDING = "The hub stopped while it was sending this mail, so it may have gone. Look in Sent in your mail app before you try again.";

const sealName = "mail outbox";
const itemOf = (r: Row): OutboxItem => ({
  id: r.id, mailbox: r.account.slice(r.account.indexOf(":") + 1), to: JSON.parse(r.to_list) as string[], subject: r.subject, state: r.state, send_at: r.send_at,
  ...(r.sent_at ? { sent_at: r.sent_at } : {}), ...(r.error ? { error: r.error } : {}), ...(r.refused ? { refused: JSON.parse(r.refused) as string[] } : {}),
});
const rowOf = (hub: Hub, id: string) => hub.mailDb.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Row | undefined;
const sealed = (hub: Hub, raw: Buffer) => hub.secretBox.seal(sealName, raw.toString("base64"));
const opened = (hub: Hub, r: Row) => Buffer.from(hub.secretBox.open(sealName, r.raw ?? ""), "base64");
const emailOf = (account: string) => account.slice(account.indexOf(":") + 1);

/**
 * Send (`POST /mail/send`): the mail written on the Mail screen, checked and built as its draft would be, into the
 * outbox. It is sent SEND_DELAY_MS later unless taken back. Refused, and nothing kept, for a Read only mailbox and one
 * without a sending server (409), and for anything a draft is refused for.
 */
export async function sendMail(hub: Hub, body: Record<string, unknown>, now = new Date()): Promise<SendResult> {
  // A preview is asked of POST /mail/drafts: one sent here by mistake must not send the mail.
  if (body.preview !== undefined && body.preview !== false) throw new StoreError(422, "a preview is asked with POST /mail/drafts; Send sends");
  const c = await composeMail(hub, body);
  const email = emailOf(c.account);
  if (readOnly(hub, c.account)) throw new StoreError(409, readOnlyText(email));
  if (!c.source.send || !c.source.canSend?.(hub, c.account)) throw new StoreError(409, noSendingServer(email));
  const files = await composedFiles(hub, c);
  // The message as it goes and as Sent keeps it: without the Bcc, which goes in the envelope alone.
  const { bcc, ...shown } = c.fields;
  const { raw, message_id } = buildMessage({ from: c.from, text: c.text, ...shown, files });
  const rcpt = [...new Set([...c.fields.to, ...(c.fields.cc ?? []), ...(bcc ?? [])])];
  const id = crypto.randomBytes(12).toString("hex");
  const sendAt = new Date(now.getTime() + delayMs).toISOString();
  hub.mailDb.prepare(`INSERT INTO outbox (id, account, state, send_at, made_at, message_id, rcpt, bcc, to_list, subject, text, files, raw, replaces)
    VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, c.account, sendAt, now.toISOString(), message_id, JSON.stringify(rcpt), bcc?.length ? JSON.stringify(bcc) : null,
    JSON.stringify(c.fields.to), c.fields.subject, c.text, JSON.stringify(files.map((f) => ({ name: f.name, type: f.type, size: f.bytes.length }))), sealed(hub, raw),
    c.replaces ? JSON.stringify(c.replaces) : null);
  console.log(`[mail-outbox] ${mailboxLabel(hub, c.account)}: 1 mail waits to be sent, ${rcpt.length} recipients${files.length ? `, ${files.length} files` : ""}`);
  scheduleOutbox(hub);
  const { saved: _saved, bcc: _bcc, id: _id, ...out } = c.out;
  return { ...out, ...(files.length ? { files: files.map((f) => ({ name: f.name, size: f.bytes.length })) } : {}), id, send_at: sendAt, state: "waiting" };
}

/**
 * A message the hub built itself for the owner's own press (since 2026-11-25: the answer to an invitation, Invitations
 * in CONTRACT.md), into the outbox as Send puts a mail there: the same checks (409 for a Read only mailbox and one
 * without a sending server), the same SEND_DELAY_MS of Undo, the same sending and the same copy in Sent.
 */
export function queueMessage(hub: Hub, account: string, m: { raw: Buffer; message_id: string; to: string[]; subject: string; text: string }, now = new Date()): { id: string; send_at: string } {
  const email = emailOf(account);
  if (readOnly(hub, account)) throw new StoreError(409, readOnlyText(email));
  const source = sourceOf(account);
  if (!source?.send || !source.canSend?.(hub, account)) throw new StoreError(409, noSendingServer(email));
  const id = crypto.randomBytes(12).toString("hex");
  const sendAt = new Date(now.getTime() + delayMs).toISOString();
  hub.mailDb.prepare(`INSERT INTO outbox (id, account, state, send_at, made_at, message_id, rcpt, bcc, to_list, subject, text, files, raw, replaces)
    VALUES (?, ?, 'waiting', ?, ?, ?, ?, NULL, ?, ?, ?, '[]', ?, NULL)`).run(id, account, sendAt, now.toISOString(), m.message_id, JSON.stringify(m.to), JSON.stringify(m.to), m.subject, m.text, sealed(hub, m.raw));
  const rcpt = m.to.length;
  console.log(`[mail-outbox] ${mailboxLabel(hub, account)}: 1 mail waits to be sent, ${rcpt} recipients`);
  scheduleOutbox(hub);
  return { id, send_at: sendAt };
}

/** Told whenever a mail in the outbox changes state (claimed, sent, not sent, taken back, tried again), with its id. */
const listeners = new WeakMap<Hub, ((id: string) => void)[]>();
export function onOutboxChange(hub: Hub, fn: (id: string) => void): void {
  const list = listeners.get(hub) ?? [];
  list.push(fn);
  listeners.set(hub, list);
}
function changed(hub: Hub, id: string): void {
  for (const fn of listeners.get(hub) ?? []) { try { fn(id); } catch (e) { console.error(`[mail-outbox] listener ${errCode(e)}`); } }
}

/**
 * Unsubscribe by mail (`POST /mail/messages/:id/unsubscribe` with `{ how: "mailto", send: true }`, since 2026-11-24):
 * the mail to the address the mail's own List-Unsubscribe header gives now (never one from the request), from the
 * mailbox it is in, saying "unsubscribe", into the outbox as Send puts a mail there: the same checks (409 for a Read
 * only mailbox and one without a sending server) and the same 10 seconds of Undo. The screen asked first.
 */
export async function sendUnsubscribe(hub: Hub, key: string): Promise<{ ok: true; outbox: OutboxItem }> {
  const sent = await sendMail(hub, await unsubscribeMail(hub, key));
  const item = outboxItem(hub, sent.id);
  if (!item) throw new StoreError(404, "This mail is not in the outbox any more.");
  return { ok: true, outbox: item };
}

/** One mail in the outbox (`GET /mail/outbox/:id`); null when it is not there (taken back, or sent a day ago). */
export function outboxItem(hub: Hub, id: string): OutboxItem | null {
  const r = rowOf(hub, id);
  return r ? itemOf(r) : null;
}

/** The mail waiting, being sent, or not sent (`GET /mail` `outbox`), oldest first. */
export function outboxList(hub: Hub): OutboxItem[] {
  return (hub.mailDb.prepare("SELECT * FROM outbox WHERE state IN ('waiting', 'sending', 'failed') ORDER BY made_at").all() as Row[]).map(itemOf);
}

/**
 * Take a mail back (`POST /mail/outbox/:id/undo`): Undo while it waits, and Edit or Discard once it was not sent. It
 * leaves the outbox and is never sent; the screen puts it back in its writing box as it was. 409 once it is being sent
 * or was sent, 404 when it is not there.
 */
export function takeBack(hub: Hub, id: string): { undone: true } {
  if (hub.mailDb.prepare("DELETE FROM outbox WHERE id = ? AND state IN ('waiting', 'failed')").run(id).changes) {
    console.log("[mail-outbox] 1 mail taken back before it was sent");
    scheduleOutbox(hub);
    changed(hub, id);
    return { undone: true };
  }
  const r = rowOf(hub, id);
  if (!r) throw new StoreError(404, "This mail is not in the outbox any more.");
  throw new StoreError(409, r.state === "sent" ? "It was sent already." : "It is being sent now, so it can no longer be taken back.");
}

/** Try again (`POST /mail/outbox/:id/retry`): a mail that was not sent waits again, with its Undo, and is sent as it was. */
export function retrySend(hub: Hub, id: string, now = new Date()): OutboxItem {
  const sendAt = new Date(now.getTime() + delayMs).toISOString();
  if (!hub.mailDb.prepare("UPDATE outbox SET state = 'waiting', send_at = ?, error = NULL, refused = NULL WHERE id = ? AND state = 'failed'").run(sendAt, id).changes) {
    const r = rowOf(hub, id);
    if (!r) throw new StoreError(404, "This mail is not in the outbox any more.");
    throw new StoreError(409, r.state === "sent" ? "It was sent already." : "It is waiting to be sent already.");
  }
  scheduleOutbox(hub);
  changed(hub, id);
  return itemOf(rowOf(hub, id)!);
}

/**
 * Save draft (`POST /mail/outbox/:id/draft`): a mail that was not sent goes to the mailbox's Drafts folder as it is,
 * its Bcc written back in (a draft keeps it, as one made in a mail app does), and leaves the outbox. An edited draft's
 * old version goes to Trash, as when it is saved from the writing box.
 */
export async function draftFromOutbox(hub: Hub, id: string): Promise<{ saved: true; id?: string }> {
  const r = rowOf(hub, id);
  if (!r) throw new StoreError(404, "This mail is not in the outbox any more.");
  if (r.state !== "failed") throw new StoreError(409, r.state === "sent" ? "It was sent already." : "It is waiting to be sent: take it back first.");
  const bcc = r.bcc ? (JSON.parse(r.bcc) as string[]) : [];
  const msg = opened(hub, r);
  const raw = bcc.length ? Buffer.concat([Buffer.from(`${foldedHeader("Bcc", bcc, ",")}\r\n`), msg]) : msg;
  const name = hub.profile.get().name.trim();
  const key = await saveDraftRaw(hub, r.account, raw, {
    message_id: r.message_id, from: { name: name && name !== "the owner" ? name : "", address: emailOf(r.account) }, to: JSON.parse(r.to_list) as string[], subject: r.subject, text: r.text,
    files: r.files ? (JSON.parse(r.files) as { name: string; type: string; size: number }[]) : [],
  });
  hub.mailDb.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  if (r.replaces) await trashOldDraft(hub, r.account, JSON.parse(r.replaces) as { key: string; id: string; message_id: string | null });
  return { saved: true, ...(key ? { id: key } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sending: one mail at a time, each when its time comes

interface Runner { timer?: NodeJS.Timeout; chain: Promise<void>; stopped: boolean }
const runners = new WeakMap<Hub, Runner>();
const runnerOf = (hub: Hub): Runner => {
  let r = runners.get(hub);
  if (!r) { r = { chain: Promise.resolve(), stopped: false }; runners.set(hub, r); }
  return r;
};

/** The timer set for the next mail whose time comes. */
export function scheduleOutbox(hub: Hub): void {
  const run = runnerOf(hub);
  clearTimeout(run.timer);
  if (run.stopped) return;
  let next: { at: string | null };
  try { next = hub.mailDb.prepare("SELECT MIN(send_at) AS at FROM outbox WHERE state = 'waiting'").get() as { at: string | null }; } catch { return; }
  if (!next.at) return;
  run.timer = setTimeout(() => { void runOutbox(hub); }, Math.max(0, Date.parse(next.at) - Date.now()));
  run.timer.unref?.();
}

/** Every mail whose time has come, sent one after another; the next timer set after. Resolves with how many were sent. */
export function runOutbox(hub: Hub): Promise<number> {
  const run = runnerOf(hub);
  let sent = 0;
  const job = run.chain.then(async () => {
    for (;;) {
      if (run.stopped) return;
      const due = hub.mailDb.prepare("SELECT id FROM outbox WHERE state = 'waiting' AND send_at <= ? ORDER BY send_at LIMIT 1").get(new Date().toISOString()) as { id: string } | undefined;
      if (!due) return;
      // Claimed in one statement: Undo, which deletes only a waiting mail, and this never both win.
      if (hub.mailDb.prepare("UPDATE outbox SET state = 'sending' WHERE id = ? AND state = 'waiting'").run(due.id).changes !== 1) continue;
      changed(hub, due.id);
      if (await sendOne(hub, rowOf(hub, due.id)!)) sent++;
      changed(hub, due.id);
    }
  }).catch((e) => console.error(`[mail-outbox] ${errCode(e)}`)).finally(() => scheduleOutbox(hub));
  run.chain = job;
  return job.then(() => sent);
}

/** Send one claimed mail. True when the server took it. */
async function sendOne(hub: Hub, r: Row): Promise<boolean> {
  const db = hub.mailDb;
  const label = mailboxLabel(hub, r.account);
  const fail = (error: string, refused: string[] = []) => {
    db.prepare("UPDATE outbox SET state = 'failed', error = ?, refused = ? WHERE id = ? AND state = 'sending'").run(error, refused.length ? JSON.stringify(refused) : null, r.id);
  };
  let raw: Buffer;
  try { raw = opened(hub, r); } catch {
    fail("The hub could not read this mail back (its sign-ins key is not there), so it was not sent.");
    console.error(`[mail-outbox] ${label}: 1 mail could not be opened`);
    return false;
  }
  const source = sourceOf(r.account);
  if (!source?.send) { fail(noSendingServer(emailOf(r.account))); return false; }
  let taken = false;
  // Marked sent the moment the server has it, before the connection closes: a hub that stops after this never sends it again.
  const markSent = () => {
    taken = true;
    db.prepare("UPDATE outbox SET state = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(new Date().toISOString(), r.id);
  };
  try {
    await source.send(hub, r.account, { from: emailOf(r.account), to: JSON.parse(r.rcpt) as string[] }, raw, markSent);
  } catch (e) {
    if (!taken) {
      const known = e instanceof StoreError;
      fail(known ? e.message : "The mail was not sent: something went wrong on the hub. Try again.", (e as { refused?: string[] }).refused ?? []);
      console.error(`[mail-outbox] ${label}: 1 mail not sent ${(e as { kind?: string }).kind ?? errCode(e)}`);
      return false;
    }
  }
  if (!taken) markSent();
  console.log(`[mail-outbox] ${label}: 1 mail sent`);
  await fileSent(hub, r.id);
  return true;
}

/**
 * After a mail is sent: its copy in Sent (`\Seen`; none on Gmail, which files it itself), an edited draft's old version
 * to Trash, and a refresh, which threads a reply. Tried once now, and once more at the next start when it did not get
 * through (`last`); then the message is cleared from the hub either way.
 */
async function fileSent(hub: Hub, id: string, opts: { last?: boolean } = {}): Promise<void> {
  const db = hub.mailDb;
  const r = rowOf(hub, id);
  if (!r || r.state !== "sent" || r.filed || !r.raw) return;
  const source = sourceOf(r.account);
  const label = mailboxLabel(hub, r.account);
  let filed = true;
  try {
    const put = source?.saveSent ? await exclusive(hub, () => source.saveSent!(hub, r.account, opened(hub, r))) : null;
    if (put) {
      const name = hub.profile.get().name.trim();
      listInFolder(hub, r.account, put, "sent", {
        message_id: r.message_id, from: { name: name && name !== "the owner" ? name : "", address: emailOf(r.account) }, to: JSON.parse(r.to_list) as string[], subject: r.subject, text: r.text,
        files: r.files ? (JSON.parse(r.files) as { name: string; type: string; size: number }[]) : [],
      });
      console.log(`[mail-outbox] ${label}: its copy is in Sent`);
    }
  } catch (e) {
    filed = !!opts.last;
    console.error(`[mail-outbox] ${label}: the copy for Sent was not filed ${errCode(e)}`);
  }
  if (r.replaces) await trashOldDraft(hub, r.account, JSON.parse(r.replaces) as { key: string; id: string; message_id: string | null });
  db.prepare(`UPDATE outbox SET replaces = NULL${filed ? ", filed = 1, raw = NULL" : ""} WHERE id = ?`).run(id);
  void refreshMail(hub).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
}

/** Sent mail is listed for a day (a screen that asks learns it went), then leaves the outbox. */
const SENT_KEPT_MS = 86_400_000;

/**
 * At start (main.ts, the hub that serves; never a command run beside it): a mail that was being sent when the hub
 * stopped is marked not sent, with STOPPED_WHILE_SENDING, and never sent again by itself; sent mail whose copy was not
 * filed gets its last try; sent mail a day old leaves; and the timer is set for what waits (at once for a mail whose
 * time passed while the hub was stopped).
 */
export function startOutbox(hub: Hub): () => void {
  const db = hub.mailDb;
  const stopped = (db.prepare("SELECT id FROM outbox WHERE state = 'sending'").all() as { id: string }[]).map((r) => r.id);
  const cut = db.prepare("UPDATE outbox SET state = 'failed', error = ? WHERE state = 'sending'").run(STOPPED_WHILE_SENDING).changes;
  if (cut) console.error(`[mail-outbox] ${cut} mail may have gone as the hub stopped: shown as not sent`);
  for (const id of stopped) changed(hub, id);
  db.prepare("DELETE FROM outbox WHERE state = 'sent' AND sent_at < ?").run(new Date(Date.now() - SENT_KEPT_MS).toISOString());
  for (const r of db.prepare("SELECT id FROM outbox WHERE state = 'sent' AND filed = 0").all() as { id: string }[]) void fileSent(hub, r.id, { last: true });
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'waiting'").get() as { n: number }).n;
  if (waiting) console.log(`[mail-outbox] ${waiting} mail waits to be sent`);
  runnerOf(hub).stopped = false;
  scheduleOutbox(hub);
  // Mail the assistant proposed and nobody sent: gone 24 hours after it was made (mail-proposals.ts).
  const purge = () => { try { hub.mailDb.prepare("DELETE FROM mail_proposals WHERE expires_at <= ?").run(new Date().toISOString()); } catch { /* closed */ } };
  purge();
  const hourly = setInterval(purge, 3600_000);
  hourly.unref?.();
  return () => { clearInterval(hourly); stopOutbox(hub); };
}

/** Nothing more is sent by this hub object (it is closing); what waits stays for the next start. */
export function stopOutbox(hub: Hub): void {
  const run = runnerOf(hub);
  run.stopped = true;
  clearTimeout(run.timer);
}
