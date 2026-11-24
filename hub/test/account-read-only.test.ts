import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailSummary } from "../src/mail-inbox.js";

// Read only on an Internet account (gnomecannon/aeneas#10): the hub writes nothing to it. Every write the Mail screen
// can make is refused by the hub itself, not only hidden on a screen, and the fake server shows nothing reached it.
// Made-up mail and addresses.

const ALEX = { name: "Alex", address: "alex@example.com" };
const inbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "a1@x", plain: "Saturday?" },
  { uid: 2, folder: "INBOX", at: ago(2), subject: "Deals", from: { name: "Shop", address: "deals@shop.example" }, messageId: "d1@x", plain: "Sale." },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[]; mailboxes: { email: string; read_only: boolean }[] });
const bySubject = async (t: TestHub, subject: string) => (await list(t)).messages.find((m) => m.subject === subject)!;
const setReadOnly = (t: TestHub, on: boolean) => t.api(`/connections/accounts/${encodeURIComponent(ACCOUNT)}`, { method: "PUT", json: { read_only: on } });
/** The calls that change a mailbox; none may reach a Read only one. */
const WRITES = ["messageMove", "messageFlagsAdd", "messageFlagsRemove", "append"];

test("read only: the switch is kept, shown in Internet Accounts and on the Mail screen, and is off for an account linked before it", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(inbox());
    const view = async () => ((await (await t.api("/connections")).json()) as { internet: { key: string; read_only: boolean }[] }).internet;
    assert.deepEqual((await view()).map((a) => [a.key, a.read_only]), [[ACCOUNT, false]], "an existing account is not read only");
    const r = await setReadOnly(t, true);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { receipts: true, inbox: true, read_only: true });
    assert.deepEqual((await view()).map((a) => a.read_only), [true]);
    assert.deepEqual((await list(t)).mailboxes.map((m) => [m.email, m.read_only]), [[EMAIL, true]]);
    assert.equal((await t.api(`/connections/accounts/${encodeURIComponent(ACCOUNT)}`, { method: "PUT", json: { read_only: "yes" } })).status, 422);
    // Its other switches stay as they were, and nothing else changed.
    assert.equal(t.hub.connections.get().icloud![0].mail, undefined);
  } finally { done(t); }
});

test("read only: Done, Delete, Spam, Pin and drafts are refused by the hub, and nothing reaches the mailbox", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    await setReadOnly(t, true);
    const gutters = await bySubject(t, "Gutters");
    const doneAnswer = (await (await t.api("/mail/done", { method: "POST", json: { ids: [gutters.id] } })).json()) as { moved: string[]; failed: number; error?: string };
    assert.deepEqual(doneAnswer.moved, []);
    assert.match(doneAnswer.error ?? "", /Read only/);
    const moveAnswer = (await (await t.api("/mail/move", { method: "POST", json: { ids: [gutters.id], to: "trash" } })).json()) as { moved: string[]; error?: string };
    assert.deepEqual(moveAnswer.moved, []);
    assert.match(moveAnswer.error ?? "", /Read only/);
    const pin = await t.api(`/mail/messages/${gutters.id}/pin`, { method: "POST", json: { pinned: true } });
    assert.equal(pin.status, 409);
    assert.match((await pin.json() as { error: string }).error, /Read only/);
    assert.equal((await bySubject(t, "Gutters")).pinned, false, "not pinned on the hub either");
    const draft = await t.api("/mail/drafts", { method: "POST", json: { reply_to: gutters.id, text: "Yes, Saturday works." } });
    assert.equal(draft.status, 409);
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "INBOX", "still in the Inbox");
    assert.equal((await bySubject(t, "Gutters")).state, "inbox");
    assert.deepEqual(seen.calls.filter((c) => WRITES.includes(c)), [], "no write reached the mailbox");
    assert.deepEqual(seen.opened.filter((o) => o.readOnly === false), [], "no folder opened for writing");

    // Switched off again, the same Done moves the mail.
    await setReadOnly(t, false);
    const again = (await (await t.api("/mail/done", { method: "POST", json: { ids: [gutters.id] } })).json()) as { moved: string[] };
    assert.deepEqual(again.moved, [gutters.id]);
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "Archive");
  } finally { done(t); }
});

test("read only: opening a mail marks it read on the hub only, and a refresh does not make it unread again", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    await setReadOnly(t, true);
    const gutters = await bySubject(t, "Gutters");
    const r = (await (await t.api(`/mail/messages/${gutters.id}/seen`, { method: "POST", json: { seen: true } })).json()) as { ok: boolean; synced: boolean };
    assert.deepEqual([r.ok, r.synced], [true, false], "kept on the hub, not written to the mailbox");
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.seen, undefined, "the mailbox is not told");
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await bySubject(t, "Gutters")).seen, true, "still read on the hub after a refresh");
    // Read in the mail app: the hub follows.
    msgs.find((m) => m.messageId === "d1@x")!.seen = true;
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await bySubject(t, "Deals")).seen, true);
    assert.deepEqual(seen.calls.filter((c) => WRITES.includes(c)), []);
  } finally { done(t); }
});

test("read only: a blocked sender's mail is left where it is", async () => {
  const t = makeHub();
  try {
    linked(t, { read_only: true });
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const b = (await (await t.api("/mail/settings/blocked", { method: "POST", json: { sender: "deals@shop.example" } })).json()) as { blocked: string[]; moved: number; error?: string };
    assert.deepEqual(b.blocked, ["deals@shop.example"], "the block itself is kept on the hub");
    assert.equal(b.moved, 0);
    assert.match(b.error ?? "", /Read only/);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(msgs.find((m) => m.messageId === "d1@x")!.folder, "INBOX");
    assert.deepEqual(seen.calls.filter((c) => WRITES.includes(c)), []);
  } finally { done(t); }
});

test("read only: Read now for one account lists that account only", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([]);
    t.hub.connections.update((c) => { c.icloud!.push({ email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop", linked_at: new Date().toISOString() }); });
    const one = (await (await t.api("/connections/icloud/sync", { method: "POST", json: { account: "icloud:jamie@icloud.example" } })).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(one), ["icloud:jamie@icloud.example"]);
    const all = (await (await t.api("/connections/icloud/sync", { method: "POST" })).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(all).sort(), [ACCOUNT, "icloud:jamie@icloud.example"].sort(), "no body: every account, as before");
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST", json: { account: 3 } })).status, 422);
    assert.ok(seen.connects > 0);
  } finally { done(t); }
});
