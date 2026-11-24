import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { notifyDeliveries } from "../src/mail-inbox.js";
import type { NotifyEvent } from "../src/bus.js";

// New-mail notifications. Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const PROMO = "List-Unsubscribe: <mailto:out@shop.example>\r\n";
const setNotify = (t: TestHub, body: unknown) => t.api("/mail/settings/notify", { method: "PUT", json: body });

async function setUp(msgs: Msg[]) {
  const t = makeHub();
  linked(t);
  fake(msgs);
  const events: NotifyEvent[] = [];
  t.hub.bus.on("notify", (e) => { if (e.kind === "mail") events.push(e); });
  await t.api("/mail/refresh", { method: "POST" });
  return { t, events };
}

test("mail notify: never for a mailbox's first refresh; then one notification for new mail from people, sender and subject", async () => {
  const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(2), subject: "Old one", from: ALEX, messageId: "o@x", plain: "x" }];
  const { t, events } = await setUp(msgs);
  try {
    assert.equal(events.length, 0, "the first 90 days are not news");
    msgs.push({ uid: 2, folder: "INBOX", at: new Date(), subject: "Lunch?", from: ALEX, messageId: "l@x", plain: "Noon?" });
    msgs.push({ uid: 3, folder: "INBOX", at: new Date(), subject: "Half off", from: { name: "Shop", address: "deals@shop.example" }, messageId: "p@x", plain: "Sale", headers: PROMO });
    await t.api("/mail/refresh", { method: "POST" });
    assert.deepEqual(events.map((e) => e.title), ["Alex: Lunch?"], "a person's mail; bundles are quiet until switched on");
  } finally { done(t); }
});

test("mail notify: a bundle switched on notifies; what it says follows the detail setting", async () => {
  const msgs: Msg[] = [];
  const { t, events } = await setUp(msgs);
  try {
    assert.equal((await setNotify(t, { bundle: "promos", on: true })).status, 200);
    await setNotify(t, { detail: "sender" });
    msgs.push({ uid: 3, folder: "INBOX", at: new Date(), subject: "Half off", from: { name: "Shop", address: "deals@shop.example" }, messageId: "p@x", plain: "Sale", headers: PROMO });
    msgs.push({ uid: 4, folder: "INBOX", at: new Date(), subject: "Lunch?", from: ALEX, messageId: "l@x", plain: "Noon?" });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(events.length, 1, "one notification for a refresh");
    assert.match(events[0].title, /^2 new mails from (Shop, Alex|Alex, Shop)$/);
    await setNotify(t, { detail: "count" });
    msgs.push({ uid: 5, folder: "INBOX", at: new Date(), subject: "Again", from: ALEX, messageId: "a@x", plain: "?" });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(events[1].title, "1 new mail");
    await setNotify(t, { people: false });
    msgs.push({ uid: 6, folder: "INBOX", at: new Date(), subject: "Quiet", from: ALEX, messageId: "q@x", plain: "?" });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(events.length, 2, "people switched off");
  } finally { done(t); }
});

test("mail notify: a held bundle is quiet when mail arrives and notifies when it shows", async () => {
  const msgs: Msg[] = [];
  const { t, events } = await setUp(msgs);
  try {
    const now = new Date();
    const slot = new Date(now.getTime() - 60_000);
    const hhmm = `${String(slot.getHours()).padStart(2, "0")}:${String(slot.getMinutes()).padStart(2, "0")}`;
    await setNotify(t, { bundle: "promos", on: true });
    await t.api("/mail/settings/bundles/promotions", { method: "PUT", json: { mode: "daily", time: hhmm } });
    msgs.push({ uid: 3, folder: "INBOX", at: new Date(now.getTime() - 3 * 3600_000), subject: "Half off", from: { name: "Shop", address: "deals@shop.example" }, messageId: "p@x", plain: "Sale", headers: PROMO });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(events.length, 0, "held: quiet when it arrives");
    assert.equal(notifyDeliveries(t.hub, new Date(now.getTime() - 5 * 60_000)), 0, "the first look only marks the time");
    assert.equal(notifyDeliveries(t.hub, now), 1);
    assert.equal(events[0].title, "Promotions: Shop: Half off");
    assert.equal(notifyDeliveries(t.hub, new Date(now.getTime() + 60_000)), 0, "once per showing");
  } finally { done(t); }
});

test("mail notify: settings are checked, and the assistant cannot change them", async () => {
  const { t } = await setUp([]);
  try {
    for (const bad of [{ people: "yes" }, { detail: "everything" }, { bundle: "promos" }, { bundle: "made-up", on: true }]) {
      assert.ok([404, 422].includes((await setNotify(t, bad)).status), JSON.stringify(bad));
    }
    const list = await (await t.api("/mail")).json() as { mail_notify: unknown };
    assert.deepEqual(list.mail_notify, { people: true, bundles: [], detail: "full" });
    assert.ok(refuseToolCall("PUT", "/mail/settings/notify"));
  } finally { done(t); }
});
