import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, PASSWORD } from "./fake-icloud-mail.js";
import { archiveOf, googleAppPassword, imapSource, mailFolders, setImapFactory, setMailLookup, shownFolders, type ImapClient, type ImapFolder } from "../src/imports/icloud.js";
import { INBOX_SOURCES, listMail } from "../src/mail-inbox.js";

// Other mail accounts on the Mail screen (since 2026-11-22): Gmail and any IMAP server, beside iCloud. Every server,
// address and password here is made up; the fake server stands in for every real one, and names are looked up by a
// stand-in for DNS.

// Addresses from the block kept for examples (203.0.113.0/24): no real server has one.
const PUBLIC = "203.0.113.34";
const NAMES: Record<string, string[]> = {
  "imap.fastmail.example": [PUBLIC],
  "imap.gmail.com": ["203.0.113.108"],
  "mail.home.example": ["192.168.1.20"],
  "sneaky.example": [PUBLIC, "10.0.0.5"],
  "loop.example": ["127.0.0.1"],
  // Two addresses, and many of one family with one of the other (3fff::/20 is IPv6's block for examples).
  "two.example": ["203.0.113.50", "203.0.113.51"],
  "many.example": ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "3fff:0:0:1::25"],
};
const lookups: string[] = [];
const setUp = () => {
  lookups.length = 0;
  setMailLookup(async (host) => {
    lookups.push(host);
    const a = NAMES[host];
    if (!a) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return a.map((address) => ({ address }));
  });
  const t = makeHub();
  return t;
};
const tearDown = (t: TestHub) => { setMailLookup(null); done(t); };
const on = (t: TestHub) => t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
const link = (t: TestHub, body: Record<string, unknown>) => t.api("/connections/imap", { method: "PUT", json: body });

test("other accounts: only a server name, a TLS port and an app password are taken, and Mail must be on", async () => {
  const t = setUp();
  try {
    fake([]);
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false, mail: false } });
    assert.equal((await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD })).status, 404, "Mail and Receipts and renewals are off");
    await on(t);
    for (const [body, why] of [
      [{ email: "not an address", host: "imap.fastmail.example", password: PASSWORD }, "an address"],
      [{ email: "robin@fastmail.example", host: "203.0.113.34", password: PASSWORD }, "a name, never an address typed in"],
      [{ email: "robin@fastmail.example", host: "imap fastmail", password: PASSWORD }, "a server name"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", port: 143, password: PASSWORD }, "143 is IMAP without TLS"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", port: 70000, password: PASSWORD }, "a port"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", password: "" }, "a password"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", password: "line\nbreak" }, "no control characters"],
      [{ email: "robin@gmail.example", preset: "gmail", password: "my-google-pass-2026" }, "Gmail takes an app password, not the Google one"],
    ] as const) assert.equal((await link(t, body)).status, 422, why);
    assert.equal(lookups.length, 0, "nothing looked up for a refused form");
  } finally { tearDown(t); }
});

test("other accounts: a server on the owner's own network is refused before any connection", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    await on(t);
    for (const host of ["mail.home.example", "sneaky.example", "loop.example"]) {
      const r = await link(t, { email: "robin@home.example", host, password: PASSWORD });
      assert.equal(r.status, 422, host);
      assert.match((await r.json() as { error: string }).error, /own network/);
    }
    assert.equal((await link(t, { email: "robin@home.example", host: "nowhere.example", password: PASSWORD })).status, 422, "a name that is not found");
    assert.equal(seen.connects, 0, "never connected");
    assert.equal(t.hub.connections.get().imap?.length ?? 0, 0);
  } finally { tearDown(t); }
});

