import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeHub, type TestHub } from "./helpers.js";
import { smtp, type Fake } from "./fake-smtp.js";

const ALEX = { name: "Alex", address: "alex@example.com" };
const GMAIL = "robin@gmail.example";
import { ago, EMAIL, fake, GMAIL_PASSWORD, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { setImapFactory, setMailLookup } from "../src/imports/icloud.js";
import { checkedSmtp, setSmtpTest } from "../src/imports/smtp.js";
import { setSendDelay, startOutbox, STOPPED_WHILE_SENDING } from "../src/mail-outbox.js";
import { refreshMail, type MailSummary } from "../src/mail-inbox.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { TOOLS } from "../src/ai/tools.js";

// Sending from the Mail screen: the outbox, Undo, a restart in the window, the copy in Sent, and failures, against a
// local SMTP server with a test certificate (TLS on connect and STARTTLS). Made-up mail and addresses; nothing leaves
// this machine.

const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].replace(/\r\n(?= )/g, "").split("\r\n");
const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for: ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Item = { id: string; state: string; error?: string; refused?: string[]; to: string[]; subject: string; mailbox: string };
const state = async (t: TestHub, id: string) => (await t.api(`/mail/outbox/${id}`)).status === 404 ? null : ((await (await t.api(`/mail/outbox/${id}`)).json()) as Item);
const sendOf = (t: TestHub, body: unknown) => t.api("/mail/send", { method: "POST", json: body });
async function settled(t: TestHub, id: string, ms?: number): Promise<Item> {
  let last: Item | null = null;
  await until(`mail ${id} sent or not`, async () => { last = await state(t, id); return !!last && (last.state === "sent" || last.state === "failed"); }, ms);
  return last!;
}
/** The hub as it is left: no refresh still running against the fake mailbox when the test ends. */
async function finish(t: TestHub, servers: Fake[] = []) {
  await refreshMail(t.hub).catch(() => undefined);
  t.hub.close();
  setImapFactory(null);
  setSmtpTest(null);
  setSendDelay(null);
  setMailLookup(null);
  for (const s of servers) await s.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

/** Robin's iCloud mailbox with one mail from Alex in the Inbox (and `more`), refreshed. */
async function icloud(t: TestHub, more: Msg[] = [], extra: Record<string, unknown> = {}) {
  linked(t, extra);
  t.hub.profile.set({ name: "Robin" });
  const seen = fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", references: "<g0@x>", plain: "Saturday?" }, ...more]);
  await t.api("/mail/refresh", { method: "POST" });
  const list = (await (await t.api("/mail")).json()) as { messages: MailSummary[]; folders: { key: string; role: string }[]; mailboxes: { email: string; can_send: boolean; read_only: boolean }[] };
  return { seen, list, id: list.messages.find((m) => m.subject === "Gutters")!.id };
}

test("mail send: a reply goes as its draft would, over STARTTLS, signed in as the account; its copy goes into Sent, seen", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(20);
    const { seen, list, id } = await icloud(t);
    assert.deepEqual(list.mailboxes.map((b) => [b.email, b.can_send, b.read_only]), [[EMAIL, true, false]]);
    assert.equal((await sendOf(t, { reply_to: id, text: "Yes, 10 AM.", preview: true })).status, 422, "a preview asked here never sends");
    const r = await sendOf(t, { reply_to: id, text: "Yes, 10 AM.", to: ["evil@x.example"], subject: "Other" });
    assert.equal(r.status, 200);
    const out = (await r.json()) as { id: string; state: string; to: string[]; subject: string; send_at: string };
    assert.deepEqual([out.state, out.to, out.subject], ["waiting", ["alex@example.com"], "Re: Gutters"], "the request's to and subject are not used");
    const done = await settled(t, out.id);
    assert.equal(done.state, "sent");
    assert.equal(server.got.length, 1, "sent once");
    const m = server.got[0];
    assert.deepEqual([m.from, m.to, m.secure, m.user], [EMAIL, ["alex@example.com"], true, EMAIL], "STARTTLS, then signed in as the account");
    const h = headersOf(m.raw);
    assert.ok(h.includes("To: alex@example.com"));
    assert.ok(h.includes("Subject: Re: Gutters"));
    assert.ok(h.includes("In-Reply-To: <g1@x>"));
    assert.ok(h.includes("References: <g0@x> <g1@x>"));
    assert.ok(h.includes(`From: "Robin" <${EMAIL}>`));
    assert.equal(bodyOf(m.raw), "Yes, 10 AM.");
    // The copy in Sent: the same message, flagged seen, and listed in Sent at once.
    await until("the copy in Sent", () => seen.appends.length === 1);
    assert.equal(seen.appends[0].path, "Sent Messages");
    assert.deepEqual(seen.appends[0].flags, ["\\Seen"]);
    assert.equal(seen.appends[0].raw.trimEnd(), m.raw.trimEnd(), "the copy is what was sent");
    const sent = list.folders.find((f) => f.role === "sent")!;
    await until("listed in Sent", async () => ((await (await t.api(`/mail/folders/${sent.key}`)).json()) as { messages: { subject: string }[] }).messages.some((x) => x.subject === "Re: Gutters"));
    assert.ok(!seen.calls.some((c) => /messageFlags|expunge|delete/i.test(c)), "a reply marks nothing else");
    assert.equal(((await (await t.api("/mail")).json()) as { outbox: Item[] }).outbox.length, 0, "sent mail is not listed as waiting");
  } finally { await finish(t, [server]); }
});

