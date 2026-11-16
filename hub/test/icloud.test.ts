import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { makeHub, type TestHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { appPassword, BODY_WORDS, icloudLink, linkICloud, listICloud, mailFolders, PART_MAX, setImapFactory, SUBJECT_WORDS, textParts, unlinkICloud, type ImapClient, type ImapFolder, type ImapLogin, type ImapPart } from "../src/imports/icloud.js";
import { isMailLink, sourceOf } from "../src/imports/mail-sources.js";
import { fileMessage, type MailRead } from "../src/mail-filer.js";

/** A made-up app-specific password in Apple's format. Never a real one. */
const PASSWORD = "abcd-efgh-ijkl-mnop";
const EMAIL = "robin@icloud.example";
const ACCOUNT = `icloud:${EMAIL}`;

interface FakeMsg {
  uid: number;
  folder: string;
  at: Date;
  subject: string;
  from: { name?: string; address: string };
  messageId?: string;
  parts: { type: string; body: string; attachment?: boolean; filename?: string }[];
  read: MailRead;
}

/**
 * A fake iCloud: a few folders, messages in them, and a record of every call. It answers only the calls the hub's
 * ImapClient type has; `calls` lets a test check nothing else was attempted and every connection was closed.
 */
function fakeICloud(messages: FakeMsg[], opts: { password?: string; validity?: Record<string, bigint>; failOn?: string } = {}) {
  const folders: ImapFolder[] = [
    { path: "INBOX", flags: new Set() },
    { path: "Archive", specialUse: "\\Archive", flags: new Set() },
    { path: "Junk", specialUse: "\\Junk", flags: new Set() },
    { path: "Deleted Messages", specialUse: "\\Trash", flags: new Set() },
    { path: "Drafts", specialUse: "\\Drafts", flags: new Set() },
    { path: "Sent Messages", specialUse: "\\Sent", flags: new Set() },
    { path: "Receipts: 2026", flags: new Set() },
    { path: "[Group]", flags: new Set(["\\Noselect"]) },
  ];
  const seen = {
    logins: [] as ImapLogin[],
    connects: 0, logouts: 0,
    calls: [] as string[],
    opened: [] as { path: string; readOnly: unknown }[],
    searches: [] as Record<string, any>[],
    downloads: [] as { uid: string; part: string; maxBytes: number }[],
  };
  const validity = (folder: string) => opts.validity?.[folder] ?? 7n;
  const structure = (m: FakeMsg): ImapPart => (m.parts.length === 1
    ? { type: m.parts[0].type }
    : { type: "multipart/mixed", childNodes: m.parts.map((p, i) => ({ part: String(i + 1), type: p.type, ...(p.attachment ? { disposition: "attachment" } : {}), ...(p.filename ? { dispositionParameters: { filename: p.filename } } : {}) })) });
  setImapFactory((login) => {
    seen.logins.push(login);
    let open: string | null = null;
    const c: ImapClient = {
      async connect() {
        seen.calls.push("connect"); seen.connects++;
        if (opts.failOn === "connect") throw Object.assign(new Error(`connect ECONNRESET while talking to ${login.user}`), { code: "ECONNRESET" });
        if (login.pass !== (opts.password ?? PASSWORD)) throw Object.assign(new Error(`Authentication failed for ${login.user}`), { authenticationFailed: true });
      },
      async logout() { seen.calls.push("logout"); seen.logouts++; },
      close() { seen.calls.push("close"); },
      async list() { seen.calls.push("list"); return folders; },
      async mailboxOpen(p, o) {
        seen.calls.push("mailboxOpen"); seen.opened.push({ path: p, readOnly: (o as { readOnly?: unknown }).readOnly });
        if (!folders.some((f) => f.path === p)) throw Object.assign(new Error(`Mailbox ${p} does not exist`), { responseStatus: "NO" });
        open = p;
        return { uidValidity: validity(p) };
      },
      async search(q, o) {
        seen.calls.push("search"); seen.searches.push(q);
        assert.equal(o.uid, true);
        const since = new Date((q.since as Date).getFullYear(), (q.since as Date).getMonth(), (q.since as Date).getDate());
        return messages.filter((m) => m.folder === open && m.at >= since && (q.or as Record<string, string>[]).some((t) =>
          (t.subject && m.subject.toLowerCase().includes(t.subject)) || (t.body && m.parts.some((p) => p.body.toLowerCase().includes(t.body))))).map((m) => m.uid);
      },
      async fetchOne(uid, query, o) {
        seen.calls.push("fetchOne");
        assert.deepEqual({ query, o }, { query: { envelope: true, bodyStructure: true, internalDate: true }, o: { uid: true } });
        const m = messages.find((x) => x.folder === open && String(x.uid) === uid);
        if (!m) return false;
        return { internalDate: m.at, envelope: { date: m.at, subject: m.subject, messageId: m.messageId, from: [m.from] }, bodyStructure: structure(m) };
      },
      async download(uid, part, o) {
        seen.calls.push("download"); seen.downloads.push({ uid, part, maxBytes: o.maxBytes });
        const m = messages.find((x) => x.folder === open && String(x.uid) === uid)!;
        const p = m.parts.length === 1 ? m.parts[0] : m.parts[Number(part) - 1];
        return { content: Readable.from([Buffer.from(p.body, "utf8")]) };
      },
    };
    return c;
  });
  return seen;
}

/** A model that answers each mail with the reading the test gave it, found by subject. */
function mailModel(messages: FakeMsg[]): Backend & { sent: AiMessage[][] } {
  const b = {
    name: "ollama" as const, model: "scripted", sent: [] as AiMessage[][],
    chat: async (msgs: AiMessage[]) => {
      b.sent.push(msgs);
      const subject = /^Subject: (.*)$/m.exec(msgs[1].content)?.[1];
      return { text: JSON.stringify(messages.find((m) => m.subject === subject)?.read ?? { type: "none" }), usage: {} };
    },
    stream: async () => ({ text: "", usage: {} }),
  };
  return b;
}

const done = (t: TestHub) => { setImapFactory(null); setBackendOverride(null); t.cleanup(); };
const days = (n: number, from = new Date()) => new Date(from.getTime() - n * 86400_000);

test("icloud: only an app-specific password is taken, never an Apple ID password", () => {
  assert.equal(appPassword("abcd efgh ijkl mnop"), PASSWORD);
  assert.equal(appPassword("ABCD-EFGH-IJKL-MNOP"), PASSWORD);
  assert.equal(appPassword("abcdefghijklmnop"), PASSWORD);
  for (const bad of ["Hunter2!Hunter2!", "abcd-efgh-ijkl-mno", "abcd-efgh-ijkl-mnop-q", "abcd-efgh-ijkl-mn0p", "", 42, null]) assert.equal(appPassword(bad), null, String(bad));
});

test("icloud: linking checks the password with iCloud once, keeps it sealed, and never shows it", async () => {
  const t = makeHub();
  try {
    const seen = fakeICloud([]);
    // Not an app-specific password: refused before iCloud is even asked.
    await assert.rejects(linkICloud(t.hub, { email: EMAIL, password: "MyAppleID-Password1" }), (e: any) => e.status === 422 && /not your Apple ID password/.test(e.message));
    await assert.rejects(linkICloud(t.hub, { email: "not an address", password: PASSWORD }), (e: any) => e.status === 422);
    assert.equal(seen.connects, 0);
    // iCloud refuses it: the hub's own words, never the server's (which named the address).
    await assert.rejects(linkICloud(t.hub, { email: EMAIL, password: "zzzz-zzzz-zzzz-zzzz" }), (e: any) => e.status === 422 && !e.message.includes(EMAIL) && /account\.apple\.com/.test(e.message));
    assert.equal(t.hub.connections.get().icloud?.length ?? 0, 0, "a refused password is not kept");
    // Accepted.
    const started: string[] = [];
    const view = await linkICloud(t.hub, { email: ` ${EMAIL.toUpperCase()} `, password: "ABCD EFGH IJKL MNOP" }, (a) => started.push(a));
    assert.deepEqual(started, [ACCOUNT], "the first read starts");
    assert.deepEqual(view.accounts.map((a) => a.email), [EMAIL]);
    assert.equal(t.hub.connections.get().icloud![0].password, PASSWORD);
    assert.equal(seen.logins.at(-1)!.user, EMAIL);
    assert.equal(seen.connects, seen.logouts, "every connection is closed, the refused one too");
    // Never in a view, and never readable in the file on disk.
    assert.equal(JSON.stringify(t.hub.connections.view()).includes(PASSWORD), false);
    assert.equal(JSON.stringify(t.hub.connections.view()).includes("abcdefghijklmnop"), false);
    assert.equal(fs.readFileSync(path.join(t.dir, "connections.json"), "utf8").includes("abcd"), false, "connections.json is sealed");
    // Linking again replaces the link instead of adding one.
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    assert.equal(t.hub.connections.get().icloud!.length, 1);
  } finally { done(t); }
});

test("icloud: listing searches every received-mail folder read-only, skips Junk, Trash, Drafts and Sent, and ids hold the folder", async () => {
  const t = makeHub();
  const now = new Date();
  const msg = (uid: number, folder: string, ago: number, subject: string, body = "Total $9.99"): FakeMsg => ({ uid, folder, at: days(ago, now), subject, from: { address: "billing@shop.example" }, parts: [{ type: "text/plain", body }], read: { type: "none" } });
  const messages = [
    msg(11, "INBOX", 3, "Your receipt"),
    msg(12, "INBOX", 2, "Lunch on Friday?", "See you there"),
    msg(13, "INBOX", 1, "Visit summary", "Pinecrest Animal Hospital, Pepper's exam"),
    msg(5, "Archive", 30, "Subscription renewal"),
    msg(6, "Archive", 500, "Old invoice"),
    msg(1, "Junk", 1, "Your receipt (spam)"),
    msg(2, "Deleted Messages", 1, "Invoice"),
    msg(3, "Sent Messages", 1, "Re: payment"),
    msg(4, "Drafts", 1, "Billing question"),
    msg(9, "Receipts: 2026", 4, "Payment received"),
  ];
  try {
    const seen = fakeICloud(messages);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    const r = await listICloud(t.hub, ACCOUNT, now);
    assert.deepEqual(seen.opened.map((o) => o.path), ["INBOX", "Archive", "Receipts: 2026"], "no Junk, Trash, Drafts, Sent or unselectable folder");
    assert.ok(seen.opened.every((o) => o.readOnly === true), "every folder is opened read-only (EXAMINE)");
    const ids = (t.hub.db.prepare("SELECT id FROM mail WHERE account = ? ORDER BY n").all(ACCOUNT) as { id: string }[]).map((x) => x.id);
    assert.deepEqual(ids, ["7:11:INBOX", "7:13:INBOX", "7:5:Archive", "7:9:Receipts: 2026"], "receipts and vet mail, not lunch; 400 days back, not 500");
    assert.deepEqual(r, { listed: 4, queued: 4 });
    // The search is Gmail's: its subject words, and the vet words in the body.
    const q = seen.searches[0];
    assert.ok(SUBJECT_WORDS.includes("receipt") && SUBJECT_WORDS.includes("vaccine") && SUBJECT_WORDS.length >= 20);
    assert.deepEqual(q.or.filter((x: any) => x.body).map((x: any) => x.body), BODY_WORDS);
    assert.ok(Math.abs(now.getTime() - 400 * 86400_000 - (q.since as Date).getTime()) < 1000, "the first read goes back 400 days");
    // A later read starts two days before the last and queues nothing twice.
    const again = await listICloud(t.hub, ACCOUNT, new Date(now.getTime() + 3600_000));
    assert.equal(again.queued, 0);
    assert.ok(Math.abs(seen.searches.at(-1)!.since.getTime() - (now.getTime() - 2 * 86400_000)) < 1000);
    assert.equal(seen.connects, seen.logouts, "every connection was closed");
    assert.ok(seen.calls.every((c) => ["connect", "logout", "close", "list", "mailboxOpen", "search"].includes(c)), "listing only lists, opens and searches");
  } finally { done(t); }
});

test("icloud: mail files itself like Gmail's, read with capped text parts only, linked to Apple Mail", async () => {
  const t = makeHub();
  const now = new Date();
  const messages: FakeMsg[] = [{
    uid: 21, folder: "INBOX", at: days(5, now), subject: "Your receipt from Apple", from: { name: "Apple", address: "no_reply@email.apple.example" }, messageId: "<abc.123@email.apple.example>",
    parts: [
      { type: "text/plain", body: "Thanks" },
      { type: "text/html", body: "<p>iCloud+ with 2 TB storage $9.99/month</p>" },
      { type: "text/plain", body: "attached text", filename: "terms.txt" },
      { type: "application/pdf", body: "%PDF", attachment: true },
    ],
    read: { type: "charge", vendor: "Apple", service: "iCloud+", category: "subscription", amount: 9.99, period: "month" },
  }];
  try {
    const seen = fakeICloud(messages);
    const model = mailModel(messages);
    setBackendOverride(model);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    await listICloud(t.hub, ACCOUNT, now);
    const r = await fileMessage(t.hub, ACCOUNT, "7:21:INBOX", now);
    assert.equal(r.state, "filed");
    const watch = t.hub.store.list({ kind: "watch" }).find((w) => w.fields.title === "iCloud+")!;
    assert.equal(watch.fields.cost, 9.99);
    assert.equal(watch.fields.url, "message://%3Cabc.123%40email.apple.example%3E", "opens the message in Apple Mail");
    // Only the two text parts that are not attachments, each capped.
    assert.deepEqual(seen.downloads.map((d) => d.part), ["1", "2"]);
    assert.ok(seen.downloads.every((d) => d.maxBytes === PART_MAX));
    assert.match(model.sent[0][1].content, /iCloud\+ with 2 TB storage \$9\.99\/month/, "the short text part gave way to the HTML");
    assert.match(model.sent[0][1].content, /^From: Apple <no_reply@email\.apple\.example>$/m);
    assert.doesNotMatch(model.sent[0][1].content, /attached text|%PDF/);
    assert.ok(seen.opened.every((o) => o.readOnly === true));
    assert.equal(seen.connects, seen.logouts);
    // A cancellation later finds this renewal as made by mail.
    assert.equal(isMailLink(String(watch.fields.url)), true);
  } finally { done(t); }
});

test("icloud: a message whose folder was reset, renamed or emptied is gone, not an error", async () => {
  const t = makeHub();
  const now = new Date();
  const messages: FakeMsg[] = [{ uid: 31, folder: "INBOX", at: days(1, now), subject: "Your invoice", from: { address: "a@b.example" }, parts: [{ type: "text/plain", body: "$5.00" }], read: { type: "none" } }];
  try {
    fakeICloud(messages);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    await listICloud(t.hub, ACCOUNT, now);
    // UIDVALIDITY changed: every UID in the folder may now name another message.
    fakeICloud(messages, { validity: { INBOX: 8n } });
    assert.equal((await fileMessage(t.hub, ACCOUNT, "7:31:INBOX", now)).state, "skipped");
    assert.equal(JSON.parse((t.hub.db.prepare("SELECT result FROM mail WHERE id = ?").get("7:31:INBOX") as { result: string }).result).why, "gone");
    // The folder is gone, and a message no longer in its folder.
    t.hub.db.prepare("INSERT INTO mail (account, id, state) VALUES (?, ?, 'queued'), (?, ?, 'queued')").run(ACCOUNT, "7:1:Old Folder", ACCOUNT, "7:99:INBOX");
    fakeICloud(messages);
    assert.equal((await fileMessage(t.hub, ACCOUNT, "7:1:Old Folder", now)).state, "skipped");
    assert.equal((await fileMessage(t.hub, ACCOUNT, "7:99:INBOX", now)).state, "skipped");
  } finally { done(t); }
});

test("icloud: a failed connection is the hub's own words, kept on the mailbox, with nothing of the server's", async () => {
  const t = makeHub();
  try {
    fakeICloud([]);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    const seen = fakeICloud([], { failOn: "connect" });
    await assert.rejects(listICloud(t.hub, ACCOUNT), (e: any) => e.status === 502 && !e.message.includes(EMAIL));
    const a = t.hub.connections.view().icloud.accounts[0];
    assert.match(String(a.last_error), /could not be reached/);
    assert.equal(String(a.last_error).includes(EMAIL), false);
    assert.equal(seen.connects, 1);
    assert.equal(seen.calls.includes("logout") || seen.calls.includes("close"), true, "the connection is closed even when it failed");
  } finally { done(t); }
});

test("icloud: unlinking deletes the password and the queue, keeps what was filed, and says to revoke it at Apple", async () => {
  const t = makeHub();
  try {
    fakeICloud([]);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    t.hub.db.prepare("INSERT INTO mail (account, id, state) VALUES (?, '7:1:INBOX', 'queued')").run(ACCOUNT);
    const kept = t.hub.store.create("watch", { title: "iCloud+", category: "subscription", due: "2030-01-01", lead_days: 3, url: "message://%3Cx%3E" });
    const r = unlinkICloud(t.hub, EMAIL);
    assert.match(r.message, /account\.apple\.com/);
    assert.deepEqual(r.accounts, []);
    assert.equal(t.hub.connections.get().icloud!.length, 0);
    assert.equal(JSON.stringify(t.hub.connections.get()).includes(PASSWORD), false, "the password is gone");
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE account = ?").get(ACCOUNT) as { n: number }).n, 0);
    assert.ok(t.hub.store.get(kept.id), "what was filed stays");
    assert.throws(() => unlinkICloud(t.hub, EMAIL), (e: any) => e.status === 404);
  } finally { done(t); }
});

test("icloud: text parts, folders, links and the account prefix", () => {
  const tree: ImapPart = { type: "multipart/mixed", childNodes: [
    { type: "multipart/alternative", childNodes: [{ part: "1.1", type: "TEXT/PLAIN" }, { part: "1.2", type: "text/html" }] },
    { part: "2", type: "text/calendar" },
    { part: "3", type: "text/plain", disposition: "ATTACHMENT" },
    { part: "4", type: "text/html", parameters: { name: "page.html" } },
    { part: "5", type: "image/png" },
  ] };
  assert.deepEqual(textParts(tree), [{ part: "1.1", html: false }, { part: "1.2", html: true }]);
  assert.deepEqual(textParts({ type: "text/plain" }), [{ part: "1", html: false }], "a single-part message is part 1");
  assert.equal(textParts({ type: "multipart/mixed", childNodes: Array.from({ length: 9 }, (_, i) => ({ part: String(i + 1), type: "text/plain" })) }).length, 4, "at most four parts");
  assert.deepEqual(mailFolders([{ path: "INBOX", flags: new Set() }, { path: "x", specialUse: "\\Junk", flags: new Set() }, { path: "y", flags: new Set(["\\NonExistent"]) }]).map((f) => f.path), ["INBOX"]);
  // The Message-ID is the sender's to write: encoded, so it cannot add to the link.
  assert.equal(icloudLink({ account: ACCOUNT, id: "1", message_id: "<a\" onclick=x@b.example>" }), "message://%3Ca%22%20onclick%3Dx%40b.example%3E");
  assert.equal(icloudLink({ account: ACCOUNT, id: "1" }), "https://www.icloud.com/mail/");
  assert.equal(sourceOf(ACCOUNT)?.kind, "icloud");
  assert.equal(sourceOf("robin@example.com")?.kind, "gmail");
  assert.equal(sourceOf("outlook:robin@example.com"), null);
});

test("icloud routes: link, view, Read now and unlink over HTTP, with the password never in an answer", async () => {
  const t = makeHub();
  try {
    fakeICloud([]);
    let r = await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: "Not-An-App-Password-1" } });
    assert.equal(r.status, 422);
    r = await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal((await r.text()).includes("abcd"), false);
    const body = await (await t.api("/connections")).text();
    assert.equal(body.includes("abcd"), false, "GET /connections never carries the password");
    const view = JSON.parse(body) as any;
    assert.equal(view.icloud.accounts[0].email, EMAIL);
    assert.equal(typeof view.icloud.accounts[0].to_read, "number", "with what its mail came to");
    r = await t.api("/connections/icloud/sync", { method: "POST" });
    assert.deepEqual(Object.keys(await r.json() as object), [ACCOUNT]);
    r = await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" });
    assert.match(((await r.json()) as { message: string }).message, /account\.apple\.com/);
    assert.equal((await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).status, 404);
  } finally { done(t); }
});

