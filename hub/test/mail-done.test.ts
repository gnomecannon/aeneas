import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { refreshMail, type MailSummary } from "../src/mail-inbox.js";

// Done and Undo: the Mail screen's only change to a mailbox, an IMAP MOVE between the Inbox and Archive. Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const inbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "a1@x", plain: "Saturday?" },
  { uid: 2, folder: "INBOX", at: ago(2), subject: "Receipt", from: { name: "Shop", address: "orders@shop.example" }, messageId: "r1@x", plain: "Thanks." },
  { uid: 3, folder: "INBOX", at: ago(1), subject: "Promo", from: { name: "Shop", address: "deals@shop.example" }, messageId: "p1@x", plain: "Sale." },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const byKey = async (t: TestHub, subject: string) => (await list(t)).find((m) => m.subject === subject)!;
const post = async (t: TestHub, path: string, ids: string[]) => (await (await t.api(path, { method: "POST", json: { ids } })).json()) as { moved: string[]; failed: number; error?: string };
/** Every call the hub may make to iCloud; a delete, flag, copy, append or expunge would show here as something else. */
const ALLOWED = new Set(["connect", "logout", "close", "list", "mailboxOpen", "search", "fetch", "fetchOne", "download", "messageMove"]);

test("mail done: Done moves the mail to Archive, it shows under Done, a refresh leaves it there, and Undo brings it back", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const gutters = await byKey(t, "Gutters");
    const r = await post(t, "/mail/done", [gutters.id]);
    assert.deepEqual(r, { moved: [gutters.id], failed: 0 });
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "Archive", "moved in iCloud");
    assert.deepEqual(seen.moves, [{ from: "INBOX", uid: 1, to: "Archive" }]);
    assert.equal((await byKey(t, "Gutters")).state, "done");
    assert.equal((await byKey(t, "Gutters")).id, gutters.id, "the screen's id stays the same");

    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await byKey(t, "Gutters")).state, "done", "a refresh does not bring it back");

    assert.deepEqual(await post(t, "/mail/undo", [gutters.id]), { moved: [gutters.id], failed: 0 });
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "INBOX");
    assert.equal((await byKey(t, "Gutters")).state, "inbox");
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await byKey(t, "Gutters")).state, "inbox", "and stays in the Inbox after a refresh");

    assert.ok(seen.calls.every((c) => ALLOWED.has(c)), seen.calls.filter((c) => !ALLOWED.has(c)).join(", "));
    assert.ok(seen.opened.filter((o) => o.readOnly === false).every((o) => o.path === "INBOX" || o.path === "Archive"), "read-write only to move");
  } finally { done(t); }
});

test("mail done: Sweep moves many at once, in one connection", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const ids = (await list(t)).map((m) => m.id);
    const connects = seen.connects;
    const r = await post(t, "/mail/done", ids);
    assert.equal(r.moved.length, 3);
    assert.equal(seen.connects, connects + 1);
    assert.ok(msgs.every((m) => m.folder === "Archive"));
  } finally { done(t); }
});

test("mail done: the fence: never a mail the hub does not keep, never a different mail at the same place, never without MOVE", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const [promo, receipt] = [await byKey(t, "Promo"), await byKey(t, "Receipt")];

    assert.deepEqual(await post(t, "/mail/done", ["000000000000000000000000"]), { moved: [], failed: 1, error: "One mail was not moved: it changed in the mailbox since the last refresh. Refresh and try again." });
    // Another message now sits at the receipt's UID (the folder was renumbered): its Message-ID differs, so it stays.
    msgs.find((m) => m.messageId === "r1@x")!.messageId = "someone-else@x";
    const r = await post(t, "/mail/done", [receipt.id]);
    assert.deepEqual([r.moved, r.failed], [[], 1]);
    assert.equal(msgs.find((m) => m.uid === 2)!.folder, "INBOX");
    // Undo of mail that is not done moves nothing.
    assert.deepEqual((await post(t, "/mail/undo", [promo.id])).moved, []);
    assert.deepEqual(seen.moves, []);

    // A server without MOVE: nothing is moved (a client would otherwise copy, mark deleted and expunge).
    const seen2 = fake(msgs, { noMove: true });
    const r2 = await post(t, "/mail/done", [promo.id]);
    assert.deepEqual([r2.moved, r2.failed], [[], 1]);
    assert.match(r2.error!, /did not offer to move mail/);
    assert.deepEqual(seen2.moves, []);
    assert.equal((await byKey(t, "Promo")).state, "inbox");
  } finally { done(t); }
});

test("mail done: bad requests are refused, and the assistant can neither archive nor undo", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(inbox());
    for (const body of [{}, { ids: [] }, { ids: "x" }, { ids: [1] }, { ids: Array.from({ length: 501 }, (_, i) => `k${i}`) }]) {
      assert.equal((await t.api("/mail/done", { method: "POST", json: body })).status, 422, JSON.stringify(body).slice(0, 40));
    }
    assert.ok(refuseToolCall("POST", "/mail/done"));
    assert.ok(refuseToolCall("POST", "/mail/undo"));
  } finally { done(t); }
});

test("mail done: done mail leaves the hub after 30 days (it stays in iCloud's Archive)", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    await post(t, "/mail/done", [(await byKey(t, "Gutters")).id]);
    await refreshMail(t.hub, {}, new Date(Date.now() + 29 * 86400_000));
    assert.ok((await list(t)).some((m) => m.subject === "Gutters"));
    await refreshMail(t.hub, {}, new Date(Date.now() + 31 * 86400_000));
    assert.ok(!(await list(t)).some((m) => m.subject === "Gutters"));
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "Archive");
  } finally { done(t); }
});

test("mail done: a refresh running while Done is pressed cannot put the mail back", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(inbox());
    await t.api("/mail/refresh", { method: "POST" });
    const id = (await byKey(t, "Gutters")).id;
    const [, r] = await Promise.all([refreshMail(t.hub, { owner: true }), post(t, "/mail/done", [id])]);
    assert.deepEqual(r.moved, [id]);
    await refreshMail(t.hub);
    assert.equal((await byKey(t, "Gutters")).state, "done");
  } finally { done(t); }
});

void EMAIL;