test("other accounts: linked after one check with the server, at the checked address, its certificate checked by name; the password never shown", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    await on(t);
    const r = await link(t, { email: "Robin@Fastmail.example", host: "imap.fastmail.example", user: "robin", password: PASSWORD });
    assert.equal(r.status, 200);
    assert.deepEqual(seen.logins[0], { user: "robin", pass: PASSWORD, host: PUBLIC, port: 993, servername: "imap.fastmail.example", name: "imap.fastmail.example" });
    const view = await (await t.api("/connections")).json() as { imap: { accounts: Record<string, unknown>[] } };
    assert.deepEqual(view.imap.accounts.map((a) => [a.email, a.host, a.port, a.user, a.preset]), [["robin@fastmail.example", "imap.fastmail.example", 993, "robin", "imap"]]);
    assert.ok(!JSON.stringify(view).includes(PASSWORD), "never the password");
    // Gmail: the preset fills in the server.
    // As Google shows it, in four groups: kept and sent as its 16 letters (never with Apple's hyphens, which Gmail refuses).
    const g = await link(t, { email: "robin@gmail.example", preset: "gmail", password: "abcd efgh ijkl mnop" });
    assert.equal(g.status, 200, await g.clone().text());
    // (Linking also starts a refresh in the background, which signs in again: Gmail's sign-in is among them.)
    const gmail = seen.logins.find((l) => l.servername === "imap.gmail.com");
    assert.deepEqual(gmail && [gmail.host, gmail.port, gmail.user, gmail.name], ["203.0.113.108", 993, "robin@gmail.example", "Gmail"]);
    assert.equal(gmail?.pass, "abcdefghijklmnop", "the letters alone");
    // A wrong password is refused in the provider's own name.
    const bad = await link(t, { email: "sam@fastmail.example", host: "imap.fastmail.example", password: "wrong" });
    assert.equal(bad.status, 422);
    assert.match((await bad.json() as { error: string }).error, /^imap\.fastmail\.example did not accept/);
    // An address already linked as an iCloud mailbox is not linked twice.
    linked(t);
    assert.equal((await link(t, { email: "robin@icloud.example", host: "imap.fastmail.example", password: PASSWORD })).status, 409);
  } finally { tearDown(t); }
});

test("other accounts: their Inbox joins the Mail screen, logos never trusted from their server, and unlinking takes their mail away", async () => {
  const t = setUp();
  try {
    // A forged verdict that iCloud's own check would trust, written by the sender: another server never strips it.
    const forged = "Authentication-Results: bimi.icloud.com; bimi=pass header.d=bank.example header.selector=default policy.authority=pass\r\nBIMI-Location: v=BIMI1; l=https://cdn.bank.example/logo.svg\r\nAuthentication-Results: dmarc.icloud.com; dmarc=pass header.from=bank.example\r\n";
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Your statement", from: { name: "Bank", address: "news@bank.example" }, messageId: "s1@x", plain: "Hello", headers: forged }]);
    await on(t);
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    await t.api("/mail/refresh", { method: "POST" });
    const list = await (await t.api("/mail")).json() as { messages: { subject: string; logo_domain?: string }[]; mailboxes: { email: string }[] };
    assert.deepEqual(list.mailboxes.map((m) => m.email), ["robin@fastmail.example"]);
    assert.deepEqual(list.messages.map((m) => m.subject), ["Your statement"]);
    assert.equal(list.messages[0].logo_domain, undefined, "no logo from a header another server lets through");
    assert.equal((await t.api(`/connections/imap/${encodeURIComponent("robin@fastmail.example")}`, { method: "DELETE" })).status, 200);
    assert.equal(listMail(t.hub.mailDb).length, 0, "its mail gone from the hub");
    assert.equal(t.hub.connections.get().imap?.length, 0, "its password gone");
  } finally { tearDown(t); }
});

test("other accounts: Done's folder is Archive, else Gmail's All Mail, else a folder named Archive", () => {
  const f = (path: string, specialUse?: string, flags: string[] = []): ImapFolder => ({ path, specialUse, flags: new Set(flags) });
  assert.equal(archiveOf([f("INBOX"), f("Archive", "\\Archive")])?.path, "Archive");
  assert.equal(archiveOf([f("INBOX"), f("[Gmail]", undefined, ["\\Noselect"]), f("[Gmail]/All Mail", "\\All"), f("[Gmail]/Sent Mail", "\\Sent")])?.path, "[Gmail]/All Mail");
  assert.equal(archiveOf([f("INBOX"), f("INBOX.Archive")])?.path, "INBOX.Archive");
  assert.equal(archiveOf([f("INBOX"), f("Old")]), null);
});

