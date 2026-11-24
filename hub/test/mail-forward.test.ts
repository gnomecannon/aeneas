import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { forwardSubject, replyAllCc } from "../src/mail-compose.js";
import type { MailFolder, MailSummary } from "../src/mail-inbox.js";

// Reply all and Forward, as drafts: recipients from the kept mail or typed by the owner, never from anything else.
// Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday at 10?",
    to: [{ name: "Robin", address: EMAIL }, { name: "Sam", address: "sam@example.com" }], cc: [{ name: "Kim", address: "Kim@Example.com" }, { address: "not an address" }] },
  { uid: 1, folder: "Junk", at: ago(1), subject: "Fwd: Club news", from: { address: "club@lists.example" }, messageId: "j1@x", plain: "Hike on Sunday." },
];
const ask = (t: TestHub, body: unknown) => t.api("/mail/drafts", { method: "POST", json: body });
const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].split("\r\n");
const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();

test("mail reply all: the others on the mail go in Cc, from the mailbox, never the owner, the sender or the request", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const id = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages.find((m) => m.subject === "Gutters")!.id;
    const p = await (await ask(t, { reply_to: id, reply_all: true, text: "Works for me.", cc: ["evil@x.example"], to: ["evil@x.example"], preview: true })).json() as { to: string[]; cc?: string[] };
    assert.deepEqual([p.to, p.cc], [["alex@example.com"], ["sam@example.com", "kim@example.com"]]);
    const plain = await (await ask(t, { reply_to: id, text: "Works for me.", preview: true })).json() as { cc?: string[] };
    assert.equal(plain.cc, undefined, "Reply alone has no Cc");
    await ask(t, { reply_to: id, reply_all: true, text: "Works for me." });
    const lines = headersOf(seen.appends[0].raw);
    assert.ok(lines.includes("Cc: sam@example.com, kim@example.com"));
    assert.ok(lines.includes("To: alex@example.com"));
    assert.ok(seen.opened.every((o) => o.readOnly === true), "the recipients read read-only");
  } finally { done(t); }
});

test("mail forward: to whom the owner types, Fwd: once, the mail quoted below the owner's words, from a folder too", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const { messages, folders } = (await (await t.api("/mail")).json()) as { messages: MailSummary[]; folders: MailFolder[] };
    const id = messages.find((m) => m.subject === "Gutters")!.id;
    const p = await (await ask(t, { forward: id, to: "pat@example.com", text: "FYI", preview: true })).json() as { to: string[]; subject: string; text: string; in_reply_to?: string };
    assert.deepEqual([p.to, p.subject, p.in_reply_to], [["pat@example.com"], "Fwd: Gutters", undefined]);
    assert.match(p.text, /^FYI\n\n---------- Forwarded message ----------\nFrom: Alex <alex@example\.com>\nDate: .+\nSubject: Gutters\n\nSaturday at 10\?/);
    const bare = await (await ask(t, { forward: id, to: "pat@example.com", text: "", preview: true })).json() as { text: string };
    assert.match(bare.text, /^---------- Forwarded message ----------\n/, "no note: the mail alone, no words added");
    assert.equal((await ask(t, { reply_to: id, text: "" })).status, 422, "a reply still needs the owner's words");
    assert.equal((await ask(t, { forward: id, to: "", text: "FYI" })).status, 422, "someone to forward to");
    assert.equal((await ask(t, { forward: id, to: "Evil <evil@x.example>", text: "FYI" })).status, 422, "plain addresses only");
    assert.equal((await ask(t, { forward: "nope", to: "pat@example.com", text: "FYI" })).status, 404);
    const junk = folders.find((f) => f.role === "junk")!;
    const club = ((await (await t.api(`/mail/folders/${junk.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    await ask(t, { forward: club.id, to: "pat@example.com", text: "Want to go?" });
    const raw = seen.appends[0].raw;
    assert.ok(headersOf(raw).includes("Subject: Fwd: Club news"), "not Fwd: Fwd:");
    assert.match(bodyOf(raw), /Want to go\?\r\n\r\n---------- Forwarded message ----------/);
  } finally { done(t); }
});

test("mail reply all and forward: the helpers", () => {
  assert.deepEqual(replyAllCc([{ name: "", address: "A@x.example" }, { name: "", address: "a@x.example" }, { name: "", address: "me@x.example" }, { name: "", address: "bad" }], ["ME@x.example"]), ["a@x.example"]);
  assert.equal(replyAllCc(Array.from({ length: 30 }, (_, i) => ({ name: "", address: `p${i}@x.example` })), []).length, 20);
  assert.equal(forwardSubject("FW: Plans"), "FW: Plans");
  assert.equal(forwardSubject("Plans\r\nBcc: evil@x.example"), "Fwd: Plans Bcc: evil@x.example", "one line");
});
