/**
 * The Mail screen's types and the small rules it shows mail by (hub CONTRACT.md, Mail). Mail is hostile input:
 * everything here is shown as text, never as HTML, and only https links the screen checks itself are opened.
 */

export interface MailAddress { name: string; address: string }
/** `sent`: the owner's own reply, shown only inside its thread. */
export type MailState = "inbox" | "snoozed" | "done" | "sent" | "folder";
/** One message in the list (GET /mail): no text, `preview` is its first words. `bundle`: the bundle the hub sorted it into. */
export interface MailSummary {
  id: string; at: string; from: MailAddress; reply_to?: string; subject: string; preview: string;
  automated: boolean; bundle: string | null; state: MailState; pinned: boolean; snooze_until?: string;
  /** The sender's verified brand logo (the list's `logos` by this domain). */
  logo_domain?: string;
  /** When it came back from a snooze: the Inbox lists it by this, not by when it arrived. */
  back_at?: string;
  /** Read (opened here, or read in another mail app). An older hub leaves it out: then everything shows as read. */
  seen?: boolean;
  /** Its thread: messages with the same one show as one row. */
  thread?: string;
  /** The local model's triage (kept a week): how soon it matters, what it is in a line, whether it needs a reply. */
  triage?: { urgency: "today" | "soon" | "fyi" | "low"; summary?: string; needs_reply: boolean };
  /** How many attachments (the row's paperclip): absent when none, null when not known yet (ask once, on opening). */
  attachments?: number | null;
  /** The owner's own reply (from Sent). */
  mine?: boolean;
  /** Its key facts (a package, a flight, a bill), from the sender's own data or its text. */
  cards?: MailCard[];
  /** The mailbox it is in, by its address (one of the list's `mailboxes`). An older hub leaves it out. */
  mailbox?: string;
}

/**
 * A mail's key facts (the hub's mail-cards.ts). Written by the sender: plain text, shown as text; `at` and `until` are
 * an ISO time, or a day (`YYYY-MM-DD`) when the sender gave no time.
 */
export interface MailCard {
  kind: "package" | "flight" | "stay" | "table" | "event" | "bill" | "order" | "booking";
  title?: string; number?: string; from?: string; to?: string; at?: string; until?: string; amount?: string; status?: string; url?: string;
  source: "sender" | "text";
}
/** A card's icon: the bundle it belongs with. */
export const CARD_ICON: Record<MailCard["kind"], string> = { package: "purchases", order: "purchases", flight: "trips", stay: "trips", table: "trips", event: "trips", booking: "trips", bill: "bills" };

/** A card's time as words: a day ("Tue, Dec 15"), or a day and time ("Tue, Dec 3, 8:00 AM"). */
export function cardTime(at: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
  const d = day ? new Date(+day[1], +day[2] - 1, +day[3]) : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", ...(day ? {} : { hour: "numeric", minute: "2-digit" }) });
}

/** A card in one line, its facts in the order a person looks for them, joined by " · ". */
export function cardLine(c: MailCard): string {
  const t = (x?: string) => (x ? cardTime(x) : "");
  const parts: (string | undefined)[] =
    c.kind === "package" ? [c.title, c.number, c.at && `Arrives ${t(c.at)}`, c.status]
    : c.kind === "flight" ? [c.number ?? c.title, c.from && c.to ? `${c.from} → ${c.to}` : undefined, c.at && `Leaves ${t(c.at)}`, c.status]
    : c.kind === "stay" ? [c.title, c.at && (c.until ? `${t(c.at)} to ${t(c.until)}` : t(c.at)), c.number && `Confirmation ${c.number}`]
    : c.kind === "bill" ? [c.title, c.amount && `${c.amount} due`, c.at && `By ${t(c.at)}`]
    : c.kind === "order" ? [c.title, c.number && `Order ${c.number}`, c.amount, c.status]
    : c.kind === "booking" ? [c.title, c.number && `Confirmation ${c.number}`, c.at && t(c.at)]
    : [c.title, c.at && t(c.at), c.status, c.number && `Confirmation ${c.number}`];
  return parts.filter((x): x is string => !!x).join(" · ");
}

/** A card's time in milliseconds: a day (`YYYY-MM-DD`) at the device's own midnight, a time as written; NaN if neither. */
export function cardMs(at: string): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
  return day ? new Date(+day[1], +day[2] - 1, +day[3]).getTime() : Date.parse(at);
}

/** One piece of a trip: a card with a date, and the thread whose mail it came from. */
export interface TripPart<T> { card: MailCard; mail: T; start: number; end: number }
/** A trip: a flight's or a stay's mail and the bookings around it, as one. `name`: "Trip to JFK", "Stay at Harbor Inn". */
export interface Trip<T> { id: string; name: string; start: number; end: number; parts: TripPart<T>[] }

const TRIP_KINDS = new Set<MailCard["kind"]>(["flight", "stay", "booking", "table", "event"]);
const DAY_MS = 86_400_000;

/**
 * The trips in some mail, from its cards' dates (the sender's data; cards read from text have none):
 * - flights and stays make trips: each joins the one before while it starts within a day of where that one ends (the
 *   flight out, the hotel, the flight back);
 * - a booking, a table or an event only joins a trip it is within a day of, never makes one (a dinner at home is no
 *   trip); a day without a time counts at the usual hour (check-in 3 PM, check-out 11 AM, else noon);
 * - a trip is at least two mails (one flight alone stays a row of its own).
 * Trips not over yet come first, the soonest first; then past ones, the latest first.
 */
export function tripsOf<T extends MailSummary & { members?: MailSummary[] }>(mails: T[], now = Date.now()): Trip<T>[] {
  const parts: TripPart<T>[] = [];
  for (const m of mails) {
    for (const c of (m.members ?? [m]).flatMap((x) => x.cards ?? [])) {
      if (!TRIP_KINDS.has(c.kind) || !c.at) continue;
      // A day without a time is put at the usual hour, so a stay follows the flight that lands that day: check-in at
      // 3 PM, check-out at 11 AM, anything else at noon.
      const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const start = cardMs(c.at) + (isDay(c.at) ? (c.kind === "stay" ? 15 : 12) * 3_600_000 : 0);
      const end = c.until ? cardMs(c.until) + (isDay(c.until) ? 11 * 3_600_000 : 0) : start;
      if (Number.isNaN(start)) continue;
      parts.push({ card: c, mail: m, start, end: Number.isNaN(end) || end < start ? start : end });
    }
  }
  parts.sort((a, b) => a.start - b.start);
  // First the flights and stays, chained; then each other booking joins a trip it is within a day of.
  const seeds = (p: TripPart<T>) => p.card.kind === "flight" || p.card.kind === "stay";
  const trips: Trip<T>[] = [];
  let cur: Trip<T> | null = null;
  for (const p of parts.filter(seeds)) {
    if (cur && p.start <= cur.end + DAY_MS) { cur.parts.push(p); cur.end = Math.max(cur.end, p.end); continue; }
    cur = { id: p.mail.id, name: "", start: p.start, end: p.end, parts: [p] };
    trips.push(cur);
  }
  for (const p of parts.filter((x) => !seeds(x))) {
    const t = trips.find((x) => p.start >= x.start - DAY_MS && p.start <= x.end + DAY_MS);
    if (!t) continue;
    t.parts.push(p);
    t.start = Math.min(t.start, p.start);
    t.end = Math.max(t.end, p.end);
  }
  for (const t of trips) t.parts.sort((a, b) => a.start - b.start);
  const kept = trips.filter((t) => new Set(t.parts.map((p) => p.mail.id)).size >= 2);
  for (const t of kept) {
    const flight = t.parts.find((p) => p.card.kind === "flight" && p.card.to)?.card;
    const stay = t.parts.find((p) => p.card.kind === "stay" && p.card.title)?.card;
    t.name = flight ? `Trip to ${flight.to}` : stay ? `Stay at ${stay.title}` : "Trip";
  }
  const over = (t: Trip<T>) => t.end + DAY_MS < now;
  return [...kept.filter((t) => !over(t)).sort((a, b) => a.start - b.start), ...kept.filter(over).sort((a, b) => b.start - a.start)];
}

