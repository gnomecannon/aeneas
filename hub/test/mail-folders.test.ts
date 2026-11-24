import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, FOLDERS, linked, type Msg } from "./fake-icloud-mail.js";
import { shownFolders } from "../src/imports/icloud.js";
import type { MailFolder, MailMessage, MailSummary } from "../src/mail-inbox.js";

// The Mail screen's other folders: Drafts, Sent, Junk, Trash and the owner's own, kept like the Inbox, read-only.
// Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const SPAM = { name: "Prize Desk", address: "win@prize.example" };
const mailbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?" },
  { uid: 1, folder: "Drafts", at: ago(1), subject: "Re: Lunch?", from: { address: EMAIL }, to: [ALEX], messageId: "d1@x", plain: "Thursday works", seen: true },
  { uid: 1, folder: "Sent Messages", at: ago(2), subject: "Photos", from: { address: EMAIL }, to: [{ name: "Sam", address: "sam@example.com" }], messageId: "s1@x", plain: "Here they are.", seen: true },
  { uid: 1, folder: "Junk", at: ago(1), subject: "You won!", from: SPAM, messageId: "j1@x", html: `<p>Claim it <img src="https://prize.example/track.png" width="300" height="200"></p>`, plain: "Claim it" },
  { uid: 2, folder: "Junk", at: ago(200), subject: "Old spam", from: SPAM, messageId: "j0@x", plain: "old" },
  { uid: 1, folder: "Deleted Messages", at: ago(3), subject: "Old newsletter", from: { address: "news@shop.example" }, messageId: "t1@x", plain: "Sale", seen: true },
  { uid: 1, folder: "Archive", at: ago(4), subject: "Archived", from: ALEX, messageId: "a1@x", plain: "Kept" },
];
const get = async <T>(t: TestHub, p: string) => (await (await t.api(p)).json()) as T;

test("mail folders: Drafts, Sent, Junk and Trash are kept and listed in that order, not Archive (Done shows it)", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(mailbox());
    await t.api("/mail/refresh", { method: "POST" });
    const list = await get<{ messages: MailSummary[]; folders: MailFolder[] }>(t, "/mail");
    assert.deepEqual(list.folders.map((f) => [f.role, f.count, f.unread]), [["drafts", 1, 0], ["sent", 1, 0], ["junk", 1, 1], ["trash", 1, 0]], "Junk's 200-day-old mail is past the 90 days");
    assert.deepEqual(list.messages.map((m) => m.subject), ["Lunch?"], "the Inbox's list has only Inbox mail");
    assert.ok(seen.opened.every((o) => o.readOnly === true), "every folder opened read-only");
    assert.deepEqual([seen.moves.length, seen.flags.length, seen.appends.length], [0, 0, 0], "nothing written");

    const sent = await get<{ messages: (MailSummary & { to: { address: string }[]; folder_role: string })[] }>(t, `/mail/folders/${list.folders[1].key}`);
    assert.deepEqual(sent.messages.map((m) => [m.subject, m.to.map((x) => x.address), m.mine, m.state]), [["Photos", ["sam@example.com"], true, "folder"]]);

    const junk = await get<{ messages: MailSummary[] }>(t, `/mail/folders/${list.folders[2].key}`);
    const open = await get<MailMessage>(t, `/mail/messages/${junk.messages[0].id}`);
    assert.equal(open.subject, "You won!");
    assert.equal(open.pictures_pending || open.pictures_ask, false, "no web pictures for folder mail");
    assert.doesNotMatch(open.html ?? "", /prize\.example\/track/, "the picture's address is not in the page");
    assert.equal((await t.api("/mail/folders/nope")).status, 404);
  } finally { done(t); }
});

test("mail folders: mail that left a folder goes at the next refresh; unlinking takes the folders too", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = mailbox();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    msgs.splice(msgs.findIndex((m) => m.folder === "Deleted Messages"), 1);
    msgs.find((m) => m.folder === "Junk" && m.uid === 1)!.seen = true;
    await t.api("/mail/refresh", { method: "POST" });
    const folders = (await get<{ folders: MailFolder[] }>(t, "/mail")).folders;
    assert.deepEqual(folders.map((f) => [f.role, f.count, f.unread]), [["drafts", 1, 0], ["sent", 1, 0], ["junk", 1, 0], ["trash", 0, 0]], "read in Apple Mail counts");
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM folder_mail").get() as { n: number }).n, 0, "switching Mail off deletes folder mail");
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM folders").get() as { n: number }).n, 0);
  } finally { done(t); }
});