test("internet accounts: one app password feeds the Mail screen and receipts, each with its own switch", async () => {
  const t = setUp();
  try {
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Your receipt", from: { name: "Shop", address: "billing@shop.example" }, messageId: "r1@x", plain: "Total $9.99" }]);
    await on(t);
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    const KEY = "imap:robin@fastmail.example";
    assert.deepEqual(imapSource.accounts(t.hub), [KEY], "receipts read it by default");
    await imapSource.list(t.hub, KEY);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE account = ?").get(KEY) as { n: number }).n, 1, "the receipt is queued for the filer");
    const view = async () => (await (await t.api("/connections")).json() as { internet: { key: string; kind: string; features: Record<string, boolean | null>; receipts?: { to_read: number } }[] }).internet;
    assert.deepEqual((await view()).map((a) => [a.key, a.kind, a.features, a.receipts?.to_read]), [[KEY, "imap", { inbox: true, receipts: true, calendars: null }, 1]]);

    // Receipts off: the queue goes, the Mail screen stays.
    const sw = (body: unknown, key = KEY) => t.api(`/connections/accounts/${encodeURIComponent(key)}`, { method: "PUT", json: body });
    assert.deepEqual(await (await sw({ receipts: false })).json(), { receipts: false, inbox: true, read_only: false });
    assert.deepEqual(imapSource.accounts(t.hub), []);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE account = ?").get(KEY) as { n: number }).n, 0);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(listMail(t.hub.mailDb).length, 1, "still on the Mail screen");
    assert.equal((await sw({ inbox: "yes" })).status, 422);
    assert.equal((await sw({ inbox: true }, "robin@gmail.example")).status, 404, "Sign in with Google has no switches");
    // Mail off too: its mail leaves the screen at once, and with nothing using the account any more it is removed,
    // password and all (it stayed linked with both switches off, its password kept for nothing).
    const off = (await (await sw({ inbox: false })).json()) as { receipts: boolean; inbox: boolean; removed?: boolean; message?: string };
    assert.deepEqual([off.receipts, off.inbox, off.removed], [false, false, true]);
    assert.match(off.message ?? "", /Nothing on the hub uses this account now\. The mailbox is unlinked and its password deleted/);
    assert.equal(listMail(t.hub.mailDb).length, 0);
    assert.equal(t.hub.connections.get().imap?.length, 0);
    assert.equal(JSON.stringify(t.hub.connections.get()).includes(PASSWORD), false, "no password left behind");
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(listMail(t.hub.mailDb).length, 0);
    assert.equal((await sw({ inbox: true })).status, 404, "gone: linked again from Add account");
  } finally { tearDown(t); }
});

