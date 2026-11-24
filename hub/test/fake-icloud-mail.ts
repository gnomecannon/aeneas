import { Readable } from "node:stream";
import type { TestHub } from "./helpers.js";
import { setImapFactory, type ImapClient, type ImapFolder, type ImapLogin } from "../src/imports/icloud.js";

// A fake iCloud for the Mail screen's tests (icloud-inbox, mail-inbox, mail-routes). Not a test file itself.
export const PASSWORD = "abcd-efgh-ijkl-mnop";
/** What Gmail takes: the 16 letters of an app password as Google gives them, without Apple's hyphens. */
export const GMAIL_PASSWORD = "abcdefghijklmnop";
export const EMAIL = "robin@icloud.example";
export const ACCOUNT = `icloud:${EMAIL}`;

export interface Msg {
  uid: number;
  folder: string;
  at: Date;
  subject: string;
  from: { name?: string; address: string };
  replyTo?: { address: string };
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** To and Cc; To is the owner unless set. */
  to?: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  /** Bcc, as a draft written in a mail app keeps it. */
  bcc?: { name?: string; address: string }[];
  plain?: string;
  html?: string;
  /** Raw header lines (List-Unsubscribe and the like), as the server sends them. */
  headers?: string;
  /** Read (the \Seen flag). */
  seen?: boolean;
  /** Flagged (Apple Mail's flag; a pin on the Mail screen). */
  flagged?: boolean;
  /** Gmail's own id of the message, as the Gmail API writes it (hex); a `gmail` server gives it in decimal (X-GM-MSGID). */
  gmailId?: string;
  /**
   * Attachments (only with `plain`): parts 2, 3, … after the text. `inlineId` makes one a picture shown inside the mail
   * (with a Content-ID, beside the text in a multipart/related, as mail apps build it); `photoId` gives an attached
   * photo a Content-ID where it stands, among the attachments, as Apple Mail does.
   */
  files?: { name: string; type: string; bytes: Buffer; inlineId?: string; photoId?: string }[];
}

export const FOLDERS: ImapFolder[] = [
  { path: "INBOX", flags: new Set() },
  { path: "Archive", specialUse: "\\Archive", flags: new Set() },
  { path: "Junk", specialUse: "\\Junk", flags: new Set() },
  { path: "Deleted Messages", specialUse: "\\Trash", flags: new Set() },
  { path: "Drafts", specialUse: "\\Drafts", flags: new Set() },
  { path: "Sent Messages", specialUse: "\\Sent", flags: new Set() },
  { path: "[Group]", flags: new Set(["\\Noselect"]) },
];

/** A fake iCloud for the Mail screen: folders, messages, and a record of every call and query. */
/**
 * A file's name from its part's headers, as a mail app reads it (RFC 2231): `filename*=`, or its numbered pieces
 * (`filename*0*=`, `filename*1*=`) put together in order, else plain `filename="…"`.
 */
export function partName(headers: string): string {
  const h = headers.replace(/\r\n(?=[ \t])/g, "");
  const pieces = [...h.matchAll(/filename\*(?:(\d+)\*)?=([^;\r\n]+)/g)].sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0)).map((m) => m[2].trim());
  if (pieces.length) return decodeURIComponent(pieces.join("").replace(/^UTF-8''/, ""));
  return /filename="([^"]*)"/.exec(h)?.[1] ?? "file";
}

/** A draft as the hub writes it (mail-compose.ts buildMessage), read back into what the fake keeps of a message. */
function parsedDraft(raw: string): Pick<Msg, "subject" | "from" | "to" | "cc" | "bcc" | "messageId" | "inReplyTo" | "references" | "plain" | "files"> {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const lines = head.replace(/\r\n(?=[ \t])/g, "");
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(lines)?.[1] ?? "";
  const words = (v: string) => (/=\?UTF-8\?B\?/.test(v) ? v.split(" ").map((w) => Buffer.from(/=\?UTF-8\?B\?([^?]*)\?=/.exec(w)?.[1] ?? "", "base64").toString("utf8")).join("") : v);
  const people = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ address: /<([^>]+)>/.exec(x)?.[1] ?? x }));
  const id = (v: string) => /<([^>]+)>/.exec(v)?.[1];
  const boundary = /boundary="([^"]+)"/.exec(lines)?.[1];
  const decoded = (b: string) => Buffer.from(b.replace(/\r\n/g, ""), "base64");
  let plain = "";
  const files: NonNullable<Msg["files"]> = [];
  if (!boundary) plain = decoded(body).toString("utf8");
  else body.split(`--${boundary}`).slice(1, -1).forEach((p, i) => {
    const [h, ...b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    if (i === 0) plain = decoded(b.join("\r\n\r\n")).toString("utf8");
    else files.push({ name: partName(h), type: /^Content-Type: ([^;\r\n]+)/m.exec(h)?.[1] ?? "application/octet-stream", bytes: decoded(b.join("\r\n\r\n")) });
  });
  return {
    subject: words(header("Subject")), from: people(header("From"))[0] ?? { address: EMAIL }, to: people(header("To")), cc: people(header("Cc")), bcc: people(header("Bcc")),
    messageId: id(header("Message-ID")), inReplyTo: id(header("In-Reply-To")), ...(header("References") ? { references: header("References") } : {}),
    plain: plain.replace(/\r\n/g, "\n"), ...(files.length ? { files } : {}),
  };
}