test("icloud routes: Mail off turns iCloud off, and the assistant can only ask for Read now", async () => {
  const t = makeHub();
  try {
    fakeICloud([]);
    assert.equal((await t.api("/modules", { method: "PUT", json: { mail: false } })).status, 200);
    const r = await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } });
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { module: string }).module, "mail");
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 404);
    const { refuseToolCall } = await import("../src/ai/api-guard.js");
    assert.ok(refuseToolCall("PUT", "/connections/icloud"), "the assistant cannot link a mailbox");
    assert.ok(refuseToolCall("DELETE", `/connections/icloud/${encodeURIComponent(EMAIL)}`), "or unlink one");
    assert.equal(refuseToolCall("POST", "/connections/icloud/sync"), null, "Read now, as for Gmail");
  } finally { done(t); }
});

test("icloud guide: an app-specific password, Apple's own page, and the fields go only to the link route", async () => {
  const t = makeHub();
  try {
    const g = await (await t.api("/connections/guides/icloud")).json() as { done: boolean; warning: string | null; steps: { title: string; text: string; link?: { url: string }; fields?: { id: string; secret: boolean }[]; save?: { path: string } }[] };
    assert.equal(g.done, false);
    assert.equal(g.warning, null, "no https or Tailscale needed: there is no return address");
    const last = g.steps[g.steps.length - 1];
    assert.deepEqual(last.fields?.map((f) => [f.id, f.secret]), [["email", false], ["password", true]]);
    assert.equal(last.save?.path, "/connections/icloud");
    for (const st of g.steps) {
      if (st.link) assert.match(st.link.url, /^https:\/\/account\.apple\.com\//);
      assert.ok(!/[–—]/.test(st.title + st.text), st.title);
    }
    fakeICloud([]);
    await linkICloud(t.hub, { email: EMAIL, password: PASSWORD });
    assert.equal(((await (await t.api("/connections/guides/icloud")).json()) as { done: boolean }).done, true);
  } finally { done(t); }
});
