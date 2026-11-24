import { ImapFlow } from "imapflow";
import dns from "node:dns";
import { isNonPublicAddress } from "../ai/web.js";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { errCode } from "../logsafe.js";
import { BACKFILL_DAYS, MAIL_QUERY, OVERLAP_MS } from "./gmail.js";
import type { FetchedMail, MailRef, MailSource } from "./mail-sources.js";
import { bodyText, readingText } from "./mail-text.js";
import { cleanMailHtml, pictureData } from "../mail-html.js";
import { mailCards } from "../mail-cards.js";
import { wholeChars } from "../mail-compose.js";
import type { InboxListing, InboxMail, InboxSource, MailAddress, MoveRef } from "./inbox-source.js";
export type { InboxMail, MailAddress, MoveRef } from "./inbox-source.js";

/**
 * iCloud Mail and other mail accounts, over IMAP. Apple has no sign-in for mail, so each mailbox is linked with an
 * app-specific password the owner makes at account.apple.com and enters once; it is kept only in connections.json
 * (sealed) and never shown, logged or sent anywhere but iCloud. For an iCloud mailbox the hub talks only to
 * imap.mail.me.com:993 over TLS with normal certificate checks; nothing a request, setting or the assistant sends can
 * change that.
 *
 * Reading changes nothing: every folder is opened with EXAMINE and message parts are fetched with BODY.PEEK (nothing is
 * marked read). For Mail receipts that is all there is: mail is read in memory and never stored, as for Gmail. For the
 * Mail screen, what is read is the Inbox and the other folders' mail (listInboxICloud, listFoldersICloud: text parts,
 * capped, and the pictures a mail's HTML shows from inside it), which mail-inbox.ts keeps, and an attachment when the
 * owner opens or downloads one (attachmentsICloud, attachmentICloud: kept nowhere).
 *
 * The Mail screen's writes, each fenced in a function of its own that checks the message is still the one the hub kept
 * (its folder not reset, its Message-ID read again) and can ask the server for nothing else (ImapMover, ImapDrafter):
 * - moveICloud: Done and Undo, an IMAP MOVE between the Inbox and the archive folder;
 * - moveToICloud: Delete, Spam, Not spam and Move to, an IMAP MOVE to Trash, Junk, the Inbox or one of the owner's own
 *   folders that the server lists now;
 * - setSeenICloud and setFlaggedICloud: the `\Seen` flag (read or unread) and the `\Flagged` flag (a pin), no other;
 * - saveDraftICloud: one message appended to the Drafts folder, never sent.
 * Nothing here copies, expunges or deletes a message, and nothing sends mail.
 *
 * Other mail accounts (since 2026-11-22): the same code reads any mailbox the owner links with a server, a port, a
 * username and an app password (`imap:` accounts, `connections.imap`), Gmail as a preset (imap.gmail.com). The Mail
 * screen reads them, and Mail receipts when that switch is on for the account (imapSource); calendars are iCloud's
 * only. The fences above hold for them too; on top: TLS on connect always (no plain or STARTTLS port), certificates
 * checked against the server's name, and the server's addresses looked up and refused when one is on the owner's own
 * network (a mistyped or planted server cannot point the hub inside the home), the connection then made to a checked
 * address. Brand logos stay iCloud's only: they trust a verdict iCloud writes on each mail, which another server does
 * not write and a sender could forge there.
 */

const HOST = "imap.mail.me.com";
const PORT = 993;
/** The prefix that marks an iCloud mailbox in the `mail` table (mail-sources.ts). */
const PREFIX = "icloud:";
/** At most this much of each text part is read. */
export const PART_MAX = 256 * 1024;
/** At most this many text parts of one message are read (a text and an HTML version, and a few more). */
const PARTS_MAX = 4;
/** Folders whose special use says they are not received mail. */
const SKIP_USE = new Set(["\\Junk", "\\Trash", "\\Drafts", "\\Sent"]);
/** A link to the message when it carries no Message-ID: iCloud Mail on the web. */
const WEB_LINK = "https://www.icloud.com/mail/";

export interface ICloudAccount {
  email: string;
  /** The app-specific password, as Apple shows it (abcd-efgh-ijkl-mnop). Never leaves the hub but to iCloud. */
  password: string;
  linked_at: string;
  /** Mail up to this time has been listed; the next read starts a little before it. */
  listed_to?: string;
  /** The search it was listed with; another search lists the mailbox again. */
  query?: string;
  last_sync?: string;
  last_error?: string | null;
  /**
   * When iCloud last refused the password. The hub then stops signing in on its own (repeated refused sign-ins can get
   * an Apple Account locked) until the mailbox is linked again or the owner presses Read now, which tries once.
   */
  refused_at?: string | null;
  /** Whether its mail is read (Mail receipts). Absent is yes: accounts linked before calendars were. */
  mail?: boolean;
  /**
   * Whether its Inbox shows on the Mail screen (Internet Accounts, since 2026-11-22). Absent follows `mail`, as before:
   * a mailbox linked only for calendars shows on neither.
   */
  inbox?: boolean;
  /** Its calendars, when calendar sync uses this account (calendar-sync.ts). */
  calendar?: import("../calendar-sync.js").CalendarConf;
  /**
   * Read only (Internet Accounts, since 2026-11-24): the hub changes nothing in the account. No draft is saved, no mail
   * is moved, flagged or marked read there, and no calendar event is written or deleted; it is only read. Absent is off.
   */
  read_only?: boolean;
}

/** Said when iCloud refused a mailbox's password and the hub stopped signing in. */
export const REFUSED = "iCloud refused this mailbox's app-specific password (it was revoked, or the Apple Account changed). The hub stopped signing in so your account is not locked. Make a new app-specific password at account.apple.com and link the mailbox again, or press Read now (or Refresh in Mail) to try this one once more.";

/**
 * Gmail's search words, so both sources look for the same mail: every `subject:` word in MAIL_QUERY, and the two
 * words Gmail looks for anywhere in the mail, which IMAP looks for in the body.
 */
export const SUBJECT_WORDS = [...MAIL_QUERY.matchAll(/subject:(\w+)/g)].map((m) => m[1]);
export const BODY_WORDS = ["veterinary", "animal hospital"];
/** What a listing searched with, kept on the account: a change lists the mailbox again. */
const SEARCH_ID = JSON.stringify({ subject: SUBJECT_WORDS, body: BODY_WORDS });

// ---------------------------------------------------------------------------------------------------------------------
// The IMAP client. Only these calls are used; the type names exactly what the hub may ask of a server, and no call that
// changes a mailbox is in it. Tests swap in a fake with setImapFactory.

/** `name` and `delimiter`: the folder's own name and the mark between the parts of its path, as the server gives them. */
export interface ImapFolder { path: string; specialUse?: string; flags: Set<string>; name?: string; delimiter?: string }
export interface ImapPart { part?: string; type: string; id?: string; size?: number; encoding?: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: ImapPart[] }
export interface ImapAddress { name?: string; address?: string }
export interface ImapMessage {
  internalDate?: Date | string;
  envelope?: { date?: Date | string; subject?: string; messageId?: string; inReplyTo?: string; from?: ImapAddress[]; replyTo?: ImapAddress[]; to?: ImapAddress[]; cc?: ImapAddress[]; bcc?: ImapAddress[] };
  bodyStructure?: ImapPart;
  /** Only the header lines asked for by name (`headers`), as the server sent them. */
  headers?: Buffer;
}
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ImapFolder[]>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  /** `headers` names header lines to fetch (with BODY.PEEK, like everything here): only the Mail screen asks for them. */
  fetchOne(uid: string, query: { envelope: true; bodyStructure: true; internalDate: true; headers?: string[] }, options: { uid: true }): Promise<ImapMessage | false>;
  download(uid: string, part: string, options: { uid: true; maxBytes: number }): Promise<{ content?: NodeJS.ReadableStream } | undefined>;
  /** Each message's flags (`FETCH FLAGS`, which reads and changes nothing): only the Mail screen asks, for read and unread. */
  fetch?(range: string, query: { uid: true; flags: true }, options: { uid: true }): AsyncIterable<{ uid: number; flags?: Set<string> }>;
}
/** Who signs in, and where: iCloud when `host` is absent. `name` is the provider's name in the hub's messages. */
export interface ImapLogin { user: string; pass: string; host?: string; port?: number; servername?: string; name?: string }
/**
 * What the Mail screen's moves and flags may ask of a server besides reading, and only they: open a folder read-write
 * (SELECT), MOVE messages out of it, and add or remove the `\Seen` or the `\Flagged` flag. Never another flag, a
 * COPY, an APPEND, an EXPUNGE or a delete: those are not in the type. (APPEND is in a type of its own, ImapDrafter.)
 */
