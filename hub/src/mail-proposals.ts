import crypto from "node:crypto";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { checkedText, SUBJECT_MAX, typedAddresses, FILES_BYTES, FILES_MAX } from "./mail-compose.js";
import { INBOX_SOURCES, sourceOf } from "./mail-inbox.js";
import { noSendingServer, readOnly, readOnlyText } from "./imports/icloud.js";
import { outboxItem, retrySend, sendMail, takeBack, type OutboxItem } from "./mail-outbox.js";
import { errCode } from "./logsafe.js";

/**
 * A mail the assistant wrote, for the owner to send with one tap (since 2026-11-24, CONTRACT.md Mail, Mail from the
 * assistant). The owner asked for it, and declined letting the assistant send by itself: its tool, propose_mail
 * (ai/tools.ts), only keeps a proposal here, and the chat shows it as a card with Send, Edit and Cancel. Send is the
 * owner's, on routes the assistant's tools can never reach (`/mail` is closed to them, ai/api-guard.ts), and puts the
 * mail in the outbox with its 10 seconds of Undo (mail-outbox.ts), built as any mail written on the Mail screen.
 *
 * - Its recipients are only addresses the owner gave in the chat (their own messages) or that are in People: never one
 *   from a web page, a mail or anything a tool fetched, so nothing the model read can choose who gets a mail.
 * - It goes from a mailbox that is not Read only and has a sending server, while Mail is on; otherwise the tool says why.
 * - Kept in `mail.sqlite` beside the outbox, its words sealed with the hub's sign-ins key, and deleted 24 hours after
 *   it was made, whatever came of it (the chat keeps whether it was sent, cancelled or opened to edit).
 * - The pictures the owner attached in the chat may go with it as files (`photos`), read from the hub's own store.
 */

/** How long a proposal is kept. */
export const PROPOSAL_HOURS = 24;
const sealName = "mail proposal";

export type ProposalState = "proposed" | "sent" | "cancelled" | "edited";
interface Row { id: string; session_id: string; account: string; state: ProposalState; made_at: string; expires_at: string; body: string; outbox_id: string | null }
interface Body { to: string[]; cc: string[]; subject: string; text: string; photos: string[] }

/**
 * A proposal as its card shows it. `state`: proposed (Send, Edit, Cancel), waiting (Sending, with Undo), sending, sent,
 * failed (the hub's words, Try again, Edit, Cancel), cancelled, or edited (opened on the Mail screen).
 */
export interface ProposalView {
  id: string; from: { name: string; address: string }; to: string[]; cc: string[]; subject: string; text: string; files: { name: string; size: number }[];
  state: "proposed" | "waiting" | "sending" | "sent" | "failed" | "cancelled" | "edited"; error?: string; expires_at: string;
}

/** What the chat keeps on the assistant's reply that proposed a mail: its id, and how it ended once it did. */
export interface ChatProposal { id: string; state?: "sent" | "cancelled" | "edited" }

const ownerName = (hub: Hub) => { const n = hub.profile.get().name.trim(); return n && n !== "the owner" ? n : ""; };
const emailOf = (account: string) => account.slice(account.indexOf(":") + 1);
const rowOf = (hub: Hub, id: string) => hub.mailDb.prepare("SELECT * FROM mail_proposals WHERE id = ?").get(id) as Row | undefined;
const bodyOf = (hub: Hub, r: Row) => JSON.parse(hub.secretBox.open(sealName, r.body)) as Body;

/** Proposals older than PROPOSAL_HOURS: gone. Run before every read and each hour on the hub that serves. */
export function purgeProposals(hub: Hub, now = new Date()): number {
  try { return hub.mailDb.prepare("DELETE FROM mail_proposals WHERE expires_at <= ?").run(now.toISOString()).changes; } catch { return 0; }
}