/** Whether a UID is in a FETCH range as the hub writes them: `5`, `3:9`, `7:*`, or several with commas. */
const inRange = (range: string, uid: number, highest: number) => range.split(",").some((part) => {
  const [a, b = a] = part.split(":");
  const from = a === "*" ? highest : Number(a), to = b === "*" ? Math.max(highest, from) : Number(b);
  return uid >= Math.min(from, to) && uid <= Math.max(from, to);
});

/** Gmail's id of a message as its IMAP server gives it: the Gmail API's hex id, in decimal. */
const decimalId = (hex: string) => BigInt(`0x${hex}`).toString();

/**
 * `closed`: folders the server lists and will not open (it answers NO). `gmail`: the server names each message by
 * Gmail's own id (X-GM-EXT-1), gives it with every FETCH and searches by it. `days`: SINCE is read as a day, as an IMAP
 * server reads it: every message from that day's start (in UTC here), not from the moment asked.
 */
export function fake(messages: Msg[], opts: { password?: string; noMove?: boolean; noAppendUid?: boolean; closed?: string[]; gmail?: boolean; days?: boolean } = {}) {
  const seen = { connects: 0, logouts: 0, calls: [] as string[], opened: [] as { path: string; readOnly: unknown }[], fetches: [] as unknown[], searches: [] as Record<string, unknown>[], moves: [] as { from: string; uid: number; to: string }[], flags: [] as { uid: number; flags: string[]; add: boolean }[], appends: [] as { path: string; raw: string; flags: string[] }[], downloads: [] as string[], ranges: [] as { folder: string | null; range: string }[] };
  const logins: ImapLogin[] = [];
  const factory = (login: ImapLogin): ImapClient => {
    logins.push(login);
    let open: string | null = null;
    const find = (uid: string) => messages.find((m) => m.folder === open && String(m.uid) === uid);
    const c: ImapClient = {
      async connect() {
        seen.calls.push("connect"); seen.connects++;
        // Each server takes its own form of app password: Gmail refuses one written with Apple's hyphens.
        const takes = opts.password ?? (login.servername === "imap.gmail.com" ? GMAIL_PASSWORD : PASSWORD);
        if (login.pass !== takes) throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
      },
      async logout() { seen.calls.push("logout"); seen.logouts++; },
      close() { seen.calls.push("close"); },
      async list() { seen.calls.push("list"); return FOLDERS; },
      async mailboxOpen(p, o) {
        seen.calls.push("mailboxOpen"); seen.opened.push({ path: p, readOnly: (o as { readOnly?: unknown }).readOnly });
        if (!FOLDERS.some((f) => f.path === p) || opts.closed?.includes(p)) throw Object.assign(new Error("no such folder"), { responseStatus: "NO" });
        open = p;
        return { uidValidity: 7n };
      },
      async search(q) {
        seen.calls.push("search"); seen.searches.push(q);
        if (typeof q.emailId === "string") return opts.gmail ? messages.filter((m) => m.folder === open && m.gmailId && decimalId(m.gmailId) === q.emailId).map((m) => m.uid) : [];
        const since = q.all ? new Date(0) : q.since as Date;
        const from = opts.days && !q.all ? new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())) : since;
        return messages.filter((m) => m.folder === open && m.at >= from).map((m) => m.uid);
      },
      async fetchOne(uid, query, o) {
        seen.calls.push("fetchOne"); seen.fetches.push({ query, o });
        const m = find(uid);
        if (!m) return false;
        const parts = [m.plain !== undefined ? { type: "text/plain" } : null, m.html !== undefined ? { type: "text/html" } : null].filter(Boolean) as { type: string }[];
        // With files: the text as part 1, each file a part after it, as a server lists a multipart/mixed message.
        const files = (m.files ?? []).map((f, i) => ({
          part: String(i + 2), type: f.type, size: Math.ceil(f.bytes.length / 3) * 4, encoding: "base64",
          ...(f.inlineId ? { id: `<${f.inlineId}>`, disposition: "inline" } : f.photoId ? { id: `<${f.photoId}>`, disposition: "inline", dispositionParameters: { filename: f.name } } : { disposition: "attachment", dispositionParameters: { filename: f.name } }),
        }));
        const shown = files.filter((_, i) => m.files![i].inlineId);
        const attached = files.filter((_, i) => !m.files![i].inlineId);
        const text = { ...parts[0], part: "1" };
        return {
          internalDate: m.at,
          envelope: { date: m.at, subject: m.subject, messageId: m.messageId && `<${m.messageId}>`, inReplyTo: m.inReplyTo && `<${m.inReplyTo}>`, from: [m.from], replyTo: [m.replyTo ?? m.from], to: m.to ?? [{ name: "Robin", address: EMAIL }], cc: m.cc ?? [], bcc: m.bcc ?? [] },
          bodyStructure: files.length ? { type: "multipart/mixed", childNodes: [shown.length ? { type: "multipart/related", childNodes: [text, ...shown] } : text, ...attached] } : parts.length === 1 ? parts[0] : { type: "multipart/alternative", childNodes: parts.map((p, i) => ({ ...p, part: String(i + 1) })) },
          ...(query.headers ? { headers: Buffer.from(`${m.references ? `References: ${m.references}\r\n` : ""}${m.headers ?? ""}\r\n`) } : {}),
        };
      },
      async *fetch(range: string) {
        seen.calls.push("fetch"); seen.ranges.push({ folder: open, range });
        const here = messages.filter((x) => x.folder === open);
        const highest = Math.max(0, ...here.map((x) => x.uid));
        for (const m of here.filter((x) => inRange(range, x.uid, highest))) {
          yield { uid: m.uid, flags: new Set([...(m.seen ? ["\\Seen"] : []), ...(m.flagged ? ["\\Flagged"] : [])]), internalDate: m.at, ...(opts.gmail && m.gmailId ? { emailId: decimalId(m.gmailId) } : {}) };
        }
      },
      ...({
        async messageFlagsAdd(uid: string, flags: string[]) {
          seen.calls.push("messageFlagsAdd"); seen.flags.push({ uid: Number(uid), flags, add: true });
          const m = find(uid); if (m) { if (flags[0] === "\\Flagged") m.flagged = true; else m.seen = true; } return !!m;
        },
        async messageFlagsRemove(uid: string, flags: string[]) {
          seen.calls.push("messageFlagsRemove"); seen.flags.push({ uid: Number(uid), flags, add: false });
          const m = find(uid); if (m) { if (flags[0] === "\\Flagged") m.flagged = false; else m.seen = false; } return !!m;
        },
        /**
         * APPEND: a draft the Mail screen saved, recorded as sent to the server and kept in its folder like any mail,
         * under the next number there. The answer says where it is, as a server with UIDPLUS does (iCloud, Gmail);
         * with `noAppendUid` it does not, as an older server.
         */
        async append(path: string, content: Buffer, flags: string[]) {
          seen.calls.push("append"); seen.appends.push({ path, raw: content.toString(), flags });
          const uid = Math.max(0, ...messages.filter((x) => x.folder === path).map((x) => x.uid)) + 100;
          messages.push({ uid, folder: path, at: new Date(), seen: flags.includes("\\Seen"), ...parsedDraft(content.toString()) });
          return opts.noAppendUid ? { destination: path } : { destination: path, uid, uidValidity: 7n };
        },
        capabilities: new Map<string, unknown>([...(opts.noMove ? [] : [["MOVE", true], ["UIDPLUS", true]] as const), ...(opts.gmail ? [["X-GM-EXT-1", true]] as const : [])]),
        /** MOVE: the message goes to the destination folder under the next UID there. */
        async messageMove(uid: string, destination: string) {
          seen.calls.push("messageMove"); seen.moves.push({ from: open!, uid: Number(uid), to: destination });
          const m = find(uid);
          if (!m) return false;
          const next = Math.max(0, ...messages.filter((x) => x.folder === destination).map((x) => x.uid)) + 100;
          const old = m.uid;
          m.folder = destination;
          m.uid = next;
          return { uidValidity: 7n, uidMap: new Map([[old, next]]) };
        },
      } as object),
      async download(uid, part) {
        seen.calls.push("download");
        const m = find(uid)!;
        if (m.files?.length && part !== "1") {
          const f = m.files[Number(part) - 2];
          seen.downloads.push(part);
          return { content: Readable.from([f ? f.bytes : Buffer.alloc(0)]) };
        }
        const both = m.plain !== undefined && m.html !== undefined;
        const body = both ? (part === "1" ? m.plain! : m.html!) : (m.plain ?? m.html ?? "");
        return { content: Readable.from([Buffer.from(body, "utf8")]) };
      },
    };
    return c;
  };
  setImapFactory(factory);
  /** `factory`: what makes this fake's clients, for a test that wraps it (a server that fails one call). */
  return Object.assign(seen, { logins, factory });
}

export function linked(t: TestHub, extra: Record<string, unknown> = {}) {
  t.hub.connections.update((c) => { c.icloud = [{ email: EMAIL, password: PASSWORD, linked_at: new Date().toISOString(), ...extra }]; });
}
export const done = (t: TestHub) => { setImapFactory(null); t.cleanup(); };
export const ago = (days: number) => new Date(Date.now() - days * 86400_000);
