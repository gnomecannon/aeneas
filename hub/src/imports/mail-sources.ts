import type { Hub } from "../hub.js";
import { gmailSource } from "./gmail.js";
import { icloudSource, imapSource } from "./icloud.js";

/**
 * Where mail comes from. The mail filer (mail-filer.ts) reads mail only through a MailSource, so it does not know or
 * care whether a mailbox is Gmail or iCloud. Each source lists likely mail into the hub's `mail` table and reads one
 * message at a time, as plain text, when the filer gets to it. The mail itself is never stored.
 *
 * A mailbox's `account` in the `mail` table says which source it belongs to: Gmail's are bare addresses (as before
 * there were sources, so no row changes), every other source's start with its kind (`icloud:you@icloud.com`).
 */

/** One message, read and turned into plain text, ready for the model. */
export interface FetchedMail {
  /** When the message arrived. */
  at: Date;
  /** The From header as written ("Apple <no_reply@email.apple.com>"). */
  from: string;
  subject: string;
  /** The body as plain text: the text part, or the HTML part with its markup taken out. */
  text: string;
  /** The Message-ID header, for sources whose link needs it (iCloud). */
  message_id?: string;
}

/** What a source needs to make a message's link. */
export interface MailRef {
  account: string;
  id: string;
  message_id?: string;
}

/** One kind of mailbox: Gmail, iCloud. */
export interface MailSource {
  kind: "gmail" | "icloud" | "imap";
  /** The linked mailboxes, as the `mail` table names them. */
  accounts(hub: Hub): string[];
  /**
   * List the mailbox's likely mail since it was last listed and queue what is new for the filer. `owner`: the owner
   * asked (Read now), so a mailbox that stopped signing in after a refused password tries once more.
   */
  list(hub: Hub, account: string, opts?: { owner?: boolean }): Promise<{ listed: number; queued: number }>;
  /** One queued message, or null when it is gone from the mailbox. Reading never marks it as read. */
  read(hub: Hub, account: string, id: string): Promise<FetchedMail | null>;
  /** An address that opens the message in its own mail app, kept on what the mail filed (a renewal's `url`). */
  link(ref: MailRef): string;
  /** True when `url` is a link this source makes, so the filer knows a renewal came from mail and not by hand. */
  isOwnLink(url: string): boolean;
}

/** Every mail source the hub knows, in the order Settings lists them. A new source is added here. */
export const MAIL_SOURCES: MailSource[] = [gmailSource, icloudSource, imapSource];

/** The source an account name belongs to, from its prefix; a bare address is Gmail's. Null for an unknown prefix. */
export function sourceOf(account: string): MailSource | null {
  const kind = /^([a-z]+):/.exec(account)?.[1];
  if (!kind) return gmailSource;
  return MAIL_SOURCES.find((s) => s.kind === kind) ?? null;
}

/** Every linked mailbox, source by source, as the `mail` table names them. */
export function mailAccounts(hub: Hub): { source: MailSource; account: string }[] {
  return MAIL_SOURCES.flatMap((source) => source.accounts(hub).map((account) => ({ source, account })));
}

/** Whether a mailbox is still linked. */
export function isLinked(hub: Hub, account: string): boolean {
  return sourceOf(account)?.accounts(hub).includes(account) ?? false;
}

/** True when `url` is a link some mail source made, so the thing that holds it was filed from mail. */
export function isMailLink(url: string): boolean {
  return MAIL_SOURCES.some((s) => s.isOwnLink(url));
}
