import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { setMailboxFeatures } from "../src/imports/icloud.js";
import { deleteMailbox } from "../src/mail-inbox.js";

// One account, three uses: Mail receipts (`mail`), the Mail screen (`inbox`) and calendar sync (`calendar`). Its
// password stays on the hub while any of them uses it, and every way of unlinking takes the kept mail with it.
// Made-up account and mail.

const CAL = { calendars: [], chosen: [], target: null };
const box = (): Msg[] => [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Hello", from: { name: "Alex", address: "alex@northwind.example" }, messageId: "a1@x", plain: "Hi" }];
const on = (t: TestHub) => t.api("/modules", { method: "PUT", json: { mail_inbox: true, mail: true, calendars: true } });
const account = (t: TestHub) => (t.hub.connections.get().icloud ?? []).find((a) => a.email === EMAIL);
const kept = (t: TestHub) => (t.hub.mailDb.prepare("SELECT count(*) AS n FROM inbox").get() as { n: number }).n;
const key = encodeURIComponent(ACCOUNT);

test("accounts: stopping calendar sync keeps the password while the Mail screen reads the mailbox", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake(box());
    linked(t, { mail: false, inbox: true, calendar: CAL });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 1);
    const r = await t.api(`/calendars/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.match(((await r.json()) as { message: string }).message, /Mail still reads this address/);
    assert.equal(account(t)?.password, PASSWORD, "the Mail screen's password is still there");
    assert.equal(account(t)?.calendar, undefined);
    assert.equal(((await (await t.api("/mail/refresh", { method: "POST" })).json()) as { mailboxes: { error?: string }[] }).mailboxes[0].error, undefined, "and the mailbox still refreshes");
    // With nothing reading its mail, the password goes with calendar sync.
    linked(t, { mail: false, inbox: false, calendar: CAL });
    assert.match(((await (await t.api(`/calendars/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).json()) as { message: string }).message, /password is deleted/);
    assert.equal(account(t), undefined);
  } finally { done(t); }
});

test("accounts: Unlink of a mailbox with calendars stops Receipts and the Mail screen, and its kept mail goes", async () => {
  const t = makeHub();
  try {
    await on(t);
    const seen = fake(box());
    // The Mail switch was used once, so it is kept on its own: only `mail` set to false left the Inbox read on.
    linked(t, { mail: true, inbox: true, calendar: CAL });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 1);
    const r = await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal(account(t)?.mail, false);
    assert.equal(account(t)?.inbox, false);
    assert.ok(account(t)?.calendar, "calendar sync goes on with the same password");
    assert.equal(kept(t), 0);
    const connects = seen.connects;
    assert.deepEqual(((await (await t.api("/mail/refresh", { method: "POST" })).json()) as { mailboxes: unknown[] }).mailboxes, []);
    assert.equal(seen.connects, connects, "no sign-in to a mailbox the hub said it stopped reading");
  } finally { done(t); }
});

test("accounts: Remove account is one call: calendars, mail and password, also when only calendars used it", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake(box());
    // Only calendars: stopping them removes the account, and nothing may fail after that.
    linked(t, { mail: false, inbox: false, calendar: CAL });
    let r = await t.api(`/connections/accounts/${key}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.match(((await r.json()) as { message: string }).message, /removed and its password deleted/);
    assert.equal(account(t), undefined);
    // The Mail screen and calendars: everything goes, the kept mail too.
    linked(t, { mail: false, inbox: true, calendar: CAL });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 1);
    r = await t.api(`/connections/accounts/${key}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal(account(t), undefined);
    assert.equal(kept(t), 0);
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM mailboxes").get() as { n: number }).n, 0);
    // Not linked: said so, and mail left behind by anything else still goes.
    t.hub.mailDb.prepare("INSERT INTO inbox (account, id, key, at, from_name, from_address, subject, text, automated, unsubscribe) VALUES (?, '1:1:INBOX', 'k1', ?, '', 'a@x.example', 's', 't', 0, 0)").run(ACCOUNT, new Date().toISOString());
    assert.equal((await t.api(`/connections/accounts/${key}`, { method: "DELETE" })).status, 404);
    assert.equal(kept(t), 0);
    // The route answers while any of the three modules is on, and not with all of them off.
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false, mail: false, calendars: false } });
    assert.equal((await t.api(`/connections/accounts/${key}`, { method: "DELETE" })).status, 404);
    assert.match(((await (await t.api(`/connections/accounts/${key}`, { method: "PUT", json: { inbox: true } })).json()) as { error: string }).error, /off|not found|module/i);
  } finally { done(t); }
});

test("accounts: a new password keeps the switches; only an account whose mail nothing reads is linked for mail again", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake([]);
    linked(t, { mail: false, inbox: true });
    assert.equal((await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } })).status, 200);
    assert.equal(account(t)?.mail, false, "Receipts stays off");
    assert.equal(account(t)?.inbox, true);
    linked(t, { mail: false, inbox: false, calendar: CAL });
    await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } });
    assert.equal(account(t)?.mail, true, "linked for calendars alone: now for mail too");
    assert.equal(account(t)?.inbox, undefined, "the Mail screen follows");
    assert.ok(account(t)?.calendar);
    // Linking starts a refresh behind the answer: waited for, so it does not outlive this hub.
    await t.api("/mail/refresh", { method: "POST" });
  } finally { done(t); }
});