/** What the tool is given: from (an address of a linked mailbox), to and cc (addresses), subject, text, photos. */
export interface ProposalInput { from?: unknown; to?: unknown; cc?: unknown; subject?: unknown; text?: unknown; photos?: unknown }
/** What the assistant's turn knows that a proposal is checked against. */
export interface ProposalTurn {
  sessionId: string;
  /** Everything the owner wrote in this chat, their newest message included. */
  ownerText: string;
  /** The pictures the owner attached in this chat (hub image ids), newest last. */
  photoIds: string[];
}

/** The mailbox a proposal goes from: the one named, else the first that is not Read only and can send. */
function mailboxFor(hub: Hub, from: unknown): string {
  const all = INBOX_SOURCES.flatMap((s) => s.accounts(hub));
  const asked = typeof from === "string" ? from.trim().toLowerCase() : "";
  if (!all.length) throw new StoreError(409, "No mailbox is linked, so I cannot write a mail for you to send. Add one in Settings, Accounts.");
  if (asked) {
    const a = all.find((x) => emailOf(x) === asked);
    if (!a) throw new StoreError(422, `${asked} is not one of your linked mailboxes.`);
    if (readOnly(hub, a)) throw new StoreError(409, readOnlyText(asked));
    if (!sourceOf(a)?.canSend?.(hub, a)) throw new StoreError(409, noSendingServer(asked));
    return a;
  }
  const ok = all.find((a) => !readOnly(hub, a) && !!sourceOf(a)?.canSend?.(hub, a));
  if (ok) return ok;
  const first = all[0];
  throw new StoreError(409, readOnly(hub, first) ? readOnlyText(emailOf(first)) : noSendingServer(emailOf(first)));
}

/** The addresses in People (each person's emails), lower case. */
function peopleAddresses(hub: Hub): Set<string> {
  const out = new Set<string>();
  for (const p of hub.store.list({ kind: "person" })) {
    if (p.deleted_at) continue;
    const emails = Array.isArray(p.fields.emails) ? p.fields.emails : [];
    for (const e of emails) { const v = String((e as { value?: unknown })?.value ?? "").trim().toLowerCase(); if (v) out.add(v); }
  }
  return out;
}

/**
 * propose_mail: check everything a send would, keep the proposal, send nothing. The answer names it for the card;
 * a refusal says why in words the assistant passes on (Mail off, no mailbox, Read only, no sending server, an address
 * the owner never gave).
 */
export function proposeMail(hub: Hub, input: ProposalInput, turn: ProposalTurn, now = new Date()): { id: string; from: string; to: string[]; cc: string[]; subject: string; files: { name: string; size: number }[]; expires_at: string } {
  purgeProposals(hub, now);
  if (!hub.modules.on("mail_inbox")) throw new StoreError(409, "Mail is off on this hub, so I cannot write a mail for you to send. Switch Mail on in Settings, Modules, and add a mailbox in Settings, Accounts.");
  const account = mailboxFor(hub, input.from);
  const to = typedAddresses(input.to, "to", 1);
  const cc = typedAddresses(input.cc, "cc", 0).filter((x) => !to.includes(x));
  // Only addresses the owner gave: typed in this chat, or in People. Never one the model read somewhere.
  const said = turn.ownerText.toLowerCase();
  const people = peopleAddresses(hub);
  const unknown = [...to, ...cc].filter((x) => !people.has(x) && !said.includes(x));
  if (unknown.length) throw new StoreError(422, `I can only write to addresses you gave me in this chat or that are in People, and ${unknown.join(", ")} is neither. Tell me the address, or add it to the person in People.`);
  const subject = typeof input.subject === "string" ? input.subject.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (subject.length > SUBJECT_MAX) throw new StoreError(422, `subject is at most ${SUBJECT_MAX} characters`);
  const text = checkedText(input.text);
  const photos = input.photos === true ? turn.photoIds.filter((p) => !!hub.ai.images.read(p)).slice(-FILES_MAX) : [];
  const files = photoFiles(hub, photos).map((f) => ({ name: f.name, size: f.bytes.length }));
  if (files.reduce((n, f) => n + f.size, 0) > FILES_BYTES) throw new StoreError(413, "The pictures are more than 15 MB together. Send them from your mail app.");
  const id = crypto.randomBytes(12).toString("hex");
  const expires = new Date(now.getTime() + PROPOSAL_HOURS * 3600_000).toISOString();
  const body: Body = { to, cc, subject, text, photos };
  hub.mailDb.prepare("INSERT INTO mail_proposals (id, session_id, account, state, made_at, expires_at, body) VALUES (?, ?, ?, 'proposed', ?, ?, ?)")
    .run(id, turn.sessionId, account, now.toISOString(), expires, hub.secretBox.seal(sealName, JSON.stringify(body)));
  // Counts only: no address, subject or file name reaches the log.
  const recipients = to.length + cc.length, attached = files.length;
  console.log(`[mail-proposals] 1 mail proposed in a chat, ${recipients} recipients${attached ? `, ${attached} files` : ""}`);
  return { id, from: emailOf(account), to, cc, subject, files, expires_at: expires };
}

