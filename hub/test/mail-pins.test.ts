import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailSummary } from "../src/mail-inbox.js";

// Pins kept the same as Apple Mail's flag, both ways: only the \Flagged flag, fenced as the read flag. Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const ME = { name: "Robin", address: EMAIL };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" },
  { uid: 2, folder: "INBOX", at: ago(2), subject: "Re: Gutters", from: ALEX, messageId: "g2@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "10 AM?" },
  { uid: 3, folder: "INBOX", at: ago(1), subject: "Receipt", from: { address: "orders@shop.example" }, messageId: "r1@x", plain: "Thanks" },
  { uid: 1, folder: "Sent Messages", at: ago(2.5), subject: "Re: Gutters", from: ME, messageId: "me1@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Yes" },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const refresh = (t: TestHub) => t.api("/mail/refresh", { method: "POST" });
const pinnedSubjects = async (t: TestHub) => [...new Set((await list(t)).filter((m) => m.pinned && !m.mine).map((m) => m.subject))].sort();

test("mail pins: Pin flags the whole thread's received mail in iCloud (only \\Flagged); Unpin takes the flags off", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    const seen = fake(msgs);
    await refresh(t);
    const first = (await list(t)).find((m) => m.subject === "Gutters")!;
    const r = await (await t.api(`/mail/messages/${first.id}/pin`, { method: "POST", json: { pinned: true } })).json() as { synced: number };
    assert.equal(r.synced, 2, "both of Alex's mails");
    assert.deepEqual(msgs.filter((m) => m.flagged).map((m) => m.messageId).sort(), ["g1@x", "g2@x"], "not the owner's reply in Sent");
    assert.ok(seen.flags.every((f) => f.flags.length === 1 && f.flags[0] === "\\Flagged"), "only the flag");
    await refresh(t);
    assert.deepEqual(await pinnedSubjects(t), ["Gutters", "Re: Gutters"], "the refresh reads them back as pins");
    await t.api(`/mail/messages/${first.id}/pin`, { method: "POST", json: { pinned: false } });
    assert.deepEqual(msgs.filter((m) => m.flagged), []);
    await refresh(t);
    assert.deepEqual(await pinnedSubjects(t), []);
  } finally { done(t); }
});

test("mail pins: flagging or unflagging in Apple Mail pins or unpins on the next refresh", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await refresh(t);
    msgs.find((m) => m.messageId === "r1@x")!.flagged = true;
    await refresh(t);
    assert.deepEqual(await pinnedSubjects(t), ["Receipt"]);
    msgs.find((m) => m.messageId === "r1@x")!.flagged = false;
    await refresh(t);
    assert.deepEqual(await pinnedSubjects(t), []);
  } finally { done(t); }
});

test("mail pins: pins made before flags are flagged in iCloud once, not taken away by the first refresh", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await refresh(t);
    // As a hub from before: a pin on the hub alone, and no mark that pins were flagged.
    t.hub.mailDb.prepare("UPDATE inbox SET pinned = 1 WHERE message_id = 'r1@x'").run();
    t.hub.mailDb.prepare("DELETE FROM settings WHERE key = ?").run(`pins_flagged:${ACCOUNT}`);
    await refresh(t);
    assert.equal(msgs.find((m) => m.messageId === "r1@x")!.flagged, true, "flagged in iCloud");
    assert.deepEqual(await pinnedSubjects(t), ["Receipt"], "still pinned");
    // Done once: unflagged in Apple Mail afterwards, it is unpinned.
    msgs.find((m) => m.messageId === "r1@x")!.flagged = false;
    await refresh(t);
    assert.deepEqual(await pinnedSubjects(t), []);
  } finally { done(t); }
});

test("mail pins: a message that changed in iCloud is not flagged", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await refresh(t);
    const receipt = (await list(t)).find((m) => m.subject === "Receipt")!;
    msgs.find((m) => m.messageId === "r1@x")!.messageId = "other@x";
    const r = await (await t.api(`/mail/messages/${receipt.id}/pin`, { method: "POST", json: { pinned: true } })).json() as { synced: number; ok: boolean };
    assert.deepEqual([r.ok, r.synced], [true, 0], "pinned on the hub, not in iCloud");
    assert.equal(msgs.find((m) => m.messageId === "other@x")!.flagged, undefined);
  } finally { done(t); }
});
