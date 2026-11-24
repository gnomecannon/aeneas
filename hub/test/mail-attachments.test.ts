import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { attachmentName, attachmentParts } from "../src/imports/icloud.js";
import type { MailFolder, MailSummary } from "../src/mail-inbox.js";

// Attachments: listed from the structure, previews of real pictures only, downloads as files to save. Read-only.
// Made-up mail and files.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("made-up picture")]);
const FAKE_PNG = Buffer.from("<html><script>alert(1)</script></html>");
const PDF = Buffer.from("%PDF-1.4 made-up");
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Trip photos", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@x", plain: "See attached.", files: [
    { name: "beach.png", type: "image/png", bytes: PNG },
    { name: "not-a-picture.png", type: "image/png", bytes: FAKE_PNG },
    { name: "tickets.pdf", type: "application/pdf", bytes: PDF },
    { name: "../../setup\r\n.exe", type: "application/x-msdownload", bytes: Buffer.from("MZ made-up") },
    { name: "logo.png", type: "image/png", bytes: PNG, inlineId: "logo@x" },
  ] },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "No files", from: { name: "Sam", address: "sam@example.com" }, messageId: "a2@x", plain: "Hi" },
  { uid: 1, folder: "Junk", at: ago(1), subject: "Invoice", from: { address: "billing@prize.example" }, messageId: "j1@x", plain: "Open it", files: [{ name: "invoice.zip", type: "application/zip", bytes: Buffer.from("PK made-up") }] },
];
type Att = { part: string; name: string; type: string; size: number; preview?: string };
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[]; folders: MailFolder[] });
const atts = async (t: TestHub, id: string) => ((await (await t.api(`/mail/messages/${id}/attachments`)).json()) as { attachments: Att[] }).attachments;

test("mail attachments: listed at refresh from the structure alone (a paperclip count), never the pictures shown inside", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const ms = (await list(t)).messages;
    assert.equal(ms.find((m) => m.subject === "Trip photos")!.attachments, 4);
    assert.equal(ms.find((m) => m.subject === "No files")!.attachments, undefined);
    assert.deepEqual(seen.downloads, [], "no file read at refresh");
  } finally { done(t); }
});

test("mail attachments: opening a mail lists them, with previews of real pictures only, read-only", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const id = (await list(t)).messages.find((m) => m.subject === "Trip photos")!.id;
    const before = seen.opened.length;
    const a = await atts(t, id);
    assert.deepEqual(a.map((x) => [x.name, x.type, !!x.preview]), [
      ["beach.png", "image/png", true],
      ["not-a-picture.png", "image/png", false],
      ["tickets.pdf", "application/pdf", false],
      ["_.._setup.exe", "application/x-msdownload", false],
    ], "HTML called a picture gets no preview; the file name loses its folders and line break");
    assert.match(a[0].preview!, /^data:image\/png;base64,/);
    assert.ok(seen.opened.slice(before).every((o) => o.readOnly === true), "opened read-only");
    assert.deepEqual([seen.flags.length, seen.moves.length, seen.appends.length], [0, 0, 0], "nothing written");
  } finally { done(t); }
});

test("mail attachments: a download is a file to save, only of a listed part, of the message the hub kept", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const { messages, folders } = await list(t);
    const id = messages.find((m) => m.subject === "Trip photos")!.id;
    const pdf = (await atts(t, id)).find((x) => x.name === "tickets.pdf")!;
    const res = await t.api(`/mail/messages/${id}/attachments/${pdf.part}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream", "never the type the mail claims");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="tickets\.pdf"/);
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
    for (const part of ["1", "6", "abc", "2.x"]) assert.equal((await t.api(`/mail/messages/${id}/attachments/${part}`)).status, 404, `part ${part}: the text, the inline picture, or no part`);
    // A folder's mail too.
    const junk = folders.find((f) => f.role === "junk")!;
    const inv = ((await (await t.api(`/mail/folders/${junk.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    assert.equal(inv.attachments, 1);
    assert.equal((await t.api(`/mail/messages/${inv.id}/attachments/2`)).status, 200);
    // Another message took its place in iCloud: nothing read.
    msgs.find((m) => m.messageId === "a1@x")!.messageId = "other@x";
    assert.equal((await t.api(`/mail/messages/${id}/attachments`)).status, 404);
    assert.equal((await t.api(`/mail/messages/${id}/attachments/${pdf.part}`)).status, 404);
  } finally { done(t); }
});