test("internet accounts: an address also signed in with Google is read for receipts there only; iCloud keeps Mail and receipts apart", async () => {
  const t = setUp();
  try {
    fake([]);
    await on(t);
    await link(t, { email: "robin@gmail.example", preset: "gmail", password: "abcdefghijklmnop" });
    assert.deepEqual(imapSource.accounts(t.hub), ["imap:robin@gmail.example"]);
    t.hub.connections.update((c) => { c.google = [{ email: "robin@gmail.example", linked_at: new Date().toISOString() } as never]; });
    assert.deepEqual(imapSource.accounts(t.hub), [], "filed once, through Sign in with Google");
    const internet = (t.hub.connections.view() as unknown as { internet: { kind: string; features: Record<string, boolean | null> }[] }).internet;
    assert.deepEqual(internet.map((a) => [a.kind, a.features]), [["google", { inbox: null, receipts: true, calendars: null }], ["gmail", { inbox: true, receipts: false, calendars: null }]]);
    // A Gmail address gets Gmail's own link for what receipts file; another server the mail app's.
    assert.match(imapSource.link({ account: "imap:you@gmail.com", id: "1:2:INBOX", message_id: "<a@b>" }), /^https:\/\/mail\.google\.com\/.*rfc822msgid%3Aa%40b$/);
    assert.match(imapSource.link({ account: "imap:robin@fastmail.example", id: "1:2:INBOX", message_id: "<a@b>" }), /^message:\/\//);

    // iCloud: receipts off keeps it on the Mail screen (before, one switch did both).
    linked(t);
    const sw = await t.api(`/connections/accounts/${encodeURIComponent("icloud:robin@icloud.example")}`, { method: "PUT", json: { receipts: false } });
    assert.deepEqual(await sw.json(), { receipts: false, inbox: true, read_only: false });
    assert.deepEqual(INBOX_SOURCES.flatMap((s) => s.accounts(t.hub)).filter((a) => a.startsWith("icloud:")), ["icloud:robin@icloud.example"]);
  } finally { tearDown(t); }
});

test("other accounts: Gmail's All Mail, Starred and Important are views, not folders; receipts read each mail once", () => {
  const f = (path: string, specialUse?: string, flags: string[] = []): ImapFolder => ({ path, ...(specialUse ? { specialUse } : {}), flags: new Set(flags) });
  // As Gmail lists them. The library names Important only in the folder's own flags.
  const gmail = [f("INBOX"), f("[Gmail]", undefined, ["\\Noselect"]), f("[Gmail]/All Mail", "\\All", ["\\All"]), f("[Gmail]/Important", undefined, ["\\Important"]), f("[Gmail]/Starred", "\\Flagged", ["\\Flagged"]),
    f("[Gmail]/Sent Mail", "\\Sent"), f("[Gmail]/Spam", "\\Junk"), f("[Gmail]/Trash", "\\Trash"), f("[Gmail]/Drafts", "\\Drafts"), f("Receipts"), f("Work")];
  const paths = (l: { path: string }[]) => l.map((x) => x.path);
  assert.deepEqual(shownFolders(gmail).map((x) => [x.path, x.role]), [["[Gmail]/Sent Mail", "sent"], ["[Gmail]/Spam", "junk"], ["[Gmail]/Trash", "trash"], ["[Gmail]/Drafts", "drafts"], ["Receipts", "own"], ["Work", "own"]], "Important is not one of the owner's folders");
  assert.deepEqual(paths(mailFolders(gmail, { allMail: true })), ["[Gmail]/All Mail"], "a Gmail account's receipts: All Mail alone, each mail once");
  assert.deepEqual(paths(mailFolders(gmail.filter((x) => x.specialUse !== "\\All"), { allMail: true })), ["INBOX", "Receipts", "Work"], "All Mail hidden from mail apps: the folders, never a view");
  assert.deepEqual(paths(mailFolders(gmail)), ["INBOX", "Receipts", "Work"], "another server: its folders, never a view");
  assert.equal(googleAppPassword("abcd efgh ijkl mnop"), "abcdefghijklmnop");
  assert.equal(googleAppPassword("ABCD-EFGH-IJKL-MNOP"), "abcdefghijklmnop", "typed with hyphens by habit: the letters");
  assert.equal(googleAppPassword("my-google-pass-2026"), null);
});

test("other accounts: a server that is busy is tried again later; only a refused password pauses the mailbox", async () => {
  const t = setUp();
  try {
    await on(t);
    t.hub.connections.update((c) => { c.imap = [{ email: "robin@fastmail.example", preset: "imap", host: "imap.fastmail.example", port: 993, user: "robin@fastmail.example", password: PASSWORD, linked_at: new Date().toISOString() }]; });
    const account = () => t.hub.connections.get().imap![0];
    const answer = (code?: string) => setImapFactory(() => ({
      async connect() { throw Object.assign(new Error("NO"), { authenticationFailed: true, ...(code ? { serverResponseCode: code } : {}) }); },
      async logout() {}, close() {},
    } as unknown as ImapClient));
    const refresh = async () => ((await (await t.api("/mail/refresh", { method: "POST" })).json()) as { mailboxes: { error?: string }[] }).mailboxes[0].error ?? "";
    for (const code of ["UNAVAILABLE", "LIMIT", "INUSE", "SERVERBUG", "OVERQUOTA"]) {
      answer(code);
      assert.match(await refresh(), /could not be reached|stopped answering/, code);
      assert.equal(account().refused_at ?? null, null, `${code}: not a refused password`);
    }
    // The same said in words under a code that says nothing, as Gmail turns away one connection too many.
    for (const words of [{ responseText: "[ALERT] Too many simultaneous connections. (Failure)" }, { response: "A1 NO Temporary authentication failure, try again later" }, { serverResponseCode: "ALERT", responseText: "Rate limit reached" }]) {
      setImapFactory(() => ({ async connect() { throw Object.assign(new Error("NO"), { authenticationFailed: true, ...words }); }, async logout() {}, close() {} } as unknown as ImapClient));
      assert.match(await refresh(), /could not be reached|stopped answering/, JSON.stringify(words));
      assert.equal(account().refused_at ?? null, null, "busy, not refused");
    }
    // CONTACTADMIN is for the owner to settle with the provider: signing in again every 15 minutes would not help.
    for (const code of ["AUTHENTICATIONFAILED", "CONTACTADMIN", undefined]) {
      t.hub.connections.update((c) => { c.imap![0].refused_at = null; });
      answer(code);
      assert.match(await refresh(), /did not accept this username and app password/, String(code));
      assert.ok(account().refused_at, `${code}: paused, so the account is not locked by more tries`);
    }
  } finally { tearDown(t); }
});

test("internet accounts: an address whose receipts are read through Google: Mail off is its last use, and linking it again turns Mail on", async () => {
  const t = setUp();
  try {
    fake([]);
    await on(t);
    const KEY = "imap:robin@fastmail.example";
    const sw = async (body: unknown) => (await (await t.api(`/connections/accounts/${encodeURIComponent(KEY)}`, { method: "PUT", json: body })).json()) as { receipts: boolean; inbox: boolean; removed?: boolean };
    const mine = () => t.hub.connections.get().imap?.find((a) => a.email === "robin@fastmail.example");
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    t.hub.connections.update((c) => { c.google = [{ email: "robin@fastmail.example", linked_at: new Date().toISOString() } as never]; });
    // Receipts is on in name only (they are read through Google): with Mail off, nothing uses this password.
    assert.equal((await sw({ inbox: false })).removed, true);
    assert.equal(mine(), undefined);
    // Without the Google link the same switch leaves Receipts' use, and the account.
    t.hub.connections.update((c) => { c.google = []; });
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    assert.deepEqual(await sw({ inbox: false }), { receipts: true, inbox: false, read_only: false });
    assert.ok(mine());
    // A new password keeps the switches as the owner set them (Mail stays off, Receipts on).
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    assert.deepEqual([mine()?.mail ?? true, mine()?.inbox], [true, false]);
    // One that nothing uses (kept so by a hub from before the last switch removed it) is linked for mail again.
    t.hub.connections.update((c) => { Object.assign(c.imap![0], { mail: false, inbox: false }); });
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    assert.deepEqual([mine()?.mail, mine()?.inbox], [true, undefined], "Receipts and the Mail screen both, as a new one");
    await t.api("/mail/refresh", { method: "POST" });
  } finally { tearDown(t); }
});

test("other accounts: each checked address is tried in turn, IPv4 and IPv6 by turns; a refused sign-in is the answer at the first", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    await on(t);
    const down = (hosts: string[], how: Record<string, unknown> = { code: "ECONNREFUSED" }) => setImapFactory((login) => {
      const c = seen.factory(login);
      if (hosts.includes(login.host ?? "")) c.connect = async () => { throw Object.assign(new Error("connect failed"), how); };
      return c;
    });
    // The first address takes no connection (a home whose route to it is broken): the second one is used.
    down(["203.0.113.50"]);
    assert.equal((await link(t, { email: "robin@two.example", host: "two.example", password: PASSWORD })).status, 200);
    assert.deepEqual(seen.logins.slice(0, 2).map((l) => [l.host, l.servername]), [["203.0.113.50", "two.example"], ["203.0.113.51", "two.example"]], "the certificate is checked against the name at each");
    // (Linking starts a refresh behind its answer, which signs in the same way: waited for, then the account is taken
    // out again so that only the next link signs in.)
    await t.api("/mail/refresh", { method: "POST" });
    t.hub.connections.update((c) => { c.imap = []; });
    // A name with many addresses of one family still gives one of the other, at most four in all.
    seen.logins.length = 0;
    down(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "3fff:0:0:1::25"]);
    assert.equal((await link(t, { email: "robin@many.example", host: "many.example", password: PASSWORD })).status, 502);
    assert.deepEqual(seen.logins.map((l) => l.host), ["203.0.113.1", "3fff:0:0:1::25", "203.0.113.2", "203.0.113.3"]);
    // A sign-in turned away is the server's answer wherever it is asked: no second address, no second try.
    seen.logins.length = 0;
    down(["203.0.113.50"], { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    const r = await link(t, { email: "robin@two.example", host: "two.example", password: PASSWORD });
    assert.ok(r.status >= 400);
    assert.deepEqual(seen.logins.map((l) => l.host), ["203.0.113.50"]);
  } finally { tearDown(t); }
});