test("mail folders: which folders show, by iCloud's marks", () => {
  const f = (path: string, specialUse?: string, flags: string[] = []) => ({ path, specialUse, flags: new Set(flags) });
  assert.deepEqual(shownFolders([f("INBOX"), f("Archive", "\\Archive"), f("Brouillons", "\\Drafts"), f("Envoyés", "\\Sent"), f("Indésirables", "\\Junk"), f("Corbeille", "\\Trash"), f("Taxes"), f("[Gmail]", undefined, ["\\Noselect"]), f("All Mail", "\\All")]),
    [{ path: "Brouillons", role: "drafts", name: "Brouillons" }, { path: "Envoyés", role: "sent", name: "Envoyés" }, { path: "Indésirables", role: "junk", name: "Indésirables" }, { path: "Corbeille", role: "trash", name: "Corbeille" }, { path: "Taxes", role: "own", name: "Taxes" }]);
  // A folder's name is the last part of its path by the server's own mark between parts: a dot is part of a name on
  // a server that parts with "/", and the other way round.
  const named = (path: string, delimiter?: string, name?: string) => shownFolders([{ path, flags: new Set<string>(), ...(delimiter ? { delimiter } : {}), ...(name ? { name } : {}) }])[0].name;
  assert.equal(named("Money/Taxes 2025.Q1", "/"), "Taxes 2025.Q1");
  assert.equal(named("INBOX.Money.Taxes", "."), "Taxes");
  assert.equal(named("Money/Taxes 2025.Q1", "/", "Taxes 2025.Q1"), "Taxes 2025.Q1", "the server's own name when it gives one");
  assert.equal(named("Taxes 2025.Q1"), "Taxes 2025.Q1", "no mark known: the whole path");
});

test("mail folders: a folder's name is kept as the server gives it, dots and all", async () => {
  const t = makeHub();
  try {
    linked(t);
    FOLDERS.push({ path: "Money/Taxes 2025.Q1", name: "Taxes 2025.Q1", delimiter: "/", flags: new Set() });
    fake([{ uid: 1, folder: "Money/Taxes 2025.Q1", at: ago(1), subject: "Receipt", from: ALEX, messageId: "q1@x", plain: "Kept." }]);
    await t.api("/mail/refresh", { method: "POST" });
    const own = (await get<{ folders: MailFolder[] }>(t, "/mail")).folders.find((f) => f.role === "own")!;
    assert.equal(own.name, "Taxes 2025.Q1");
    const hit = (await get<{ hits: { folder_name?: string }[] }>(t, "/mail/search?q=receipt")).hits[0];
    assert.equal(hit.folder_name, "Taxes 2025.Q1");
  } finally { FOLDERS.pop(); done(t); }
});

test("mail folders: a folder with more than 500 mails keeps the newest 500 and then downloads nothing again", async () => {
  const t = makeHub();
  try {
    linked(t);
    // 520 sent mails of the last 90 days. The oldest by number are among the newest by date (moved in late, as a
    // mail app does), so keeping by date and listing by number would never agree.
    const sent: Msg[] = Array.from({ length: 520 }, (_, i) => ({ uid: i + 1, folder: "Sent Messages", at: ago(i < 30 ? 1 : 2 + (i % 80)), subject: `Sent ${i + 1}`, from: { address: EMAIL }, to: [ALEX], messageId: `s${i + 1}@x`, plain: "Hi", seen: true }));
    const seen = fake(sent);
    const count = () => (t.hub.mailDb.prepare("SELECT count(*) AS n FROM folder_mail").get() as { n: number }).n;
    // 50 new mails of a folder a refresh: ten refreshes bring the 500.
    for (let i = 0; i < 10; i++) await t.api("/mail/refresh", { method: "POST" });
    assert.equal(count(), 500);
    const lowest = (t.hub.mailDb.prepare("SELECT min(CAST(substr(id, 3, instr(substr(id, 3), ':') - 1) AS INTEGER)) AS u FROM folder_mail").get() as { u: number }).u;
    assert.equal(lowest, 21, "the newest 500 by their number in the folder");
    const folders = (await get<{ folders: MailFolder[] }>(t, "/mail")).folders;
    assert.deepEqual(folders.filter((f) => f.role === "sent").map((f) => [f.count, f.more]), [[500, false]], "nothing more is waiting");
    // Every refresh after that reads no mail again.
    const fetched = seen.fetches.length;
    for (let i = 0; i < 3; i++) await t.api("/mail/refresh", { method: "POST" });
    assert.equal(seen.fetches.length, fetched, "no mail is downloaded a second time");
    assert.equal(count(), 500);
  } finally { done(t); }
});
