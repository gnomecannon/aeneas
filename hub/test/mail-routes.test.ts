import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { fetchMailImages, mailImages, type MailMessage, type MailSummary } from "../src/mail-inbox.js";
import { TorDown } from "../src/ai/web.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
/** A hub with Tor (its SOCKS address is only handed to the stand-in fetcher here). */
const TOR = "127.0.0.1:9";
/** The real fetchers, put back after a test swaps them. */
const real = { ...mailImages };

/** How many messages the Mail screen keeps. */
const kept = (t: TestHub) => (t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
const list = async (t: TestHub) => (await (await t.api("/mail")).json()) as { messages: MailSummary[]; mailboxes: { email: string; last_error: string | null; more: boolean }[] };

const ALEX = { name: "Alex", address: "alex@example.com" };
const INBOX: Msg[] = [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "a1@x", plain: "Hi Robin,\n\nCan you help with the gutters this weekend?\n\nThanks,\nAlex" },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "Your account", from: { name: "Your Bank", address: "alerts@bank.example" }, replyTo: { address: "help@b4nk-support.example" }, messageId: "p1@x", plain: "Please confirm your details today." },
  { uid: 3, folder: "Archive", at: ago(1), subject: "Archived already", from: ALEX, messageId: "z@x", plain: "x" },
];

test("mail routes: Refresh keeps the Inbox; the list has no text, a message has all of it, as written", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(INBOX);
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { email: string; kept: number; more: boolean }[] };
    assert.deepEqual(r.mailboxes, [{ email: EMAIL, kept: 2, gone: 0, more: false }]);
    const l = await list(t);
    assert.deepEqual(l.messages.map((m) => m.subject), ["Your account", "Gutters"], "newest first, Inbox only");
    assert.equal(l.messages[0].reply_to, "help@b4nk-support.example", "a Reply-To that differs comes with it");
    assert.equal(l.messages[1].preview, "Hi Robin, Can you help with the gutters this weekend? Thanks, Alex");
    assert.ok(!("text" in l.messages[1]));
    assert.equal(l.mailboxes[0].email, EMAIL);
    const m = await (await t.api(`/mail/messages/${l.messages[1].id}`)).json() as MailMessage;
    assert.equal(m.text, "Hi Robin,\n\nCan you help with the gutters this weekend?\n\nThanks,\nAlex", "nothing taken off");
    assert.equal((await t.api("/mail/messages/000000000000000000000000")).status, 404);
  } finally { done(t); }
});