export interface ImapMover {
  capabilities: Map<string, unknown>;
  mailboxOpen(path: string, options: { readOnly: false }): Promise<{ uidValidity: bigint }>;
  /** imapflow's MOVE: `uidMap` gives each message's new UID in the destination (UIDPLUS, which iCloud has). */
  messageMove(uid: string, destination: string, options: { uid: true }): Promise<{ uidValidity?: bigint; uidMap?: Map<number, number> } | false>;
  /** STORE +FLAGS / -FLAGS of `\Seen` (read) or `\Flagged` (a pin) only: the type takes no other flag (setFlagICloud). */
  messageFlagsAdd(uid: string, flags: ["\\Seen"] | ["\\Flagged"], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(uid: string, flags: ["\\Seen"] | ["\\Flagged"], options: { uid: true }): Promise<boolean>;
}

const realClient = (login: ImapLogin): ImapClient => new ImapFlow({
  host: login.host ?? HOST, port: login.port ?? PORT, secure: true, auth: { user: login.user, pass: login.pass },
  // Connected to a checked address (publicAddress), the certificate is still checked against the server's name.
  ...(login.servername ? { servername: login.servername } : {}),
  // imapflow's own logger would write the conversation with the server, addresses included.
  logger: false,
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  disableAutoIdle: true,
  // How much a server may send in one piece (the library's own limits are 1 GB and 2 GB, more than the hub's memory):
  // files come in pieces of 64 KB, so only a folder's listing is ever long. A server that sends more is cut off.
  maxLiteralSize: 4 * 1024 * 1024, maxLineLength: 16 * 1024 * 1024, maxResponseSize: 32 * 1024 * 1024,
}) as unknown as ImapClient;
let makeClient = realClient;

/** For tests: a fake IMAP client in place of iCloud. Null puts the real one back. */
export function setImapFactory(f: ((login: ImapLogin) => ImapClient) | null) {
  makeClient = f ?? realClient;
}

/** A job's time limit ended it (withClient): told apart, so a listing can keep what it had read by then. */
export class MailDeadline extends StoreError {
  constructor(name: string) { super(502, `${name} stopped answering in time. The hub tries again later.`); }
}

/** iCloud refused the address and password: told apart from a server out of reach, which is tried again later. */
export class ICloudRefused extends StoreError {
  constructor(message = "iCloud did not accept this address and app-specific password. Check both, or make a new app-specific password at account.apple.com.") { super(422, message); }
}

/**
 * What a server says when it turns a sign-in away for a reason that is not the password (RFC 5530): it is busy, the
 * account is in use or over a limit, or it is broken. Tried again later like a server out of reach; counted as a
 * refused password, it paused the mailbox until the owner linked it again.
 */
const NOT_THE_PASSWORD = new Set(["UNAVAILABLE", "LIMIT", "INUSE", "SERVERBUG", "OVERQUOTA"]);
/**
 * The same said in words, under a code that says nothing: Gmail turns away one sign-in too many with
 * `NO [ALERT] Too many simultaneous connections`. The server's words are read here only to tell busy from refused;
 * they are never logged, kept or shown. (`CONTACTADMIN` is not among the codes: it means the owner must see the
 * provider, and signing in again every 15 minutes for good would not help.)
 */
const BUSY_WORDS = /too many|simultaneous|try again|temporar|throttl|rate.?limit/i;

/** The hub's own words for a failure: never the server's, which can repeat the address or the password's owner. */
function failure(e: unknown, name = "iCloud Mail"): StoreError {
  if (e instanceof StoreError) return e;
  const refused = e as { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: unknown; response?: unknown } | null;
  const said = [refused?.responseText, refused?.response].filter((x): x is string => typeof x === "string").join(" ").slice(0, 500);
  if (refused?.authenticationFailed && !NOT_THE_PASSWORD.has(String(refused.serverResponseCode ?? "").toUpperCase()) && !BUSY_WORDS.test(said)) {
    return name === "iCloud Mail" ? new ICloudRefused() : new ICloudRefused(`${name} did not accept this username and app password. Check both, or make a new app password with your mail provider.`);
  }
  return new StoreError(502, `${name} could not be reached from the hub, or stopped answering. Check the server's name and port and the hub's internet connection, and try again.`);
}

/**
 * How long one job may take in all, connection included: the socket timeout ends only a silent connection, and a
 * server that keeps sending a little would hold the mail job without end. Tests shorten them.
 */
const DEADLINES = { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 };
export function setICloudDeadlines(d: Partial<typeof DEADLINES> | null) {
  Object.assign(DEADLINES, d ?? { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 });
}

/** One connection for one job, closed at the end whatever happens, and given up at its deadline. */
async function withClient<T>(login: ImapLogin, deadlineMs: number, job: (c: ImapClient) => Promise<T>): Promise<T> {
  const name = login.name ?? "iCloud Mail";
  let c: ImapClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  let over = false;
  const close = () => { try { c?.close(); } catch { /* closed already */ } };
  const run = (async () => {
    // A server the owner named: each of its checked addresses in turn, the certificate checked against the name.
    const targets: ImapLogin[] = login.host && login.host !== HOST ? (await publicAddresses(login.host)).map((address) => ({ ...login, host: address, servername: login.host })) : [login];
    for (const [i, target] of targets.entries()) {
      if (over) throw new MailDeadline(name);
      c = makeClient(target);
      try { await c.connect(); break; }
      catch (e) {
        // A sign-in turned away is the server's answer at any address; only an address that takes no connection gives
        // way to the next one.
        if ((e as { authenticationFailed?: boolean })?.authenticationFailed || i === targets.length - 1) throw e;
        close();
      }
    }
    return job(c!);
  })();
  run.catch(() => {}); // after the deadline it ends on its own, as the connection is closed under it
  try {
    return await Promise.race([run, new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        over = true;
        close();
        fail(new MailDeadline(name));
      }, deadlineMs);
      timer.unref?.();
    })]);
  } catch (e) {
    throw failure(e, name);
  } finally {
    clearTimeout(timer);
    await c?.logout().catch(close);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounts

const accountName = (email: string) => `${PREFIX}${email}`;

/** The start of another mail account's key (`imap:you@mail.example`), its mailbox in `connections.imap`. */
export const IMAP_PREFIX = "imap:";
const isImapKey = (key: string) => key.startsWith(IMAP_PREFIX);

/** A mailbox on another server (since 2026-11-22): where it is and who signs in, besides what an iCloud one keeps. */
export interface ImapAccount extends ICloudAccount {
  /** `gmail` (imap.gmail.com, an app password Google shows), or `imap` (the server the owner typed). */
  preset: "gmail" | "imap";
  host: string;
  port: number;
  /** The username the server takes, most often the address itself. */
  user: string;
}

/** Whether a mailbox's Inbox shows on the Mail screen. */
export const inboxOn = (a: { inbox?: boolean; mail?: boolean }) => a.inbox ?? a.mail !== false;
/** Whether Mail receipts reads a mailbox. */
export const receiptsOn = (a: { mail?: boolean }) => a.mail !== false;
/**
 * Whether anything reads a mailbox's mail: Mail receipts or the Mail screen. While either does (or calendar sync uses
 * the account), its password stays on the hub; every way of unlinking asks this, so none takes the password from under
 * the other.
 */
export const mailUsed = (a: { inbox?: boolean; mail?: boolean }) => receiptsOn(a) || inboxOn(a);

/** The presets: the server filled in for the owner. */
export const IMAP_PRESETS = { gmail: { host: "imap.gmail.com", port: 993, name: "Gmail" } } as const;

/** A linked mailbox by its key (`icloud:…` or `imap:…`). */
function account(hub: Hub, key: string): ICloudAccount & Partial<ImapAccount> {
  const c = hub.connections.get();
  const a = isImapKey(key) ? c.imap?.find((x) => x.email === key.slice(IMAP_PREFIX.length)) : c.icloud?.find((x) => x.email === key.slice(PREFIX.length));
  if (!a) throw new StoreError(404, "that mailbox is not linked");
  return a;
}

/**
 * Whether anything on the hub still uses a linked account's password: the Mail screen, Mail receipts (not for another
 * mail account whose address is also signed in with Google: its receipts are read there, never with this password),
 * or calendar sync. When the last of them is switched off the account is removed (routes/imports.ts), since a password
 * is kept only while something uses it.
 */
export function accountUsed(hub: Hub, key: string): boolean {
  const a = account(hub, key);
  return inboxOn(a) || (receiptsOn(a) && !readByGoogle(hub, key)) || !!a.calendar;
}
/** Another mail account whose address is also signed in with Google: Mail receipts reads it there (imapSource.accounts). */
const readByGoogle = (hub: Hub, key: string) => isImapKey(key) && !!hub.connections.get().google?.some((g) => g.email === key.slice(IMAP_PREFIX.length));

function saveAccount(hub: Hub, key: string, fields: Partial<ICloudAccount>) {
  hub.connections.update((c) => {
    const a = isImapKey(key) ? c.imap?.find((x) => x.email === key.slice(IMAP_PREFIX.length)) : c.icloud?.find((x) => x.email === key.slice(PREFIX.length));
    if (a) Object.assign(a, fields);
  });
}

/** The provider's name in the hub's words: iCloud Mail, Gmail, or the server's name. */
const providerName = (a: Partial<ImapAccount>) => (!a.host ? "iCloud Mail" : a.preset === "gmail" ? "Gmail" : a.host);

/**
 * Who a linked mailbox is with, for the Mail screen's words ("in iCloud", "in Gmail", "your mail app"): its kind, and
 * the provider's name as people say it (another server by its own name). Null when it is not linked any more.
 */
export function mailboxProvider(hub: Hub, key: string): { kind: "icloud" | "gmail" | "imap"; provider: string } | null {
  let a: ICloudAccount & Partial<ImapAccount>;
  try { a = account(hub, key); } catch { return null; }
  return !a.host ? { kind: "icloud", provider: "iCloud" } : a.preset === "gmail" ? { kind: "gmail", provider: "Gmail" } : { kind: "imap", provider: a.host };
}

/** Whether a mailbox is Gmail's: linked as Google, or as another server whose name is Gmail's. */
export const isGmail = (a: Partial<ImapAccount>) => a.preset === "gmail" || /(^|\.)(gmail|googlemail)\.com$/.test(a.host ?? "");

/** How to sign in to a linked mailbox. */
const loginOf = (a: ICloudAccount & Partial<ImapAccount>): ImapLogin =>
  a.host ? { user: a.user ?? a.email, pass: a.password, host: a.host, port: a.port ?? PORT, name: providerName(a) } : { user: a.email, pass: a.password };

/** Whether an account is Read only: the hub writes nothing to it (a Google sign-in can only read, so it always is). */
export function readOnly(hub: Hub, key: string): boolean {
  if (!key.startsWith(PREFIX) && !isImapKey(key)) return true;
  try { return account(hub, key).read_only === true; } catch { return false; }
}

/** What a write to a Read only account is refused with. */
export const readOnlyText = (email: string) => `${email} is set to Read only in Settings, Connections, so Aeneas changes nothing in it. Switch Read only off there to do this.`;

/** Refuse a write to a Read only account: every one of the Mail screen's writes asks this first. */
function refuseIfReadOnly(a: { email: string; read_only?: boolean }) {
  if (a.read_only) throw new StoreError(409, readOnlyText(a.email));
}

/** What a paused mailbox says: iCloud's own words, or the same for another provider. */
const refusedText = (a: Partial<ImapAccount>) => (!a.host ? REFUSED
  : `${providerName(a)} refused this mailbox's app password (it was revoked, or the account changed). The hub stopped signing in so your account is not locked. Make a new app password and link the mailbox again, or press Refresh in Mail to try this one once more.`);

/** How a server's name is looked up (tests swap it). */
let lookupAll: (host: string) => Promise<{ address: string }[]> = (host) => dns.promises.lookup(host, { all: true });
export function setMailLookup(f: ((host: string) => Promise<{ address: string }[]>) | null) {
  lookupAll = f ?? ((host) => dns.promises.lookup(host, { all: true }));
}

/**
 * The addresses to connect to for a server the owner named, when none of them is on the owner's own network (private,
 * loopback, link-local and the like, ai/web.ts isNonPublicAddress): IPv4 and IPv6 in turn, at most four. Looked up at each
 * connection and connected to as looked up, so a name cannot answer a public address to the check and a private one to
 * the connection. Each is tried in turn until one takes the connection (withClient): a home whose IPv6 route is
 * broken reaches the server by its IPv4 address instead of timing out on the first one.
 */
async function publicAddresses(host: string): Promise<string[]> {
  let found: { address: string }[];
  try { found = await lookupAll(host); } catch { throw new StoreError(422, `The hub could not find the mail server ${host}. Check its name.`); }
  if (!found.length) throw new StoreError(422, `The hub could not find the mail server ${host}. Check its name.`);
  if (found.some((x) => isNonPublicAddress(x.address))) throw new StoreError(422, `${host} is on your own network. The hub links mail servers on the internet only.`);
  // IPv4 and IPv6 in turn, IPv4 first, so that a name with many addresses of one family still gives one of the other
  // (a hub with only IPv6, or only IPv4, must reach it).
  const all = [...new Set(found.map((x) => x.address))];
  const v4 = all.filter((x) => !x.includes(":")), v6 = all.filter((x) => x.includes(":"));
  const turns: string[] = [];
  for (let i = 0; i < Math.max(v4.length, v6.length); i++) { if (v4[i]) turns.push(v4[i]); if (v6[i]) turns.push(v6[i]); }
  return turns.slice(0, 4);
}

/** An app-specific password as Apple shows it, or null when `v` is not one (an Apple ID password never is). */
export function appPassword(v: unknown): string | null {
  const letters = typeof v === "string" ? v.replace(/[\s-]/g, "").toLowerCase() : "";
  return /^[a-z]{16}$/.test(letters) ? letters.match(/.{4}/g)!.join("-") : null;
}

/**
 * An app password as Google shows it (16 letters in four groups with spaces between), kept and sent as the 16 letters:
 * Google takes them with or without the spaces, and not with Apple's hyphens. Null when `v` is not one (a Google
 * Account password never is).
 */
export function googleAppPassword(v: unknown): string | null {
  const letters = typeof v === "string" ? v.replace(/[\s-]/g, "").toLowerCase() : "";
  return /^[a-z]{16}$/.test(letters) ? letters : null;
}

/** Link a mailbox: check the password with iCloud once, keep it, and start the first read. */
export async function linkICloud(hub: Hub, body: Record<string, unknown>, read: (account: string) => void = () => {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError(422, "email is the iCloud Mail address");
  const password = appPassword(body.password);
  if (!password) throw new StoreError(422, "password is an app-specific password made at account.apple.com (16 letters, like abcd-efgh-ijkl-mnop), not your Apple ID password");
  await withClient({ user: email, pass: password }, DEADLINES.check, async () => {});
  hub.connections.update((c) => {
    const list = (c.icloud ??= []);
    const prev = list.find((a) => a.email === email);
    if (prev) {
      // A new password for an account already linked: its switches stay as the owner set them (Receipts off stays off).
      // Only an account whose mail nothing reads (linked for calendars alone, or its mail unlinked) is linked for mail
      // again, as a new one is: Receipts and the Mail screen both.
      Object.assign(prev, { password, last_error: null, refused_at: null });
      if (!mailUsed(prev)) { prev.mail = true; delete prev.inbox; }
    } else list.push({ email, password, linked_at: nowIso() });
  });
  read(accountName(email));
  return hub.connections.view().icloud;
}

/**
 * Link another mail account (the Mail screen's, since 2026-11-22): Gmail (the preset fills in the server) or any IMAP
 * server on port 993 or another TLS port. Checked with the server once, kept sealed like iCloud's, never returned.
 */
export async function linkImap(hub: Hub, body: Record<string, unknown>, read: (account: string) => void = () => {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError(422, "email is the mailbox's address");
  if (hub.connections.get().icloud?.some((a) => a.email === email && mailUsed(a))) throw new StoreError(409, "that address is already linked as an iCloud mailbox");
  const preset = body.preset === "gmail" ? "gmail" : "imap";
  let host: string, port: number, password: string | null;
  if (preset === "gmail") {
    ({ host, port } = IMAP_PRESETS.gmail);
    password = googleAppPassword(body.password);
    if (!password) throw new StoreError(422, "password is an app password made in your Google Account (16 letters, like abcd efgh ijkl mnop), not your Google password");
  } else {
    host = typeof body.host === "string" ? body.host.trim().toLowerCase().replace(/\.$/, "") : "";
    // A name, never an address typed in: the hub looks the name up and checks every address it answers.
    if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new StoreError(422, "host is the mail server's name, like imap.fastmail.com");
    port = body.port === undefined || body.port === null || body.port === "" ? 993 : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 143) throw new StoreError(422, "port is the server's IMAP port over TLS, most often 993 (143, without TLS, is not used)");
    const p = typeof body.password === "string" ? body.password.trim() : "";
    password = p.length >= 1 && p.length <= 200 && !/[\x00-\x1f\x7f]/.test(p) ? p : null;
    if (!password) throw new StoreError(422, "password is the app password your mail provider made for this (at most 200 characters)");
  }
  const u = typeof body.user === "string" && body.user.trim() ? body.user.trim() : email;
  if (u.length > 254 || /[\x00-\x1f\x7f]/.test(u)) throw new StoreError(422, "user is the name the server signs in with, most often the address");
  const acct = { email, preset, host, port, user: u, password } as const;
  await withClient(loginOf({ ...acct, linked_at: "" }), DEADLINES.check, async () => {});
  hub.connections.update((c) => {
    const list = (c.imap ??= []);
    const prev = list.find((a) => a.email === email);
    if (prev) {
      // As for iCloud (linkICloud): the switches stay as the owner set them, and only an account nothing uses is
      // linked for mail again, as a new one is.
      Object.assign(prev, { ...acct, last_error: null, refused_at: null });
      if (!inboxOn(prev) && !(receiptsOn(prev) && !c.google?.some((g) => g.email === email))) { prev.mail = true; delete prev.inbox; }
    } else list.push({ ...acct, linked_at: nowIso() });
  });
  read(`${IMAP_PREFIX}${email}`);
  return hub.connections.view().imap;
}

/** Unlink another mail account: its password and its receipts queue go from the hub; filed records stay. The provider revokes the app password itself. */
export function unlinkImap(hub: Hub, email: string) {
  account(hub, `${IMAP_PREFIX}${email}`);
  hub.db.prepare("DELETE FROM mail WHERE account = ?").run(`${IMAP_PREFIX}${email}`);
  hub.connections.update((c) => { c.imap = (c.imap ?? []).filter((x) => x.email !== email); });
  return { ...hub.connections.view().imap, message: "The mailbox is unlinked and its password deleted from the hub. To end the app password itself, revoke it with your mail provider." };
}

/** Unlink a mailbox: its password and queue go; filed records stay. The password itself is revoked only at Apple. */
export function unlinkICloud(hub: Hub, email: string) {
  account(hub, accountName(email));
  hub.db.prepare("DELETE FROM mail WHERE account = ?").run(accountName(email));
  // Calendar sync may still use the account: then only its mail stops, Receipts and the Mail screen both (each has a
  // switch of its own since 2026-11-22: with only Receipts off the hub said it stopped reading and read the Inbox on),
  // and the password stays for the calendars.
  if (account(hub, accountName(email)).calendar) {
    hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a) { a.mail = false; a.inbox = false; } });
    return { ...hub.connections.view().icloud, message: "The hub stopped reading this mailbox. Its app-specific password stays on the hub because calendar sync uses it; stop calendar sync too to delete it." };
  }
  hub.connections.update((c) => { c.icloud = (c.icloud ?? []).filter((x) => x.email !== email); });
  return { ...hub.connections.view().icloud, message: "The mailbox is unlinked and its password deleted from the hub. To end the password itself, revoke it at account.apple.com, under Sign-In and Security, App-Specific Passwords." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Listing and reading

/** The marks of a folder that only shows mail kept in other folders again: Gmail's All Mail, Starred and Important. */
const VIEW_MARKS = ["\\All", "\\Flagged", "\\Important"];
/**
 * Whether a folder is such a view. The mark is looked for in the folder's own flags too: the IMAP library names
 * `\\Important` nowhere else, so Gmail's Important counted as one of the owner's folders.
 */
export const isView = (f: ImapFolder) => VIEW_MARKS.some((m) => f.specialUse === m || f.flags.has(m));

/**
 * The folders Mail receipts reads: every one but Junk, Trash, Drafts and Sent, ones that cannot be opened, and views
 * (a mail under three Gmail labels was queued and read by the model three times, and again from All Mail). With
 * `allMail` (a Gmail account), only All Mail when the server lists it: there each mail is once, archived mail too, and
 * Spam and Trash are not in it. The owner's own sent mail is in it; the search words decide what is read, as they do
 * for a mailbox signed in with Google.
 */
export function mailFolders(folders: ImapFolder[], opts: { allMail?: boolean } = {}): ImapFolder[] {
  const open = folders.filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
  const all = opts.allMail ? open.find((f) => f.specialUse === "\\All" || f.flags.has("\\All")) : undefined;
  if (all) return [all];
  return open.filter((f) => !(f.specialUse && SKIP_USE.has(f.specialUse)) && !isView(f));
}

/** The server-side search: since a day, any of Gmail's subject words, or the vet words in the body. */
export function searchQuery(since: Date): Record<string, unknown> {
  return { since, or: [...SUBJECT_WORDS.map((w) => ({ subject: w })), ...BODY_WORDS.map((w) => ({ body: w }))] };
}

/** A message id: `<UIDVALIDITY>:<UID>:<folder>`, since a UID is unique only in one folder and one UIDVALIDITY. */
const messageId = (uidValidity: bigint | number | string, uid: number, folder: string) => `${uidValidity}:${uid}:${folder}`;
function parseId(id: string): { validity: string; uid: string; folder: string } | null {
  const m = /^(\d+):(\d+):([\s\S]+)$/.exec(id);
  return m ? { validity: m[1], uid: m[2], folder: m[3] } : null;
}

/**
 * Open a folder read-only, or null when the server says no to it (it was renamed or deleted since it was listed, or
 * the server lists a folder it does not let anyone open): that folder is passed by, and the others are still read.
 * One such folder failed the whole listing. Anything else (a lost connection) is an error as before.
 */
async function openOrPass(c: ImapClient, path: string): Promise<{ uidValidity: bigint } | null> {
  try { return await c.mailboxOpen(path, { readOnly: true }); }
  catch (e) {
    if ((e as { responseStatus?: string })?.responseStatus === "NO") return null;
    throw e;
  }
}

/** List a mailbox's likely mail since it was last listed (the first time, the last BACKFILL_DAYS) and queue what is new. */
export async function listICloud(hub: Hub, accountKey: string, now: Date = new Date(), opts: { owner?: boolean } = {}): Promise<{ listed: number; queued: number }> {
  const email = accountKey;
  let a = account(hub, accountKey);
  if (a.refused_at && !opts.owner) throw new StoreError(409, refusedText(a));
  if (a.listed_to && a.query !== SEARCH_ID) {
    hub.db.prepare("DELETE FROM mail WHERE account = ? AND state = 'queued'").run(accountKey);
    saveAccount(hub, email, { listed_to: undefined });
    a = account(hub, accountKey);
  }
  const from = a.listed_to ? new Date(Date.parse(a.listed_to) - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 86400_000);
  const ids: string[] = [];
  try {
    await withClient(loginOf(a), DEADLINES.list, async (c) => {
      for (const f of mailFolders(await c.list(), { allMail: isGmail(a) })) {
        const box = await openOrPass(c, f.path);
        if (!box) continue;
        const uids = (await c.search(searchQuery(from), { uid: true })) || [];
        // Oldest first, so the filer (which takes the newest queued first) reads recent mail before old.
        for (const uid of [...uids].sort((x, y) => x - y)) ids.push(messageId(box.uidValidity, uid, f.path));
      }
    });
  } catch (e) {
    const f = failure(e);
    if (f instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: refusedText(a), refused_at: nowIso() });
    else saveAccount(hub, email, { last_sync: nowIso(), last_error: f.message });
    throw f;
  }
  const insert = hub.db.prepare("INSERT OR IGNORE INTO mail (account, id, state) VALUES (?, ?, 'queued')");
  let queued = 0;
  hub.db.transaction(() => { for (const id of ids) queued += insert.run(accountKey, id).changes; }).immediate();
  saveAccount(hub, email, { listed_to: now.toISOString(), query: SEARCH_ID, last_sync: nowIso(), last_error: null, refused_at: null });
  return { listed: ids.length, queued };
}

