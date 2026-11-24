import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { attachmentName, attachmentParts, decodedName, setICloudDeadlines, setImapFactory } from "../src/imports/icloud.js";
import { fileHeaders } from "../src/mail-compose.js";
import { triageNew, type MailFolder, type MailSummary, type TriageState } from "../src/mail-inbox.js";
import { blockRefusal } from "../src/mail-unsubscribe.js";
import type { NotifyEvent } from "../src/bus.js";

// What the second review of the Mail change (2026-11-23) found in the fixes of the first, each with the case that
// showed it. Made-up mail, people and senders.

const { setBackendOverride } = await import("../src/ai/backends.js");
const ALEX = { name: "Alex", address: "alex@northwind.example" };
type List = { messages: MailSummary[]; folders: MailFolder[]; mail_notify: { bundles: string[] }; bundle_delivery: Record<string, unknown> };
const list = async (t: TestHub) => (await (await t.api("/mail")).json()) as List;
const refresh = (t: TestHub) => t.api("/mail/refresh", { method: "POST" });
const byS = (ms: MailSummary[], s: string) => ms.find((m) => m.subject === s);
const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));

test("review 2: Block sender refuses the owner's own domain and a mail provider under a country's ending", () => {
  // The owner's own domain, or one above it: their own mail would be moved out with it.
  assert.match(blockRefusal("@icloud.example", [EMAIL]) ?? "", /Your own address is at icloud\.example/);
  assert.match(blockRefusal("@northwind.example", ["robin@mail.northwind.example"]) ?? "", /Your own address is at northwind\.example/);
  assert.equal(blockRefusal("@mail.northwind.example", ["robin@northwind.example"]), null, "a domain under the owner's is another sender's");
  for (const d of ["hotmail.co.uk", "yahoo.co.jp", "outlook.de", "yahoo.com.br", "gmx.at", "live.nl", "mail.ee"]) assert.match(blockRefusal(`@${d}`, [EMAIL]) ?? "", /Many people have an address/, d);
  // One site's own domain, also under a shared ending or with a provider's name in it, can be blocked.
  for (const d of ["shop.co.uk", "outlook-deals.example", "mailer.shop.example", "yahoo.shop.example"]) assert.equal(blockRefusal(`@${d}`, [EMAIL]), null, d);
  // One address at a provider, or at the owner's own domain, can be blocked.
  assert.equal(blockRefusal("them@hotmail.co.uk", [EMAIL]), null);
  assert.equal(blockRefusal("them@icloud.example", [EMAIL]), null);
});

