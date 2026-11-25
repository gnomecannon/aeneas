import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeHub, type TestHub } from "./helpers.js";
import { scripted } from "./ai-helpers.js";
import { smtp, type Fake } from "./fake-smtp.js";
import { EMAIL, fake, linked, PASSWORD } from "./fake-icloud-mail.js";
import { setBackendOverride } from "../src/ai/backends.js";
import { setImapFactory, setMailLookup } from "../src/imports/icloud.js";
import { setSmtpTest } from "../src/imports/smtp.js";
import { setSendDelay } from "../src/mail-outbox.js";
import { proposeMail, purgeProposals } from "../src/mail-proposals.js";
import { refreshMail } from "../src/mail-inbox.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { MAIL_NOT_SENT, type ChatOutput } from "../src/ai/index.js";
import { runTool, TOOLS } from "../src/ai/tools.js";
import { ctxFor } from "./ai-helpers.js";

// A mail the assistant writes for the owner to send with one tap: the tool keeps a proposal and sends nothing; only
// the owner's Send on its card does, through the outbox. Made-up people and addresses; nothing leaves this machine.

type View = { id: string; state: string; to: string[]; cc: string[]; subject: string; text: string; from: { address: string }; files: { name: string; size: number }[]; error?: string; expires_at: string };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for: ${what}`);
}
async function finish(t: TestHub, servers: Fake[] = []) {
  setBackendOverride(null);
  await refreshMail(t.hub).catch(() => undefined);
  t.hub.close();
  setImapFactory(null);
  setSmtpTest(null);
  setSendDelay(null);
  setMailLookup(null);
  for (const s of servers) await s.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}
const view = async (t: TestHub, id: string) => ((await (await t.api(`/mail/proposals/${id}`)).json()) as View);
const post = (t: TestHub, id: string, what: string) => t.api(`/mail/proposals/${id}/${what}`, { method: "POST", json: {} });

/** The owner asks in a chat; the scripted model calls propose_mail with `args`, then answers `answer`. */
async function ask(t: TestHub, message: string, args: Record<string, unknown>, answer = "Here it is.", images?: string[]): Promise<{ out: ChatOutput; model: ReturnType<typeof scripted> }> {
  const model = scripted([() => ({ calls: [{ name: "propose_mail", arguments: args }] }), () => ({ text: answer })]);
  setBackendOverride(model);
  const out = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "mail-chat", message, ...(images ? { images } : {}) } })).json()) as ChatOutput;
  return { out, model };
}

test("mail proposals: the tool keeps a proposal and sends nothing; the reply and the chat carry its card, and say it is not sent", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(20);
    linked(t);
    t.hub.profile.set({ name: "Robin" });
    fake([]);
    const { out, model } = await ask(t, "Email alex@example.com that Saturday works", { to: ["alex@example.com"], subject: "Saturday", text: "Hi Alex,\n\nSaturday works.\n\nRobin" }, "I wrote it and sent it to Alex.");
    const id = out.mail_proposal?.id;
    assert.ok(id, "the reply names its proposal");
    assert.ok(out.reply.endsWith(MAIL_NOT_SENT), "a reply that says it was sent is set right");
    const toolResult = JSON.parse(model.seen[1].find((m) => m.role === "tool")!.content) as { status: string; instruction: string };
    assert.equal(toolResult.status, "waiting_for_owner");
    assert.match(toolResult.instruction, /nothing is sent until .* taps Send/);
    const stored = t.hub.ai.sessions.get("mail-chat")!.messages.at(-1)!;
    assert.deepEqual(stored.mail_proposal, { id });
    // Kept sealed: its words are not in the database in the clear.
    const row = t.hub.mailDb.prepare("SELECT body, state, account FROM mail_proposals WHERE id = ?").get(id) as { body: string; state: string; account: string };
    assert.deepEqual([row.state, row.account], ["proposed", `icloud:${EMAIL}`]);
    assert.ok(!row.body.includes("Saturday works"));
    const v = await view(t, id!);
    assert.deepEqual([v.state, v.from.address, v.to, v.subject, v.text], ["proposed", EMAIL, ["alex@example.com"], "Saturday", "Hi Alex,\n\nSaturday works.\n\nRobin"]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(server.got.length, 0, "the tool sent nothing");
    assert.equal((t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n, 0, "nothing in the outbox either");
    // A reply that says it plainly is left as it is.
    const plain = await ask(t, "And one to alex@example.com about Sunday", { to: "alex@example.com", subject: "Sunday", text: "Sunday too?" }, "It is below. Nothing is sent until you tap Send.");
    assert.equal(plain.out.reply, "It is below. Nothing is sent until you tap Send.");
  } finally { await finish(t, [server]); }
});

test("mail proposals: Send puts it in the outbox with its Undo; the card follows it to Sent, and the chat keeps that", async () => {
  const t = makeHub();
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  try {
    setSendDelay(400);
    linked(t);
    t.hub.profile.set({ name: "Robin" });
    fake([]);
    const { out } = await ask(t, "Mail alex@example.com and copy sam@example.com: the gutters are done", { to: ["alex@example.com"], cc: ["sam@example.com"], subject: "Gutters", text: "Done." });
    const id = out.mail_proposal!.id;
    let v = (await (await post(t, id, "send")).json()) as View;
    assert.equal(v.state, "waiting", "Sending, with Undo");
    // Undo: back to a proposal, and Send is offered again.
    v = (await (await post(t, id, "undo")).json()) as View;
    assert.equal(v.state, "proposed");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(server.got.length, 0);
    setSendDelay(20);
    assert.equal((await post(t, id, "send")).status, 200);
    await until("sent", async () => (await view(t, id)).state === "sent");
    assert.equal(server.got.length, 1);
    assert.deepEqual([...server.got[0].to].sort(), ["alex@example.com", "sam@example.com"]);
    assert.match(server.got[0].raw, /^Cc: sam@example\.com\r$/m);
    assert.equal((await post(t, id, "send")).status, 409, "once");
    assert.equal((await post(t, id, "cancel")).status, 409, "too late to cancel");
    assert.deepEqual(t.hub.ai.sessions.get("mail-chat")!.messages.at(-1)!.mail_proposal, { id, state: "sent" });
  } finally { await finish(t, [server]); }
});

test("mail proposals: Cancel deletes nothing but sends nothing; Edit hands the mail to the writing box with its pictures", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([]);
    const a = (await ask(t, "Write alex@example.com that I am late", { to: ["alex@example.com"], subject: "Late", text: "Ten minutes late." })).out.mail_proposal!.id;
    const c = (await (await post(t, a, "cancel")).json()) as View;
    assert.equal(c.state, "cancelled");
    assert.equal((await post(t, a, "send")).status, 409, "a cancelled mail is never sent");
    assert.deepEqual(t.hub.ai.sessions.get("mail-chat")!.messages.at(-1)!.mail_proposal, { id: a, state: "cancelled" });

    const b = (await ask(t, "Send this photo to alex@example.com", { to: ["alex@example.com"], subject: "The fence", text: "Here is the fence.", photos: true }, "It is below.", [PNG])).out.mail_proposal!.id;
    assert.deepEqual((await view(t, b)).files.map((f) => f.name), ["Photo 1.png"]);
    const e = (await (await post(t, b, "edit")).json()) as { to: string[]; subject: string; text: string; files: { name: string; type: string; data: string }[] };
    assert.deepEqual([e.to, e.subject, e.text, e.files.map((f) => [f.name, f.type, f.data])], [["alex@example.com"], "The fence", "Here is the fence.", [["Photo 1.png", "image/png", PNG]]]);
    assert.equal((await view(t, b)).state, "edited");
    assert.equal((await post(t, b, "send")).status, 409, "after Edit it is sent from the Mail screen only");
  } finally { await finish(t); }
});

test("mail proposals: a proposal is gone 24 hours after it was made, and its card says so", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([]);
    const id = (await ask(t, "Email alex@example.com", { to: ["alex@example.com"], subject: "Hi", text: "Hi." })).out.mail_proposal!.id;
    assert.equal(purgeProposals(t.hub, new Date(Date.now() + 23 * 3600_000)), 0);
    assert.equal(purgeProposals(t.hub, new Date(Date.now() + 25 * 3600_000)), 1);
    const r = await t.api(`/mail/proposals/${id}`);
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as { error: string }).error, /after 24 hours it is gone\. Nothing was sent/);
    assert.equal((await post(t, id, "send")).status, 404);
  } finally { await finish(t); }
});

test("mail proposals: only addresses the owner gave or that are in People; Read only, no sending server and Mail off say why", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([]);
    const turn = { sessionId: "s", ownerText: "write to alex@example.com about the fence", photoIds: [] };
    // An address the owner never gave (one a page or a mail could have put in front of the model) is refused.
    assert.throws(() => proposeMail(t.hub, { to: ["collect@evil.example"], subject: "x", text: "x" }, turn), /only write to addresses you gave me in this chat or that are in People, and collect@evil\.example is neither/);
    assert.throws(() => proposeMail(t.hub, { to: ["alex@example.com"], cc: ["boss@evil.example"], subject: "x", text: "x" }, turn), /boss@evil\.example is neither/);
    // One in People is fine.
    t.hub.store.create("person", { name: "Jamie Lee", emails: [{ value: "Jamie@Example.com" }] });
    assert.ok(proposeMail(t.hub, { to: ["jamie@example.com"], subject: "x", text: "x" }, turn).id);
    assert.throws(() => proposeMail(t.hub, { to: ["alex@example.com"], from: "nobody@else.example", subject: "x", text: "x" }, turn), /not one of your linked mailboxes/);

    t.hub.connections.update((c) => { c.icloud![0].read_only = true; });
    assert.throws(() => proposeMail(t.hub, { to: ["alex@example.com"], subject: "x", text: "x" }, turn), /is set to Read only in Settings, Accounts/);
    t.hub.connections.update((c) => { c.icloud![0].read_only = false; });

    // Another mail account without a sending server.
    setMailLookup(async () => [{ address: "203.0.113.25" }]);
    t.hub.connections.update((c) => { c.icloud = []; c.imap = [{ email: "robin@mail.example", preset: "imap", host: "imap.mail.example", port: 993, user: "robin@mail.example", password: PASSWORD, linked_at: new Date().toISOString() }]; });
    assert.throws(() => proposeMail(t.hub, { to: ["alex@example.com"], subject: "x", text: "x" }, turn), /has no sending server, so Aeneas cannot send from it/);

    t.hub.modules.set({ mail_inbox: false });
    assert.throws(() => proposeMail(t.hub, { to: ["alex@example.com"], subject: "x", text: "x" }, turn), /^Error: Mail is off on this hub/);
    // The tool passes the reason on, as an error the model reads.
    const r = await runTool(async () => ({ status: 200, data: {} }), { name: "propose_mail", arguments: { to: ["alex@example.com"], subject: "x", text: "x" } }, { ...ctxFor(t), proposeMail: (a) => proposeMail(t.hub, a, turn) });
    assert.match(JSON.parse(r.text).error, /Mail is off on this hub/);
    assert.equal(r.ok, false);
  } finally { await finish(t); }
});

test("mail proposals: the assistant's tools can never send one, and capture filing never proposes one", async () => {
  for (const [m, p] of [["POST", "/mail/proposals/abc/send"], ["GET", "/mail/proposals/abc"], ["POST", "/mail/proposals/abc/edit"], ["POST", "/mail/proposals/abc/cancel"], ["POST", "/mail/proposals/abc/undo"], ["POST", "/mail/proposals/abc/retry"], ["POST", "/mail/%70roposals/abc/send"]] as const) {
    assert.notEqual(refuseToolCall(m, p), null, `${m} ${p}`);
  }
  const tool = TOOLS.find((x) => x.name === "propose_mail")!;
  assert.match(tool.description, /It sends nothing/);
  assert.match(tool.description, /Never say or suggest that a mail was sent/);
  const t = makeHub();
  try {
    // Outside a chat with the owner (a capture being filed) the tool has nothing to keep a proposal with.
    const r = await runTool(async () => ({ status: 200, data: {} }), { name: "propose_mail", arguments: { to: ["alex@example.com"], subject: "x", text: "x" } }, ctxFor(t));
    assert.match(JSON.parse(r.text).error, /only be written in a chat/);
  } finally { await finish(t); }
});

test("mail proposals: a mail that was not sent shows the hub's words; Try again sends it, Cancel takes it out of the outbox", async () => {
  const t = makeHub();
  let server = await smtp({ secure: false, user: EMAIL, pass: "another" });
  try {
    setSendDelay(20);
    linked(t);
    fake([]);
    const id = (await ask(t, "Email alex@example.com", { to: ["alex@example.com"], subject: "Hi", text: "Hi." })).out.mail_proposal!.id;
    await post(t, id, "send");
    await until("not sent", async () => (await view(t, id)).state === "failed");
    assert.match((await view(t, id)).error!, /did not accept the account's password for sending/);
    await server.close();
    server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
    assert.equal((await post(t, id, "retry")).status, 200);
    await until("sent", async () => (await view(t, id)).state === "sent");
    assert.equal(server.got.length, 1);

    const two = (await ask(t, "Email alex@example.com again", { to: ["alex@example.com"], subject: "Again", text: "Again." })).out.mail_proposal!.id;
    await server.close();
    server = await smtp({ secure: false, user: EMAIL, pass: "another" });
    await post(t, two, "send");
    await until("not sent", async () => (await view(t, two)).state === "failed");
    assert.equal(((await (await post(t, two, "cancel")).json()) as View).state, "cancelled");
    assert.equal((t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get() as { n: number }).n, 0, "out of the outbox");
  } finally { await finish(t, [server]); }
});
