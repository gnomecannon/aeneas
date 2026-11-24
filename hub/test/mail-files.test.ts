import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailFolder, MailSummary } from "../src/mail-inbox.js";

// Files in drafts (the owner's, and a forwarded mail's), and editing a draft. Made-up mail and files.

const PDF = Buffer.from("%PDF-1.4 made-up tickets");
const ALEX = { name: "Alex", address: "alex@example.com" };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Tickets", from: ALEX, messageId: "t1@x", plain: "Here they are.", files: [{ name: "tickets.pdf", type: "application/pdf", bytes: PDF }] },
  { uid: 1, folder: "Drafts", at: ago(1), subject: "Re: Gutters", from: { address: EMAIL }, to: [ALEX], cc: [{ address: "sam@example.com" }], messageId: "d1@x", inReplyTo: "g2@x", references: "<g1@x> <g2@x>", plain: "Saturday wor", seen: true },
];
const ask = (t: TestHub, body: unknown) => t.api("/mail/drafts", { method: "POST", json: body });
const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].split("\r\n");
/** A multipart draft's parts: each one's headers and its base64 body decoded. */
function partsOf(raw: string): { headers: string[]; body: Buffer }[] {
  const boundary = /boundary="([^"]+)"/.exec(raw)![1];
  return raw.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, ...b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { headers: h.split("\r\n"), body: Buffer.from(b.join("\r\n\r\n").replace(/\r\n/g, ""), "base64") };
  });
}

test("mail files: the owner's files go in as attachments, names cleaned; the preview lists them and saves nothing", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const files = [{ name: "notes.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") }, { name: "../evil\r\n.pdf", type: "bad type<", data: PDF.toString("base64") }];
    const p = await (await ask(t, { to: "pat@example.com", subject: "Files", text: "Attached.", files, preview: true })).json() as { files: { name: string; size: number }[] };
    assert.deepEqual(p.files, [{ name: "notes.txt", size: 5 }, { name: "_evil.pdf", size: PDF.length }]);
    assert.equal(seen.appends.length, 0);
    await ask(t, { to: "pat@example.com", subject: "Files", text: "Attached.", files });
    const parts = partsOf(seen.appends[0].raw);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].body.toString(), "Attached.");
    assert.deepEqual(parts[1].headers.slice(0, 4), ["Content-Type: text/plain;", ' name="notes.txt"', "Content-Disposition: attachment;", ' filename="notes.txt"'], "each parameter on its own folded line");
    assert.ok(parts[2].headers[0].startsWith("Content-Type: application/octet-stream;"), "a type the hub cannot read");
    assert.deepEqual(parts[2].body, PDF);
    assert.ok(headersOf(seen.appends[0].raw).some((h) => h.startsWith("Content-Type: multipart/mixed;")));
  } finally { done(t); }
});

test("mail files: limits on files", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const one = { name: "a.txt", data: "aGk=" };
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: Array(11).fill(one) })).status, 422, "at most 10");
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: [{ name: "a", data: "not base64!" }] })).status, 422);
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: [{ name: "big", data: Buffer.alloc(16 * 1024 * 1024).toString("base64") }] })).status, 413, "15 MB together");
  } finally { done(t); }
});

test("mail files: a forward can carry the mail's own attachments, read from the mailbox only when saved", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const id = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages.find((m) => m.subject === "Tickets")!.id;
    await ask(t, { forward: id, to: "pat@example.com", text: "FYI", forward_attachments: true, preview: true });
    assert.deepEqual(seen.downloads, [], "a preview reads no file");
    await ask(t, { forward: id, to: "pat@example.com", text: "FYI", forward_attachments: true });
    const parts = partsOf(seen.appends[0].raw);
    assert.equal(parts.length, 2);
    assert.match(parts[1].headers.join("\n"), /filename="tickets\.pdf"/);
    assert.deepEqual(parts[1].body, PDF);
  } finally { done(t); }
});