test("other accounts: a mailbox switched off while a refresh reads another one is not signed in to", async () => {
  const t = setUp();
  try {
    await on(t);
    linked(t);
    t.hub.connections.update((c) => { c.imap = [{ email: "robin@fastmail.example", preset: "imap", host: "imap.fastmail.example", port: 993, user: "robin@fastmail.example", password: PASSWORD, linked_at: new Date().toISOString() }]; });
    // The owner unticks Mail for the second mailbox while the first one's mail is being read.
    let off = false;
    const m = { uid: 1, folder: "INBOX", at: ago(1), subject: "Hello", from: { address: "alex@northwind.example" }, messageId: "a1@x" } as { uid: number; folder: string; at: Date; subject: string; from: { address: string }; messageId: string; plain?: string };
    Object.defineProperty(m, "plain", { enumerable: true, get() {
      if (!off) { off = true; t.hub.connections.update((c) => { c.imap![0].inbox = false; }); }
      return "Hi";
    } });
    const seen = fake([m]);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(off, true);
    assert.deepEqual([...new Set(seen.logins.map((l) => l.user))], ["robin@icloud.example"], "the mailbox switched off meanwhile was never signed in to");
    assert.deepEqual(listMail(t.hub.mailDb).map((x) => x.subject), ["Hello"]);
  } finally { tearDown(t); }
});