test("mail send: a Bcc is sent but never written into the message or its copy; an edited draft's old version goes to Trash; files go with it", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(20);
    const draft: Msg = { uid: 7, folder: "Drafts", at: ago(1), subject: "Quote", from: { address: EMAIL }, messageId: "d1@x", to: [ALEX], cc: [{ address: "sam@example.com" }], bcc: [{ address: "quiet@example.com" }], plain: "Draft words", seen: true };
    const { seen, list } = await icloud(t, [draft]);
    const drafts = list.folders.find((f) => f.role === "drafts")!;
    const kept = ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: { id: string; subject: string }[] }).messages.find((x) => x.subject === "Quote")!;
    const r = await sendOf(t, { to: "alex@example.com", subject: "Quote", text: "Here it is.", replaces: kept.id, files: [{ name: "plan.txt", type: "text/plain", data: Buffer.from("the plan").toString("base64") }] });
    assert.equal(r.status, 200);
    const out = (await r.json()) as { id: string; cc?: string[]; files?: { name: string }[] };
    assert.deepEqual(out.cc, ["sam@example.com"]);
    assert.equal(Object.hasOwn(out, "bcc"), false, "the answer does not list the Bcc either");
    assert.equal((await settled(t, out.id)).state, "sent");
    const m = server.got[0];
    assert.deepEqual([...m.to].sort(), ["alex@example.com", "quiet@example.com", "sam@example.com"], "the Bcc is in the envelope");
    assert.ok(!/^bcc:/im.test(m.raw.split("\r\n\r\n")[0]), "no Bcc header in what was sent");
    assert.ok(!m.raw.includes("quiet@example.com"), "the Bcc's address is nowhere in the message");
    assert.ok(headersOf(m.raw).includes("Cc: sam@example.com"));
    assert.match(m.raw, /filename="plan\.txt"/);
    assert.ok(m.raw.includes(Buffer.from("the plan").toString("base64")));
    await until("the copy in Sent", () => seen.appends.some((a) => a.path === "Sent Messages"));
    const copy = seen.appends.find((a) => a.path === "Sent Messages")!;
    assert.ok(!copy.raw.includes("quiet@example.com"), "the copy in Sent has no Bcc");
    await until("the old draft in Trash", () => seen.moves.some((x) => x.from === "Drafts" && x.to === "Deleted Messages"));
    assert.equal(seen.appends.filter((a) => a.path === "Drafts").length, 0, "no new draft is saved for a mail sent");
  } finally { await finish(t, [server]); }
});

test("mail send: Undo inside the window takes it back and nothing is sent; once sent, it is too late", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(400);
    const { id } = await icloud(t);
    const out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    assert.equal((await state(t, out.id))?.state, "waiting");
    assert.equal(((await (await t.api("/mail")).json()) as { outbox: Item[] }).outbox[0].id, out.id, "the screen sees it waiting");
    const undo = await t.api(`/mail/outbox/${out.id}/undo`, { method: "POST" });
    assert.deepEqual(await undo.json(), { undone: true });
    await sleep(700);
    assert.equal(server.got.length, 0, "nothing was sent");
    assert.equal(await state(t, out.id), null, "it left the outbox");
    assert.equal((await t.api(`/mail/outbox/${out.id}/undo`, { method: "POST" })).status, 404);

    setSendDelay(20);
    const again = (await (await sendOf(t, { reply_to: id, text: "Yes, really." })).json()) as { id: string };
    assert.equal((await settled(t, again.id)).state, "sent");
    const late = await t.api(`/mail/outbox/${again.id}/undo`, { method: "POST" });
    assert.equal(late.status, 409);
    assert.match(((await late.json()) as { error: string }).error, /sent already/);
    assert.equal(server.got.length, 1);
  } finally { await finish(t, [server]); }
});