test("review 2: deleting one of the owner's bundles takes its alerts switch with it; a built-in bundle's id changes nothing", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
    const made = (await (await t.api("/mail/settings/custom-bundles", { method: "POST", json: { name: "School", color: 2, addresses: ["office@school.example"] } })).json()) as { id: string };
    for (const bundle of [made.id, "purchases"]) assert.equal((await t.api("/mail/settings/notify", { method: "PUT", json: { bundle, on: true } })).status, 200);
    assert.deepEqual((await list(t)).mail_notify.bundles.sort(), [made.id, "purchases"].sort());
    assert.equal((await t.api("/mail/settings/custom-bundles/purchases", { method: "DELETE" })).status, 404);
    assert.deepEqual((await list(t)).mail_notify.bundles.sort(), [made.id, "purchases"].sort(), "a built-in bundle keeps its alerts");
    assert.equal((await t.api(`/mail/settings/custom-bundles/${made.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await list(t)).mail_notify.bundles, ["purchases"], "the deleted bundle's id is not left in the alert settings");
  } finally { t.cleanup(); }
});

test("review 2: a newsletter that writes Re: alerts as its bundle does, not as a person's mail", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(2), subject: "Old one", from: ALEX, messageId: "o@x", plain: "x" }];
    fake(msgs);
    const events: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => { if (e.kind === "mail") events.push(e); });
    await refresh(t);
    const news = { from: { name: "Deals", address: "deals@shop.example" }, plain: "Sale", headers: "List-Id: <deals.shop.example>\r\nList-Unsubscribe: <mailto:out@shop.example>\r\n" };
    msgs.push({ uid: 2, folder: "INBOX", at: new Date(), subject: "Re: our chat last week", messageId: "n@x", ...news });
    // A reply in a list's discussion answers another mail: that one is people talking.
    msgs.push({ uid: 3, folder: "INBOX", at: new Date(), subject: "Re: Saturday hike", messageId: "h2@x", inReplyTo: "h1@x", references: "<h1@x>", from: ALEX, plain: "I am in.", headers: "List-Id: <hikers.club.example>\r\n" });
    await refresh(t);
    assert.equal(byS((await list(t)).messages, "Re: our chat last week")?.bundle, "promos");
    assert.deepEqual(events.map((e) => e.title), ["Alex: Re: Saturday hike"], "the newsletter is quiet, as the list shows it");
  } finally { done(t); }
});

test("review 2: a mailbox just linked takes the mail app's flags from its first refresh", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Flagged there", from: ALEX, messageId: "f1@x", plain: "x", flagged: true }, { uid: 2, folder: "INBOX", at: ago(1), subject: "Plain", from: ALEX, messageId: "f2@x", plain: "x" }]);
    await refresh(t);
    const { messages } = await list(t);
    assert.deepEqual([byS(messages, "Flagged there")?.pinned, byS(messages, "Plain")?.pinned], [true, false]);
  } finally { done(t); }
});

test("review 2: Sort new mail with nothing waiting starts no run and reports none", async () => {
  const t = makeHub();
  let calls = 0;
  try {
    linked(t);
    fake([]);
    setBackendOverride({ name: "ollama", model: "scripted", chat: async () => { calls++; return { text: "{}", usage: {} }; } } as never);
    await refresh(t);
    const r = (await (await t.api("/mail/triage", { method: "POST", json: {} })).json()) as TriageState;
    assert.deepEqual(r, { on: true, waiting: 0, running: false, auto: false });
    assert.equal(calls, 0);
  } finally { setBackendOverride(null); done(t); }
});

test("review 2: triage switched off while the hub asks whether the model is up: nothing is written after the erasing", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Can you call me today?", from: ALEX, messageId: "a1@x", plain: "The plumber needs an answer by 5." }]);
    setBackendOverride({ name: "ollama", model: "scripted", chat: async () => { throw new Error("timed out"); } } as never);
    await refresh(t);
    assert.equal(await triageNew(t.hub, new Date(), { asked: true }), 0, "no answer: passed by the first time");
    // The second time it would be kept as fyi. The owner switches triage off while the hub checks the model.
    const ai = t.hub.ai as unknown as { localModelUp: () => Promise<boolean> };
    const up = ai.localModelUp.bind(t.hub.ai);
    ai.localModelUp = async () => { await t.api("/mail/settings/triage", { method: "PUT", json: { on: false } }); return up(); };
    assert.equal(await triageNew(t.hub, new Date(), { asked: true }), 0);
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM inbox WHERE triage IS NOT NULL").get() as { n: number }).n, 0);
  } finally { setBackendOverride(null); done(t); }
});

test("review 2: a forward asked to carry the attachments of a mail that left the mailbox says so and saves nothing", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Tickets", from: ALEX, messageId: "t1@x", plain: "Here they are.", files: [{ name: "tickets.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4 made-up tickets") }] }];
    const seen = fake(msgs);
    await refresh(t);
    const id = byS((await list(t)).messages, "Tickets")!.id;
    // Deleted in the mail app since the last refresh.
    msgs.length = 0;
    const r = await t.api("/mail/drafts", { method: "POST", json: { forward: id, to: "pat@northwind.example", text: "FYI", forward_attachments: true } });
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as { error: string }).error, /not in the mailbox any more/);
    assert.equal(seen.appends.length, 0, "no draft without the files it was asked to carry");
  } finally { done(t); }
});

test("review 2: a listed folder the server will not open is passed by: the others are read, and what was kept of it stays", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 5, folder: "Sent Messages", at: ago(1), subject: "Sent one", from: { address: EMAIL }, to: [ALEX], messageId: "s1@x", plain: "x", seen: true },
      { uid: 6, folder: "Sent Messages", at: ago(1), subject: "Sent two", from: { address: EMAIL }, to: [ALEX], messageId: "s2@x", plain: "x", seen: true },
      { uid: 3, folder: "Junk", at: ago(1), subject: "You won", from: { address: "win@prize.example" }, messageId: "j1@x", plain: "x" },
    ];
    const first = fake(msgs);
    await refresh(t);
    const counts = async () => Object.fromEntries((await list(t)).folders.map((f) => [f.role, f.count]));
    assert.deepEqual([(await counts()).sent, (await counts()).junk], [2, 1]);
    // Flags are asked from the lowest listed message on, never for the whole folder.
    assert.deepEqual(first.ranges.filter((r) => r.folder === "Sent Messages").map((r) => r.range), ["5:*"]);
    assert.deepEqual(first.ranges.filter((r) => r.folder === "Junk").map((r) => r.range), ["3:*"]);
    // Sent stops opening (the server answers NO); a new mail arrives in Junk.
    msgs.push({ uid: 4, folder: "Junk", at: ago(0.5), subject: "You won again", from: { address: "win@prize.example" }, messageId: "j2@x", plain: "x" });
    const second = fake(msgs, { closed: ["Sent Messages"] });
    assert.equal((await refresh(t)).status, 200);
    assert.ok(second.opened.some((o) => o.path === "Sent Messages"), "it was tried");
    assert.deepEqual([(await counts()).sent, (await counts()).junk], [2, 2], "Junk was read after the folder that would not open; Sent's mail is not taken for gone");
  } finally { done(t); }
});

test("review 2: a folders listing that runs out of time keeps what it read, and what was kept of the folders it did not reach", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 3, folder: "Junk", at: ago(1), subject: "You won", from: { address: "win@prize.example" }, messageId: "j1@x", plain: "x" },
      { uid: 5, folder: "Sent Messages", at: ago(1), subject: "Sent one", from: { address: EMAIL }, to: [ALEX], messageId: "s1@x", plain: "x", seen: true },
      { uid: 9, folder: "Drafts", at: ago(1), subject: "A draft", from: { address: EMAIL }, to: [ALEX], messageId: "d1@x", plain: "x", seen: true },
    ];
    const seen = fake(msgs);
    await refresh(t);
    const kept = async () => (await list(t)).folders.filter((f) => f.count).map((f) => `${f.role} ${f.count}`).sort();
    assert.deepEqual(await kept(), ["drafts 1", "junk 1", "sent 1"]);
    // The server answers every folder but the Inbox after the listing's whole time is over.
    let hang = 0;
    setImapFactory((login) => {
      const c = seen.factory(login);
      const open = c.mailboxOpen.bind(c);
      c.mailboxOpen = (async (p: string, o: { readOnly: true }) => { if (p !== "INBOX") { hang++; await sleep(1500); } return open(p, o); }) as typeof c.mailboxOpen;
      return c;
    });
    setICloudDeadlines({ list: 300 });
    const started = Date.now();
    assert.equal((await refresh(t)).status, 200);
    assert.ok(Date.now() - started < 1400, "ended by the time limit, not by the server");
    assert.ok(hang >= 1);
    assert.deepEqual(await kept(), ["drafts 1", "junk 1", "sent 1"], "nothing kept is taken for gone");
    // At its usual speed again, everything is read as before.
    setICloudDeadlines(null);
    fake(msgs);
    await refresh(t);
    assert.deepEqual(await kept(), ["drafts 1", "junk 1", "sent 1"]);
  } finally { setICloudDeadlines(null); done(t); }
});

test("review 2: search matches a plain word and a word in another alphabet together, whatever their capitals", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "ÜBER die Rechnung", from: ALEX, messageId: "u1@x", plain: "Die INVOICE liegt bei." },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Invoice", from: ALEX, messageId: "u2@x", plain: "Nothing else." },
      { uid: 7, folder: "Sent Messages", at: ago(1), subject: "Re: über alles", from: { address: EMAIL }, to: [ALEX], messageId: "u3@x", plain: "Die Invoice kommt.", seen: true },
    ]);
    await refresh(t);
    const find = async (q: string) => ((await (await t.api(`/mail/search?q=${encodeURIComponent(q)}`)).json()) as { hits: { subject: string }[] }).hits.map((h) => h.subject).sort();
    assert.deepEqual(await find("invoice über"), ["Re: über alles", "ÜBER die Rechnung"]);
    assert.deepEqual(await find("INVOICE"), ["Invoice", "Re: über alles", "ÜBER die Rechnung"]);
    // The marks a search may hold are words, not patterns.
    assert.deepEqual(await find("100%_"), []);
  } finally { done(t); }
});

test("real server: a long name the server joins from its RFC 2231 pieces and sends still encoded is read; a name with a percent sign stays", async () => {
  // As Dovecot 2.4 sends it in BODYSTRUCTURE: the pieces joined under the plain key, %XX left in, the charset taken off.
  const joined = "%E5%B1%B1%E7%99%BB%E3%82%8A%E3%81%AE%E5%86%99%E7%9C%9F.pdf";
  assert.equal(decodedName(joined), "山登りの写真.pdf");
  assert.equal(decodedName(`UTF-8''${joined}`), "山登りの写真.pdf", "with its charset still in front");
  assert.equal(decodedName("iso-8859-1''R%E9sum%E9.pdf"), "Résumé.pdf");
  for (const name of ["100%25 done.pdf", "report%20final.pdf", "50% off.pdf", "%FF%FE broken.pdf", "plain.pdf", "Über.pdf"]) assert.equal(decodedName(name), name, name);
  const n = attachmentParts({ type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: joined } }] });
  assert.deepEqual(n.map((a) => a.name), ["山登りの写真.pdf"]);
  assert.equal(attachmentName(joined, "2"), "山登りの写真.pdf");
  // The hub's own drafts: a name that is not ASCII has no stand-in beside it (the server listed two names, and "_.pdf"
  // won), its type's name is RFC 2047 words, and a mail parser reads both forms.
  const libmime = (await import("libmime")).default as { parseHeaderValue(v: string): { params: Record<string, string> }; decodeWords(v: string): string };
  const h = fileHeaders({ name: "山登りの写真と地図の一覧表.pdf", type: "application/pdf" });
  const unfolded = h.replace(/\r\n(?=[ \t])/g, "");
  assert.doesNotMatch(h, /filename="/);
  assert.match(h, /^ name="=\?UTF-8\?B\?/m);
  assert.equal(libmime.decodeWords(libmime.parseHeaderValue(/^Content-Type: (.*)$/m.exec(unfolded)![1]).params.name), "山登りの写真と地図の一覧表.pdf");
  assert.equal(libmime.parseHeaderValue(/^Content-Disposition: (.*)$/m.exec(unfolded)![1]).params.filename, "山登りの写真と地図の一覧表.pdf");
  for (const line of h.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.equal(fileHeaders({ name: "plan.pdf", type: "application/pdf" }), 'Content-Type: application/pdf;\r\n name="plan.pdf"\r\nContent-Disposition: attachment;\r\n filename="plan.pdf"', "a plain name as before");
});