/** A trip's days: "Dec 3 to 6", "Dec 30 to Jan 2", or one day. */
export function tripDates(t: { start: number; end: number }): string {
  const a = new Date(t.start), b = new Date(t.end);
  const md = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (a.toDateString() === b.toDateString()) return md(a);
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${md(a)} to ${b.getDate()}` : `${md(a)} to ${md(b)}`;
}

/**
 * A touch on a row, once it has moved: sideways (`h`, a swipe) or up and down (`v`, the list scrolls), or null while it
 * has moved under 10px. Sideways only when clearly so (half again as much across as down), so scrolling never swipes.
 */
export function swipeLock(dx: number, dy: number): "h" | "v" | null {
  if (Math.hypot(dx, dy) < 10) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? "h" : "v";
}
/** What a swipe let go at `dx` does on a row `width` wide: right far enough is Done, left is Snooze, else nothing. */
export function swipeAction(dx: number, width: number): "done" | "snooze" | null {
  const far = Math.min(120, width * 0.35);
  return dx >= far ? "done" : dx <= -far ? "snooze" : null;
}

/** Where a card's Track or Open button goes: its https link, checked here again, or null. */
export const cardLink = (c: MailCard): string | null => (c.url ? httpsLink(c.url)?.href ?? null : null);

/**
 * A thread as one row: it reads like a mail (its newest received one in the thread's state: id, sender, bundle) so the
 * day groups, bundles and views work as for single mail, with its messages (`members`, oldest first, the owner's
 * replies among them) and the ids each action takes.
 */
export interface MailThread extends MailSummary {
  /**
   * What the screen knows the row by (open, highlighted, selected): its thread, else its one mail's id. It stays the
   * same while mail comes and goes in the thread; `id` is its newest received mail's, and changes when another arrives.
   */
  key: string;
  members: MailSummary[];
  /** "Alex, me (3)": who wrote, in order, the owner as "me". */
  people: string;
  /** Done and Snooze: the thread's mail in the Inbox or snoozed; Move to Inbox: its done mail; read on opening: its unread. */
  ids: { open: string[]; done: string[]; unread: string[] };
}

/**
 * Messages into threads. A thread's state is the Inbox while any of its received mail is there, else Snoozed, else Done;
 * it is unread while any received message is; pinned when any is; a person's mail in it keeps it out of the bundles.
 * The owner's own replies never make a thread on their own.
 */
export function threadRows(messages: MailSummary[]): MailThread[] {
  const groups = new Map<string, MailSummary[]>();
  for (const m of messages) { const k = m.thread ?? m.id; const g = groups.get(k); if (g) g.push(m); else groups.set(k, [m]); }
  const out: MailThread[] = [];
  for (const [key, group] of groups) {
    const members = [...group].sort((a, b) => a.at.localeCompare(b.at));
    const received = members.filter((m) => !m.mine && m.state !== "sent");
    if (!received.length) continue;
    const state: MailState = received.some((m) => m.state === "inbox") ? "inbox" : received.some((m) => m.state === "snoozed") ? "snoozed" : "done";
    const inState = received.filter((m) => m.state === state);
    const base = inState[inState.length - 1];
    const last = members[members.length - 1];
    const person = received.some((m) => !m.automated);
    const names: string[] = [];
    for (const m of members) {
      const n = m.mine ? "me" : members.length > 1 ? (personLabel(m.from).split(/\s+/)[0] || m.from.address) : personLabel(m.from);
      if (!names.includes(n)) names.push(n);
    }
    out.push({
      ...base,
      key,
      subject: members[0].subject,
      preview: last.mine ? `You: ${last.preview}` : last.preview,
      at: last.at > base.at ? last.at : base.at,
      pinned: received.some((m) => m.pinned),
      ...(members.some((m) => m.attachments === null) ? { attachments: null } : members.some((m) => m.attachments) ? { attachments: members.reduce((n, m) => n + (m.attachments ?? 0), 0) } : { attachments: undefined }),
      seen: received.every((m) => m.seen !== false),
      automated: !person,
      bundle: person ? null : base.bundle,
      members,
      people: members.length > 1 ? `${names.join(", ")} (${members.length})` : names[0],
      ids: {
        open: received.filter((m) => m.state === "inbox" || m.state === "snoozed").map((m) => m.id),
        done: received.filter((m) => m.state === "done").map((m) => m.id),
        unread: received.filter((m) => m.seen === false).map((m) => m.id),
      },
    });
  }
  return out;
}

/** Unread: the hub says it has not been read. */
export const isUnread = (m: Pick<MailSummary, "seen">) => m.seen === false;

/** The time a mail is listed by in the Inbox: when it came back from a snooze, else when it arrived. */
export const shownAt = (m: Pick<MailSummary, "at" | "back_at">) => (m.back_at && m.back_at > m.at ? m.back_at : m.at);

/** A snooze choice: "Tomorrow" at 8 AM and so on. */
export interface SnoozeChoice { id: "later" | "tomorrow" | "weekend" | "nextweek"; label: string; at: Date }

/** What the choices mean, as the owner set them on the hub (days 0 Sunday to 6 Saturday, times `HH:MM`). */
export interface SnoozeTimes { later_hours: number; tomorrow: string; weekend_day: number; weekend_time: string; week_day: number; week_time: string }
export const SNOOZE_DEFAULTS: SnoozeTimes = { later_hours: 3, tomorrow: "08:00", weekend_day: 6, weekend_time: "09:00", week_day: 1, week_time: "08:00" };

/**
 * The snooze choices from `now`: Later today (3 hours on, on the hour; only before 9 PM), Tomorrow 8 AM, This weekend
 * (Saturday 9 AM; next Saturday when it is the weekend), Next week (Monday 8 AM).
 */
export function snoozeChoices(now: Date = new Date(), times: SnoozeTimes = SNOOZE_DEFAULTS): SnoozeChoice[] {
  const at = (days: number, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h || 0, m || 0, 0, 0); return d;
  };
  const out: SnoozeChoice[] = [];
  const later = new Date(now);
  later.setHours(now.getHours() + times.later_hours, 0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() < 21) out.push({ id: "later", label: "Later today", at: later });
  out.push({ id: "tomorrow", label: "Tomorrow", at: at(1, times.tomorrow) });
  const day = now.getDay();
  const weekendNow = day === 6 || day === 0;
  out.push({ id: "weekend", label: weekendNow ? "Next weekend" : "This weekend", at: at((times.weekend_day - day + 7) % 7 || 7, times.weekend_time) });
  out.push({ id: "nextweek", label: "Next week", at: at((times.week_day - day + 7) % 7 || 7, times.week_time) });
  return out;
}
/** An automated message's button: the line `text` shows as a link to `url` (kept for highlights; the hub sends none yet). */
export interface MailButton { text: string; url: string }
/** One message with its whole text (GET /mail/messages/:id). */
/**
 * One message whole. `html`: the mail as sent, cleaned by the hub into a page that loads nothing (its pictures written
 * in), or null when it has none; `pictures_pending`: the hub is still fetching its web pictures (through Tor);
 * `pictures_ask`: the hub has no Tor, so it fetches them only when asked for this mail's (Show pictures).
 */
export interface MailMessage extends MailSummary {
  text: string; links?: MailButton[]; html?: string | null; pictures_pending?: boolean; pictures_ask?: boolean;
  /** The owner said not to fold this mail (a folding note): show it, its page too, unfolded. */
  no_fold?: boolean;
  /** Where the quoted history starts in `text`: folded behind a button. */
  quote_at?: number;
}

/**
 * The quoted history in a mail's page, as mail apps mark it: the hub's page folds it while its body has `aeneas-fold`
 * (hub/src/mail-html.ts, QUOTE_SELECTOR, kept the same).
 */
export const QUOTE_SELECTOR = '.gmail_quote, blockquote[type="cite"], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #divRplyFwdMsg ~ *';

/** The hub takes at most this many ids in one Done, Undo or read mark. */
export const BATCH_MAX = 500;
/** A list in pieces of at most BATCH_MAX, so a selection of any size goes through. */
export function batches<T>(items: T[], size = BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How many of a thread's unread messages open by themselves, the newest ones; the rest open with a click. */
export const OPEN_UNREAD_MAX = 3;

/** A link from inside a mail's page that the app opens: http, https or mailto, nothing else. */
export function frameLink(href: string | null): string | null {
  const h = (href ?? "").trim();
  if (/^mailto:[^\s<>"]{1,500}$/i.test(h)) return h;
  try {
    const u = new URL(h);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? u.toString() : null;
  } catch { return null; }
}
/**
 * A draft to write (POST /mail/drafts): a reply (`reply_to`, a mail's id: the hub sets its recipient, subject and
 * thread), a forward, or a new mail (`to`, `subject`; `from`: which mailbox, with several). `preview`: the hub says
 * what it would save, and saves nothing. A kept draft being changed names the draft it takes the place of (`replaces`)
 * and, always, which of that draft's attachments stay (`keep_parts`, each one's `part`; an empty list keeps none). The
 * hub carries the old draft's Cc and Bcc over by itself.
 */
export type MailDraftRequest = ({ reply_to: string; reply_all?: boolean } | { forward: string; to: string; forward_attachments?: boolean } | { to: string; cc?: string; subject: string; replaces?: string; keep_parts?: string[]; from?: string }) & { text: string; greeting?: string; signoff?: string; preview?: boolean; files?: DraftFileIn[] };
/** A file attached to a draft, as sent to the hub (base64). */
export interface DraftFileIn { name: string; type: string; data: string }
/** At most this many files, and this many bytes of them together (the hub's limits). */
export const DRAFT_FILES_MAX = 10;
export const DRAFT_FILES_BYTES = 15 * 1024 * 1024;
/** A reply's greeting and sign-off as suggested (POST /mail/messages/:id/greeting): by the local model, or the plain ones. */
/** `replies`: up to 3 short answers the local model suggests (none without it), each checked as plain words by the hub. */
export interface MailGreeting { greeting: string; signoff: string; by: "model" | "plain"; replies?: string[] }
/** What the hub saved to Drafts (or, for a preview, would save). `files`: every file on it, a changed draft's kept ones too. */
export interface MailDraft { saved: boolean; from: MailAddress; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; in_reply_to?: string; files?: { name: string; size: number }[] }

/** What a writing box is for: a reply (to the sender, or to all), a forward, a kept draft being changed, or a new mail. */
export type DraftFor = { reply: string; all: boolean } | { forward: string } | { draft: string; from: string } | { fresh: true };
/** What a writing box holds that goes into the draft. `kept`: a changed draft's old attachments that stay on it. */
export interface DraftFields { to: string; /** A new mail's Cc (since 2026-11-24; a mail the assistant wrote may carry one). */ cc?: string; subject: string; text: string; greeting: string | null; signoff: string | null; from?: string; withTheirs: boolean; kept: { part: string }[] }

/**
 * What the hub is asked for a writing box (POST /mail/drafts). A greeting or sign-off left empty or dropped is not
 * sent. A changed draft always says which old attachments it keeps, so none is dropped by being left unsaid.
 */
export function draftRequest(what: DraftFor, f: DraftFields, files: DraftFileIn[], preview: boolean): MailDraftRequest {
  const head = "reply" in what ? { reply_to: what.reply, ...(what.all ? { reply_all: true } : {}) }
    : "forward" in what ? { forward: what.forward, to: f.to, ...(f.withTheirs ? { forward_attachments: true } : {}) }
    : "draft" in what ? { to: f.to, subject: f.subject, replaces: what.draft, keep_parts: f.kept.map((a) => a.part), from: what.from }
    : { to: f.to, ...(f.cc?.trim() ? { cc: f.cc } : {}), subject: f.subject, ...(f.from ? { from: f.from } : {}) };
  return { ...head, text: f.text, ...(f.greeting?.trim() ? { greeting: f.greeting } : {}), ...(f.signoff?.trim() ? { signoff: f.signoff } : {}), ...(files.length ? { files } : {}), ...(preview ? { preview: true } : {}) };
}
/**
 * A mailbox's other folders (GET /mail `folders`), kept on the hub like the Inbox: `email` is the mailbox it belongs
 * to, `role` the part the mail server marks it for (`own`: one of the owner's), `name` its own name (shown for `own`).
 */
export type FolderRole = "drafts" | "sent" | "junk" | "trash" | "own";
export interface MailFolder { key: string; email: string; role: FolderRole; name: string; count: number; unread: number; more: boolean }
/** A folder's mail (GET /mail/folders/:key): `to` for what the owner wrote (Sent, Drafts). */
export type FolderMail = MailSummary & { to: MailAddress[]; folder_role: FolderRole };
const FOLDER_NAMES: Record<FolderRole, string> = { drafts: "Drafts", sent: "Sent", junk: "Spam", trash: "Trash", own: "" };
export const FOLDER_ICONS: Record<FolderRole, string> = { drafts: "pencil", sent: "send", junk: "spam", trash: "trash", own: "folder" };
/** A folder's name on the screen: Drafts, Sent, Spam (the server's Junk), Trash, or the owner's own; with its mailbox when several are linked. */
export const folderLabel = (f: MailFolder, many = false) => `${FOLDER_NAMES[f.role] || f.name}${many ? ` (${f.email})` : ""}`;
/** The number a folder shows in the list: its drafts, else its unread mail. */
export const folderCount = (f: MailFolder) => (f.role === "drafts" ? f.count : f.role === "trash" || f.role === "sent" ? 0 : f.unread);
/** Who a folder row names: those it went to for the owner's own (Sent, Drafts), else its sender. */
export const folderWho = (m: FolderMail) => (m.folder_role === "sent" || m.folder_role === "drafts" ? `To: ${m.to.map(personLabel).join(", ") || "(no one yet)"}` : personLabel(m.from));

/**
 * What a folder's mail can do, by its folder: go to the Inbox (`inbox`: Not spam in Spam, Move to Inbox in Trash and
 * the owner's own), Delete (`trash`: everywhere but Trash itself), with an Undo (`undo`: not from Sent or Drafts, where
 * nothing may be moved back in), and Move to another of the owner's folders (`move`: from one of the owner's own).
 */
export function folderActs(role: FolderRole): { inbox: boolean; trash: boolean; undo: boolean; move: boolean } {
  return { inbox: role === "junk" || role === "trash" || role === "own", trash: role !== "trash", undo: role !== "sent" && role !== "drafts", move: role === "own" };
}

/**
 * The owner's folders that mail can move to. A folder belongs to one mailbox and mail moves only inside its own, so
 * these are the folders of the mailbox all of the mail is in (`mailboxes`: each mail's mailbox, by address; `except`:
 * the folder it is in now). Mail from several mailboxes, or from one that is not known, has no folder to move to.
 */
export function moveFolders(folders: MailFolder[], mailboxes: (string | undefined)[], except?: string): MailFolder[] {
  const of = new Set(mailboxes.map((m) => m?.toLowerCase()));
  const [only] = of;
  if (of.size !== 1 || !only) return [];
  return folders.filter((f) => f.role === "own" && f.key !== except && f.email.toLowerCase() === only);
}

/** A link element in a mail's page, as checkFrameLinks reads and changes it. */
export interface FrameAnchor { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; removeAttribute(name: string): void }

/**
 * The links in a mail's page made fit for the browser to open by itself, done by the screen when the page has loaded:
 * WebKit (Safari) runs no listener the screen puts in a frame sandboxed without scripts, so there a click is never
 * the screen's to take, and the frame's `allow-popups` lets the browser open the link in a new tab instead (2026-11-22).
 * A link keeps its address only when frameLink accepts it (http, https, mailto), written as frameLink gives it, opens
 * in a new tab with no opener and no referrer, and shows that address when pointed at; any other link loses its
 * address and opens nothing. `ping`, `download` and `referrerpolicy` go from every link.
 */
export function checkFrameLinks(links: Iterable<FrameAnchor>): void {
  for (const a of links) {
    const href = frameLink(a.getAttribute("href"));
    for (const name of ["ping", "download", "referrerpolicy"]) a.removeAttribute(name);
    if (!href) {
      for (const name of ["href", "target", "rel", "title"]) a.removeAttribute(name);
      continue;
    }
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("title", href);
  }
}

/**
 * What a click inside a mail's page does: null when it is not the screen's to take (not on a link, or a button that
 * opens nothing), else `open`, the link to open (frameLink), or null for a link that opens nothing; either way the page
 * itself must not follow it. A middle click is taken too: it is an `auxclick`, not a `click`, and Firefox opened the
 * mail's link in a new tab by itself, past frameLink, when the screen did not take it (2026-11-22).
 */
export function frameClick(e: { type: string; button: number; target: unknown }): { open: string | null } | null {
  if (e.type === "auxclick" && e.button !== 1) return null;
  const a = (e.target as { closest?: (sel: string) => { getAttribute(name: string): string | null } | null } | null)?.closest?.("a");
  return a ? { open: frameLink(a.getAttribute("href")) } : null;
}
/**
 * A linked mailbox. `more`: the last refresh left new mail for the next one (a big Inbox comes in batches).
 * `provider`: who keeps it, as the screen says it ("iCloud", "Gmail", or the server's name); `kind`: how it is linked.
 * An older hub leaves both out.
 */
export interface MailMailbox { email: string; last_refresh: string | null; last_error: string | null; more: boolean; provider?: string; kind?: "icloud" | "gmail" | "imap"; read_only?: boolean; /** It has a sending server (since 2026-11-24): iCloud's, Gmail's, or one the owner gave. Absent on older hubs. */ can_send?: boolean }

/**
 * The browser's own "Leave this page?" question while something typed is not saved: a handler for `beforeunload`.
 * What is typed in a writing box is kept in memory only (never on the device), so a reload or a closed tab lost it
 * without a word. The browser writes the question itself; a page can only ask for it.
 */
export function askBeforeLeaving(unsaved: () => boolean): (e: { preventDefault(): void; returnValue?: unknown }) => void {
  return (e) => {
    if (!unsaved()) return;
    e.preventDefault();
    // What browsers from before `preventDefault` counted here need to ask.
    e.returnValue = "";
  };
}

/**
 * The other folders by mailbox, each mailbox once: with several mailboxes the side list heads each one's folders with
 * its address. In the order of `boxes` (the mailboxes as the hub lists them, the order every other place shows them
 * in); a mailbox not among them comes after, in the order its first folder comes. (Each row carried the address after
 * its name instead, "Sent (robin@icloud.example)": three lines in the narrow list, drawn over the rows around it.)
 */
export function folderGroups<F extends { email: string }>(folders: F[], boxes: { email: string }[] = []): { email: string; folders: F[] }[] {
  const out: { email: string; folders: F[] }[] = [];
  for (const f of folders) {
    const g = out.find((x) => x.email.toLowerCase() === f.email.toLowerCase());
    if (g) g.folders.push(f); else out.push({ email: f.email, folders: [f] });
  }
  const place = (email: string) => { const i = boxes.findIndex((b) => b.email.toLowerCase() === email.toLowerCase()); return i < 0 ? boxes.length : i; };
  // Array.sort keeps the order of what compares equal.
  return out.sort((a, b) => place(a.email) - place(b.email));
}

/** The mailbox a mail is in: the one it names, else the only one linked. With several linked and none named, not known. */
export function mailboxOf(boxes: MailMailbox[], email: string | undefined): MailMailbox | undefined {
  return email ? boxes.find((b) => b.email.toLowerCase() === email.toLowerCase()) : boxes.length === 1 ? boxes[0] : undefined;
}
/**
 * Whether the mailbox a mail is in is Read only (Settings, Accounts): the hub refuses every change to it, so the
 * screen offers none (Done, Delete, Spam, Move to, Pin, replies, drafts). An older hub never says so.
 */
export const readOnlyBox = (boxes: MailMailbox[], email: string | undefined) => !!mailboxOf(boxes, email)?.read_only;
/** The mailboxes a new mail can be written from: the ones that are not Read only. */
export const writableBoxes = <B extends Pick<MailMailbox, "read_only">>(boxes: B[]) => boxes.filter((b) => !b.read_only);
/** Where a mailbox's mail is kept, in words: "in iCloud", "in Gmail", or "in your mailbox" when its provider is not known. */
export const inProvider = (box: Pick<MailMailbox, "provider"> | undefined) => (box?.provider?.trim() ? `in ${box.provider.trim()}` : "in your mailbox");
/** The app a mailbox's drafts are sent from, in words: Apple Mail for an iCloud mailbox, else "your mail app". */
export const mailApp = (box: Pick<MailMailbox, "kind"> | undefined) => (box?.kind === "icloud" ? "Apple Mail" : "your mail app");
// ---------------------------------------------------------------------------------------------------------------------
// Sending (since 2026-11-24): Send, with 10 seconds of Undo, through the mailbox's own sending server

/** A mail in the hub's outbox (GET /mail `outbox`, GET /mail/outbox/:id): never its words or files. */
export interface OutboxItem { id: string; mailbox: string; to: string[]; subject: string; state: "waiting" | "sending" | "sent" | "failed"; send_at: string; sent_at?: string; error?: string; refused?: string[] }
/** What Send answers: the mail as it goes (as its preview showed it), and its place in the outbox. */
export type MailSent = Omit<MailDraft, "saved" | "bcc"> & { id: string; send_at: string; state: "waiting" };

/**
 * Whether the screen offers Send for a mail from this mailbox: it has a sending server and is not Read only. An older
 * hub says neither, and then the screen saves drafts only, as before.
 */
export const canSend = (box: Pick<MailMailbox, "can_send" | "read_only"> | undefined) => box?.can_send === true && !box.read_only;

/** The words the writing box and its preview say about where the mail goes, the same on every device (EACore `Mail.sendTexts`). */
export const SEND_TEXTS = {
  /** Under the writing box, for a mailbox that sends. */
  write: "Preview shows the whole mail, then you send it or save it as a draft.",
  /** Above the preview, for a mailbox that sends. */
  preview: "This is the whole mail. Send it, or save it as a draft.",
  /** For another mail account without a sending server. */
  noServer: "To send from here, add a sending server on this account's page in Settings, Accounts.",
  sending: "Sending",
  sent: "Sent.",
  failed: "Not sent",
  /** Discarding a mail that was not sent (its notice, or its box). */
  discard: "Discard this mail? It was not sent and is not in Drafts.",
} as const;
/** Under the writing box: what pressing on does with the mail. */
export const writeNote = (box: MailMailbox | undefined) => (canSend(box) ? SEND_TEXTS.write : `Saved to Drafts ${inProvider(box)}, to send from ${mailApp(box)}.${box?.kind === "imap" && !box.can_send ? ` ${SEND_TEXTS.noServer}` : ""}`);
/** Above the preview: what can be done with the whole mail. */
export const previewNote = (box: MailMailbox | undefined) => (canSend(box) ? SEND_TEXTS.preview : `This is the whole mail. Save it to Drafts, then send it from ${mailApp(box)}.${box?.kind === "imap" && !box.can_send ? ` ${SEND_TEXTS.noServer}` : ""}`);

/**
 * What a writing box shows for its mail in the outbox: `sending` while it waits (with Undo) or is on its way (without:
 * too late to take back), `sent`, or `failed` with the hub's words and Try again, Save draft and Edit. `gone`: not in
 * the outbox (taken back elsewhere, or sent a day ago): the box shows what was written again.
 */
export function outboxFace(item: OutboxItem | null): { face: "sending" | "sent" | "failed" | "gone"; undo: boolean; text: string } {
  if (!item) return { face: "gone", undo: false, text: "" };
  if (item.state === "waiting") return { face: "sending", undo: true, text: SEND_TEXTS.sending };
  if (item.state === "sending") return { face: "sending", undo: false, text: SEND_TEXTS.sending };
  if (item.state === "sent") return { face: "sent", undo: false, text: SEND_TEXTS.sent };
  return { face: "failed", undo: false, text: item.error ?? "The mail was not sent." };
}

/** A notice for a mail that was not sent, on the Mail screen: its subject and who it was for. */
export const outboxLine = (item: Pick<OutboxItem, "subject" | "to">) => `Not sent: ${item.subject.trim() || "(no subject)"}, to ${item.to.slice(0, 3).join(", ")}${item.to.length > 3 ? ` and ${item.to.length - 3} more` : ""}`;

/**
 * A hint for another mail account's sending server, from its IMAP server's name: `imap.` becomes `smtp.`, else the
 * same name. Only a placeholder in an empty field: the hub never connects to a server the owner did not type.
 */
export function smtpGuess(imapHost: string): string {
  const h = imapHost.trim().toLowerCase();
  if (!h) return "smtp.example.com";
  return /^imap\./.test(h) ? `smtp.${h.slice(5)}` : h;
}

/** The mailbox a new mail goes from: the one used last time while it is still linked, else the first. */
export function fromChoice(boxes: Pick<MailMailbox, "email">[], last: string | null | undefined): string {
  return boxes.find((b) => b.email === last)?.email ?? boxes[0]?.email ?? "";
}
/** What Done or Undo did: the mails moved, how many were not, and the hub's words when some were not. */
export interface MailMoved { moved: string[]; failed: number; error?: string }
/**
 * What blocking a sender did (POST /mail/settings/blocked): the blocked list now, how many of their mails moved to
 * Spam and how many did not (`failed`, with the hub's words in `error`), and where each moved mail is now (`to`: its
 * old id to its new one in Spam, as a move gives it). An older hub sends only the list and the count.
 */
export interface MailBlocked { blocked: string[]; moved: number; failed?: number; to?: Record<string, string>; error?: string }
/**
 * The Undo bar after a block: its words (how many moved, when any did), and the mail to move back out of Spam once
 * the sender is unblocked (`back`: the new id of each one the hub knows the new place of; it puts each back as it was).
 */
export function blockUndo(r: MailBlocked, who: string): { text: string; back: string[] } {
  return { text: r.moved > 0 ? `Blocked ${who}: ${r.moved} moved to Spam` : `Blocked ${who}`, back: Object.values(r.to ?? {}) };
}

/**
 * Where Delete, Spam, Not spam and Move to send mail (POST /mail/move): the Inbox, Trash, Junk, or one of the owner's
 * folders by its key. `to` in the answer: each moved mail's new id where the hub keeps it (for Undo).
 */
export type MoveTarget = "inbox" | "trash" | "junk" | string;
export interface MailMovedTo extends MailMoved { to: Record<string, string> }

/** `logos`: the verified brand logos the messages use, by domain (a message's `logo_domain`). */
/**
 * `triage`: whether the hub's model sorts new mail (the switch); `triage_state`: how that stands now. An older hub
 * sends neither.
 */
export interface MailList { messages: MailSummary[]; mailboxes: MailMailbox[]; logos?: Record<string, string>; snooze_times?: SnoozeTimes; bundle_delivery?: Record<string, BundleDelivery>; custom_bundles?: CustomBundle[]; mail_notify?: MailNotify; folders?: MailFolder[]; blocked?: string[]; triage?: boolean; triage_state?: TriageState; /** Mail waiting, being sent or not sent (since 2026-11-24). */ outbox?: OutboxItem[] }

/**
 * Sorting new mail with the hub's model (Needs you). `waiting`: Inbox mail not sorted yet; `running`: a run is going;
 * `auto`: this hub sorts by itself after each refresh (its owner set it up so), else only when the owner asks;
 * `stopped`: the hub's own sentence for why the last run that was asked for ended early.
 */
export interface TriageState { waiting: number; running: boolean; auto: boolean; stopped?: string }
/** What POST /mail/triage answers at once (it does not wait for the run): the switch, and how sorting stands. */
export type TriageAnswer = TriageState & { on: boolean };

/**
 * The quiet line above the Inbox about mail that is not sorted yet, or null for none: an older hub (no state), the
 * switch off, nothing waiting, or a hub that sorts by itself. While a run is going it says how much is left, with no
 * button; after a run that ended early, the hub's sentence for why; else how much waits. `button`: Sort new mail.
 */
export function triageRow(on: boolean | undefined, s: TriageState | undefined): { text: string; button: boolean } | null {
  if (!s || on === false) return null;
  if (s.running) return { text: `Sorting new mail: ${s.waiting} left.`, button: false };
  if (s.stopped?.trim()) return { text: s.stopped.trim(), button: s.waiting > 0 };
  if (s.auto || s.waiting <= 0) return null;
  return { text: s.waiting === 1 ? "1 new mail is not sorted yet." : `${s.waiting} new mails are not sorted yet.`, button: true };
}

/** Which new mail notifies (mail from people; bundles switched on, while they show as mail arrives) and what it says. */
export interface MailNotify { people: boolean; bundles: string[]; detail: "full" | "sender" | "count" }
export const NOTIFY_DEFAULTS: MailNotify = { people: true, bundles: [], detail: "full" };

/** When a bundle's mail shows in the Inbox: as it arrives, once a day at `time`, once a week on `day` at `time`, never. */
export interface BundleDelivery { mode: "now" | "daily" | "weekly" | "never"; time?: string; day?: number }

/** When mail that arrived at `at` shows under `d`: the next delivery time from then (null: never). */
export function deliveryAt(at: string, d: BundleDelivery | undefined): Date | null {
  const arrived = new Date(at);
  if (!d || d.mode === "now" || Number.isNaN(arrived.getTime())) return arrived;
  if (d.mode === "never") return null;
  const [h, m] = (d.time ?? "00:00").split(":").map(Number);
  const t = new Date(arrived);
  t.setHours(h || 0, m || 0, 0, 0);
  if (d.mode === "daily") { if (t < arrived) t.setDate(t.getDate() + 1); return t; }
  t.setDate(t.getDate() + (((d.day ?? 0) - t.getDay() + 7) % 7));
  if (t < arrived) t.setDate(t.getDate() + 7);
  return t;
}

/**
 * When a mail shows in the Inbox, or null while it is held (its bundle shows later) or never there (its bundle skips
 * the Inbox). Pinned mail always shows; a person's mail is in no bundle. Only a bundle the app shows (`shown`) can
 * hold mail back: mail whose bundle the app has no view for (a hub newer than the app, a module that is off) shows on
 * its own in the Inbox whatever is set for that bundle, since nowhere else would list it.
 */
export function inboxAt(m: Pick<MailSummary, "at" | "back_at" | "bundle" | "pinned">, shown: Bundle[], delivery: Record<string, BundleDelivery> = {}, now: Date = new Date()): string | null {
  const listed = shownAt(m);
  if (m.pinned || !m.bundle || !bundleOf(m, shown)) return listed;
  const at = deliveryAt(m.at, delivery[m.bundle]);
  if (!at || at > now) return null;
  const iso = at.toISOString();
  return iso > listed ? iso : listed;
}
export type MailRefresh = { mailboxes: ({ email: string; kept: number; gone: number; more: boolean } | { email: string; error: string })[] };

/** How a person is named in the list: their name, else their address. */
export const personLabel = (p: MailAddress) => p.name.trim() || p.address;

// ---------------------------------------------------------------------------------------------------------------------
// Bundles

/**
 * A bundle: a colored group of one kind of mail. The always-there ones, then the ones tied to a module, shown only while
 * that module is on (`module`), with a link to its screen. Updates takes automated mail nothing stronger claimed.
 * Built in, a module's, or the owner's own (`custom`: its color, 0 to 7, from the screen's own palette).
 */
export interface Bundle { id: string; name: string; module?: string; moduleName?: string; screen?: string; custom?: number }

/** A bundle of the owner's, as the hub keeps it: a name, a color, and its rules. */
export interface CustomBundle { id: string; name: string; color: number; addresses: string[]; domains: string[]; words: string[]; body_words?: string[]; to?: string[] }

/** The owner's own bundles' eight colors (styles.css `.b-custom.ccN`), by number. */
export const OWN_COLORS = ["#0f7c86", "#2f6fd0", "#a83e8e", "#b55d18", "#7048c0", "#c9413f", "#2f7d3a", "#8a7410"];

/** A bundle's color class: `b-<id>` for the built-in ones, `b-custom ccN` for the owner's. */
export const bundleClass = (b: Bundle) => (b.custom !== undefined ? `b-custom cc${b.custom}` : `b-${b.id}`);
/**
 * The built-in bundles, in the side list's order. Three ids differ from their names: Transactions is `purchases`,
 * Updates is `other` and Promotions is `promos`. The bundles were renamed on 2026-11-22, and the ids stayed as they
 * were, because apps already on people's devices know a bundle only by its id (its settings, its mail, its color).
 */
export const BUNDLES: Bundle[] = [
  { id: "purchases", name: "Transactions" },
  { id: "other", name: "Updates" },
  { id: "promos", name: "Promotions" },
  { id: "trips", name: "Trips" },
  { id: "bills", name: "Bills", module: "renewals", moduleName: "Renewals and bills", screen: "/renewals" },
  { id: "pet", name: "Pet", module: "pet", moduleName: "Pet", screen: "/pet" },
];

/** The bundles shown: the always-there ones, and a module's only while it is on. */
export const shownBundles = (on: (module: string) => boolean, custom: CustomBundle[] = []): Bundle[] => [
  ...BUNDLES.filter((b) => !b.module || on(b.module)),
  ...custom.map((c) => ({ id: c.id, name: c.name, custom: c.color })),
];

/**
 * The ids a build of the renaming used for a few days (2026-11-22), by the id every app knows the bundle by. A hub
 * running that build sends them, and an app that read them as bundles it has no view for listed all of their mail on
 * its own (gnomecannon/aeneas#7). The hub takes them the same way (SHORT_LIVED_BUNDLE_IDS in hub/src/mail-bundles.ts).
 */
export const SHORT_LIVED_BUNDLE_IDS: Record<string, string> = { transactions: "purchases", updates: "other", promotions: "promos" };
const bundleIdAsSent = (id: string) => (Object.hasOwn(SHORT_LIVED_BUNDLE_IDS, id) ? SHORT_LIVED_BUNDLE_IDS[id] : id);

/** The list with every bundle under its real id: its mail, when each bundle shows (the real id's setting wins) and its alerts. */
/**
 * `GET /mail?since=<cursor>` (since 2026-11-25): the whole list (`messages`), or only what changed since the cursor
 * (`changed`, `gone`), with the cursor to send next and the list's length (CONTRACT.md, Mail). A hub from before sends
 * the whole list and no cursor.
 */
export interface MailListAnswer extends Omit<MailList, "messages"> { messages?: MailSummary[]; changed?: MailSummary[]; gone?: string[]; cursor?: string; max?: number }

/**
 * A copy of the list with an answer put in, the hub's own rule: what left goes, what changed or came in replaces its
 * id, then the list's order (when it shows, `back_at` or else `at`, newest first, then the id, as plain text) and its
 * length. Null when the answer is only changes and there is no copy to put them in. Logos and the settings are the
 * answer's, logos the copy's when the answer has none (they did not change).
 */
export function applyListChanges(copy: MailList | null, a: MailListAnswer): MailList | null {
  const { changed, gone, cursor: _cursor, max, messages, ...rest } = a;
  if (messages) return { ...rest, messages };
  if (!copy) return null;
  const left = new Set(gone ?? []);
  const when = (m: MailSummary) => m.back_at ?? m.at;
  // The copy is in the list's order: a changed mail whose time stays where it was takes its old place, and the list is
  // sorted again only when a mail came in or moved.
  const waiting = new Map((changed ?? []).map((m) => [m.id, m]));
  const list: MailSummary[] = [];
  const placed: MailSummary[] = [];
  for (const m of copy.messages) {
    if (left.has(m.id)) continue;
    const c = waiting.get(m.id);
    if (!c) { list.push(m); continue; }
    waiting.delete(m.id);
    if (when(c) === when(m)) list.push(c); else placed.push(c);
  }
  placed.push(...waiting.values());
  if (placed.length) {
    list.push(...placed);
    list.sort((x, y) => (when(x) < when(y) ? 1 : when(x) > when(y) ? -1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }
  return { ...rest, logos: rest.logos ?? copy.logos, messages: max ? list.slice(0, max) : list };
}

export function listAsSent(l: MailList): MailList {
  const delivery = l.bundle_delivery && Object.fromEntries([
    ...Object.entries(l.bundle_delivery).filter(([k]) => Object.hasOwn(SHORT_LIVED_BUNDLE_IDS, k) && !l.bundle_delivery![bundleIdAsSent(k)]).map(([k, v]) => [bundleIdAsSent(k), v] as const),
    ...Object.entries(l.bundle_delivery).filter(([k]) => !Object.hasOwn(SHORT_LIVED_BUNDLE_IDS, k)),
  ]);
  return {
    ...l,
    messages: l.messages.map((m) => (m.bundle && Object.hasOwn(SHORT_LIVED_BUNDLE_IDS, m.bundle) ? { ...m, bundle: bundleIdAsSent(m.bundle) } : m)),
    ...(delivery ? { bundle_delivery: delivery } : {}),
    ...(l.mail_notify ? { mail_notify: { ...l.mail_notify, bundles: [...new Set(l.mail_notify.bundles.map(bundleIdAsSent))] } } : {}),
  };
}

/** The bundle a message shows in, or null: an unknown bundle, or one whose module is off, shows the mail on its own. */
export function bundleOf(m: Pick<MailSummary, "bundle">, shown: Bundle[]): Bundle | null {
  return (m.bundle && shown.find((b) => b.id === m.bundle)) || null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The list

/** What the screen shows: the Inbox, Snoozed, Done, one bundle (`b:<id>`), or one of the mailbox's other folders (`f:<key>`). */
export type MailView = "inbox" | "snoozed" | "done" | `b:${string}` | `f:${string}`;

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBefore = (iso: string, now: Date) => Math.round((startOfDay(now).getTime() - startOfDay(new Date(iso)).getTime()) / 86_400_000);

/** The heading a message is under: Today, Yesterday, This week, This month, then the month ("October 2026"). */
export function dayGroup(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Earlier";
  const n = daysBefore(iso, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return "This week";
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return "This month";
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
}

/**
 * dayGroup for many times at once: a heading depends only on the day, so each day is worked out once. The Inbox asked
 * for each of thousands of mails each time the screen drew, and naming a month (toLocaleDateString) is slow.
 */
export function dayGrouper(now: Date = new Date()): (iso: string) => string {
  const byDay = new Map<number, string>();
  return (iso) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Earlier";
    const day = startOfDay(d).getTime();
    let title = byDay.get(day);
    if (title === undefined) { title = dayGroup(iso, now); byDay.set(day, title); }
    return title;
  };
}

/** The time beside a message: the hour today, the weekday this week, else the date. */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const n = daysBefore(iso, now);
  if (n <= 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (n < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The letter in a sender's circle: the first letter or digit of their name or address. */
export const initial = (from: MailAddress) => (/[\p{L}\p{N}]/u.exec(personLabel(from))?.[0] ?? "?").toUpperCase();
/**
 * The letters in a sender's circle, as Apple Mail draws them: the first letters of the first and last words of their
 * name ("Alumni Relations Team" gives AT), or one letter when the name is one word or only an address.
 */
export function initials(from: MailAddress): string {
  const first = (w: string) => /[\p{L}\p{N}]/u.exec(w)?.[0] ?? "";
  const words = from.name.trim().split(/\s+/).map(first).filter(Boolean);
  return words.length >= 2 ? `${words[0]}${words[words.length - 1]}`.toUpperCase() : initial(from);
}

/** A verified brand logo as the hub sends it (a data: SVG, shown only as a picture), or null for anything else. */
/** One attachment of an open mail (GET /mail/messages/:id/attachments): `preview` for a picture, from the hub. */
export interface MailAttachment { part: string; name: string; type: string; size: number; preview?: string }

/** A picture preview as the hub sends it (a data: JPEG, PNG, GIF or WebP, shown only as a picture), or null. */
export function previewSrc(v: string | undefined): string | null {
  return v && v.length < 7_000_000 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

/**
 * Kinds of file that can run a program when opened, or hide one, by the end of their name. The screen says so beside
 * such a file and asks before downloading it.
 */
const RISKY_KINDS = [
  // Programs, installers and what they load.
  "exe com scr pif cpl msi msix msixbundle appx appxbundle msp mst gadget application appref-ms jar jnlp app command action workflow pkg mpkg deb rpm apk xapk ipa appimage run bin elf out dll sys drv ocx",
  // Scripts, and files a script host runs.
  "bat cmd ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 psm1 vbs vbe vb js jse mjs cjs ws wsf wsc wsh hta sct sh bash zsh csh ksh fish py pyc pyo pyw pyz rb pl pm php lua tcl applescript scpt scptd ahk au3 reg inf ins isp msc",
  // Shortcuts: they open or run something else.
  "lnk url webloc inetloc desktop website scf library-ms search-ms searchconnector-ms settingcontent-ms theme themepack diagcab",
  // Old Office files and the newer ones made for macros: both can hold macros.
  "doc dot wbk xls xlt xla xll xlm xlw slk iqy ppt pot pps ppa mdb mde accdb accde adp pub one onepkg docm dotm xlsm xlsb xltm xlam pptm potm ppsm ppam sldm",
  // Pages: a browser runs their scripts when they are opened.
  "html htm xhtml xht shtml mht mhtml svg svgz chm hlp",
  // Disk images and archives: what is inside is not seen until they are opened.
  "iso img vhd vhdx vmdk dmg toast cab zip zipx rar 7z tar gz tgz bz2 tbz tbz2 xz txz zst lz lzh arj ace z cpio wim",
].join(" ").split(" ");
const RISKY = new RegExp(`\\.(${RISKY_KINDS.join("|")})$`, "i");
/** Characters that change the direction text is drawn in: a name with one can show another ending than it has. */
const TURNS_TEXT = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/**
 * Whether a file can run a program when opened, or hide one: by its name's real ending (dots and spaces after it are
 * not part of it: "setup.exe." opens as a program), and any name written with direction-changing characters.
 */
export const riskyFile = (name: string) => TURNS_TEXT.test(name) || RISKY.test(name.replace(/[.\s]+$/, ""));

/** A search hit (GET /mail/search): a list entry, where it is, and a snippet around the first match. */
export type SearchHit = MailSummary & { where: MailState | FolderRole; folder_name?: string; snippet: string; to?: MailAddress[] };
const WHERE: Record<string, string> = { inbox: "Inbox", snoozed: "Snoozed", done: "Done", sent: "Sent", drafts: "Drafts", junk: "Spam", trash: "Trash", folder: "Folder" };
/** Where a hit is, as the screen names it ("Inbox", "Spam", the owner's folder's name); the owner's reply in a thread is "Your reply". */
export const whereLabel = (h: Pick<SearchHit, "where" | "folder_name" | "state">) => (h.where === "own" ? h.folder_name || "Folder" : h.where === "sent" && h.state === "sent" ? "Your reply" : WHERE[h.where] ?? "Mail");

/** How a mail can be unsubscribed from (GET /mail/messages/:id/unsubscribe), and whether this hub goes through Tor. */
export interface UnsubscribeOptions { one_click?: { host: string }; link?: string; mailto?: { to: string; subject: string }; tor: boolean }

/**
 * Unsubscribe by mail (since 2026-11-24): from a mailbox that sends, the mail to the sender's unsubscribe address is
 * shown whole, then sent through the outbox with the same 10 seconds of Undo as Send; from one without a sending server
 * it is saved to Drafts, as before. The same words on every device (EACore `Mail.UnsubscribeTexts`).
 */
export const UNSUBSCRIBE_TEXTS = {
  /** The button, for a mailbox that sends: it shows the whole mail first. */
  send: "Send the unsubscribe mail…",
  /** The button, for a mailbox that does not send. */
  write: "Write the unsubscribe mail",
  /** Above the whole mail, before it goes. */
  confirm: "This is the whole mail. Send it?",
  /** What the mail says. */
  text: "unsubscribe",
} as const;
/** Under the button: where the mail goes, and whether it is sent or saved to Drafts. */
export const unsubscribeNote = (to: string, sends: boolean) => (sends ? `To ${to}. You see the whole mail before it goes.` : `To ${to}, saved in Drafts for you to send.`);
/** Once the unsubscribe mail went. */
export const unsubscribeSent = (to: string) => `Sent. The unsubscribe mail went to ${to}.`;

/** Snoozed threads coming back later today (after `now`, before midnight), soonest first: the Inbox's "Back later today". */
export function backLaterToday<T extends MailSummary>(threads: T[], now: Date = new Date()): T[] {
  const end = new Date(now); end.setHours(24, 0, 0, 0);
  return threads
    .filter((m) => m.state === "snoozed" && m.snooze_until && Date.parse(m.snooze_until) > now.getTime() && Date.parse(m.snooze_until) < end.getTime())
    .sort((a, b) => a.snooze_until!.localeCompare(b.snooze_until!));
}

/**
 * The Inbox's "Needs you" digest: threads the Inbox shows now that the model marked for today or as needing a reply,
 * today's first, then those needing a reply, newest first in each; at most `max`. Mail a bundle holds back (it shows
 * later, or never in the Inbox) is left out: the digest only names mail the Inbox lists.
 */
export function needsYou<T extends MailSummary>(threads: T[], shown: Bundle[], opts: { max?: number; delivery?: Record<string, BundleDelivery>; now?: Date } = {}): T[] {
  const rank = (m: T) => (m.triage?.urgency === "today" ? 0 : 1);
  return threads
    .filter((m) => m.state === "inbox" && !m.mine && (m.triage?.urgency === "today" || m.triage?.needs_reply) && inboxAt(m, shown, opts.delivery, opts.now) !== null)
    .sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at))
    .slice(0, opts.max ?? 5);
}

/** A folding note (the owner said the fold hid something): the fold's first line, the lines they marked, Don't fold. */
export interface FoldNote { cut: string; lines: string[]; no_fold: boolean; at: string }

/** The first lines (at most 8, non-empty, trimmed) of what a mail's fold hides, for the owner to mark. */
export const foldedLines = (text: string, quoteAt: number | undefined, max = 8) =>
  quoteAt === undefined ? [] : text.slice(quoteAt).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, max);

/**
 * Select all: what the selection becomes when the select-all box is pressed. When every shown mail is selected,
 * nothing; else every shown mail (only those: a mail out of sight, as in a closed bundle, is never swept along).
 * `state`: how the box shows, all, some or none of the shown mail selected.
 */
export function selectAll(shown: string[], selected: Set<string>): { next: Set<string>; state: "all" | "some" | "none" } {
  const n = shown.filter((id) => selected.has(id)).length;
  const state = shown.length && n === shown.length ? "all" : n || selected.size ? "some" : "none";
  return { next: state === "all" ? new Set() : new Set(shown), state };
}

/** A size as people read it: 820 KB, 2.4 MB. */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function logoSrc(v: string | undefined): string | null {
  return v && v.length < 200_000 && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

/** Whether a message has every word of a search, in its sender, subject or first words (case aside). */
export function matches(m: MailSummary, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${m.from.name} ${m.from.address} ${m.subject} ${m.preview}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A row of the Inbox: one message, or a bundle with its messages (newest first). */
export type InboxRow<T extends MailSummary = MailSummary> = { kind: "mail"; mail: T } | { kind: "bundle"; bundle: Bundle; mails: T[] };
export interface InboxSection<T extends MailSummary = MailSummary> { title: string; rows: InboxRow<T>[] }

/**
 * The Inbox as the screen lists it: newest first, under day headings. A bundle is one row, where its newest message is
 * in each day; pinned mail always stands on its own. With `pinnedOnly`, only pinned mail, none bundled.
 */
export function inboxSections<T extends MailSummary>(messages: T[], shown: Bundle[], opts: { pinnedOnly?: boolean; now?: Date; delivery?: Record<string, BundleDelivery> } = {}): InboxSection<T>[] {
  const now = opts.now ?? new Date();
  // Each mail at the time it shows: held mail (its bundle shows later) and bundles that skip the Inbox are left out.
  const when = new Map(messages.map((m) => [m, inboxAt(m, shown, opts.delivery, now)]));
  const ms = messages.filter((m) => m.state === "inbox" && when.get(m) && (!opts.pinnedOnly || m.pinned)).sort((a, b) => when.get(b)!.localeCompare(when.get(a)!));
  const sections: InboxSection<T>[] = [];
  const group = dayGrouper(now);
  for (const m of ms) {
    const title = group(when.get(m)!);
    let s = sections[sections.length - 1];
    if (!s || s.title !== title) { s = { title, rows: [] }; sections.push(s); }
    const b = !m.pinned && !opts.pinnedOnly ? bundleOf(m, shown) : null;
    if (!b) { s.rows.push({ kind: "mail", mail: m }); continue; }
    const row = s.rows.find((r) => r.kind === "bundle" && r.bundle.id === b.id);
    if (row && row.kind === "bundle") row.mails.push(m);
    else s.rows.push({ kind: "bundle", bundle: b, mails: [m] });
  }
  return sections;
}

/**
 * The messages a view lists flat (Snoozed soonest first; Done, a bundle and the Inbox newest first). A folder's view
 * (`f:`) lists none of these: its mail is the folder's own, kept apart (GET /mail/folders/:key).
 */
export function viewMessages<T extends MailSummary>(messages: T[], view: MailView, shown: Bundle[]): T[] {
  if (view === "snoozed") return messages.filter((m) => m.state === "snoozed").sort((a, b) => (a.snooze_until ?? "").localeCompare(b.snooze_until ?? ""));
  if (view === "done") return messages.filter((m) => m.state === "done").sort((a, b) => b.at.localeCompare(a.at));
  if (view.startsWith("b:")) return messages.filter((m) => m.state === "inbox" && bundleOf(m, shown)?.id === view.slice(2)).sort((a, b) => shownAt(b).localeCompare(shownAt(a)));
  if (view === "inbox") return messages.filter((m) => m.state === "inbox").sort((a, b) => shownAt(b).localeCompare(shownAt(a)));
  return [];
}

/**
 * The Inbox as the screen lists it, top to bottom: snoozed mail coming back later today (`back`), then the day groups
 * (inboxSections), the due reminders leading the first one (a "Today" of their own when no mail came today). `needs`
 * is the Needs you digest above them. While searching or showing pinned mail only, there is only the mail itself.
 */
export interface InboxScreen<T extends MailSummary = MailSummary> { needs: T[]; back: T[]; reminders: DueReminder[]; sections: InboxSection<T>[] }
export function inboxScreen<T extends MailSummary>(messages: T[], shown: Bundle[], opts: { pinnedOnly?: boolean; searching?: boolean; reminders?: DueReminder[]; now?: Date; delivery?: Record<string, BundleDelivery> } = {}): InboxScreen<T> {
  const now = opts.now ?? new Date();
  const only = !!opts.pinnedOnly || !!opts.searching;
  const reminders = only ? [] : opts.reminders ?? [];
  const sections = inboxSections(messages, shown, { pinnedOnly: opts.pinnedOnly, now, delivery: opts.delivery });
  if (reminders.length && sections[0]?.title !== "Today") sections.unshift({ title: "Today", rows: [] });
  return { needs: only ? [] : needsYou(messages, shown, { delivery: opts.delivery, now }), back: only ? [] : backLaterToday(messages, now), reminders, sections };
}

/**
 * Where a thread is in the Inbox as listed: on its own (`row` null), or inside a bundle's row (`row`: that row's key,
 * `<day>:<bundle>`, to open before the mail can show). Null when the Inbox does not list it: its bundle holds it back.
 */
export function inboxPlace<T extends MailThread>(sections: InboxSection<T>[], key: string): { row: string | null } | null {
  for (const s of sections) {
    for (const r of s.rows) {
      if (r.kind === "mail" ? r.mail.key === key : r.mails.some((m) => m.key === key)) return { row: r.kind === "bundle" ? `${s.title}:${r.bundle.id}` : null };
    }
  }
  return null;
}

/** A flat view as listed: in the Trips bundle each trip's mail as one box first (`trips`), then the mail in no trip. */
export interface FlatScreen<T extends MailSummary = MailSummary> { trips: Trip<T>[]; rest: T[] }
export function flatScreen<T extends MailSummary & { members?: MailSummary[] }>(messages: T[], bundle: string | null, now = Date.now()): FlatScreen<T> {
  const trips = bundle === "trips" ? tripsOf(messages, now) : [];
  const inTrips = new Set(trips.flatMap((t) => t.parts.map((p) => p.mail.id)));
  return { trips, rest: messages.filter((m) => !inTrips.has(m.id)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The rows on the screen: what the arrow keys walk, and what a key may act on

/**
 * A row's kind, read from the id the screen knows it by: a thread (its `key`), a bundle's row (`bundle:<day>:<id>`), a
 * due reminder (`rem:<task>`), a folder's mail (`folder:<id>`) or a search hit (`hit:<id>`). A mail's id and a
 * thread's are hex, so none of them starts like another kind.
 */
export type RowKind = "thread" | "bundle" | "reminder" | "folder" | "hit";
export const rowKind = (id: string): RowKind => (id.startsWith("bundle:") ? "bundle" : id.startsWith("rem:") ? "reminder" : id.startsWith("folder:") ? "folder" : id.startsWith("hit:") ? "hit" : "thread");
export const bundleRow = (day: string, bundle: string) => `bundle:${day}:${bundle}`;
export const reminderRow = (task: string) => `rem:${task}`;
export const folderRow = (id: string) => `folder:${id}`;
export const hitRow = (id: string) => `hit:${id}`;

/**
 * What the list part of the screen shows: nothing of its own (`none`: not loaded yet, no mailbox, a bundle's form, or
 * all mail with one person, which is only search hits), a folder's mail, the Inbox, or a flat view (Snoozed, Done, a
 * bundle). The screen draws its rows from this, and the keys walk the same.
 */
export type ShownList<T extends MailThread = MailThread> =
  | { kind: "none" }
  | { kind: "folder"; mails: Pick<FolderMail, "id">[] }
  | { kind: "inbox"; inbox: InboxScreen<T>; openBundles: ReadonlySet<string> }
  | { kind: "flat"; flat: FlatScreen<T> };

/**
 * Every row on the screen, top to bottom, by the id the screen knows it by: the list's own rows, then the search hits
 * listed under it (`hits`). A bundle's mail is on the screen only while the bundle is open; a mail in a trip's box is
 * there once, where its first piece is.
 */
export function screenRows<T extends MailThread>(list: ShownList<T>, hits: Pick<SearchHit, "id">[] = []): string[] {
  const out: string[] = [];
  if (list.kind === "folder") out.push(...list.mails.map((m) => folderRow(m.id)));
  else if (list.kind === "flat") {
    for (const t of list.flat.trips) for (const p of t.parts) if (!out.includes(p.mail.key)) out.push(p.mail.key);
    out.push(...list.flat.rest.map((m) => m.key));
  } else if (list.kind === "inbox") {
    out.push(...list.inbox.back.map((m) => m.key));
    list.inbox.sections.forEach((s, i) => {
      if (i === 0) out.push(...list.inbox.reminders.map((r) => reminderRow(r.id)));
      for (const r of s.rows) {
        if (r.kind === "mail") { out.push(r.mail.key); continue; }
        out.push(bundleRow(s.title, r.bundle.id));
        if (list.openBundles.has(`${s.title}:${r.bundle.id}`)) out.push(...r.mails.map((m) => m.key));
      }
    });
  }
  out.push(...hits.map((h) => hitRow(h.id)));
  return out;
}

/**
 * The rows a key acts on (D, S, P, U, R, Delete, !): the selected threads; else the open mail; else the highlighted
 * row. Only rows that are on the screen now (`rows`) count: a selection, an open mail or a highlight left over from
 * another view, a closed bundle or a search is never acted on.
 */
export function keyTarget(rows: readonly string[], at: { selected: ReadonlySet<string>; open: string | null; cursor: string | null }): string[] {
  const picked = rows.filter((id) => at.selected.has(id) && rowKind(id) === "thread");
  if (picked.length) return picked;
  if (at.open && rows.includes(at.open)) return [at.open];
  if (at.cursor && rows.includes(at.cursor)) return [at.cursor];
  return [];
}

/**
 * The thread to show again where it is now, or null: the open thread, when it is no longer among the rows on the
 * screen and a writing box under one of its mails went away within the last second with the focus in it (`lost`: that
 * mail's id, and when). The owner was typing there, and the list changed under the box (new mail brought the thread
 * back from Snoozed or Done, or put it under another day's bundle): the typing must not go on as the list's keys.
 */
export function threadToFollow<T extends MailThread>(open: string | null, rows: readonly string[], lost: { id: string; at: number } | null, threads: ReadonlyMap<string, T>, now = Date.now()): T | null {
  if (!open || !lost || rows.includes(open) || now - lost.at >= 1000) return null;
  const t = threads.get(open);
  return t && t.members.some((m) => m.id === lost.id) ? t : null;
}

const ROW_TAKES: Record<RowKind, readonly MailKey[]> = {
  thread: ["done", "snooze", "pin", "unread", "read", "delete", "spam"],
  bundle: [],
  reminder: ["done", "snooze"],
  folder: ["delete"],
  hit: [],
};
/**
 * Whether a key's action applies to a row of this kind: all of them to a thread; Done and Snooze to a reminder; Delete
 * to a folder's mail, and only where it can be undone (`folder`: its folder's part; so not in Trash, Sent or Drafts);
 * none to a bundle's row or a search hit, which only open.
 */
export function rowTakes(kind: RowKind, a: MailKey, folder?: FolderRole): boolean {
  if (!ROW_TAKES[kind].includes(a)) return false;
  if (kind !== "folder") return true;
  const can = folder ? folderActs(folder) : null;
  return !!can && can.trash && can.undo;
}

/** "Transactions: Northwind, Larkspur Books": who a bundle's mail is from, each name once. */
export const sendersLine = (mails: MailSummary[]) => [...new Set(mails.map((m) => personLabel(m.from)))].join(", ");

// ---------------------------------------------------------------------------------------------------------------------
// Showing a message safely

/**
 * Where a reply would go, when that is not the sender: for the reply view (not shown in the list, since
 * Reply-To only matters when replying). Phishing mail often uses it to collect answers at another address.
 */
export function replyToWarning(m: Pick<MailMessage, "reply_to" | "from">): string | null {
  if (!m.reply_to || m.reply_to.toLowerCase() === m.from.address.toLowerCase()) return null;
  return `Replies go to ${m.reply_to}, not to ${m.from.address}.`;
}

/** Whether the sender's shown name looks like an address other than the real one ("support@bank.example" <x@evil>). */
export function nameHidesAddress(from: MailAddress): boolean {
  // Letters, digits and the usual address marks only, so brackets around it ("Alex (alex@example.com)") are not part of it.
  const inName = /[\w.+'-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.exec(from.name)?.[0];
  return !!inName && inName.toLowerCase() !== from.address.toLowerCase();
}

/** A button's link as the screen may open it: https only, a host, no user name; with the host to show beside it. */
export function httpsLink(url: string): { href: string; host: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return { href: u.toString(), host: u.hostname };
  } catch { return null; }
}

/**
 * A message's lines: a line that is one of the message's buttons with its `link`; any other line in `parts`, where a
 * link's label inside it ("take the quiz HERE and…", its first time in the line) is a link with its host beside it,
 * and web addresses written in the rest are links too (textParts). A label that names a site ("Track at fedex.com")
 * gets no link unless the link goes to that site: the label must not say one place and go another.
 */
export function messageLines(m: Pick<MailMessage, "text" | "links">): { text: string; link?: { href: string; host: string }; parts?: TextPart[] }[] {
  const byText = new Map<string, { href: string; host: string }>();
  for (const b of m.links ?? []) {
    const link = httpsLink(b.url);
    const named = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.exec(b.text)?.[0].toLowerCase();
    if (!link || b.text.trim().length < 2 || byText.has(b.text) || (named && link.host !== named && !link.host.endsWith(`.${named}`))) continue;
    byText.set(b.text, link);
  }
  return m.text.split("\n").map((text) => {
    const link = byText.get(text.trim());
    return link ? { text, link } : { text, parts: labelParts(text, byText) };
  });
}

/** A line with the links' labels in it as links (each label's first time, longest labels first), the rest by textParts. */
function labelParts(line: string, links: Map<string, { href: string; host: string }>): TextPart[] {
  let parts: TextPart[] = [{ text: line }];
  for (const [label, link] of [...links].sort((a, b) => b[0].length - a[0].length)) {
    const i = parts.findIndex((p) => !p.href && p.text.includes(label));
    if (i < 0) continue;
    const t = parts[i].text;
    const at = t.indexOf(label);
    const split: TextPart[] = [{ text: t.slice(0, at) }, { text: label, href: link.href, host: link.host }, { text: t.slice(at + label.length) }];
    parts = [...parts.slice(0, i), ...split.filter((p) => p.text), ...parts.slice(i + 1)];
  }
  return parts.flatMap((p) => (p.href ? [p] : textParts(p.text)));
}

/**
 * A piece of a line of mail text: plain text, or a link. `host` is shown beside a link whose text is a label (not the
 * address itself); `warnHost` beside an address whose host is written in another alphabet's letters.
 */
export interface TextPart { text: string; href?: string; host?: string; warnHost?: string }

/**
 * A line of mail text in pieces, its web addresses as links: `https://…`, and `www.…` (opened as https). The link's
 * text is the address itself, so a mail cannot show one place and go to another. Anything else (`http:`, `javascript:`,
 * `mailto:`, a user name in the address) stays plain text. A trailing period, comma or bracket ends the address. When
 * the host is written in another alphabet (`xn--…` once read), `warnHost` is that real host, to show beside it.
 */
export function textParts(line: string): TextPart[] {
  const out: TextPart[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !last.href) last.text += t;
    else out.push({ text: t });
  };
  let at = 0;
  for (const m of line.matchAll(/(https:\/\/|www\.)[^\s<>"]+/gi)) {
    const start = m.index ?? 0;
    // Not the middle of another word or address: "http://www.…", "me@www.…", "awww.…".
    if (start > 0 && /[\w.@/:-]/.test(line[start - 1])) continue;
    let url = m[0];
    // Punctuation after an address is the sentence's; a closing bracket only when the address has no opening one.
    for (;;) {
      const c = url[url.length - 1];
      if (/[.,;:!?'"’”]/.test(c) || (/[)\]}]/.test(c) && (url.match(/[(\[{]/g)?.length ?? 0) < (url.match(/[)\]}]/g)?.length ?? 0))) url = url.slice(0, -1);
      else break;
    }
    const link = httpsLink(/^www\./i.test(url) ? `https://${url}` : url);
    if (!link || !link.host.includes(".")) continue;
    plain(line.slice(at, start));
    out.push({ text: url, href: link.href, ...(link.host.split(".").some((p) => p.startsWith("xn--")) ? { warnHost: link.host } : {}) });
    at = start + url.length;
  }
  plain(line.slice(at));
  return out.length ? out : [{ text: line }];
}


// ---------------------------------------------------------------------------------------------------------------------
// Keyboard (desktop): arrow keys to move, letters for actions

export type MailKey = "down" | "up" | "extend-down" | "extend-up" | "open" | "escape" | "select" | "done" | "snooze" | "pin" | "unread" | "read" | "delete" | "spam" | "search" | "help";

/** The Mail screen's keys, for the "?" list. */
export const MAIL_KEYS: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: "↑ ↓", does: "Previous / next row" },
  { keys: "Shift + ↑ ↓", does: "Select while moving" },
  { keys: "Enter", does: "Open the thread, or open or close a bundle" },
  { keys: "Esc", does: "Close the open thread, then clear the selection" },
  { keys: "Space", does: "Select or unselect the row" },
  { keys: "D", does: "Done (Move to Inbox in Done)" },
  { keys: "S", does: "Snooze" },
  { keys: "P", does: "Pin or unpin" },
  { keys: "U / R", does: "Mark unread / read" },
  { keys: "Delete", does: "Delete (moves it to Trash)" },
  { keys: "!", does: "Spam (moves it to Spam)" },
  { keys: "/", does: "Search mail" },
  { keys: "?", does: "Show these keys" },
];

/** A writing box (a reply, a forward, a new mail, a draft being changed) carries this attribute in the page. */
export const WRITING_BOX = "[data-writing]";
/** A field that takes typing or keys of its own. */
const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Any other control: a key pressed on one is that control's. */
const CONTROLS = "button, a[href], summary, [role='button'], [role='checkbox'], [role='radio'], [role='menuitem'], [role='option'], [role='tab']";

/**
 * Where the focus is when a key is pressed: inside a writing box (`writing`, on any part of it), in a field
 * (`field`), on another control (`control`: a button, a link, a menu), or on none of these (`list`). Only then are
 * the keys the list's: a key pressed on a focused button is that button's.
 */
export type KeyFocus = "writing" | "field" | "control" | "list";
export function keyFocus(target: unknown): KeyFocus {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return "list";
  if (el.closest(WRITING_BOX)) return "writing";
  if (el.closest(FIELDS)) return "field";
  if (el.closest(CONTROLS)) return "control";
  return "list";
}

/**
 * Whether a button gives the focus back to the page after it is pressed: after a mouse click or a tap (`detail` counts
 * the clicks; it is 0 for a key press), on a button outside a writing box (a writing box sends the focus to its text
 * instead). The list's keys then go on working after a click, as they do in a browser that never gives a clicked
 * button the focus (Safari). A button reached with the keyboard keeps the focus, and the keys are then its own.
 */
export const givesFocusBack = (detail: number, button: unknown): boolean => detail > 0 && keyFocus(button) !== "writing";

/**
 * What a key press on the Mail screen does, or null for one it leaves to the rest of the app. Never with Ctrl, Cmd or
 * Alt. Unless the focus is on the list (`focus`, from keyFocus), only Escape: it leaves a field or a writing box, and
 * closes what is open.
 */
export function mailKeyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, focus: KeyFocus): MailKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape") return "escape";
  if (focus !== "list") return null;
  switch (e.key) {
    case "ArrowDown": return e.shiftKey ? "extend-down" : "down";
    case "ArrowUp": return e.shiftKey ? "extend-up" : "up";
    case "Enter": return "open";
    case " ": return "select";
    case "/": return "search";
    case "?": return "help";
    case "!": return "spam";
    case "Delete": case "Backspace": return "delete";
  }
  switch (e.key.toLowerCase()) {
    case "d": return "done";
    case "s": return "snooze";
    case "p": return "pin";
    case "u": return "unread";
    case "r": return "read";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reminders in the Inbox

/** A reminder that is due, as the Inbox shows it: the task's title and when it came due (its snooze, else its time). */
export interface DueReminder { id: string; title: string; at: string; friction: string }

/**
 * The owner's reminders whose time has come (overdue ones too): tasks with a reminder time, not done, not snoozed past
 * now. A task Mail made for a snoozed mail (`mail`) is left out: the mail itself shows. Earliest first.
 */
export function dueReminders(tasks: { id: string; fields: Record<string, unknown> }[], now: Date = new Date()): DueReminder[] {
  const out: DueReminder[] = [];
  for (const t of tasks) {
    const f = t.fields;
    if (f.status === "done" || typeof f.remind_at !== "string" || typeof f.mail === "string") continue;
    const snoozed = typeof f.snoozed_until === "string" && f.snoozed_until > f.remind_at ? f.snoozed_until : null;
    const at = snoozed ?? f.remind_at;
    const time = Date.parse(at);
    if (Number.isNaN(time) || time > now.getTime()) continue;
    out.push({ id: t.id, title: String(f.title ?? "").trim() || "(no title)", at: new Date(time).toISOString(), friction: typeof f.friction === "string" ? f.friction : "none" });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