test("mail send: a hub that restarts inside the window sends the mail once, at its time", async () => {
  const a = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  let b: TestHub | null = null;
  try {
    setSendDelay(600);
    const { id } = await icloud(a);
    const out = (await (await sendOf(a, { reply_to: id, text: "See you then." })).json()) as { id: string };
    a.hub.close();
    // The same data folder, a new hub: what waited is sent at its time, by the hub that serves.
    b = makeHub({ dataDir: a.dir });
    startOutbox(b.hub);
    assert.equal((await state(b, out.id))?.state, "waiting");
    assert.equal(server.got.length, 0, "not before its time");
    assert.equal((await settled(b, out.id)).state, "sent");
    await sleep(900);
    assert.equal(server.got.length, 1, "once, never twice: the closed hub sent nothing");
    assert.ok(headersOf(server.got[0].raw).includes("In-Reply-To: <g1@x>"), "the message as it was built before the restart");
  } finally {
    if (b) await finish(b, [server]); else await server.close();
  }
});

test("mail send: a hub that starts after the time sends at once; one that stopped while sending never sends again by itself", async () => {
  const a = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  let b: TestHub | null = null;
  try {
    setSendDelay(60_000);
    const { id } = await icloud(a);
    const late = (await (await sendOf(a, { reply_to: id, text: "Late." })).json()) as { id: string };
    const cut = (await (await sendOf(a, { reply_to: id, text: "Cut off." })).json()) as { id: string };
    // The first one's time passed while the hub was stopped; the second was on its way to the server when it stopped.
    a.hub.mailDb.prepare("UPDATE outbox SET send_at = ? WHERE id = ?").run(new Date(Date.now() - 5000).toISOString(), late.id);
    a.hub.mailDb.prepare("UPDATE outbox SET state = 'sending' WHERE id = ?").run(cut.id);
    a.hub.close();
    b = makeHub({ dataDir: a.dir });
    startOutbox(b.hub);
    assert.equal((await settled(b, late.id, 4000)).state, "sent", "sent at once");
    const was = (await state(b, cut.id))!;
    assert.deepEqual([was.state, was.error], ["failed", STOPPED_WHILE_SENDING], "shown as not sent, and why");
    await sleep(300);
    assert.equal(server.got.length, 1, "the one that may have gone is not sent again by itself");
    // Try again sends the same message, with the same Message-ID (a server takes it as the same mail).
    setSendDelay(20);
    const before = b.hub.mailDb.prepare("SELECT message_id FROM outbox WHERE id = ?").get(cut.id) as { message_id: string };
    assert.equal((await b.api(`/mail/outbox/${cut.id}/retry`, { method: "POST" })).status, 200);
    assert.equal((await settled(b, cut.id)).state, "sent");
    assert.ok(headersOf(server.got[1].raw).includes(`Message-ID: <${before.message_id}>`));
  } finally {
    if (b) await finish(b, [server]); else await server.close();
  }
});

test("mail send: the mail is marked sent before the connection closes", async () => {
  const t = makeHub();
  const states: string[] = [];
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD, onClose: () => {
    const r = t.hub.mailDb.prepare("SELECT state FROM outbox").get() as { state: string } | undefined;
    if (r) states.push(r.state);
  } });
  try {
    setSendDelay(20);
    const { id } = await icloud(t);
    const out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    await settled(t, out.id);
    await until("the server saw the connection close", () => states.length > 0);
    assert.deepEqual(states, ["sent"], "already sent when the server saw the connection end");
  } finally { await finish(t, [server]); }
});

