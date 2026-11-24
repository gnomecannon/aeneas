import type { Hub } from "../hub.js";
import type { MailCard } from "../mail-cards.js";

/**
 * Where the Mail screen's mail comes from (CONTRACT.md, Mail): one InboxSource per kind of mailbox. mail-inbox.ts keeps
 * what a source lists and asks it for every change to the mailbox; it knows nothing else about the mailbox. Two
 * sources today, both over IMAP (imports/icloud.ts): iCloud (icloudInbox) and other mail accounts, Gmail among them
 * (imapInbox). Another kind of mailbox is one more source like them, added to INBOX_SOURCES in mail-inbox.ts. The
 * screen, bundles, Pin and Snooze stay as they are.
 *
 * A source must keep to what iCloud's does. It lists the Inbox (and the owner's replies to it) and the other folders
 * without marking anything read, and fetches only what it lists (text, the HTML for showing, pictures sent inside a
 * mail) and, when the owner opens or downloads one, an attachment. It changes the mailbox only in these ways, each
 * after checking the message is still the one the hub kept: moving a kept message between the Inbox and the archive
 * (Done, Undo), or to Trash, Junk, the Inbox or one of the owner's own folders (never erasing one); marking one read or
 * unread; flagging or unflagging one (a pin); and adding a draft the owner wrote to its Drafts folder. It never sends
 * mail.
 */

export interface MailAddress { name: string; address: string }

/** One Inbox message for the Mail screen. Kept only in memory; mail-inbox.ts decides what is stored. */
export interface InboxMail {
  /** The source's id for the message where it is now (iCloud: `<UIDVALIDITY>:<UID>:<folder>`). */
  id: string;
  at: Date;
  message_id: string | null;
  from: MailAddress;
  /** Set only when replies would go somewhere other than From. */
  reply_to: string | null;
  subject: string;
  /** The text as a person reads it (readingText, links written out as `label (url)`), at most TEXT_MAX. */
  text: string;
  /** Sent by a system (a shipping notice, an alert, a newsletter), not a person. */
  automated: boolean;
  /** It carries List-Unsubscribe: marketing mail or a newsletter, most of the time. */
  unsubscribe: boolean;
  /** Its List-Id, when it comes from a mailing list (at most 200 characters). */
  list_id: string | null;
  /** Its HTML cleaned for showing (mail-html.ts), pictures sent inside it written in; null when it has none or too much. */
  html: string | null;
  /** The web pictures its HTML shows, to be fetched by the hub (`<img data-r="N">`). */
  remote: string[];
  /** The brand's logo the mail provider verified (BIMI with a mark certificate), fetched by the hub; or null. */
  logo: { domain: string; url: string } | null;
  /** The Message-IDs it answers (`In-Reply-To` and `References`), which put it in a thread. */
  refs: string[];
  /** The owner's own: a reply from the Sent folder, kept only while its thread is. */
  mine: boolean;
  /** Its key facts (mail-cards.ts, mailCards): from the sender's schema.org data in its HTML, or patterns in its text. */
  cards?: MailCard[];
  /** The addresses it was sent to (To and Cc, lowercase, at most 50), for the owner's bundle rules. */
  rcpt?: string[];
  /** Its attachments, from its structure (no file read): names, types and sizes. */
  attachments?: import("./icloud.js").MailAttachment[];
}

/**
 * One refresh of a mailbox's Inbox:
 * - `present`: the id of every message in the Inbox now, so the hub can tell what left it; null when that cannot be
 *   said (no Inbox found), and then nothing is taken away;
 * - `mails`: messages since the time asked that the hub does not keep yet, newest first (`more` when there were too
 *   many for one refresh);
 * - `moved`: kept messages (by Message-ID) found under another id, not fetched again;
 * - `seen`: of `present`, the ids the mailbox has as read (read in another mail app counts), or null when not known;
 * - `mails` also holds the owner's replies (`mine`) from the sent mail that answer kept mail or mail listed now;
 * - `refs`: kept messages (`needsRefs`) with the Message-IDs they answer, for mail kept before threads.
 */