test("mail drafts: editing a draft saves the new one, keeps its Cc and thread, and moves the old one to Trash", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const drafts = ((await (await t.api("/mail")).json()) as { folders: MailFolder[] }).folders.find((f) => f.role === "drafts")!;
    const draft = ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    const r = await ask(t, { to: "alex@example.com", subject: "Re: Gutters", text: "Saturday works.", replaces: draft.id });
    assert.equal(r.status, 200);
    const lines = headersOf(seen.appends[0].raw);
    assert.ok(lines.includes("Cc: sam@example.com"), "its Cc goes on");
    assert.ok(lines.includes("In-Reply-To: <g2@x>"), "and its thread");
    assert.equal(msgs.find((m) => m.messageId === "d1@x")!.folder, "Deleted Messages", "the old one in Trash, not erased");
    // The old version is out of the hub's Drafts at once, and the new one is in it at once: the draft is never nowhere.
    const inDrafts = async () => ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages;
    const now = await inDrafts();
    assert.deepEqual(now.map((m) => [m.subject, m.preview, m.id === draft.id]), [["Re: Gutters", "Saturday works.", false]]);
    assert.equal(((await r.json()) as { id?: string }).id, now[0].id, "the answer names it");
    await t.api("/mail/refresh", { method: "POST" });
    assert.deepEqual((await inDrafts()).map((m) => m.id), [now[0].id], "the next refresh neither loses nor doubles it");
    const inbox = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages[0];
    assert.equal((await ask(t, { to: "alex@example.com", text: "x", replaces: inbox.id })).status, 404, "only a draft is replaced");
  } finally { done(t); }
});

test("mail drafts: an edited draft keeps its attachments and its Bcc; the owner can take a file off", async () => {
  const t = makeHub();
  try {
    linked(t);
    const PNG = Buffer.from("made-up picture bytes");
    const msgs: Msg[] = [
      { uid: 1, folder: "Drafts", at: ago(1), subject: "Quote", from: { address: EMAIL }, to: [ALEX], cc: [{ address: "sam@example.com" }], bcc: [{ address: "records@example.com" }], messageId: "d2@x", plain: "Attached.", seen: true,
        files: [{ name: "quote.pdf", type: "application/pdf", bytes: PDF }, { name: "roof \u{1F3E0}.png", type: "image/png", bytes: PNG }] },
    ];
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const drafts = ((await (await t.api("/mail")).json()) as { folders: MailFolder[] }).folders.find((f) => f.role === "drafts")!;
    const draft = ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    // The preview says what the new draft will carry, and reads no file.
    const p = (await (await ask(t, { to: "alex@example.com", subject: "Quote", text: "Attached, with the roof.", replaces: draft.id, preview: true })).json()) as { bcc?: string[]; cc?: string[]; files?: { name: string; size: number }[] };
    assert.deepEqual(p.bcc, ["records@example.com"]);
    assert.deepEqual(p.cc, ["sam@example.com"]);
    assert.deepEqual(p.files?.map((f) => f.name), ["quote.pdf", "roof \u{1F3E0}.png"]);
    assert.deepEqual(seen.downloads, [], "a preview reads no file");
    assert.equal(seen.appends.length, 0);
    // Saved with one file taken off and one added: the kept one first, then the new one.
    const r = await ask(t, { to: "alex@example.com", subject: "Quote", text: "Attached, with the roof.", replaces: draft.id, keep_parts: ["3"], files: [{ name: "plan.txt", type: "text/plain", data: Buffer.from("plan").toString("base64") }] });
    assert.equal(r.status, 200);
    const saved = (await r.json()) as { saved: boolean; files: { name: string; size: number }[]; bcc: string[] };
    assert.deepEqual(saved.files, [{ name: "roof \u{1F3E0}.png", size: PNG.length }, { name: "plan.txt", size: 4 }]);
    const raw = seen.appends[0].raw;
    assert.ok(headersOf(raw).includes("Bcc: records@example.com"), "the Bcc set in the mail app goes on");
    assert.ok(headersOf(raw).includes("Cc: sam@example.com"));
    const parts = partsOf(raw);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[1].body, PNG);
    assert.deepEqual(parts[2].body, Buffer.from("plan"));
    assert.equal(msgs[0].folder, "Deleted Messages", "the old one in Trash, with every file it had");
    // A Bcc is never taken from a request, and parts are part numbers only.
    assert.equal(seen.appends.some((a) => /evil@x\.example/.test(a.raw)), false);
    assert.equal((await ask(t, { to: "alex@example.com", text: "x", replaces: draft.id, keep_parts: ["1; DROP"] })).status, 422);
  } finally { done(t); }
});