test("mail send: a refused password leaves the mail in the outbox, says why, and pauses nothing; Try again sends it", async () => {
  const t = makeHub();
  let server = await smtp({ secure: false, user: EMAIL, pass: "another-password" });
  try {
    setSendDelay(20);
    const { id } = await icloud(t);
    const out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    const failed = await settled(t, out.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error!, /^iCloud Mail did not accept the account's password for sending, so the mail was not sent/);
    assert.equal(server.got.length, 0);
    const listed = ((await (await t.api("/mail")).json()) as { outbox: Item[] }).outbox;
    assert.deepEqual(listed.map((x) => [x.id, x.state, x.subject, x.to]), [[out.id, "failed", "Re: Gutters", ["alex@example.com"]]], "never lost: the screen lists it");
    assert.equal(t.hub.connections.get().icloud![0].refused_at ?? null, null, "the mailbox is not paused: the owner pressed Send and is told");
    await server.close();
    server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
    assert.equal((await t.api(`/mail/outbox/${out.id}/retry`, { method: "POST" })).status, 200);
    assert.equal((await settled(t, out.id)).state, "sent");
    assert.equal(server.got.length, 1);
  } finally { await finish(t, [server]); }
});

test("mail send: a refused recipient sends to no one, pipelined or not, says which; Save draft puts it in Drafts with its Bcc", async () => {
  for (const pipelining of [true, false]) {
    const t = makeHub();
    const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD, refuse: ["nobody@example.com"], pipelining });
    try {
      setSendDelay(20);
      const { seen } = await icloud(t);
      const out = (await (await sendOf(t, { to: "alex@example.com, nobody@example.com", subject: "Plans", text: "Saturday?" })).json()) as { id: string };
      const failed = await settled(t, out.id);
      assert.equal(failed.state, "failed", `pipelining ${pipelining}`);
      assert.deepEqual(failed.refused, ["nobody@example.com"]);
      assert.match(failed.error!, /refused nobody@example\.com, so the mail was not sent to anyone/);
      assert.equal(server.got.length, 0, `all or nothing: Alex got nothing either (pipelining ${pipelining})`);
      // Save draft: to Drafts, as it was, and out of the outbox.
      const d = await t.api(`/mail/outbox/${out.id}/draft`, { method: "POST" });
      assert.equal(d.status, 200);
      assert.equal(((await d.json()) as { saved: boolean }).saved, true);
      const put = seen.appends.find((a) => a.path === "Drafts")!;
      assert.deepEqual(put.flags, ["\\Draft", "\\Seen"]);
      assert.ok(headersOf(put.raw).includes("To: alex@example.com, nobody@example.com"));
      assert.equal(await state(t, out.id), null);
    } finally { await finish(t, [server]); }
  }
});

test("mail send: a server that asks to try later, one that does not answer, and one whose certificate is not its name", async () => {
  const t = makeHub();
  let server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD, later: ["alex@example.com"] });
  try {
    setSendDelay(20);
    const { id } = await icloud(t);
    let out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    let failed = await settled(t, out.id);
    assert.match(failed.error!, /asked to try alex@example\.com again later, so the mail was not sent/);
    await server.close();
    // Nothing listens there any more.
    out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    failed = await settled(t, out.id);
    assert.match(failed.error!, /^iCloud Mail could not be reached from the hub, or stopped answering, so the mail was not sent/);
    server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD, servername: "smtp.wrong.example" });
    out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    failed = await settled(t, out.id);
    assert.match(failed.error!, /did not show a valid certificate for its name, so the hub sent nothing to it/);
    assert.equal(server.got.length, 0);
    // A server that does not offer STARTTLS is never written to in the clear, though it would take a password so.
    await server.close();
    server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD, noStartTls: true });
    out = (await (await sendOf(t, { reply_to: id, text: "Yes." })).json()) as { id: string };
    failed = await settled(t, out.id);
    assert.match(failed.error!, /did not offer STARTTLS, so the hub sent nothing to it/);
    assert.equal(server.got.length, 0);
  } finally { await finish(t, [server]); }
});