/** The text parts of a message worth reading: text/plain and text/html, not attachments, at most PARTS_MAX. */
export function textParts(node: ImapPart | undefined): { part: string; html: boolean }[] {
  const out: { part: string; html: boolean }[] = [];
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= PARTS_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const type = n.type.toLowerCase();
    const named = n.dispositionParameters?.filename || n.parameters?.name;
    if ((type === "text/plain" || type === "text/html") && n.disposition?.toLowerCase() !== "attachment" && !named) {
      out.push({ part: n.part ?? "1", html: type === "text/html" });
    }
  };
  walk(node);
  return out;
}

async function readStream(s: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!s) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(b);
    size += b.length;
    if (size >= PART_MAX) break;
  }
  return Buffer.concat(chunks).subarray(0, PART_MAX).toString("utf8");
}

/** A message's text parts (BODY.PEEK, capped), split into plain and HTML in the order they came. */
async function downloadText(c: ImapClient, uid: string, msg: ImapMessage): Promise<{ plain: string[]; html: string[] }> {
  const plain: string[] = [];
  const html: string[] = [];
  for (const p of textParts(msg.bodyStructure)) {
    const d = await c.download(uid, p.part, { uid: true, maxBytes: PART_MAX });
    (p.html ? html : plain).push(await readStream(d?.content));
  }
  return { plain, html };
}