export interface InboxListing { /** Of the done mail asked about (`doneIds`), what is still where the hub kept it and which of it the mailbox has flagged; absent or null when not read. */ doneFlags?: { present: string[]; flagged: string[] } | null; present: string[] | null; seen: string[] | null; /** Of `present`, the ids the mailbox has flagged (pinned here); absent or null when not known. */ flagged?: string[] | null; mails: InboxMail[]; moved: { id: string; message_id: string }[]; more: boolean; refs?: { id: string; refs: string[] }[]; /** How far the Sent folder has been read (`<UIDVALIDITY>:<UID>`), for the next refresh's `sentFrom`; absent when it was not read. */ sentAt?: string }

/** One kept message to move: its id where it is, and the Message-ID the hub kept for it. */
export interface MoveRef { id: string; message_id: string | null }

export interface InboxSource {
  /** The start of its accounts' keys (`icloud:`), which also tell which source an account is. */
  prefix: string;
  /** Its linked accounts whose Inbox the Mail screen shows, as keys (`icloud:you@icloud.com`). */
  accounts(hub: Hub): string[];
  /** One refresh (see InboxListing). `known` and `knownMessage` say what the hub keeps already. `owner`: Refresh pressed. */
  list(hub: Hub, account: string, since: Date, known: (id: string) => boolean, knownMessage: (messageId: string) => boolean, opts: { owner?: boolean; needsRefs?: (id: string) => boolean; sentFrom?: string | null; /** The ids of kept done mail, whose flags are read too (`doneFlags`). */ doneIds?: string[] }): Promise<InboxListing>;
  /** Done (to the archive) or Undo (back to the Inbox): each message's new id, or null when it was not moved. */
  move(hub: Hub, account: string, refs: MoveRef[], to: "archive" | "inbox"): Promise<Map<string, string | null>>;
  /** Mark a kept message read or unread in the mailbox, after checking it is still that message; false when it was not. */
  setSeen(hub: Hub, account: string, refs: MoveRef[], seen: boolean): Promise<boolean[]>;
  /** Pin or unpin as the mailbox's own flag (`\Flagged` in IMAP: Apple Mail's flag), fenced as setSeen; true for each one changed. */
  setFlagged?(hub: Hub, account: string, refs: MoveRef[], flagged: boolean): Promise<boolean[]>;
  /** A kept message's attachments now, with previews of its pictures (read-only, kept in memory); null when it is gone. */
  attachments?(hub: Hub, account: string, ref: MoveRef): Promise<(import("./icloud.js").MailAttachment & { preview?: string })[] | null>;
  /** A kept message's To, Cc and Bcc now, what it answers, and its attachments by their structure (Reply all, an edited draft, a forward), read-only; null when it is gone. */
  recipients?(hub: Hub, account: string, ref: MoveRef): Promise<{ to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; answers: string[]; in_reply_to: string | null; files: import("./icloud.js").MailAttachment[] } | null>;
  /** A kept message's List-Unsubscribe headers now (read-only); null when it is gone. */
  unsubscribeHeaders?(hub: Hub, account: string, ref: MoveRef): Promise<{ header: string; post: string } | null>;
  /** One attachment's bytes for a download (read-only, never kept); null when the message or the part is gone. */
  attachment?(hub: Hub, account: string, ref: MoveRef, part: string): Promise<{ name: string; bytes: Buffer } | null>;
  /** Save a draft (an RFC 5322 message, mail-compose.ts) to the mailbox's Drafts folder; it throws when not saved. Never sends. */
  saveDraft?(hub: Hub, account: string, raw: Buffer): Promise<{ /** Where the draft is now, when the server says. */ id: string | null; folder: string }>;
  /** Delete (to Trash), Spam (to Junk), Not spam and Move to: each message's new id, or null when it was not moved (MOVE only). */
  moveTo?(hub: Hub, account: string, refs: MoveRef[], dest: import("./icloud.js").MoveDest): Promise<Map<string, string | null>>;
  /** The mailbox's other folders (Drafts, Sent, Junk, Trash, its own), read-only like the Inbox: see FolderListing. */
  listFolders?(hub: Hub, account: string, since: Date, known: (id: string) => boolean): Promise<import("./icloud.js").FolderListing[]>;
}
