import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailSummary } from "../src/mail-inbox.js";

// Threads: mail grouped by In-Reply-To and References (a reply without them by its subject), with the owner's own replies
// from Sent. Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const ME = { name: "Robin", address: EMAIL };
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const threadOf = async (t: TestHub, subject: string) => (await list(t)).find((m) => m.subject === subject)!.thread;
const conversation = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" },
  { uid: 2, folder: "Sent Messages", at: ago(2.5), subject: "Re: Gutters", from: ME, messageId: "me1@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Yes, 10 AM." },
  { uid: 3, folder: "INBOX", at: ago(2), subject: "Re: Gutters", from: ALEX, messageId: "g2@x", inReplyTo: "me1@x", references: "<g1@x> <me1@x>", plain: "Great, bring the ladder." },
  { uid: 4, folder: "INBOX", at: ago(1), subject: "Something else", from: ALEX, messageId: "o1@x", plain: "Unrelated." },
  { uid: 5, folder: "Sent Messages", at: ago(1), subject: "Hello there", from: ME, messageId: "me2@x", plain: "A mail of mine to someone else." },
];

test("mail threads: a back-and-forth is one thread, the owner's reply from Sent in it; other sent mail is not read", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(conversation());
    await t.api("/mail/refresh", { method: "POST" });
    const ms = await list(t);
    const gutters = ms.filter((m) => m.thread === ms.find((x) => x.subject === "Gutters")!.thread);
    assert.deepEqual(gutters.map((m) => [m.subject, m.state, !!m.mine]).sort(), [["Gutters", "inbox", false], ["Re: Gutters", "inbox", false], ["Re: Gutters", "sent", true]]);
    assert.notEqual(await threadOf(t, "Something else"), gutters[0].thread);
    assert.ok(!ms.some((m) => m.subject === "Hello there"), "a sent mail answering nothing kept is in no thread");
    // The Inbox's listing fetches the text of 3 Inbox mails and 1 reply; since 2026-11-20 the Sent folder is also a
    // folder of its own on the screen (mail-folders.test.ts), which keeps its 2 mails' text like the Inbox's.
    assert.equal(seen.calls.filter((c) => c === "download").length, 6);
    assert.ok(seen.opened.every((o) => o.readOnly === true), "Sent is read read-only too");
  } finally { done(t); }
});

test("mail threads: a reply without thread headers joins by its subject and sender, within 30 days", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(5), subject: "Dinner Friday", from: ALEX, messageId: "d1@x", plain: "?" },
      { uid: 2, folder: "INBOX", at: ago(4), subject: "RE: Dinner Friday", from: ALEX, messageId: "d2@x", plain: "Also, 7 PM." },
      { uid: 3, folder: "INBOX", at: ago(3), subject: "Re: Dinner Friday", from: { name: "Sam", address: "sam@example.com" }, messageId: "d3@x", plain: "Another person's." },
    ]);
    await t.api("/mail/refresh", { method: "POST" });
    const ms = await list(t);
    const by = (words: string) => ms.find((m) => m.preview.includes(words))!;
    assert.equal(by("7 PM").thread, by("?").thread);
    assert.notEqual(by("Another person").thread, by("?").thread, "another sender's Re: is not joined by subject alone");
  } finally { done(t); }
});

test("mail threads: Pin and Snooze act on the whole thread; a new reply brings a snoozed thread back", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = conversation();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const first = (await list(t)).find((m) => m.subject === "Gutters")!;
    await t.api(`/mail/messages/${first.id}/pin`, { method: "POST", json: { pinned: true } });
    assert.ok((await list(t)).filter((m) => m.thread === first.thread).every((m) => m.pinned));
    await t.api(`/mail/messages/${first.id}/snooze`, { method: "POST", json: { until: new Date(Date.now() + 86400_000).toISOString() } });
    const after = (await list(t)).filter((m) => m.thread === first.thread);
    assert.deepEqual(after.map((m) => m.state).sort(), ["sent", "snoozed", "snoozed"], "received mail snoozed; the owner's reply stays");
    assert.equal(t.hub.store.list({ kind: "task", limit: 100 }).filter((x) => x.fields.mail).length, 1, "one task for the thread");

    msgs.push({ uid: 9, folder: "INBOX", at: ago(0), subject: "Re: Gutters", from: ALEX, messageId: "g3@x", references: "<g1@x> <me1@x> <g2@x>", plain: "Running late!" });
    await t.api("/mail/refresh", { method: "POST" });
    const back = (await list(t)).filter((m) => m.thread === first.thread);
    assert.deepEqual(back.map((m) => m.state).sort(), ["inbox", "inbox", "inbox", "sent"], "the reply woke the thread");
    assert.ok(t.hub.store.list({ kind: "task", limit: 100 }).filter((x) => x.fields.mail).every((x) => x.deleted_at), "its snooze task is gone");
  } finally { done(t); }
});

test("mail threads: mail kept before threads gets its headers at the next refresh; the owner's reply goes with its thread", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = conversation();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    // As if kept before threads: no thread headers kept, each on its own.
    t.hub.mailDb.prepare("UPDATE inbox SET refs = NULL, thread = NULL").run();
    await t.api("/mail/refresh", { method: "POST" });
    const ms = await list(t);
    const gutters = ms.filter((m) => m.thread === ms.find((x) => x.subject === "Gutters")!.thread);
    assert.equal(gutters.length, 3, "joined again from the headers read at refresh");

    // The thread's received mail leaves the Inbox (archived in Apple Mail): the owner's reply goes with it.
    for (const m of msgs.filter((x) => x.folder === "INBOX" && x.subject.includes("Gutters"))) m.folder = "Archive";
    await t.api("/mail/refresh", { method: "POST" });
    assert.ok(!(await list(t)).some((m) => m.subject.includes("Gutters")));
  } finally { done(t); }
});

test("mail threads: each sent mail is looked at once, 500 a refresh, and a reply sent later still joins its thread", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    // 600 sent mails that answer nothing the hub keeps.
    for (let i = 0; i < 600; i++) msgs.push({ uid: 100 + i, folder: "Sent Messages", at: ago(2.9 - i / 10_000), subject: `To someone else ${i}`, from: ME, messageId: `else${i}@x`, plain: "Not a reply." });
    const seen = fake(msgs);
    const looks = () => seen.fetches.filter((f) => JSON.stringify(f).includes('"references"') && !JSON.stringify(f).includes("list-unsubscribe")).length;
    const refresh = async () => ((await (await t.api("/mail/refresh", { method: "POST" })).json()) as { mailboxes: { more?: boolean }[] }).mailboxes[0];
    assert.equal((await refresh()).more, true, "the first 500, the rest next time");
    assert.equal(looks(), 500);
    assert.equal((await refresh()).more, false);
    assert.equal(looks(), 600, "the other 100");
    await refresh();
    await refresh();
    assert.equal(looks(), 600, "none of them is looked at again");
    // The owner answers Alex: only that one mail is looked at, and it joins the thread.
    msgs.push({ uid: 900, folder: "Sent Messages", at: ago(0.1), subject: "Re: Gutters", from: ME, messageId: "me9@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Yes, 10 AM." });
    await refresh();
    assert.equal(looks(), 601);
    const ms = await list(t);
    assert.deepEqual(ms.filter((m) => m.thread === ms.find((x) => x.subject === "Gutters")!.thread).map((m) => [m.subject, !!m.mine]).sort(), [["Gutters", false], ["Re: Gutters", true]]);
    assert.ok(seen.opened.every((o) => o.readOnly === true));
  } finally { done(t); }
});