/** One queued message as text, or null when it is gone (its folder, its UIDVALIDITY or the message itself). */
export async function readICloud(hub: Hub, accountKey: string, id: string): Promise<FetchedMail | null> {
  const ref = parseId(id);
  if (!ref) return null;
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    let box: { uidValidity: bigint };
    try { box = await c.mailboxOpen(ref.folder, { readOnly: true }); }
    catch (e) {
      // The server said NO: the folder is gone or renamed. Anything else (a dropped connection) is not "gone".
      if ((e as { responseStatus?: string })?.responseStatus === "NO") return null;
      throw e;
    }
    if (String(box.uidValidity) !== ref.validity) return null;
    const msg = await c.fetchOne(ref.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    const { plain, html } = await downloadText(c, ref.uid, msg);
    const env = msg.envelope ?? {};
    const sender = env.from?.[0];
    const at = new Date(msg.internalDate ?? env.date ?? Date.now());
    return {
      at: Number.isNaN(at.getTime()) ? new Date() : at,
      from: sender ? (sender.name ? `${sender.name} <${sender.address ?? ""}>` : sender.address ?? "") : "",
      subject: env.subject ?? "",
      text: bodyText(plain, html),
      message_id: env.messageId,
    };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Mail screen (mail-inbox.ts): the Inbox folder's mail. Read-only as above: EXAMINE, BODY.PEEK (headers too).

/** At most this many kept messages have their thread headers read per refresh (mail kept before threads). */
const REFS_MAX = 500;
/** At most this many sent messages are looked at per refresh (their headers); the rest come on the next. */
export const SENT_SCAN_MAX = 500;
/** At most this many new messages are fetched per mailbox per refresh, newest first; the rest come on the next. */
export const INBOX_MAX = 300;
/** How far back the Mail screen looks for mail it does not have yet (the first refresh brings in this much). */
export const INBOX_DAYS = 90;
/** At most this much of a message's text is kept (a long newsletter is cut; Show original has the rest). */
export const TEXT_MAX = 100_000;
/**
 * Header lines fetched by name: whether a system sent the mail (a list, a notice, a newsletter), which the Mail screen
 * sorts by. The envelope has the rest (From, Reply-To, Subject, Message-ID).
 */
const INBOX_HEADERS = ["list-unsubscribe", "list-id", "auto-submitted", "precedence", "authentication-results", "bimi-location", "references", ...ESP_HEADERS()];
/** The Message-IDs a message answers: its References, then In-Reply-To (at most 50). */
const answers = (msg: ImapMessage) => [...new Set([...messageIds(headerValue(msg.headers, "references")), ...messageIds(msg.envelope?.inReplyTo)])].slice(-50);
/**
 * Headers only bulk-mail services add: Feedback-Id (which large senders must send), and the sending services' own
 * (Mailgun, SendGrid, Amazon SES, Mailchimp, Postmark, SparkPost). A function so INBOX_HEADERS can use it above.
 */
function ESP_HEADERS() { return ["feedback-id", "x-mailgun-sid", "x-sg-eid", "x-ses-outgoing", "x-mc-user", "x-pm-message-id", "x-msys-api"]; }
/** Sender addresses systems use: no-reply@, notifications@, shipment-tracking@ and the like. */
const SYSTEM_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|updates?|news(letter)?s?|info|marketing|mailer(-daemon)?|bounces?|account(s)?|support|billing|receipts?|orders?|shipment-tracking|auto-?confirm|digest)([._+-][^@]*)?@/i;

/**
 * Whether a system sent this mail rather than a person: it says it is a list or automatic (List-Unsubscribe, List-Id,
 * Auto-Submitted, Precedence bulk/list/junk), or it comes from a system's kind of address.
 */
export function isAutomated(headers: Buffer | undefined, fromAddress: string): boolean {
  if (headerValue(headers, "list-unsubscribe") || headerValue(headers, "list-id")) return true;
  const auto = headerValue(headers, "auto-submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|list|junk)\b/i.test(headerValue(headers, "precedence"))) return true;
  // Sent through a bulk-mail service (a shop's order notices, a newsletter).
  if (ESP_HEADERS().some((h) => headerValue(headers, h))) return true;
  return SYSTEM_SENDER.test(fromAddress);
}

/** The Inbox: the folder named INBOX (IMAP's own name for it, in any case), or none. */
export function inboxFolder(folders: ImapFolder[]): ImapFolder | null {
  return folders.find((f) => f.path.toUpperCase() === "INBOX" && !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent")) ?? null;
}

/** `<id@host>` tokens in a header (References, In-Reply-To), at most `max`, without their angle brackets. */
export function messageIds(v: string | undefined | null, max = 50): string[] {
  if (!v) return [];
  return [...v.slice(0, 64 * 1024).matchAll(/<([^<>\s]{1,250})>/g)].slice(0, max).map((m) => m[1]);
}

/** Every value of one header, in the order the server sent them (topmost first), folded lines unfolded. */
export function headerValues(raw: Buffer | undefined, name: string): string[] {
  if (!raw) return [];
  const text = raw.subarray(0, 64 * 1024).toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const want = `${name.toLowerCase()}:`;
  return text.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(want)).map((l) => l.slice(want.length).trim());
}

/**
 * A brand's verified logo, from iCloud's own verdict, or null. iCloud checks BIMI when mail arrives (the brand's DNS
 * record, its logo, and the mark certificate a certificate authority issues only to the owner of the trademark) and
 * writes the result at the top of the mail: `Authentication-Results: bimi.icloud.com; bimi=pass header.d=… policy.
 * authority=pass`, with `BIMI-Location: … l=<logo>`. A logo is a trust signal, so all of these must hold:
 * - iCloud's own BIMI verdict is the first `bimi.icloud.com` result (iCloud writes one on every mail, `none` or
 *   `skipped` included, above anything the sender wrote; a sender's forged one comes below it and is never read), and
 *   it says bimi=pass and policy.authority=pass (the certificate checked, not only a DNS record anyone can publish);
 * - iCloud's DMARC verdict (the From address is really that domain's) is pass for the From domain;
 * - the logo's domain is the From domain or a domain above it (mail.amazon.com under amazon.com);
 * - the logo is an https address.
 * Never a site's favicon: a lookalike domain can serve a bank's logo as its own.
 */
export function verifiedLogo(headers: Buffer | undefined, fromAddress: string): { domain: string; url: string } | null {
  const from = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
  if (!from || !fromAddress.includes("@")) return null;
  const results = headerValues(headers, "authentication-results");
  const bimi = results.find((v) => /^bimi\.icloud\.com\s*;/i.test(v));
  const dmarc = results.find((v) => /^dmarc\.icloud\.com\s*;/i.test(v));
  if (!bimi || !dmarc) return null;
  if (!/;\s*bimi=pass\b/i.test(bimi) || !/\bpolicy\.authority=pass\b/i.test(bimi)) return null;
  if (!/;\s*dmarc=pass\b/i.test(dmarc) || (/\bheader\.from=([^\s;]+)/i.exec(dmarc)?.[1] ?? "").toLowerCase() !== from) return null;
  const d = (/\bheader\.d=([^\s;]+)/i.exec(bimi)?.[1] ?? "").toLowerCase();
  if (!d || (from !== d && !from.endsWith(`.${d}`))) return null;
  const url = /(?:^|[;\s])l=(https:\/\/[^\s;]{1,2000})/i.exec(headerValue(headers, "bimi-location"))?.[1];
  if (!url) return null;
  try { if (new URL(url).protocol !== "https:") return null; } catch { return null; }
  return { domain: d, url };
}

/** One header's value from header lines as the server sent them (folded lines unfolded), or "". */
export function headerValue(raw: Buffer | undefined, name: string): string {
  if (!raw) return "";
  const text = raw.subarray(0, 64 * 1024).toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const want = `${name.toLowerCase()}:`;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(want));
  return line ? line.slice(want.length).trim() : "";
}

const mailAddress = (a: ImapAddress | undefined): MailAddress => ({ name: (a?.name ?? "").trim().slice(0, 200), address: (a?.address ?? "").trim().toLowerCase().slice(0, 254) });
const bareId = (v: string | undefined | null) => messageIds(v, 1)[0] ?? null;

/** What the Mail screen keeps of one fetched message. */
function inboxMail(id: string, msg: ImapMessage, text: string, shown: { html: string; remote: string[]; pictures?: number } | null = null, trustLogo = true): InboxMail {
  const env = msg.envelope ?? {};
  const from = mailAddress(env.from?.[0]);
  const replyTo = mailAddress(env.replyTo?.[0]).address;
  const at = new Date(msg.internalDate ?? env.date ?? Date.now());
  const listId = headerValue(msg.headers, "list-id").slice(0, 200);
  return {
    id,
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    message_id: bareId(env.messageId),
    from,
    // IMAP servers fill Reply-To with From when a mail has none, so only a different address is worth a warning.
    reply_to: replyTo && replyTo !== from.address ? replyTo : null,
    rcpt: [...new Set([...(env.to ?? []), ...(env.cc ?? [])].slice(0, 50).map((a) => mailAddress(a).address).filter(Boolean))],
    subject: (env.subject ?? "").slice(0, 500),
    text: text.slice(0, TEXT_MAX),
    automated: isAutomated(msg.headers, from.address),
    unsubscribe: !!headerValue(msg.headers, "list-unsubscribe"),
    list_id: listId || null,
    // HTML_MAX is for the markup: the pictures sent inside the mail, written into it, have their own limit.
    html: shown && shown.html.length - (shown.pictures ?? 0) <= HTML_MAX ? shown.html : null,
    remote: shown && shown.html.length - (shown.pictures ?? 0) <= HTML_MAX ? shown.remote : [],
    logo: trustLogo ? verifiedLogo(msg.headers, from.address) : null,
    refs: answers(msg),
    mine: false,
  };
}

/** At most this much cleaned HTML is kept per message (pictures not counted); a larger mail is shown as text. */
export const HTML_MAX = 1_000_000;
/** Pictures sent inside a mail: at most this many, each at most this big. */
const CID_MAX = 20;
const CID_BYTES = 2_000_000;

/** The pictures sent inside a message that its HTML shows (`cid:`), by Content-ID: image parts only, never attachments. */
export function cidParts(node: ImapPart | undefined, html: string): { part: string; cid: string }[] {
  const out: { part: string; cid: string }[] = [];
  // Once, not once per part: a message can have thousands of parts.
  const lower = html.toLowerCase();
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= CID_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const cid = (n.id ?? "").trim().replace(/^<|>$/g, "");
    if (!cid || !n.type.toLowerCase().startsWith("image/") || (n.size ?? 0) > CID_BYTES * 1.4) return;
    if (!lower.includes(`cid:${cid.toLowerCase()}`)) return;
    out.push({ part: n.part ?? "1", cid });
  };
  walk(node);
  return out;
}