/** A proposal's card (`GET /mail/proposals/:id`); null when it is not kept (it expired, or never was). */
export function proposalView(hub: Hub, id: string, now = new Date()): ProposalView | null {
  purgeProposals(hub, now);
  const r = rowOf(hub, id);
  if (!r) return null;
  const b = bodyOf(hub, r);
  let state: ProposalView["state"] = r.state === "sent" ? "sent" : r.state;
  let error: string | undefined;
  if (r.state === "sent" && r.outbox_id) {
    const o = outboxItem(hub, r.outbox_id);
    if (!o) {
      // Taken out of the outbox elsewhere (Discard on the Mail screen): it was never sent.
      setState(hub, r, "cancelled");
      state = "cancelled";
    } else if (o.state === "sent") {
      state = "sent";
    } else {
      state = o.state;
      error = o.error;
    }
  }
  const files = photoFiles(hub, b.photos).map((f) => ({ name: f.name, size: f.bytes.length }));
  return { id: r.id, from: { name: ownerName(hub), address: emailOf(r.account) }, to: b.to, cc: b.cc, subject: b.subject, text: b.text, files, state, ...(error ? { error } : {}), expires_at: r.expires_at };
}

/** A picture's file as a mail carries it: "Photo 2.png", its type and bytes, from the hub's own store; null when gone. */
function photoFile(hub: Hub, id: string, i: number): { name: string; type: string; bytes: Buffer } | null {
  const img = hub.ai.images.read(id);
  if (!img) return null;
  const ext = img.mime === "image/jpeg" ? "jpeg" : img.mime.slice("image/".length);
  return { name: `Photo ${i + 1}.${ext}`, type: img.mime, bytes: img.data };
}
const photoFiles = (hub: Hub, ids: string[]) => ids.map((p, i) => photoFile(hub, p, i)).filter((f): f is NonNullable<typeof f> => !!f);

/** A proposal's end, kept on the chat's reply too, so the card says it after the proposal itself is gone. */
function setState(hub: Hub, r: Row, state: ProposalState, outbox: string | null = r.outbox_id): void {
  hub.mailDb.prepare("UPDATE mail_proposals SET state = ?, outbox_id = ? WHERE id = ?").run(state, outbox, r.id);
  const final: ChatProposal["state"] | undefined = state === "proposed" ? undefined : state;
  try {
    const s = hub.ai.sessions.get(r.session_id);
    if (!s) return;
    let changed = false;
    for (const m of s.messages) if (m.mail_proposal?.id === r.id) { m.mail_proposal = { id: r.id, ...(final ? { state: final } : {}) }; changed = true; }
    if (changed) hub.ai.sessions.save(s.session_id, s.task_type, s.messages);
  } catch (e) { console.error(`[mail-proposals] the chat was not updated ${errCode(e)}`); }
}

function needed(hub: Hub, id: string): Row {
  purgeProposals(hub);
  const r = rowOf(hub, id);
  if (!r) throw new StoreError(404, "This mail is not kept any more: after 24 hours it is gone. Nothing was sent.");
  return r;
}