test("mail attachments: names and parts, from hostile structures", () => {
  assert.equal(attachmentName("..\\..\\a:b*c?.txt", "2"), "_.._a_b_c_.txt");
  assert.equal(attachmentName("\u202ecod.exe", "2"), "cod.exe", "no direction-changing characters");
  assert.equal(attachmentName("", "3"), "attachment-3");
  assert.equal(attachmentName("x".repeat(500), "2").length, 120);
  const deep = { type: "multipart/mixed", childNodes: Array.from({ length: 50 }, (_, i) => ({ part: String(i + 1), type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: `f${i}.pdf` } })) };
  assert.equal(attachmentParts(deep).length, 30, "at most 30");
  assert.equal(attachmentParts({ type: "image/png", part: "1", disposition: "attachment", parameters: {} })[0].type, "image/png");
  assert.equal(attachmentParts({ type: "evil type<script>", part: "2", disposition: "attachment" })[0].type, "application/octet-stream");
  assert.doesNotThrow(() => encodeURIComponent(attachmentName(`${"x".repeat(119)}\u{1F4CE}.pdf`, "2")), "never half an emoji at the cut");
});

test("mail attachments: what is a file and what is the mail itself", () => {
  const names = (n: Parameters<typeof attachmentParts>[0]) => attachmentParts(n).map((a) => a.name);
  const text = { part: "1", type: "text/plain" };
  const html = { part: "2", type: "text/html" };
  // Another form of the same mail (AMP, a calendar's text) is not a file; a named one is.
  assert.deepEqual(names({ type: "multipart/alternative", childNodes: [text, html, { part: "3", type: "text/x-amp-html" }, { part: "4", type: "text/calendar" }] }), []);
  assert.deepEqual(names({ type: "multipart/mixed", childNodes: [{ type: "multipart/alternative", childNodes: [text, html] }, { part: "2", type: "text/calendar", parameters: { name: "invite.ics" } }] }), ["invite.ics"]);
  // A picture the HTML shows sits beside it in a multipart/related; a photo with a Content-ID anywhere else is a file.
  const logo = { part: "1.2", type: "image/png", id: "<logo@x>", disposition: "inline" };
  const photo = { part: "2", type: "image/jpeg", id: "<photo@x>", disposition: "inline", dispositionParameters: { filename: "beach.jpg" } };
  assert.deepEqual(names({ type: "multipart/mixed", childNodes: [{ type: "multipart/related", childNodes: [html, logo] }, photo] }), ["beach.jpg"]);
  assert.deepEqual(names({ type: "multipart/related", childNodes: [html, { ...logo, disposition: "attachment", dispositionParameters: { filename: "logo.png" } }] }), ["logo.png"], "marked as an attachment, it is one");
  // A picture beside the HTML that the hub cannot write into the page is a file: of a kind it does not show (an
  // iPhone's HEIC, a PDF) or over the size it takes. Taken for a shown picture, each was neither shown nor listed.
  const heic = { part: "1.3", type: "image/heic", id: "<h@x>", disposition: "inline" };
  const big = { part: "1.4", type: "image/jpeg", id: "<b@x>", disposition: "inline", size: 4_000_000, encoding: "base64" };
  const pdf = { part: "1.5", type: "application/pdf", id: "<p@x>", disposition: "inline" };
  assert.deepEqual(attachmentParts({ type: "multipart/related", childNodes: [html, logo, heic, big, pdf] }).map((a) => [a.part, a.type]), [["1.3", "image/heic"], ["1.4", "image/jpeg"], ["1.5", "application/pdf"]]);
  // A mail attached to this one is one file, whatever it holds.
  const inner = { part: "2", type: "message/rfc822", size: 4000, childNodes: [{ type: "multipart/mixed", childNodes: [text, { part: "2.2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "inside.pdf" } }] }] };
  assert.deepEqual(attachmentParts({ type: "multipart/mixed", childNodes: [text, inner] }), [{ part: "2", name: "attached mail.eml", type: "message/rfc822", size: 4000 }]);
});