async function readBytes(s: NodeJS.ReadableStream | undefined, max: number): Promise<Buffer | null> {
  if (!s) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** A message's HTML cleaned for the Mail screen, with the pictures sent inside it (BODY.PEEK, capped) written in. */
async function shownHtml(c: ImapClient, uid: string, msg: ImapMessage, html: string[]): Promise<{ html: string; remote: string[]; pictures: number } | null> {
  const raw = html.join("\n");
  if (!raw.trim()) return null;
  const cids = new Map<string, string>();
  for (const p of cidParts(msg.bodyStructure, raw)) {
    const d = await c.download(uid, p.part, { uid: true, maxBytes: CID_BYTES });
    const bytes = await readBytes(d?.content, CID_BYTES);
    const data = bytes && pictureData(bytes);
    if (data) cids.set(p.cid, data);
  }
  // Mail is hostile input: a mail whose HTML the cleaner fails on is shown as text, and the refresh goes on.
  try { return cleanMailHtml(raw, cids); } catch (e) { console.error(`[mail-inbox] a mail's HTML could not be cleaned, so it shows as text: ${errCode(e)}`); return null; }
}

/**
 * The Mail screen's refresh for one mailbox, in one connection, read-only:
 * - `present`: the id of every message in the Inbox now (UIDs only, cheap), so the hub can tell what left it; null
 *   when the mailbox has no Inbox (nothing can be said to have left it then);
 * - `mails`: the Inbox's messages since `since` that `known` does not have, newest first, at most INBOX_MAX (`more`
 *   when there are others);
 * - `moved`: such a message whose Message-ID `knownMessage` has (it came back to the Inbox, or the folder's ids were
 *   renumbered), without its text being fetched again.
 * A refused password pauses the mailbox exactly as for receipts; `owner` (the Refresh button) tries it once.
 */
export async function listInboxICloud(hub: Hub, accountKey: string, since: Date, known: (id: string) => boolean, knownMessage: (messageId: string) => boolean, opts: { owner?: boolean; needsRefs?: (id: string) => boolean; sentFrom?: string | null; doneIds?: string[] } = {}): Promise<InboxListing> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at && !opts.owner) throw new StoreError(409, refusedText(a));
  let present: string[] | null = null;
  let seen: string[] | null = null;
  let flagged: string[] | null = null;
  let doneFlags: { present: string[]; flagged: string[] } | null = null;
  const mails: InboxMail[] = [];
  const moved: { id: string; message_id: string }[] = [];
  const refs: { id: string; refs: string[] }[] = [];
  let more = false;
  let sentAt: string | undefined;
  try {
    await withClient(loginOf(a), DEADLINES.list, async (c) => {
      const folders = await c.list();
      const f = inboxFolder(folders);
      if (!f) return;
      const box = await c.mailboxOpen(f.path, { readOnly: true });
      const id = (uid: number) => messageId(box.uidValidity, uid, f.path);
      const all = (await c.search({ all: true }, { uid: true })) || [];
      present = all.map(id);
      // Read or unread, as the mailbox has it (read in Apple Mail counts): FETCH FLAGS, which reads and changes nothing.
      // Flagged in Apple Mail is pinned here (since 2026-11-21): the same FETCH FLAGS.
      const read = new Set<number>();
      const pins = new Set<number>();
      if (c.fetch) {
        if (all.length) for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
          if (m.flags?.has("\\Seen")) read.add(m.uid);
          if (m.flags?.has("\\Flagged")) pins.add(m.uid);
        }
        seen = all.filter((uid) => read.has(uid)).map(id);
        flagged = all.filter((uid) => pins.has(uid)).map(id);
      }
      const fresh = ((await c.search({ since }, { uid: true })) || []).filter((uid) => !known(id(uid)));
      for (const uid of [...fresh].sort((x, y) => y - x)) {
        if (mails.length >= INBOX_MAX) { more = true; break; }
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: INBOX_HEADERS }, { uid: true });
        if (!msg) continue;
        const mid = bareId(msg.envelope?.messageId);
        if (mid && knownMessage(mid)) { moved.push({ id: id(uid), message_id: mid }); continue; }
        const { plain, html } = await downloadText(c, String(uid), msg);
        // The same for its text: one mail the hub cannot read must not keep the rest of the Inbox from arriving.
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(id(uid), msg, text, await shownHtml(c, String(uid), msg, html), !isImapKey(accountKey));
        // Cards from the raw HTML: cleaning takes out the sender's schema.org data (a script) with every other script.
        m.cards = mailCards(html.join("\n"), m.subject, m.text, m.from, m.automated);
        m.attachments = attachmentParts(msg.bodyStructure);
        mails.push(m);
      }
      // Mail kept before threads: the Message-IDs it answers, headers only (at most REFS_MAX a refresh).
      for (const uid of all.filter((u) => known(id(u)) && opts.needsRefs?.(id(u))).slice(0, REFS_MAX)) {
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
        if (msg) refs.push({ id: id(uid), refs: answers(msg) });
      }
      // Done mail's flags (a pin there is the same flag): of the kept done messages only, by their numbers in the
      // archive folder, never the whole folder. FETCH FLAGS, which reads and changes nothing.
      const archive = archiveOf(folders);
      const doneHere = (opts.doneIds ?? []).map(parseId).filter((x): x is NonNullable<ReturnType<typeof parseId>> => !!x && x.folder === archive?.path);
      if (c.fetch && archive && doneHere.length) {
        const abox = await openOrPass(c, archive.path);
        const mine = abox ? doneHere.filter((x) => x.validity === String(abox.uidValidity)) : [];
        if (abox && mine.length) {
          const aid = (uid: number) => messageId(abox.uidValidity, uid, archive.path);
          const asked = new Set(mine.map((x) => Number(x.uid)));
          const there: number[] = [];
          const pinned: number[] = [];
          for await (const m of c.fetch([...asked].join(","), { uid: true, flags: true }, { uid: true })) {
            if (!asked.has(m.uid)) continue;
            there.push(m.uid);
            if (m.flags?.has("\\Flagged")) pinned.push(m.uid);
          }
          doneFlags = { present: there.map(aid), flagged: pinned.map(aid) };
        }
      }
      // The owner's replies: from the folder iCloud marks Sent, read-only like the Inbox, only those answering mail the
      // hub keeps or lists now. Each is read by its headers first; the text only of those that belong.
      // Each sent mail is looked at once, when it is new: `sentFrom` is how far the folder was read last time
      // (`<UIDVALIDITY>:<UID>`), and only mail after it is looked at, oldest first, SENT_SCAN_MAX a refresh. Looking at
      // every sent mail of the last 90 days on every refresh cost one request each, every 15 minutes, for good.
      // While Inbox mail is still waiting for the next refresh, Sent waits too: a reply looked at before the mail
      // it answers is kept would be passed over.
      const sent = folders.find((x) => x.specialUse === "\\Sent" && !x.flags.has("\\Noselect"));
      if (!sent || more) return;
      // A Sent folder the server will not open: the Inbox's listing stands, without the owner's replies this time.
      const sbox = await openOrPass(c, sent.path);
      if (!sbox) return;
      const sid = (uid: number) => messageId(sbox.uidValidity, uid, sent.path);
      const validity = String(sbox.uidValidity);
      const from = opts.sentFrom?.startsWith(`${validity}:`) ? Number(opts.sentFrom.slice(validity.length + 1)) || 0 : 0;
      const listed = new Set(mails.map((m) => m.message_id).filter((x): x is string => !!x));
      let mine = 0;
      let looked = 0;
      let at = from;
      for (const uid of ((await c.search({ since }, { uid: true })) || []).filter((u) => u > from && !known(sid(u))).sort((x, y) => x - y)) {
        if (looked >= SENT_SCAN_MAX || mine >= INBOX_MAX) { more = true; break; }
        looked++;
        at = uid;
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
        if (!msg) continue;
        const mid = bareId(msg.envelope?.messageId);
        const to = answers(msg);
        if ((mid && knownMessage(mid)) || !to.some((r) => listed.has(r) || knownMessage(r))) continue;
        const { plain, html } = await downloadText(c, String(uid), msg);
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a sent mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(sid(uid), msg, text, await shownHtml(c, String(uid), msg, html), !isImapKey(accountKey));
        m.mine = true;
        m.automated = false;
        // The owner's own reply quotes the mail it answers, web pictures and all. Fetching those again would tell
        // that mail's sender the owner answered (a second fetch, only after a reply): none is fetched for sent mail.
        m.remote = [];
        mails.push(m);
        mine++;
      }
      sentAt = `${validity}:${at}`;
    });
  } catch (e) {
    const f = failure(e);
    if (f instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw f;
  }
  if (a.refused_at) saveAccount(hub, email, { last_error: null, refused_at: null });
  return { present, seen, flagged, doneFlags, mails, moved, more, refs, ...(sentAt ? { sentAt } : {}) };
}