test("accounts: a mailbox only the Mail screen reads is listed with the mailboxes, so every app can see and unlink it", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake([]);
    linked(t, { mail: false, inbox: true });
    const c = (await (await t.api("/connections")).json()) as { icloud: { accounts: { email: string; receipts: boolean; inbox: boolean; password?: string }[] } };
    assert.deepEqual(c.icloud.accounts.map((a) => ({ email: a.email, receipts: a.receipts, inbox: a.inbox })), [{ email: EMAIL, receipts: false, inbox: true }]);
    assert.equal(JSON.stringify(c).includes(PASSWORD), false);
    linked(t, { mail: false, inbox: false, calendar: CAL });
    assert.deepEqual(((await (await t.api("/connections")).json()) as typeof c).icloud.accounts, [], "one linked for calendars alone is not a mailbox");
  } finally { done(t); }
});

test("accounts: Mail switched off for a mailbox while a refresh reads it: nothing of that refresh is kept", async () => {
  const t = makeHub();
  try {
    await on(t);
    linked(t);
    // The owner unticks Mail while the listing downloads the first mail's text (linking starts a refresh at once).
    let off = false;
    const m: Msg = { uid: 1, folder: "INBOX", at: ago(1), subject: "Hello", from: { address: "alex@northwind.example" }, messageId: "a1@x" };
    Object.defineProperty(m, "plain", { enumerable: true, get() {
      if (!off) { off = true; setMailboxFeatures(t.hub, ACCOUNT, { inbox: false }); deleteMailbox(t.hub.mailDb, ACCOUNT); }
      return "Hi";
    } });
    fake([m]);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(off, true, "the switch went off during the listing");
    assert.equal(kept(t), 0, "the mail the running refresh read is not kept");
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM mailboxes").get() as { n: number }).n, 0);
    assert.deepEqual(((await (await t.api("/mail")).json()) as { messages: unknown[]; mailboxes: unknown[] }).mailboxes, []);
  } finally { done(t); }
});

test("accounts: mail kept of a mailbox no longer shown is cleared by the next refresh", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake(box());
    linked(t);
    t.hub.mailDb.prepare("INSERT INTO inbox (account, id, key, at, from_name, from_address, subject, text, automated, unsubscribe) VALUES ('icloud:gone@icloud.example', '1:1:INBOX', 'k1', ?, '', 'a@x.example', 's', 't', 0, 0)").run(new Date().toISOString());
    await t.api("/mail/refresh", { method: "POST" });
    assert.deepEqual((t.hub.mailDb.prepare("SELECT DISTINCT account FROM inbox").all() as { account: string }[]).map((r) => r.account), [ACCOUNT]);
  } finally { done(t); }
});

test("accounts: the last use switched off removes the account with its password; calendar sync keeps it", async () => {
  const t = makeHub();
  try {
    await on(t);
    fake(box());
    const put = async (body: unknown) => (await (await t.api(`/connections/accounts/${key}`, { method: "PUT", json: body })).json()) as { receipts: boolean; inbox: boolean; removed?: boolean; message?: string };
    // Calendar sync uses the account: it stays whatever the mail switches say, and its kept mail goes.
    linked(t, { calendar: CAL });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 1);
    assert.deepEqual(await put({ inbox: false, receipts: false }), { receipts: false, inbox: false, read_only: false });
    assert.equal(account(t)?.password, PASSWORD);
    assert.equal(kept(t), 0);
    // Without calendars: Receipts off leaves the Mail screen's use.
    linked(t);
    assert.deepEqual(await put({ receipts: false }), { receipts: false, inbox: true, read_only: false });
    assert.equal(account(t)?.password, PASSWORD);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 1);
    // Mail off after it is the last use: the account goes, with its password and its kept mail.
    const r = await put({ inbox: false });
    assert.deepEqual([r.receipts, r.inbox, r.removed], [false, false, true]);
    assert.match(r.message ?? "", /Nothing on the hub uses this account now\. The account is removed and its password deleted from the hub/);
    assert.equal(account(t), undefined);
    assert.equal(kept(t), 0);
    assert.equal(JSON.stringify(t.hub.connections.get()).includes(PASSWORD), false);
    // An account already left with nothing on (by a hub from before this): only switching something off removes it.
    linked(t, { mail: false, inbox: false });
    assert.deepEqual(await put({}), { receipts: false, inbox: false, read_only: false });
    assert.ok(account(t), "a request that changes nothing removes nothing");
    assert.deepEqual(await put({ inbox: true }), { receipts: false, inbox: true, read_only: false });
    assert.ok(account(t));
    await t.api("/mail/refresh", { method: "POST" });
  } finally { done(t); }
});
