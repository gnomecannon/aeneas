import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { blockedForm, isBlocked, unsubscribeWays } from "../src/mail-unsubscribe.js";
import { oneClick, type MailSummary } from "../src/mail-inbox.js";
import { postOneClick } from "../src/ai/web.js";

// Unsubscribe (from the mail's own headers, read now; one-click through Tor or only when confirmed) and block. Made-up mail.

const NEWS = "List-Unsubscribe: <https://news.example/u?id=1>, <mailto:unsub@news.example?subject=stop%20please>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n";
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(2), subject: "This week", from: { name: "News", address: "letters@news.example" }, messageId: "n1@x", headers: NEWS, plain: "Stories" },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "Deals", from: { address: "deals@spam.example" }, messageId: "s1@x", plain: "Buy" },
  { uid: 3, folder: "INBOX", at: ago(1), subject: "More deals", from: { address: "promo@mail.spam.example" }, messageId: "s2@x", plain: "Buy more" },
  { uid: 4, folder: "INBOX", at: ago(1), subject: "Lunch?", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@x", plain: "Thursday?" },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[]; blocked: string[] });
const idOf = async (t: TestHub, s: string) => (await list(t)).messages.find((m) => m.subject === s)!.id;

test("mail unsubscribe: the ways, from hostile headers too", () => {
  assert.deepEqual(unsubscribeWays("<https://news.example/u?id=1>, <mailto:unsub@news.example?subject=stop>", "List-Unsubscribe=One-Click"),
    { one_click: "https://news.example/u?id=1", mailto: { to: "unsub@news.example", subject: "stop" } });
  assert.deepEqual(unsubscribeWays("<https://news.example/u>", ""), { link: "https://news.example/u" }, "no Post header: a page to open");
  assert.deepEqual(unsubscribeWays("<javascript:alert(1)>, <http://news.example/u>, <https://user:pw@news.example/u>, <ftp://x.example/>, <mailto:Evil <e@x.example>>", "List-Unsubscribe=One-Click"), {}, "nothing but https without a login, and a plain mailto");
  assert.deepEqual(unsubscribeWays("<mailto:u@x.example?subject=a%0D%0ABcc:%20evil@x.example>", ""), { mailto: { to: "u@x.example", subject: "a Bcc: evil@x.example" } }, "a subject is one line");
  assert.equal(blockedForm("@Spam.Example"), "@spam.example");
  assert.equal(blockedForm("@spam"), null);
  assert.equal(blockedForm("not an address"), null);
  assert.ok(isBlocked(["@spam.example"], "promo@mail.spam.example"), "a domain takes its subdomains");
  assert.ok(!isBlocked(["@spam.example"], "a@notspam.example"));
});

test("mail unsubscribe: one-click goes to the header's address, through Tor, or directly only when confirmed; mailto saves a draft", async () => {
  const t = makeHub();
  const posts: { url: string; socks: string }[] = [];
  const real = oneClick.post;
  oneClick.post = async (url, socks) => { posts.push({ url, socks }); return true; };
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const id = await idOf(t, "This week");
    const o = await (await t.api(`/mail/messages/${id}/unsubscribe`)).json();
    assert.deepEqual(o, { one_click: { host: "news.example" }, mailto: { to: "unsub@news.example", subject: "stop please" }, tor: false });
    const ask = (body: unknown) => t.api(`/mail/messages/${id}/unsubscribe`, { method: "POST", json: body });
    assert.equal((await ask({ how: "one_click", url: "https://evil.example/" })).status, 409, "no Tor and not confirmed: nothing sent");
    assert.deepEqual(posts, []);
    assert.deepEqual(await (await ask({ how: "one_click", direct: true, url: "https://evil.example/" })).json(), { ok: true, via: "direct" });
    assert.deepEqual(posts, [{ url: "https://news.example/u?id=1", socks: "" }], "the header's address, not the request's");
    t.hub.cfg.torSocks = "127.0.0.1:9050";
    assert.deepEqual(await (await ask({ how: "one_click" })).json(), { ok: true, via: "tor" });
    assert.equal((posts as { url: string; socks: string }[])[1].socks, "127.0.0.1:9050");
    assert.deepEqual(await (await ask({ how: "mailto" })).json(), { ok: true, draft: true });
    const raw = seen.appends[0].raw;
    assert.ok(raw.includes("To: unsub@news.example") && raw.includes("Subject: stop please"));
    assert.equal((await t.api(`/mail/messages/${await idOf(t, "Lunch?")}/unsubscribe`, { method: "POST", json: { how: "one_click", direct: true } })).status, 409, "no header, nothing to do");
  } finally { oneClick.post = real; done(t); }
});

test("mail unsubscribe: a direct one-click never goes to the home network or plain http", async () => {
  assert.equal(await postOneClick("https://192.168.1.1/unsub", ""), false);
  assert.equal(await postOneClick("https://127.0.0.1/unsub", ""), false);
  assert.equal(await postOneClick("http://news.example/unsub", ""), false);
});

test("mail block: a sender's mail goes to Spam now and at each refresh; a domain takes its subdomains; unblock", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const r = await (await t.api("/mail/settings/blocked", { method: "POST", json: { sender: "@spam.example" } })).json() as { blocked: string[]; moved: number };
    assert.deepEqual([r.blocked, r.moved], [["@spam.example"], 2]);
    assert.deepEqual(msgs.filter((m) => m.folder === "Junk").map((m) => m.messageId).sort(), ["s1@x", "s2@x"]);
    msgs.push({ uid: 9, folder: "INBOX", at: ago(0.1), subject: "Even more deals", from: { address: "x@spam.example" }, messageId: "s3@x", plain: "Buy" });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(msgs.find((m) => m.messageId === "s3@x")!.folder, "Junk", "new mail from them at the refresh");
    assert.ok(!(await list(t)).messages.some((m) => m.subject === "Even more deals"));
    assert.equal(msgs.find((m) => m.messageId === "a1@x")!.folder, "INBOX", "others stay");
    assert.equal((await t.api("/mail/settings/blocked", { method: "POST", json: { sender: "nope" } })).status, 422);
    assert.deepEqual(((await (await t.api("/mail/settings/unblock", { method: "POST", json: { sender: "@spam.example" } })).json()) as { blocked: string[] }).blocked, []);
    assert.deepEqual((await list(t)).blocked, []);
  } finally { done(t); }
});