test("mail send: TLS on connect for Gmail with its app password, and no copy added to Sent (Gmail files its own)", async () => {
  const t = makeHub();
  const server = await smtp({ secure: true, user: GMAIL, pass: GMAIL_PASSWORD });
  try {
    setSendDelay(20);
    setMailLookup(async () => [{ address: "203.0.113.108" }]);
    t.hub.connections.update((c) => { c.imap = [{ email: GMAIL, preset: "gmail", host: "imap.gmail.com", port: 993, user: GMAIL, password: GMAIL_PASSWORD, linked_at: new Date().toISOString() }]; });
    const seen = fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }]);
    await t.api("/mail/refresh", { method: "POST" });
    const list = (await (await t.api("/mail")).json()) as { messages: MailSummary[]; mailboxes: { can_send: boolean }[] };
    assert.equal(list.mailboxes[0].can_send, true);
    const out = (await (await sendOf(t, { reply_to: list.messages[0].id, text: "Yes." })).json()) as { id: string };
    assert.equal((await settled(t, out.id)).state, "sent");
    assert.deepEqual([server.got[0].secure, server.got[0].user, server.got[0].from], [true, GMAIL, GMAIL]);
    await sleep(200);
    assert.equal(seen.appends.length, 0, "Gmail puts what its server sends into Sent Mail itself");
    const conn = ((await (await t.api("/connections")).json()) as { internet: { key: string; smtp: unknown }[] }).internet;
    assert.deepEqual(conn.find((x) => x.key === `imap:${GMAIL}`)!.smtp, { host: "smtp.gmail.com", port: 465, security: "tls" });
  } finally { await finish(t, [server]); }
});

test("mail send: a Read only mailbox and one without a sending server cannot send; the hub says so and keeps nothing", async () => {
  const t = makeHub();
  try {
    const { list, id } = await icloud(t, [], { read_only: true });
    assert.deepEqual(list.mailboxes.map((b) => [b.can_send, b.read_only]), [[true, true]]);
    const r = await sendOf(t, { reply_to: id, text: "Yes." });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /is set to Read only in Settings, Accounts, so Aeneas changes nothing in it/);
    assert.equal((t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n, 0);
  } finally { await finish(t); }

  const o = makeHub();
  try {
    setMailLookup(async () => [{ address: "203.0.113.25" }]);
    o.hub.connections.update((c) => { c.imap = [{ email: "robin@mail.example", preset: "imap", host: "imap.mail.example", port: 993, user: "robin@mail.example", password: PASSWORD, linked_at: new Date().toISOString() }]; });
    fake([]);
    const boxes = ((await (await o.api("/mail")).json()) as { mailboxes: { can_send: boolean }[] }).mailboxes;
    assert.deepEqual(boxes.map((b) => b.can_send), [false]);
    const r = await sendOf(o, { to: "alex@example.com", text: "Hi" });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /has no sending server, so Aeneas cannot send from it\. Add one on its page in Settings, Accounts/);
    const conn = ((await (await o.api("/connections")).json()) as { internet: { smtp: unknown }[] }).internet;
    assert.equal(conn[0].smtp, null);
  } finally { await finish(o); }
});

test("mail send: another account's sending server is checked once before it is kept, and never one on the owner's network", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: "robin@mail.example", pass: PASSWORD });
  try {
    const key = encodeURIComponent("imap:robin@mail.example");
    t.hub.connections.update((c) => { c.imap = [{ email: "robin@mail.example", preset: "imap", host: "imap.mail.example", port: 993, user: "robin@mail.example", password: PASSWORD, linked_at: new Date().toISOString() }]; });
    const put = (smtpBody: unknown) => t.api(`/connections/accounts/${key}/sending`, { method: "PUT", json: { smtp: smtpBody } });
    const ok = await put({ host: "smtp.mail.example", port: 587, security: "starttls" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { smtp: { host: "smtp.mail.example", port: 587, security: "starttls" } });
    assert.deepEqual(t.hub.connections.get().imap![0].smtp, { host: "smtp.mail.example", port: 587, security: "starttls" });
    assert.equal(server.got.length, 0, "a check signs in and sends nothing");
    // A name that answers an address on the owner's own network: refused before any connection.
    setSmtpTest(null);
    setMailLookup(async () => [{ address: "10.0.0.5" }]);
    const home = await put({ host: "smtp.home.example", port: 465, security: "tls" });
    assert.equal(home.status, 422);
    assert.match(((await home.json()) as { error: string }).error, /smtp\.home\.example is on your own network/);
    assert.deepEqual(t.hub.connections.get().imap![0].smtp, { host: "smtp.mail.example", port: 587, security: "starttls" }, "the one before stays");
    assert.equal((await put({ host: "10.0.0.5" })).status, 422, "a name, never an address");
    assert.equal((await put(null)).status, 200);
    assert.equal(t.hub.connections.get().imap![0].smtp, undefined);
    assert.equal((await t.api(`/connections/accounts/${encodeURIComponent(`icloud:${EMAIL}`)}/sending`, { method: "PUT", json: { smtp: null } })).status, 409, "iCloud's is fixed");
  } finally { await finish(t, [server]); }
});