test("mail routes: an HTML mail is kept cleaned, its web pictures fetched by the hub through Tor, and opens as a page that loads nothing", async () => {
  const t = makeHub({ torSocks: TOR });
  const fetched: string[] = [];
  try {
    linked(t);
    fake([{
      uid: 5, folder: "INBOX", at: ago(0), subject: "Your next coffee", from: { name: "Shop", address: "news@shop.example" }, messageId: "c@x",
      // A text part in Markdown, as some senders write it: the list reads the HTML instead.
      plain: "[Coffee](https://shop.example/all) [Account](https://shop.example/me)\n\nEstimated arrival: Sun",
      html: `<p><a href="https://shop.example/all">Coffee</a> <a href="https://shop.example/me">Account</a></p><p>Estimated arrival: Sun</p><img src="https://img.example/bean.png" alt="Beans"><img src="https://img.example/pixel.gif" width="1" height="1"><script>alert(1)</script>`,
    }]);
    mailImages.fetch = async (url, socks) => { assert.equal(socks, TOR); fetched.push(url); return url.endsWith("bean.png") ? PNG : null; };
    mailImages.direct = async (url) => { assert.fail(`fetched straight from the hub: ${url}`); };
    await t.api("/mail/refresh", { method: "POST" });
    await fetchMailImages(t.hub);
    const l = await list(t);
    assert.equal(l.messages[0].preview, "Coffee Account Estimated arrival: Sun", "link words only, from the HTML");
    assert.deepEqual(fetched, ["https://img.example/bean.png"], "every picture the mail shows, opened or not; never its 1 by 1 one");
    const m = await (await t.api(`/mail/messages/${l.messages[0].id}`)).json() as MailMessage;
    assert.deepEqual([m.pictures_pending, m.pictures_ask], [false, false]);
    assert.ok(m.html!.startsWith("<!doctype html>"));
    assert.match(m.html!, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
    assert.match(m.html!, /<img src="data:image\/png;base64,[^"]+" alt="Beans">/);
    assert.doesNotMatch(m.html!, /img\.example|<script|data-r=/, "no web address and nothing that runs");
    assert.match(m.html!, /<a href="https:\/\/shop\.example\/all">Coffee<\/a>/);
  } finally { Object.assign(mailImages, real); done(t); }
});

test("mail routes: a hub without Tor fetches no picture until Show pictures is pressed on a mail, and then only that mail's", async () => {
  const t = makeHub();
  const byTor: string[] = [];
  const direct: string[] = [];
  try {
    linked(t);
    fake([
      { uid: 5, folder: "INBOX", at: ago(0), subject: "Your next coffee", from: { name: "Shop", address: "news@shop.example" }, messageId: "c@x", plain: "Coffee",
        html: `<p>Coffee</p><img src="https://img.example/bean.png" alt="Beans"><img src="http://img.example/old.png" alt="Old"><img src="https://img.example/pixel.gif" width="1" height="1">` },
      { uid: 6, folder: "INBOX", at: ago(1), subject: "Sale", from: { name: "Store", address: "news@store.example" }, messageId: "d@x", plain: "Sale", html: `<p>Sale</p><img src="https://img.example/sale.png">` },
    ]);
    mailImages.fetch = async (url) => { byTor.push(url); return PNG; };
    mailImages.direct = async (url) => { direct.push(url); return PNG; };
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(await fetchMailImages(t.hub), 0);
    assert.deepEqual([byTor, direct], [[], []], "nothing leaves the hub on its own");
    const [coffee, sale] = (await list(t)).messages;
    let m = await (await t.api(`/mail/messages/${coffee.id}`)).json() as MailMessage;
    assert.deepEqual([m.pictures_ask, m.pictures_pending], [true, false]);
    assert.doesNotMatch(m.html!, /<img[^>]* src=/, "no picture yet");
    // Show pictures: this mail's, straight from the hub, https only (the http one is asked for over https), never the 1 by 1 one.
    const shown = await t.api(`/mail/messages/${coffee.id}/pictures`, { method: "POST" });
    assert.equal(shown.status, 200);
    m = await shown.json() as MailMessage;
    assert.deepEqual(direct, ["https://img.example/bean.png", "https://img.example/old.png"]);
    assert.deepEqual([m.pictures_ask, m.pictures_pending], [false, false]);
    assert.match(m.html!, /<img src="data:image\/png;base64,[^"]+" alt="Beans">/);
    // The other mail still waits, and asking again for the first fetches nothing more.
    assert.equal(((await (await t.api(`/mail/messages/${sale.id}`)).json()) as MailMessage).pictures_ask, true);
    assert.equal((await t.api(`/mail/messages/${coffee.id}/pictures`, { method: "POST" })).status, 200);
    assert.equal(direct.length, 2);
    assert.deepEqual(byTor, []);
    assert.equal((await t.api("/mail/messages/000000000000000000000000/pictures", { method: "POST" })).status, 404);
    assert.ok(refuseToolCall("POST", `/mail/messages/${sale.id}/pictures`), "the assistant cannot press it");
  } finally { Object.assign(mailImages, real); done(t); }
});

test("mail routes: a hub with Tor never fetches a picture another way, and its pictures wait while Tor is not answering", async () => {
  const t = makeHub({ torSocks: TOR });
  const direct: string[] = [];
  let up = false;
  try {
    linked(t);
    fake([{ uid: 5, folder: "INBOX", at: ago(0), subject: "Your next coffee", from: { name: "Shop", address: "news@shop.example" }, messageId: "c@x", plain: "Coffee", html: `<p>Coffee</p><img src="https://img.example/bean.png" alt="Beans">` }]);
    mailImages.fetch = async () => { if (!up) throw new TorDown(); return PNG; };
    mailImages.direct = async (url) => { direct.push(url); return PNG; };
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(await fetchMailImages(t.hub), 0, "Tor is not there: the mail is not given up on");
    const id = (await list(t)).messages[0].id;
    let m = await (await t.api(`/mail/messages/${id}`)).json() as MailMessage;
    assert.deepEqual([m.pictures_pending, m.pictures_ask], [true, false]);
    assert.equal((await t.api(`/mail/messages/${id}/pictures`, { method: "POST" })).status, 409);
    assert.deepEqual(direct, [], "never straight from the hub while it has Tor");
    up = true;
    assert.equal(await fetchMailImages(t.hub), 1);
    m = await (await t.api(`/mail/messages/${id}`)).json() as MailMessage;
    assert.equal(m.pictures_pending, false);
    assert.match(m.html!, /<img src="data:image\/png;base64,[^"]+" alt="Beans">/);
  } finally { Object.assign(mailImages, real); done(t); }
});

test("mail routes: one picture shown thousands of times neither fills the hub nor holds up the mail after it", async () => {
  const t = makeHub({ torSocks: TOR });
  // 2 MB that begin as a PNG does, as a hostile server would answer.
  const big = Buffer.concat([PNG, Buffer.alloc(2_000_000 - PNG.length)]);
  const fetched: string[] = [];
  try {
    linked(t);
    fake([
      { uid: 5, folder: "INBOX", at: ago(0), subject: "Many pictures", from: { name: "Sender", address: "news@evil.example" }, messageId: "h@x", plain: "x", html: `<p>x</p>${'<img src="https://evil.example/p.png">'.repeat(2000)}` },
      { uid: 6, folder: "INBOX", at: ago(1), subject: "Your next coffee", from: { name: "Shop", address: "news@shop.example" }, messageId: "c@x", plain: "Coffee", html: `<p>Coffee</p><img src="https://img.example/bean.png" alt="Beans">` },
    ]);
    mailImages.fetch = async (url) => { fetched.push(url); return url.includes("evil") ? big : PNG; };
    await t.api("/mail/refresh", { method: "POST" });
    await fetchMailImages(t.hub);
    assert.deepEqual(fetched.sort(), ["https://evil.example/p.png", "https://img.example/bean.png"], "each address once, the older mail's too");
    const [many, coffee] = (await list(t)).messages;
    const m = await (await t.api(`/mail/messages/${many.id}`)).json() as MailMessage;
    assert.equal(m.pictures_pending, false);
    assert.ok(m.html!.length < 13_500_000, `the mail is ${m.html!.length} characters`);
    assert.equal(m.html!.split('src="data:').length - 1, 4, "the picture as often as fits, the other tags empty");
    const c = await (await t.api(`/mail/messages/${coffee.id}`)).json() as MailMessage;
    assert.match(c.html!, /<img src="data:image\/png;base64,[^"]+" alt="Beans">/);
    // Nothing is left waiting, so nothing is asked for again.
    await fetchMailImages(t.hub);
    assert.equal(fetched.length, 2);
  } finally { Object.assign(mailImages, real); done(t); }
});

test("mail routes: Pin is kept on the hub and as iCloud's flag (that flag only), and only a kept mail can be pinned", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(INBOX);
    await t.api("/mail/refresh", { method: "POST" });
    const id = (await list(t)).messages[1].id;
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: true } })).status, 200);
    assert.equal((await list(t)).messages.find((m) => m.id === id)!.pinned, true);
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: false } })).status, 200);
    assert.equal((await list(t)).messages.find((m) => m.id === id)!.pinned, false);
    // Since 2026-11-21 a pin is Apple Mail's flag too (mail-pins.test.ts): \Flagged added, then removed, nothing else.
    assert.deepEqual(seen.flags.map((f) => [f.flags, f.add]), [[["\\Flagged"], true], [["\\Flagged"], false]]);
    assert.deepEqual([seen.moves.length, seen.appends.length], [0, 0]);
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: "yes" } })).status, 422);
    assert.equal((await t.api("/mail/messages/000000000000000000000000/pin", { method: "POST", json: { pinned: true } })).status, 404);
    assert.ok(refuseToolCall("POST", `/mail/messages/${id}/pin`), "the assistant cannot pin");
  } finally { done(t); }
});

