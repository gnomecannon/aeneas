import { INVITE_TEXTS, invitationCount, invitationList, organizerName, replyLine, type Entity, type OwnerAnswer } from "@everythingapp/shared";
import { fmtDayLabel, parseLocalDate } from "./planner";
import { fmtTime } from "./time";

/**
 * Invitations on the web, Windows and Android apps (CONTRACT.md section 3, Invitations): the list rules are packages/
 * shared's (`invitationList`, the same in EACore `Invitations`), these are the words and buttons of a row.
 */

export { INVITE_TEXTS, invitationCount, invitationList };

const DAY_MS = 86_400_000;

/**
 * When it is, in words: "Fri Nov 27, 7:00 PM to 9:00 PM", "Fri Nov 27, 11:00 PM to Sat Nov 28, 1:00 AM", "Fri Nov 27,
 * all day", "Fri Nov 27 to Sun Nov 29, all day". An all-day one's start and end are UTC midnights, its end the day after.
 */
export function inviteWhen(f: Record<string, unknown>): string {
  const start = String(f.start ?? "");
  const end = String(f.end ?? start);
  if (f.all_day === true) {
    const first = parseLocalDate(start.slice(0, 10));
    const lastIso = new Date(Math.max(Date.parse(end) - DAY_MS, Date.parse(start))).toISOString().slice(0, 10);
    const last = parseLocalDate(lastIso);
    return lastIso === start.slice(0, 10) ? `${fmtDayLabel(first)}, all day` : `${fmtDayLabel(first)} to ${fmtDayLabel(last)}, all day`;
  }
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime())) return "";
  const sameDay = !Number.isNaN(e.getTime()) && s.toDateString() === e.toDateString();
  if (Number.isNaN(e.getTime()) || e.getTime() <= s.getTime()) return `${fmtDayLabel(s)}, ${fmtTime(start)}`;
  return sameDay ? `${fmtDayLabel(s)}, ${fmtTime(start)} to ${fmtTime(end)}` : `${fmtDayLabel(s)}, ${fmtTime(start)} to ${fmtDayLabel(e)}, ${fmtTime(end)}`;
}

/** What a row offers: the three answers (the current one chosen), or the calendar app, and a mail answer's state. */
export interface InviteFace {
  buttons: boolean;
  chosen: OwnerAnswer | null;
  /** The answer only the calendar app can give: a line, no button on these apps. */
  elsewhere: boolean;
  reply: { text: string; undo: boolean; retry: boolean } | null;
  /** While an answer is on its way, no new one. */
  locked: boolean;
}

export function inviteFace(e: Entity): InviteFace {
  const f = e.fields;
  const reply = replyLine(f);
  const chosen = f.answer === "accepted" || f.answer === "tentative" || f.answer === "declined" ? f.answer : null;
  const elsewhere = f.answer_by === "open_in_calendar";
  return { buttons: !elsewhere, chosen, elsewhere, reply, locked: !!reply && !reply.retry };
}

/** Today's Needs you line: "2 invitations", with the first one's title and day; null with none waiting. */
export function invitationsNeed(rows: Entity[], now: Date): { title: string; detail: string; count: number } | null {
  const { pending, count } = invitationList(rows, now);
  if (!count) return null;
  const first = pending.find((e) => e.fields.answer === "needs_action") ?? pending[0];
  const who = organizerName(first.fields);
  return { count, title: invitationCount(count), detail: [String(first.fields.title ?? ""), inviteWhen(first.fields).split(", ").slice(0, 1).join(""), who ? `from ${who}` : ""].filter(Boolean).join(", ") };
}