test("mail send: Add account, Other mail, checks a sending server it is given, and adds the account without one", async () => {
  const t = makeHub();
  const server = await smtp({ secure: true, user: "robin@mail.example", pass: PASSWORD });
  try {
    setMailLookup(async () => [{ address: "203.0.113.25" }]);
    fake([]);
    const link = (smtpBody?: unknown) => t.api("/connections/imap", { method: "PUT", json: { email: "robin@mail.example", preset: "imap", host: "imap.mail.example", password: PASSWORD, ...(smtpBody === undefined ? {} : { smtp: smtpBody }) } });
    assert.equal((await link({ host: "smtp.mail.example", port: 465, security: "tls" })).status, 200);
    assert.deepEqual(t.hub.connections.get().imap![0].smtp, { host: "smtp.mail.example", port: 465, security: "tls" });
    // A new password later, with no word about sending: the server stays.
    assert.equal((await link()).status, 200);
    assert.deepEqual(t.hub.connections.get().imap![0].smtp, { host: "smtp.mail.example", port: 465, security: "tls" });
    await server.close();
    const wrong = await smtp({ secure: true, user: "robin@mail.example", pass: "another" });
    const r = await t.api("/connections/imap", { method: "PUT", json: { email: "alex@mail.example", preset: "imap", host: "imap.mail.example", password: PASSWORD, smtp: { host: "smtp.mail.example", security: "tls" } } });
    assert.equal(r.status, 422);
    assert.match(((await r.json()) as { error: string }).error, /smtp\.mail\.example did not accept this username and password for sending/);
    assert.equal(t.hub.connections.get().imap!.some((a) => a.email === "alex@mail.example"), false, "nothing kept");
    await finish(t, [wrong]);
  } catch (e) { await finish(t, [server]); throw e; }
});

test("mail send: the sending server's form: a name, TLS or STARTTLS, the port from the security when none is given", () => {
  assert.deepEqual(checkedSmtp({ host: "SMTP.Fastmail.com." }), { host: "smtp.fastmail.com", port: 587, security: "starttls" });
  assert.deepEqual(checkedSmtp({ host: "smtp.fastmail.com", port: 465 }), { host: "smtp.fastmail.com", port: 465, security: "tls" });
  assert.deepEqual(checkedSmtp({ host: "smtp.fastmail.com", security: "tls" }), { host: "smtp.fastmail.com", port: 465, security: "tls" });
  assert.equal(checkedSmtp(null), null);
  assert.equal(checkedSmtp({ host: "" }), null);
  for (const bad of [{ host: "192.168.1.2" }, { host: "smtp.fastmail.com", security: "none" }, { host: "smtp.fastmail.com", port: 70000 }, { host: "smtp fastmail.com" }, "smtp.fastmail.com"]) {
    assert.throws(() => checkedSmtp(bad), /sending server/, JSON.stringify(bad));
  }
});

test("mail send: only the owner sends: the assistant's tools cannot reach send or the outbox", () => {
  for (const [m, p] of [["POST", "/mail/send"], ["POST", "/mail/%73end"], ["GET", "/mail/outbox/abc"], ["POST", "/mail/outbox/abc/retry"], ["POST", "/mail/outbox/abc/draft"], ["POST", "/mail/outbox/abc/undo"], ["POST", "/mail/drafts"]] as const) {
    assert.notEqual(refuseToolCall(m, p), null, `${m} ${p}`);
  }
  // Since 2026-11-24 one tool writes a mail, propose_mail, and it only keeps it for the owner's tap (mail-proposals.test.ts).
  assert.deepEqual(TOOLS.filter((x) => /mail|smtp|outbox/i.test(x.name)).map((x) => x.name), ["propose_mail"]);
});

test("mail send: unlinking a mailbox or switching Mail off drops what waited to be sent from it", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(60_000);
    const { id } = await icloud(t);
    await sendOf(t, { reply_to: id, text: "One." });
    assert.equal((await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).status, 200);
    assert.equal((t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n, 0);
  } finally { await finish(t, [server]); }
});