test("mail routes: a second refresh fetches only what is new, and drops what left the Inbox", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = [...INBOX];
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const downloads = seen.calls.filter((c) => c === "download").length;
    msgs.push({ uid: 9, folder: "INBOX", at: ago(0), subject: "New one", from: ALEX, messageId: "n@x", plain: "Hello" });
    msgs.splice(msgs.findIndex((m) => m.uid === 1), 1);
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { kept: number; gone: number }[] };
    assert.deepEqual([r.mailboxes[0].kept, r.mailboxes[0].gone], [1, 1]);
    assert.equal(seen.calls.filter((c) => c === "download").length, downloads + 1, "only the new message's text fetched");
    assert.deepEqual((await list(t)).messages.map((m) => m.subject), ["New one", "Your account"]);
  } finally { done(t); }
});

test("mail routes: unlinking deletes the mailbox's mail; switching the module off deletes it all and closes the routes", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(INBOX);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).status, 200);
    assert.equal(kept(t), 0);

    linked(t);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 2);
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal(kept(t), 0, "module off: mail deleted");
    const r = await t.api("/mail");
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { module: string }).module, "mail_inbox");
  } finally { done(t); }
});

test("mail routes: the iCloud link serves either module; receipts' Read now needs receipts on", async () => {
  const t = makeHub();
  try {
    const seen = fake([]);
    await t.api("/modules", { method: "PUT", json: { mail: false, mail_inbox: true } });
    assert.equal((await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } })).status, 200, "linking works with only the Mail screen on");
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 404, "receipts are off");
    await t.api("/modules", { method: "PUT", json: { mail: true, mail_inbox: false } });
    assert.equal((await t.api("/mail")).status, 404);
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 200);
    assert.ok(seen.connects >= 1);
  } finally { done(t); }
});