/** Show original: one message's whole text, fetched now and never kept; null when it is gone from the mailbox. */
export async function originalICloud(hub: Hub, accountKey: string, id: string): Promise<{ at: Date; from: MailAddress; reply_to: string | null; subject: string; text: string } | null> {
  const ref = parseId(id);
  if (!ref) return null;
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    let box: { uidValidity: bigint };
    try { box = await c.mailboxOpen(ref.folder, { readOnly: true }); }
    catch (e) { if ((e as { responseStatus?: string })?.responseStatus === "NO") return null; throw e; }
    if (String(box.uidValidity) !== ref.validity) return null;
    const msg = await c.fetchOne(ref.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    const { plain, html } = await downloadText(c, ref.uid, msg);
    const m = inboxMail(id, msg, readingText(plain, html), null, !isImapKey(accountKey));
    m.text = readingText(plain, html);
    return { at: m.at, from: m.from, reply_to: m.reply_to, subject: m.subject, text: m.text };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachments (since 2026-11-21): listed from the message's structure, read only when the owner opens or asks for one

/** One attachment as the Mail screen lists it: the part's number in the message, its name, its type, its size in bytes. */
export interface MailAttachment { part: string; name: string; type: string; size: number }
/**
 * At most this many listed; a download at most FILE_BYTES. A preview is the picture itself (the hub has nothing to
 * make a small copy with), so only a small picture gets one: at most PREVIEW_BYTES, PREVIEWS_MAX a mail, about 3 MB
 * in an answer at the most. A bigger picture shows as a file to download. (Whole pictures of up to 5 MB, ten a mail,
 * went to the device every time a mail was opened.)
 */
export const ATTACH_MAX = 30;
export const PREVIEW_BYTES = 400_000;
export const PREVIEWS_MAX = 6;
export const FILE_BYTES = 25_000_000;

/**
 * A name a server hands over still in its RFC 2231 form: Dovecot joins a long name's pieces (`filename*0*=`,
 * `filename*1*=`, as Apple Mail and Thunderbird write a name that is not ASCII) and sends them under the plain key with
 * their %XX left in and their charset taken off, so "山登り.pdf" came as "%E5%B1%B1%E7%99%BB%E3%82%8A.pdf". Decoded
 * when the %XX make UTF-8 text with a letter outside ASCII (a charset left in front, `utf-8''`, is read too); any other
 * name with a percent sign in it is a name, and stays as it is.
 */
export function decodedName(v: string): string {
  const m = /^(?:([A-Za-z0-9_.:-]+)'[A-Za-z-]*')?((?:[\x20-\x24\x26-\x7e]|%[0-9A-Fa-f]{2})+)$/.exec(v);
  if (!m || !/%[89A-Fa-f][0-9A-Fa-f]/.test(m[2])) return v;
  const charset = (m[1] ?? "utf-8").toLowerCase();
  const bytes: number[] = [];
  for (let i = 0; i < m[2].length; i++) {
    if (m[2][i] === "%") { bytes.push(parseInt(m[2].slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(m[2].charCodeAt(i));
  }
  try {
    if (charset === "utf-8" || charset === "utf8") return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    if (charset === "iso-8859-1" || charset === "latin1" || charset === "us-ascii") return Buffer.from(bytes).toString("latin1");
  } catch { /* not UTF-8: a name with percent signs */ }
  return v;
}

/** A file name as the screen may show it and a browser may save it: one line, no folder in it, at most 120 characters. */
export function attachmentName(v: string | undefined, part: string): string {
  const s = decodedName(v ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return wholeChars(s || `attachment-${part}`, 120);
}

/**
 * A message's attachments, from its structure alone (nothing downloaded): every part that is marked as an attachment
 * or has a file name, or is not text. Not among them:
 * - its text parts, and another form of the same mail (an unnamed part of a multipart/alternative: AMP, a calendar's
 *   text form);
 * - a picture the HTML shows from inside the mail: an image with a Content-ID inside a multipart/related, not marked
 *   as an attachment, of a kind and size the hub writes into the page (PNG, JPEG, GIF or WebP, at most CID_BYTES). An
 *   image with a Content-ID anywhere else is a file (Apple Mail gives every attached photo one), and so is one the
 *   hub cannot show: taken for a shown picture, each was neither shown nor listed. (One such picture the HTML never
 *   names stays unlisted: the structure alone does not say.)
 * A mail attached to this one is one attachment, whatever is inside it. The size is the part's own (base64 is a third
 * bigger than the file).
 */
export function attachmentParts(node: ImapPart | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];
  const add = (n: ImapPart, type: string, named: string | undefined) => {
    const part = n.part ?? "1";
    const size = Math.max(0, Math.round((n.size ?? 0) * ((n.encoding ?? "").toLowerCase() === "base64" ? 0.75 : 1)));
    out.push({ part, name: attachmentName(named, part), type: /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/.test(type) ? type : "application/octet-stream", size });
  };
  /** `related`: inside a multipart/related. `alternative`: one of the forms of a multipart/alternative. */
  const walk = (n: ImapPart | undefined, related: boolean, alternative: boolean) => {
    if (!n || out.length >= ATTACH_MAX) return;
    const type = (n.type ?? "").toLowerCase();
    const disposition = (n.disposition ?? "").toLowerCase();
    const named = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (type === "message/rfc822") { add(n, type, named ?? "attached mail.eml"); return; }
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c, related || type === "multipart/related", type === "multipart/alternative"); return; }
    const isText = type === "text/plain" || type === "text/html";
    if (disposition !== "attachment" && !named && (isText || alternative || type.startsWith("multipart/"))) return;
    // The mail's own picture only when the hub can write it into the page (shownHtml): a kind it shows, and not over
    // its size limit. Anything else beside the HTML (a 3.5 MB photo an iPhone sends inline, a HEIC) is listed, or it
    // would be neither shown nor listed.
    const shows = /^image\/(png|jpe?g|gif|webp)$/.test(type) && (n.size ?? 0) <= CID_BYTES * 1.4;
    if (disposition !== "attachment" && related && n.id && shows) return;
    add(n, type, named);
  };
  walk(node, false, false);
  return out;
}

/**
 * A kept message, opened read-only (EXAMINE) in its folder for reading its attachments: the folder must be one iCloud
 * lists (the Inbox, Archive or a shown folder), not reset since (UIDVALIDITY), and the message still the one the hub
 * kept (its Message-ID read again). Null when it is not.
 */
async function openKept(c: ImapClient, ref: MoveRef): Promise<{ uid: string; msg: ImapMessage } | null> {
  const at = parseId(ref.id);
  if (!at || !ref.message_id) return null;
  const folders = await c.list();
  const allowed = new Set([inboxFolder(folders)?.path, archiveOf(folders)?.path, ...shownFolders(folders).map((f) => f.path)].filter(Boolean));
  if (!allowed.has(at.folder)) return null;
  const box = await c.mailboxOpen(at.folder, { readOnly: true });
  if (String(box.uidValidity) !== at.validity) return null;
  const msg = await c.fetchOne(at.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
  if (!msg || bareId(msg.envelope?.messageId) !== ref.message_id) return null;
  return { uid: at.uid, msg };
}

/**
 * A kept message's attachments now, with a preview of each picture (JPEG, PNG, GIF or WebP, at most PREVIEW_BYTES,
 * PREVIEWS_MAX of them; its bytes must be a picture, whatever the mail calls it): read with BODY.PEEK, kept in memory
 * only. Null when the message is not there any more.
 */
export async function attachmentsICloud(hub: Hub, accountKey: string, ref: MoveRef): Promise<(MailAttachment & { preview?: string })[] | null> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const list: (MailAttachment & { preview?: string })[] = attachmentParts(kept.msg.bodyStructure);
    let previews = 0;
    for (const x of list) {
      if (previews >= PREVIEWS_MAX || !/^image\/(jpeg|png|gif|webp)$/.test(x.type) || x.size > PREVIEW_BYTES) continue;
      const d = await c.download(kept.uid, x.part, { uid: true, maxBytes: PREVIEW_BYTES });
      const bytes = await readBytes(d?.content, PREVIEW_BYTES);
      const data = bytes && pictureData(bytes);
      if (data) { x.preview = data; previews++; }
    }
    return list;
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

/**
 * A kept message's To, Cc and Bcc as the mailbox has them now (Reply all; a draft being edited, whose Bcc the owner
 * set in their mail app), the Message-IDs it answers (In-Reply-To first, then References: an edited reply draft stays
 * in its thread), and its attachments by their structure (`files`: nothing downloaded; an edited draft and a forward
 * carry them on); read-only and checked again; null when it is gone.
 */
export async function recipientsICloud(hub: Hub, accountKey: string, ref: MoveRef): Promise<{ to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; answers: string[]; in_reply_to: string | null; files: MailAttachment[] } | null> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const env = kept.msg.envelope ?? {};
    const withRefs = await c.fetchOne(kept.uid, { envelope: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
    return { to: (env.to ?? []).slice(0, 50).map(mailAddress), cc: (env.cc ?? []).slice(0, 50).map(mailAddress), bcc: (env.bcc ?? []).slice(0, 50).map(mailAddress), answers: withRefs ? answers(withRefs) : [], in_reply_to: bareId(env.inReplyTo), files: attachmentParts(kept.msg.bodyStructure) };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

/** A kept message's List-Unsubscribe and List-Unsubscribe-Post headers now (read-only, checked again); null when it is gone. */
export async function unsubscribeHeadersICloud(hub: Hub, accountKey: string, ref: MoveRef): Promise<{ header: string; post: string } | null> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const m = await c.fetchOne(kept.uid, { envelope: true, bodyStructure: true, internalDate: true, headers: ["list-unsubscribe", "list-unsubscribe-post"] }, { uid: true });
    return m ? { header: headerValue(m.headers, "list-unsubscribe"), post: headerValue(m.headers, "list-unsubscribe-post") } : null;
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

/**
 * One attachment's bytes, for a download the owner asked for: only a part the message's own structure lists as an
 * attachment, at most FILE_BYTES, read with BODY.PEEK, never kept. Null when the message or the part is not there.
 */
export async function attachmentICloud(hub: Hub, accountKey: string, ref: MoveRef, part: string): Promise<{ name: string; bytes: Buffer } | null> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const x = attachmentParts(kept.msg.bodyStructure).find((y) => y.part === part);
    if (!x) return null;
    if (x.size > FILE_BYTES) throw new StoreError(413, "This attachment is too big to download here (more than 25 MB). Open the mail in your mail app for it.");
    const d = await c.download(kept.uid, x.part, { uid: true, maxBytes: FILE_BYTES });
    const bytes = await readBytes(d?.content, FILE_BYTES);
    if (!bytes) throw new StoreError(413, "This attachment is too big to download here (more than 25 MB). Open the mail in your mail app for it.");
    return { name: x.name, bytes };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Mail screen's other folders (since 2026-11-20): Drafts, Sent, Junk, Trash and the owner's own, read-only

/** A folder's part on the Mail screen, by the mark iCloud gives it (in any language); `own` for the owner's folders. */
export type FolderRole = "drafts" | "sent" | "junk" | "trash" | "own";
const ROLES: Record<string, FolderRole> = { "\\Drafts": "drafts", "\\Sent": "sent", "\\Junk": "junk", "\\Trash": "trash" };
/** At most this many folders, and this many new messages of one folder a refresh. */
export const FOLDERS_MAX = 30;
export const FOLDER_NEW_MAX = 50;
/** At most this many messages kept of one folder: the newest, by their number in the folder. */
export const FOLDER_KEEP = 500;
/** One folder of one refresh: what is in it since the time asked, what of that is read, and its new mail. */
export interface FolderListing {
  path: string; role: FolderRole; present: string[]; seen: string[]; mails: (InboxMail & { to: MailAddress[] })[]; more: boolean;
  /** The folder's own name (the last part of its path, by the server's own mark between parts). */
  name?: string;
  /** Not read this time (it could not be opened, or the refresh ran out of time before it): what is kept of it stays as it is. */
  skipped?: boolean;
}

/**
 * The folder Done moves mail to: the one marked `\Archive` (iCloud and most servers), else Gmail's All Mail (`\All`:
 * moving out of the Inbox there takes the Inbox label off, as Gmail's own Archive does), else a folder named Archive.
 */
export function archiveOf(folders: ImapFolder[]): ImapFolder | null {
  const open = folders.filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
  return open.find((f) => f.specialUse === "\\Archive") ?? open.find((f) => f.specialUse === "\\All") ?? open.find((f) => /^(INBOX[./])?archive$/i.test(f.path)) ?? null;
}

/** The folders the Mail screen shows besides the Inbox: not the Inbox, not Archive (Done shows it), not iCloud's virtual ones. */
export function shownFolders(folders: ImapFolder[]): { path: string; role: FolderRole; name: string }[] {
  return folders
    .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent") && f.path.toUpperCase() !== "INBOX" && f.specialUse !== "\\Archive" && !isView(f) && f.path !== archiveOf(folders)?.path)
    .map((f) => ({ path: f.path, role: ROLES[f.specialUse ?? ""] ?? "own", name: (f.name?.trim() || (f.delimiter ? f.path.split(f.delimiter).pop() : "") || f.path).slice(0, 200) }))
    .slice(0, FOLDERS_MAX);
}

/**
 * The Mail screen's refresh of a mailbox's other folders, in one connection, read-only like the Inbox (EXAMINE,
 * BODY.PEEK: nothing marked read): each folder's messages since `since`, their read flags, and the new ones' text and
 * HTML (FOLDER_NEW_MAX a folder, newest first). Their web pictures are never fetched: Sent and Drafts are the owner's
 * own (fetching them again tells the people they wrote to), and Junk's would tell a spammer the address is read.
 */
export async function listFoldersICloud(hub: Hub, accountKey: string, since: Date, known: (id: string) => boolean): Promise<FolderListing[]> {
  const email = accountKey;
  const a = account(hub, accountKey);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  const out: FolderListing[] = [];
  const started = Date.now();
  // Well before the connection's own time limit, which would end the listing with nothing to show for it: the folders
  // not reached by then are named as not read, and the next refresh goes on with them.
  const late = () => Date.now() - started > DEADLINES.list * 0.7;
  const pass = (f: { path: string; role: FolderRole; name: string }) => out.push({ path: f.path, role: f.role, name: f.name, present: [], seen: [], mails: [], more: true, skipped: true });
  const listed: { all: ReturnType<typeof shownFolders> | null } = { all: null };
  await withClient(loginOf(a), DEADLINES.list, async (c) => {
    listed.all = shownFolders(await c.list());
    for (const f of listed.all) {
      if (late()) { pass(f); continue; }
      const box = await openOrPass(c, f.path);
      if (!box) { pass(f); continue; }
      const id = (uid: number) => messageId(box.uidValidity, uid, f.path);
      // The newest FOLDER_KEEP of the folder's messages since `since`, by their number in the folder: the hub keeps no
      // more of a folder (keepFolders lets go of what is not listed), so this listing and what is kept are always the
      // same messages. Before, the listing named every message and the hub kept the 500 newest by date: what it let go
      // counted as new again at the next refresh, and a folder with more downloaded 50 mails again every 15 minutes.
      const uids = [...((await c.search({ since }, { uid: true })) || [])].sort((x, y) => y - x).slice(0, FOLDER_KEEP);
      const here = new Set(uids);
      const read: number[] = [];
      // Read flags of the listed messages only: from the lowest of them on, not the whole folder.
      if (c.fetch && uids.length) for await (const m of c.fetch(`${uids[uids.length - 1]}:*`, { uid: true, flags: true }, { uid: true })) if (here.has(m.uid) && m.flags?.has("\\Seen")) read.push(m.uid);
      const fresh = uids.filter((u) => !known(id(u)));
      const mails: FolderListing["mails"] = [];
      let cut = false;
      for (const uid of fresh.slice(0, FOLDER_NEW_MAX)) {
        if (late()) { cut = true; break; }
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: INBOX_HEADERS }, { uid: true });
        if (!msg) continue;
        const { plain, html } = await downloadText(c, String(uid), msg);
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(id(uid), msg, text, await shownHtml(c, String(uid), msg, html), !isImapKey(accountKey));
        m.remote = [];
        mails.push({ ...m, attachments: attachmentParts(msg.bodyStructure), to: (msg.envelope?.to ?? []).slice(0, 20).map(mailAddress).filter((x) => x.address) });
      }
      out.push({ path: f.path, role: f.role, name: f.name, present: uids.map(id), seen: read.map(id), mails, more: cut || fresh.length > FOLDER_NEW_MAX });
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    // The connection's own time limit ended the listing in the middle of a folder (one mail took longer than the
    // margin above): the folders read before it stand, and the others are named as not read, so nothing kept of them
    // is taken for gone.
    if (e instanceof MailDeadline && listed.all) {
      for (const f of listed.all) if (!out.some((l) => l.path === f.path)) pass(f);
      console.error("[mail-inbox] a folders listing ran out of time: what it had read is kept, the rest is read next time");
      return;
    }
    throw e;
  });
  return out;
}

/**
 * Where Delete, Spam, Not spam and Move to may put mail: the Inbox, Trash, Junk, or one of the owner's own folders (its
 * path, as the hub kept it). Never Drafts, Sent or Archive (Done moves there), and never a path a request made up: the
 * folder must be one iCloud lists now.
 */
export type MoveDest = { role: "inbox" | "trash" | "junk" } | { path: string };

/**
 * Move kept messages (from the Inbox, Archive or any shown folder) to `dest`, in one connection: the same fence as
 * moveICloud. Only folders iCloud lists now take part; each message's folder must not have been reset (UIDVALIDITY) and
 * its Message-ID is read again (BODY.PEEK) and compared; only MOVE, never a copy, a delete flag or an expunge. The answer
 * has each message's new id, or null when it was not moved.
 */
export async function moveToICloud(hub: Hub, accountKey: string, refs: MoveRef[], dest: MoveDest): Promise<Map<string, string | null>> {
  const email = accountKey;
  const a = account(hub, accountKey);
  refuseIfReadOnly(a);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  const out = new Map<string, string | null>(refs.map((r) => [r.id, null]));
  await withClient(loginOf(a), DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    if (typeof w.messageMove !== "function" || !w.capabilities?.has("MOVE")) throw new StoreError(502, `${providerName(a)} did not offer to move mail (IMAP MOVE), so nothing was moved.`);
    const folders = await c.list();
    const inbox = inboxFolder(folders);
    const archive = archiveOf(folders);
    const shown = shownFolders(folders);
    const to = "path" in dest
      ? shown.find((f) => f.path === dest.path && f.role === "own")?.path
      : dest.role === "inbox" ? inbox?.path : shown.find((f) => f.role === dest.role)?.path;
    if (!to) throw new StoreError(409, "That folder is not in this mailbox any more (it was renamed or deleted). Refresh and try again.");
    const sources = new Set([inbox?.path, archive?.path, ...shown.map((f) => f.path)].filter((p): p is string => !!p && p !== to));
    const mine = refs.map((r) => ({ r, ref: parseId(r.id) })).filter((x) => !!x.ref && sources.has(x.ref.folder) && !!x.r.message_id);
    for (const folder of new Set(mine.map((x) => x.ref!.folder))) {
      const box = await w.mailboxOpen(folder, { readOnly: false });
      for (const { r, ref } of mine.filter((x) => x.ref!.folder === folder)) {
        if (String(box.uidValidity) !== ref!.validity) continue;
        const msg = await c.fetchOne(ref!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
        if (!msg || bareId(msg.envelope?.messageId) !== r.message_id) continue;
        const moved = await w.messageMove(ref!.uid, to, { uid: true });
        if (!moved) continue;
        const uid = moved.uidMap?.get(Number(ref!.uid));
        out.set(r.id, uid && moved.uidValidity !== undefined ? messageId(moved.uidValidity, uid, to) : `moved:${r.id}`);
      }
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Done (Inbox to Archive) and its Undo (Archive to Inbox): the first of the Mail screen's writes


/**
 * Move kept messages between the Inbox and the Archive folder, in one connection. The fence around this write (the
 * other writes, each in a function of its own, keep the same one):
 * 1. only the Inbox (IMAP's INBOX) and the folder iCloud marks `\Archive` take part: Done moves from the first to the
 *    second, Undo back; a message whose id names another folder is not touched;
 * 2. the folder must not have been reset since (its UIDVALIDITY is the id's);
 * 3. the message at that UID must still be the one the hub kept: its Message-ID is read again (BODY.PEEK) and compared,
 *    and a message without one is not moved;
 * 4. only MOVE, and only when the server offers it: without it a client copies, marks deleted and expunges, which the
 *    hub never does.
 * The answer has each message's new id (in the destination), or null when it was not moved.
 */
export async function moveICloud(hub: Hub, accountKey: string, refs: MoveRef[], to: "archive" | "inbox"): Promise<Map<string, string | null>> {
  const email = accountKey;
  const a = account(hub, accountKey);
  refuseIfReadOnly(a);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  const out = new Map<string, string | null>(refs.map((r) => [r.id, null]));
  await withClient(loginOf(a), DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    if (typeof w.messageMove !== "function" || !w.capabilities?.has("MOVE")) throw new StoreError(502, `${providerName(a)} did not offer to move mail (IMAP MOVE), so nothing was moved.`);
    const folders = await c.list();
    const inbox = inboxFolder(folders);
    const archive = archiveOf(folders);
    if (!inbox || !archive) throw new StoreError(409, "This mailbox has no Archive folder, so Done cannot move mail there.");
    const [from, dest] = to === "archive" ? [inbox, archive] : [archive, inbox];
    const mine = refs.map((r) => ({ r, ref: parseId(r.id) })).filter((x) => x.ref?.folder === from.path && !!x.r.message_id);
    if (!mine.length) return;
    const box = await w.mailboxOpen(from.path, { readOnly: false });
    for (const { r, ref } of mine) {
      if (String(box.uidValidity) !== ref!.validity) continue;
      const msg = await c.fetchOne(ref!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
      if (!msg || bareId(msg.envelope?.messageId) !== r.message_id) continue;
      const moved = await w.messageMove(ref!.uid, dest.path, { uid: true });
      if (!moved) continue;
      const uid = moved.uidMap?.get(Number(ref!.uid));
      out.set(r.id, uid && moved.uidValidity !== undefined ? messageId(moved.uidValidity, uid, dest.path) : `moved:${r.id}`);
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
  return out;
}

/**
 * Mark a kept message read or unread in the mailbox (opening it on the Mail screen, or Mark unread). The fence around
 * this write: only a message in the Inbox or the `\Archive` folder, the folder not reset since (its
 * UIDVALIDITY), the message still the one the hub kept (its Message-ID read again), and only the `\Seen` flag, added or
 * removed. False when it was not changed.
 */
export async function setSeenICloud(hub: Hub, accountKey: string, refs: MoveRef[], seen: boolean): Promise<boolean[]> {
  return setFlagICloud(hub, accountKey, refs, "\\Seen", seen);
}

/**
 * Pin or unpin as Apple Mail's flag (since 2026-11-21): `\Flagged` added or removed, fenced exactly as the read flag
 * (setFlagICloud): only a kept message in the Inbox or Archive, its UIDVALIDITY and Message-ID checked again.
 */
export async function setFlaggedICloud(hub: Hub, accountKey: string, refs: MoveRef[], flagged: boolean): Promise<boolean[]> {
  return setFlagICloud(hub, accountKey, refs, "\\Flagged", flagged);
}

/** Add or remove one flag, `\Seen` or `\Flagged` and no other, on kept messages in the Inbox or Archive (setSeenICloud's fence). */
async function setFlagICloud(hub: Hub, accountKey: string, refs: MoveRef[], flag: "\\Seen" | "\\Flagged", on: boolean): Promise<boolean[]> {
  const out = refs.map(() => false);
  const todo = refs.map((ref, i) => ({ i, ref, at: parseId(ref.id) })).filter((x) => x.at && x.ref.message_id);
  if (!todo.length) return out;
  const email = accountKey;
  const a = account(hub, accountKey);
  refuseIfReadOnly(a);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  // One sign-in for all of them (opening a thread of 25 unread mails used to make 25), a folder at a time.
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    const folders = await c.list();
    const allowed = [inboxFolder(folders)?.path, archiveOf(folders)?.path].filter(Boolean);
    for (const folder of [...new Set(todo.map((x) => x.at!.folder))]) {
      if (!allowed.includes(folder)) continue;
      const box = await w.mailboxOpen(folder, { readOnly: false });
      for (const x of todo.filter((y) => y.at!.folder === folder)) {
        if (String(box.uidValidity) !== x.at!.validity) continue;
        const msg = await c.fetchOne(x.at!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
        if (!msg || bareId(msg.envelope?.messageId) !== x.ref.message_id) continue;
        out[x.i] = await (on ? w.messageFlagsAdd(x.at!.uid, [flag], { uid: true }) : w.messageFlagsRemove(x.at!.uid, [flag], { uid: true }));
      }
    }
    return out;
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

/**
 * What saveDraftICloud may ask of a server, and only it: APPEND one message to a folder, flagged `\Draft` and `\Seen`
 * (a draft is the owner's own, not new mail). The type takes no other flag, and nothing here opens, changes or deletes
 * a message that is there.
 */
export interface ImapDrafter {
  append(path: string, content: Buffer, flags: ["\\Draft", "\\Seen"]): Promise<{ uid?: number; uidValidity?: bigint } | false>;
}
/** A draft is at most this big: 50,000 characters of text and 15 MB of files, which base64 makes 20 MB (iCloud's limit). */
export const DRAFT_BYTES = 22_000_000;

/**
 * Save a draft (mail-compose.ts built it) to the folder the server marks `\Drafts`: the only one of the Mail screen's
 * writes that adds a message. Only that folder, only APPEND; the owner sends it from their mail app, and nothing here
 * sends mail. Answers the folder, and where the draft is in it (`id`, as the hub knows a folder's mail) when the server
 * says so (APPENDUID, which iCloud and Gmail give), so the hub can list it under Drafts at once.
 */
export async function saveDraftICloud(hub: Hub, accountKey: string, raw: Buffer): Promise<{ id: string | null; folder: string }> {
  if (raw.length > DRAFT_BYTES) throw new StoreError(413, "the draft is too big to save");
  const email = accountKey;
  const a = account(hub, accountKey);
  refuseIfReadOnly(a);
  if (a.refused_at) throw new StoreError(409, refusedText(a));
  return withClient(loginOf(a), DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapDrafter;
    if (typeof w.append !== "function") throw new StoreError(502, `${providerName(a)} did not offer to save a draft, so nothing was saved.`);
    const drafts = (await c.list()).find((f) => f.specialUse === "\\Drafts" && !f.flags.has("\\Noselect"));
    if (!drafts) throw new StoreError(409, "This mailbox has no Drafts folder, so the draft was not saved.");
    const put = await w.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
    if (!put) throw new StoreError(502, `${providerName(a)} did not take the draft.`);
    return { id: put.uid && put.uidValidity !== undefined ? messageId(put.uidValidity, put.uid, drafts.path) : null, folder: drafts.path };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: refusedText(a), refused_at: nowIso() });
    throw e;
  });
}

/** Opens the message in Apple Mail (Mac, iPhone, iPad) by its Message-ID; iCloud Mail on the web when it has none. */
export function icloudLink(ref: MailRef): string {
  const mid = ref.message_id?.trim().replace(/^<|>$/g, "");
  return mid ? `message://${encodeURIComponent(`<${mid}>`)}` : WEB_LINK;
}

/** iCloud Mail as a mail source. */
export const icloudSource: MailSource = {
  kind: "icloud",
  accounts: (hub) => (hub.connections.get().icloud ?? []).filter((a) => a.mail !== false).map((a) => accountName(a.email)),
  list: (hub, accountKey, opts) => listICloud(hub, accountKey, new Date(), opts),
  read: (hub, accountKey, id) => readICloud(hub, accountKey, id),
  link: icloudLink,
  isOwnLink: (url) => url.startsWith("message://") || url === WEB_LINK,
};

/** The Mail screen's iCloud source (imports/inbox-source.ts): its Inbox listing, its move (Inbox to Archive and back) and read or unread. */
export const icloudInbox: InboxSource = {
  prefix: PREFIX,
  accounts: (hub) => (hub.connections.get().icloud ?? []).filter(inboxOn).map((a) => accountName(a.email)),
  list: (hub, account, since, known, knownMessage, opts) => listInboxICloud(hub, account, since, known, knownMessage, opts),
  move: (hub, account, refs, to) => moveICloud(hub, account, refs, to),
  setSeen: (hub, account, refs, seen) => setSeenICloud(hub, account, refs, seen),
  setFlagged: (hub, account, refs, flagged) => setFlaggedICloud(hub, account, refs, flagged),
  saveDraft: (hub, account, raw) => saveDraftICloud(hub, account, raw),
  listFolders: (hub, account, since, known) => listFoldersICloud(hub, account, since, known),
  moveTo: (hub, account, refs, dest) => moveToICloud(hub, account, refs, dest),
  attachments: (hub, account, ref) => attachmentsICloud(hub, account, ref),
  attachment: (hub, account, ref, part) => attachmentICloud(hub, account, ref, part),
  recipients: (hub, account, ref) => recipientsICloud(hub, account, ref),
  unsubscribeHeaders: (hub, account, ref) => unsubscribeHeadersICloud(hub, account, ref),
};

/** Other mail accounts as the Mail screen's source (since 2026-11-22): the same IMAP code, their own accounts. */
export const imapInbox: InboxSource = {
  ...icloudInbox,
  prefix: IMAP_PREFIX,
  accounts: (hub) => (hub.connections.get().imap ?? []).filter(inboxOn).map((a) => `${IMAP_PREFIX}${a.email}`),
};

/**
 * Other mail accounts as a Mail receipts source (since 2026-11-22): one app password serves the Mail screen and
 * receipts. An address also signed in with Google is read for receipts there only, so its mail is filed once.
 */
export const imapSource: MailSource = {
  kind: "imap",
  accounts: (hub) => {
    const c = hub.connections.get();
    return (c.imap ?? []).filter((a) => a.mail !== false && !c.google?.some((g) => g.email === a.email)).map((a) => `${IMAP_PREFIX}${a.email}`);
  },
  list: (hub, accountKey, opts) => listICloud(hub, accountKey, new Date(), opts),
  read: (hub, accountKey, id) => readICloud(hub, accountKey, id),
  // Gmail's own web search by Message-ID for a Gmail address; elsewhere the mail app's message link, as for iCloud.
  link: (ref) => {
    const email = ref.account.slice(IMAP_PREFIX.length);
    const mid = ref.message_id?.trim().replace(/^<|>$/g, "");
    if (mid && /@(gmail|googlemail)\.com$/.test(email)) return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#search/rfc822msgid%3A${encodeURIComponent(mid)}`;
    return icloudLink(ref);
  },
  isOwnLink: (url) => url.startsWith("message://") || url.startsWith("https://mail.google.com/"),
};

/**
 * An account's switches (Internet Accounts, since 2026-11-22): `receipts` (Mail receipts reads it), `inbox` (the Mail
 * screen shows it) and `read_only` (since 2026-11-24: the hub writes nothing to it), each only when given. The account
 * stays linked whatever is off; Remove unlinks it.
 */
export function setMailboxFeatures(hub: Hub, key: string, body: Record<string, unknown>): { receipts: boolean; inbox: boolean; read_only: boolean } {
  const a = account(hub, key);
  for (const k of ["receipts", "inbox", "read_only"] as const) if (body[k] !== undefined && typeof body[k] !== "boolean") throw new StoreError(422, `${k} is true or false`);
  const fields: Partial<ICloudAccount> = {};
  if (typeof body.receipts === "boolean") fields.mail = body.receipts;
  if (typeof body.read_only === "boolean") fields.read_only = body.read_only;
  // The Mail screen's switch is kept on its own once set, so turning receipts off leaves Mail as it was.
  if (typeof body.inbox === "boolean") fields.inbox = body.inbox;
  else if (typeof body.receipts === "boolean" && a.inbox === undefined) fields.inbox = inboxOn(a);
  saveAccount(hub, key, fields);
  const now = account(hub, key);
  return { receipts: now.mail !== false, inbox: inboxOn(now), read_only: now.read_only === true };
}