test("mail drafts: a Bcc in a request is not taken, and an edited draft with nothing kept has no files", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "Drafts", at: ago(1), subject: "Quote", from: { address: EMAIL }, to: [ALEX], messageId: "d3@x", plain: "Attached.", seen: true, files: [{ name: "quote.pdf", type: "application/pdf", bytes: PDF }] }];
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const drafts = ((await (await t.api("/mail")).json()) as { folders: MailFolder[] }).folders.find((f) => f.role === "drafts")!;
    const draft = ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    const r = await ask(t, { to: "alex@example.com", subject: "Quote", text: "No file after all.", replaces: draft.id, keep_parts: [], bcc: ["evil@x.example"] });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { files?: unknown; bcc?: unknown }).files, undefined);
    assert.doesNotMatch(seen.appends[0].raw, /Bcc|evil@x\.example|multipart/);
    await ask(t, { to: "alex@example.com", subject: "New", text: "Hello", bcc: ["evil@x.example"] });
    assert.doesNotMatch(seen.appends[1].raw, /Bcc|evil@x\.example/);
  } finally { done(t); }
});

test("mail files: a forward of a mail with more attachments than a draft carries says so, and saves nothing", async () => {
  const t = makeHub();
  try {
    linked(t);
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `photo-${i + 1}.jpg`, type: "image/jpeg", bytes: Buffer.from(`made-up ${i}`) }));
    const seen = fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Photos", from: ALEX, messageId: "p1@x", plain: "All twelve.", files: many }]);
    await t.api("/mail/refresh", { method: "POST" });
    const id = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages[0].id;
    for (const preview of [true, false]) {
      const r = await ask(t, { forward: id, to: "pat@example.com", text: "FYI", forward_attachments: true, preview });
      assert.equal(r.status, 413, preview ? "the preview says so already" : "and nothing is saved with two of them left out");
      assert.match(((await r.json()) as { error: string }).error, /has 12 attachments, and a draft from Aeneas carries at most 10/);
    }
    assert.equal(seen.appends.length, 0);
    assert.deepEqual(seen.downloads, []);
    // Without its attachments the forward is saved as before.
    assert.equal((await ask(t, { forward: id, to: "pat@example.com", text: "FYI" })).status, 200);
  } finally { done(t); }
});

test("mail drafts: a saved draft is listed under Drafts at once, with its files; a server that does not say where it is brings it with a refresh", async () => {
  for (const noAppendUid of [false, true]) {
    const t = makeHub();
    try {
      linked(t);
      fake(box(), { noAppendUid });
      await t.api("/mail/refresh", { method: "POST" });
      const drafts = ((await (await t.api("/mail")).json()) as { folders: MailFolder[] }).folders.find((f) => f.role === "drafts")!;
      const inDrafts = async () => ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: (MailSummary & { to: { address: string }[] })[] }).messages;
      const before = (await inDrafts()).length;
      const r = (await (await ask(t, { to: "pat@example.com", subject: "Plan", text: "Here is the plan.", files: [{ name: "plan.txt", type: "text/plain", data: Buffer.from("plan").toString("base64") }] })).json()) as { saved: boolean; id?: string };
      assert.equal(r.saved, true);
      // Where the server did not say where it put it, the hub starts a refresh: waited for here.
      if (noAppendUid) { assert.equal(r.id, undefined); await t.api("/mail/refresh", { method: "POST" }); }
      const list = await inDrafts();
      assert.equal(list.length, before + 1, noAppendUid ? "after the refresh" : "at once");
      const mine = list.find((m) => m.subject === "Plan")!;
      assert.deepEqual([mine.preview, mine.to.map((a) => a.address), mine.attachments, mine.seen], ["Here is the plan.", ["pat@example.com"], 1, true]);
      if (!noAppendUid) assert.equal(mine.id, r.id);
      // Its file can be read back from the mailbox by the part the hub listed, and a refresh changes nothing.
      const atts = ((await (await t.api(`/mail/messages/${mine.id}/attachments`)).json()) as { attachments: { part: string; name: string; size: number }[] }).attachments;
      assert.deepEqual(atts.map((a) => [a.part, a.name]), [["2", "plan.txt"]]);
      assert.deepEqual(Buffer.from(await (await t.api(`/mail/messages/${mine.id}/attachments/2`)).arrayBuffer()), Buffer.from("plan"));
      await t.api("/mail/refresh", { method: "POST" });
      assert.deepEqual((await inDrafts()).filter((m) => m.subject === "Plan").map((m) => m.id), [mine.id]);
    } finally { done(t); }
  }
});