test("mail routes: the assistant's tools can neither read the mail nor refresh it", () => {
  for (const [m, p] of [["GET", "/mail"], ["GET", "/mail/messages/abc"], ["POST", "/mail/refresh"], ["GET", "/mail%2Fmessages"], ["GET", "/%6Dail"]]) {
    assert.ok(refuseToolCall(m, p), `${m} ${p}`);
  }
});

test("mail routes: a refused password shows on the mailbox, without the server's words", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([], { password: "zzzz-zzzz-zzzz-zzzz" });
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { error?: string }[] };
    assert.match(r.mailboxes[0].error!, /did not accept/);
    const l = await list(t);
    assert.equal(l.mailboxes[0].last_error, r.mailboxes[0].error);
    assert.ok(!l.mailboxes[0].last_error!.includes("Authentication failed"), "the hub's words, not the server's");
  } finally { done(t); }
});

test("mail routes: no answer may be stored by a device, browser or proxy", async () => {
  const t = makeHub();
  try {
    t.hub.modules.set({ mail_inbox: true });
    for (const p of ["/mail", "/mail/messages/nope", "/mail/settings/notify"]) {
      const res = await t.api(p);
      assert.equal(res.headers.get("cache-control"), "no-store", p);
    }
  } finally { t.cleanup(); }
});
