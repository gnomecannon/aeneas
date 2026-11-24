import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, FOLDERS, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailFolder, MailSummary } from "../src/mail-inbox.js";

// Delete (to Trash), Spam (to Junk), Not spam and Move to: IMAP MOVE only, each message checked again; nothing erased.
// Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?" },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "You won!", from: { address: "win@prize.example" }, messageId: "i2@x", plain: "Claim it" },
  { uid: 3, folder: "INBOX", at: ago(2), subject: "Receipt", from: { address: "orders@shop.example" }, messageId: "i3@x", plain: "Thanks" },
  { uid: 1, folder: "Junk", at: ago(1), subject: "Club news", from: { address: "club@lists.example" }, messageId: "j1@x", plain: "Saturday hike" },
];
const list = async (t: TestHub) => (await (await t.api("/mail")).json()) as { messages: MailSummary[]; folders: MailFolder[] };
const inFolder = async (t: TestHub, role: string) => {
  const f = (await list(t)).folders.find((x) => x.role === role)!;
  return ((await (await t.api(`/mail/folders/${f.key}`)).json()) as { messages: MailSummary[] }).messages;
};
const move = async (t: TestHub, ids: string[], to: string) => t.api("/mail/move", { method: "POST", json: { ids, to } });
const byS = (ms: MailSummary[], s: string) => ms.find((m) => m.subject === s)!;

test("mail move: Delete puts Inbox mail in Trash with MOVE, kept there at once; Undo brings it back", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const lunch = byS((await list(t)).messages, "Lunch?");
    const r = await (await move(t, [lunch.id], "trash")).json() as { moved: string[]; failed: number; to: Record<string, string> };
    assert.deepEqual([r.moved, r.failed], [[lunch.id], 0]);
    assert.equal(msgs.find((m) => m.messageId === "i1@x")!.folder, "Deleted Messages", "in iCloud's Trash");
    assert.ok(!(await list(t)).messages.some((m) => m.subject === "Lunch?"), "out of the Inbox");
    const trash = await inFolder(t, "trash");
    assert.deepEqual(trash.map((m) => [m.subject, m.id]), [["Lunch?", r.to[lunch.id]]], "kept in Trash under its new id");
    assert.deepEqual([seen.flags.length, seen.appends.length], [0, 0], "only MOVE");
    assert.ok(seen.calls.every((c) => !/expunge|delete/i.test(c)));

    const back = await (await move(t, [r.to[lunch.id]], "inbox")).json() as { moved: string[] };
    assert.equal(back.moved.length, 1);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(msgs.find((m) => m.messageId === "i1@x")!.folder, "INBOX");
    assert.ok((await list(t)).messages.some((m) => m.subject === "Lunch?" && m.state === "inbox"), "back in the Inbox");
    assert.deepEqual(await inFolder(t, "trash"), []);
  } finally { done(t); }
});

test("mail move: Spam and Not spam, and Move to one of the owner's folders", async () => {
  const t = makeHub();
  FOLDERS.push({ path: "Receipts", flags: new Set() });
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const ms = (await list(t)).messages;
    await move(t, [byS(ms, "You won!").id], "junk");
    assert.equal(msgs.find((m) => m.messageId === "i2@x")!.folder, "Junk");
    const club = byS(await inFolder(t, "junk"), "Club news");
    await move(t, [club.id], "inbox");
    assert.equal(msgs.find((m) => m.messageId === "j1@x")!.folder, "INBOX", "Not spam");
    const own = (await list(t)).folders.find((f) => f.role === "own")!;
    assert.equal(own.name, "Receipts");
    await move(t, [byS(ms, "Receipt").id], own.key);
    assert.equal(msgs.find((m) => m.messageId === "i3@x")!.folder, "Receipts");
    assert.deepEqual((await inFolder(t, "own")).map((m) => m.subject), ["Receipt"]);
  } finally { FOLDERS.pop(); done(t); }
});

test("mail move: only to the Inbox, Trash, Junk or the owner's folders, and only the message the hub kept", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const { messages, folders } = await list(t);
    const lunch = byS(messages, "Lunch?");
    for (const to of ["Drafts", "Sent Messages", "archive", "../INBOX", folders.find((f) => f.role === "drafts")!.key, folders.find((f) => f.role === "trash")!.key]) {
      assert.equal((await move(t, [lunch.id], to)).status, 422, to);
    }
    assert.equal(msgs.find((m) => m.messageId === "i1@x")!.folder, "INBOX", "nothing moved");
    // Another message took its place in iCloud (its Message-ID differs): not moved.
    msgs.find((m) => m.messageId === "i1@x")!.messageId = "other@x";
    const r = await (await move(t, [lunch.id], "trash")).json() as { moved: string[]; failed: number; error?: string };
    assert.deepEqual([r.moved.length, r.failed], [0, 1]);
    assert.match(r.error ?? "", /changed in the mailbox/);
    assert.equal(msgs.find((m) => m.messageId === "other@x")!.folder, "INBOX");
  } finally { done(t); }
});

test("mail move: deleting a snoozed mail is done with its snooze task", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const lunch = byS((await list(t)).messages, "Lunch?");
    await t.api(`/mail/messages/${lunch.id}/snooze`, { method: "POST", json: { until: new Date(Date.now() + 86400_000).toISOString() } });
    const task = () => t.hub.store.list({ kind: "task" }).find((x) => x.fields.mail === lunch.id);
    assert.ok(task(), "a snooze task");
    await move(t, [lunch.id], "trash");
    assert.equal(task()?.fields.status, "done");
  } finally { done(t); }
});