/** Send (`POST /mail/proposals/:id/send`): into the outbox, with its Undo, as a mail written on the Mail screen. */
export async function sendProposal(hub: Hub, id: string): Promise<ProposalView> {
  const r = needed(hub, id);
  if (r.state !== "proposed") throw new StoreError(409, r.state === "sent" ? "It was sent already." : r.state === "cancelled" ? "It was cancelled." : "It was opened on the Mail screen: send it from there.");
  const b = bodyOf(hub, r);
  const files = photoFiles(hub, b.photos).map((f) => ({ name: f.name, type: f.type, data: f.bytes.toString("base64") }));
  // The same mail and checks as Send on the Mail screen: Read only and no sending server are refused there too.
  const out = await sendMail(hub, { from: emailOf(r.account), to: b.to, ...(b.cc.length ? { cc: b.cc } : {}), subject: b.subject, text: b.text, ...(files.length ? { files } : {}) });
  setState(hub, r, "sent", out.id);
  return proposalView(hub, id)!;
}

/** Undo (`POST /mail/proposals/:id/undo`) while it waits: out of the outbox, and the card offers Send again. */
export function undoProposal(hub: Hub, id: string): ProposalView {
  const r = needed(hub, id);
  if (r.state !== "sent" || !r.outbox_id) throw new StoreError(409, "It is not waiting to be sent.");
  takeBack(hub, r.outbox_id);
  setState(hub, r, "proposed", null);
  return proposalView(hub, id)!;
}

/** Try again (`POST /mail/proposals/:id/retry`) after it was not sent. */
export function retryProposal(hub: Hub, id: string): ProposalView {
  const r = needed(hub, id);
  if (r.state !== "sent" || !r.outbox_id) throw new StoreError(409, "It is not waiting to be sent.");
  retrySend(hub, r.outbox_id);
  return proposalView(hub, id)!;
}

/** Cancel (`POST /mail/proposals/:id/cancel`): never sent (one that was not sent leaves the outbox too). */
export function cancelProposal(hub: Hub, id: string): ProposalView {
  const r = needed(hub, id);
  if (r.state === "sent" && r.outbox_id) {
    const o: OutboxItem | null = outboxItem(hub, r.outbox_id);
    if (o && o.state !== "failed") throw new StoreError(409, o.state === "sent" ? "It was sent already." : "It is being sent: use Undo.");
    if (o) takeBack(hub, r.outbox_id);
  } else if (r.state !== "proposed") throw new StoreError(409, r.state === "cancelled" ? "It was cancelled already." : "It was opened on the Mail screen.");
  setState(hub, r, "cancelled", null);
  console.log("[mail-proposals] 1 proposed mail cancelled");
  return proposalView(hub, id)!;
}

/**
 * Edit (`POST /mail/proposals/:id/edit`): the mail as the Mail screen's writing box takes it (its pictures as files,
 * base64), and the card leaves it to the box: from there it is sent or saved as a draft. One that was not sent leaves
 * the outbox first.
 */
export function editProposal(hub: Hub, id: string): { from: string; to: string[]; cc: string[]; subject: string; text: string; files: { name: string; type: string; data: string }[] } {
  const r = needed(hub, id);
  if (r.state === "sent" && r.outbox_id) {
    const o = outboxItem(hub, r.outbox_id);
    if (o && o.state !== "failed") throw new StoreError(409, o.state === "sent" ? "It was sent already." : "It is being sent: use Undo first.");
    if (o) takeBack(hub, r.outbox_id);
  } else if (r.state !== "proposed") throw new StoreError(409, r.state === "cancelled" ? "It was cancelled." : "It was opened on the Mail screen already.");
  const b = bodyOf(hub, r);
  setState(hub, r, "edited", null);
  const files = photoFiles(hub, b.photos).map((f) => ({ name: f.name, type: f.type, data: f.bytes.toString("base64") }));
  return { from: emailOf(r.account), to: b.to, cc: b.cc, subject: b.subject, text: b.text, files };
}
