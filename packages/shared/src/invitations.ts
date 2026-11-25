import { z } from "zod";

/**
 * Invitations (CONTRACT.md section 2, `invitation`, and section 3, Invitations): one list of the invitations waiting
 * for the owner's answer, from an iCloud calendar the hub keeps in step, from mail, or from Apple Calendar on an
 * iPhone, iPad or Mac. The list rules here are the web's and the hub's; EACore `Invitations.swift` keeps the same, and
 * both are tested with `test/invitation-cases.json`.
 */

const iso = z.string().min(10).max(40);

export const InvitationAnswer = z.enum(["needs_action", "accepted", "tentative", "declined"]);
export type InvitationAnswer = z.infer<typeof InvitationAnswer>;
/** What the owner can press: Accept, Maybe, Decline. */
export const OwnerAnswer = z.enum(["accepted", "tentative", "declined"]);
export type OwnerAnswer = z.infer<typeof OwnerAnswer>;
export const AnswerBy = z.enum(["caldav", "mail", "open_in_calendar"]);
export type AnswerBy = z.infer<typeof AnswerBy>;

const text = (max: number) => z.string().max(max);

export const InvitationFrom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("icloud"), account: text(254), calendar: text(2000), href: text(2000) }),
  z.object({ kind: z.literal("mail"), mailbox: text(254), message: text(200) }),
  z.object({ kind: z.literal("device"), device: text(200), event: text(1000) }),
]);
export type InvitationFrom = z.infer<typeof InvitationFrom>;

export const ReplyState = z.enum(["waiting", "sending", "sent", "failed"]);
export type ReplyState = z.infer<typeof ReplyState>;

export const InvitationFields = z.object({
  title: text(1000),
  start: iso,
  end: iso,
  all_day: z.boolean().optional(),
  location: text(1000).optional(),
  organizer: z.object({ name: text(200).optional(), address: text(254).optional() }).optional(),
  answer: InvitationAnswer,
  answered_at: iso.optional(),
  answer_by: AnswerBy,
  from: InvitationFrom,
  uid: z.string().min(1).max(1000),
  sequence: z.number().int().min(0).max(1_000_000_000).optional(),
  repeats: z.boolean().optional(),
  event_id: text(100).optional(),
  /** Made by the demo hub's sample world: its made-up account is never linked, so the sweep keeps it. */
  sample: z.boolean().optional(),
  reply: z.object({
    outbox: text(100),
    state: ReplyState,
    answer: OwnerAnswer,
    was: InvitationAnswer,
    send_at: iso,
    error: text(1000).optional(),
    added_event: z.boolean().optional(),
  }).optional(),
});
export type InvitationFieldsT = z.infer<typeof InvitationFields>;

/** Which source is listed when one invitation (one UID) came from several: iCloud, then mail, then Apple Calendar. */
export const ANSWER_BY_ORDER: Record<string, number> = { caldav: 0, mail: 1, open_in_calendar: 2 };

/** Answered ones stay under Answered this long. */
export const ANSWERED_DAYS = 7;
const DAY_MS = 86_400_000;

export interface InvitationLike {
  id: string;
  deleted_at?: string | null;
  updated_at?: string;
  fields: Record<string, unknown>;
}

/** A mail answer that is not sent yet: the row stays among the pending ones, with Undo or Try again. */
export function replyOpen(f: Record<string, unknown>): boolean {
  const r = f.reply as { state?: unknown } | undefined;
  return !!r && (r.state === "waiting" || r.state === "sending" || r.state === "failed");
}

/**
 * The list as every client shows it: one per UID (iCloud first, then mail, then Apple Calendar; of one source the
 * newest), the pending ones by start (an answer still being sent stays among them), the ones answered in the last
 * ANSWERED_DAYS newest first, and how many wait for an answer (the badge and Today's line).
 */
export function invitationList<T extends InvitationLike>(items: T[], now: Date): { pending: T[]; answered: T[]; count: number } {
  const best = new Map<string, T>();
  for (const e of items) {
    if (e.deleted_at) continue;
    const uid = typeof e.fields.uid === "string" && e.fields.uid ? e.fields.uid : `id:${e.id}`;
    const cur = best.get(uid);
    if (!cur) { best.set(uid, e); continue; }
    const a = ANSWER_BY_ORDER[String(e.fields.answer_by)] ?? 9;
    const b = ANSWER_BY_ORDER[String(cur.fields.answer_by)] ?? 9;
    if (a < b || (a === b && (e.updated_at ?? "") > (cur.updated_at ?? ""))) best.set(uid, e);
  }
  const pending: T[] = [];
  const answered: T[] = [];
  const since = now.getTime() - ANSWERED_DAYS * DAY_MS;
  for (const e of best.values()) {
    const f = e.fields;
    const ended = Date.parse(String(f.end ?? f.start ?? "")) <= now.getTime();
    if (replyOpen(f) || (f.answer === "needs_action" && !ended)) { pending.push(e); continue; }
    if (f.answer !== "needs_action" && typeof f.answered_at === "string" && Date.parse(f.answered_at) >= since) answered.push(e);
  }
  const start = (e: T) => String(e.fields.start ?? "");
  pending.sort((x, y) => start(x).localeCompare(start(y)) || x.id.localeCompare(y.id));
  answered.sort((x, y) => String(y.fields.answered_at).localeCompare(String(x.fields.answered_at)) || x.id.localeCompare(y.id));
  return { pending, answered, count: pending.filter((e) => e.fields.answer === "needs_action" && !replyOpen(e.fields)).length };
}

/** The words every client uses (EACore `Invitations.Texts`). */
export const INVITE_TEXTS = {
  title: "Invitations",
  none: "No invitations need an answer.",
  answered: "Answered",
  offline: "Connect to your hub to answer.",
  inCalendarApp: "Answer this in your calendar app.",
  openInCalendar: "Open in Calendar",
  accept: "Accept",
  maybe: "Maybe",
  decline: "Decline",
  undo: "Undo",
  retry: "Try again",
  done: { accepted: "Accepted.", tentative: "Maybe.", declined: "Declined." } as Record<OwnerAnswer, string>,
  state: { needs_action: "Not answered", accepted: "Accepted", tentative: "Maybe", declined: "Declined" } as Record<InvitationAnswer, string>,
} as const;

/** "1 invitation", "2 invitations": Today's Needs you line. */
export const invitationCount = (n: number) => `${n} invitation${n === 1 ? "" : "s"}`;

/** Who invited the owner, in words: the organizer's name, else the address, else nothing. */
export function organizerName(f: Record<string, unknown>): string {
  const o = f.organizer as { name?: unknown; address?: unknown } | undefined;
  const name = typeof o?.name === "string" ? o.name.trim() : "";
  const address = typeof o?.address === "string" ? o.address.trim() : "";
  return name || address;
}

/** The line a mail answer shows while it is not sent yet, or null when there is none. */
export function replyLine(f: Record<string, unknown>): { text: string; undo: boolean; retry: boolean } | null {
  const r = f.reply as { state?: unknown; error?: unknown } | undefined;
  if (!r || !replyOpen(f)) return null;
  if (r.state === "failed") return { text: `Not sent: ${typeof r.error === "string" && r.error ? r.error : "the answer did not go."}`, undo: true, retry: true };
  const who = organizerName(f) || "the organizer";
  return { text: `Sending your answer to ${who}.`, undo: r.state === "waiting", retry: false };
}

/** A declined event that stays on its calendar (`event.declined`): every client leaves it out, as Calendar does. */
export const isDeclined = (f: Record<string, unknown>) => f.declined === true;
