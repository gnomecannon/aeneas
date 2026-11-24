import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, partName, type Msg } from "./fake-icloud-mail.js";
import { setImapFactory, type ImapClient } from "../src/imports/icloud.js";
import type { MailFolder, MailSummary, SearchHit } from "../src/mail-inbox.js";
import { bundleOf, NO_MODULES } from "../src/mail-bundles.js";
import { blockRefusal, isBlocked } from "../src/mail-unsubscribe.js";
import { buildMessage, checkedLine, checkedNew, checkedReply, fileHeaders, fileName, isAddress, plainAddress } from "../src/mail-compose.js";

// What the review of the Mail change (2026-11-23) found in the store, the bundles and the writing code, each with the
// case that showed it. Made-up mail, people and senders.

const ALEX = { name: "Alex", address: "alex@northwind.example" };
const list = async (t: TestHub) => (await (await t.api("/mail")).json()) as { messages: MailSummary[]; folders: MailFolder[]; mailboxes: { email: string; kind?: string; provider?: string }[] };
const refresh = (t: TestHub) => t.api("/mail/refresh", { method: "POST" });
/** `undo`: the screen's Undo, which puts mail going back to the Inbox back as it was. */
const move = async (t: TestHub, ids: string[], to: string, undo = false) => (await (await t.api("/mail/move", { method: "POST", json: { ids, to, ...(undo ? { undo: true } : {}) } })).json()) as { moved: string[]; failed: number; to: Record<string, string> };
const byS = (ms: MailSummary[], s: string) => ms.find((m) => m.subject === s);

test("review: Undo of Delete puts a snoozed mail back snoozed, with a reminder, its note and its triage", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?\n\nOn Monday Alex wrote:\n> an older line" }];
    fake(msgs);
    await refresh(t);
    const lunch = byS((await list(t)).messages, "Lunch?")!;
    const until = new Date(Date.now() + 3 * 86400_000).toISOString();
    assert.equal((await t.api(`/mail/messages/${lunch.id}/snooze`, { method: "POST", json: { until } })).status, 200);
    t.hub.mailDb.prepare("UPDATE inbox SET triage = ?, triaged_at = ?, fold_note = ? WHERE key = ?").run(JSON.stringify({ urgency: "soon", needs_reply: true }), new Date().toISOString(), JSON.stringify({ cut: "On Monday Alex wrote:", lines: [], no_fold: true, at: new Date().toISOString() }), lunch.id);
    const tasks = () => t.hub.store.list({ kind: "task", limit: 100 }).filter((e) => e.fields.mail === lunch.id && !e.deleted_at);
    assert.equal(tasks().filter((e) => e.fields.status !== "done").length, 1);
    // Delete: to Trash, its reminder done with it.
    const gone = await move(t, [lunch.id], "trash");
    assert.equal(msgs[0].folder, "Deleted Messages");
    assert.equal(tasks().filter((e) => e.fields.status !== "done").length, 0);
    // Undo: back where it was, as it was, under the id it had.
    // What is remembered holds the mail's facts, not its text a second time (the folder's copy has that).
    const remembered = (t.hub.mailDb.prepare("SELECT ref, row FROM moved_out").all() as { ref: string; row: string }[]);
    assert.deepEqual(remembered.map((r) => r.ref), [`k:${gone.to[lunch.id]}`], "known by where the mail went");
    assert.deepEqual([Object.hasOwn(JSON.parse(remembered[0].row), "text"), Object.hasOwn(JSON.parse(remembered[0].row), "html"), JSON.parse(remembered[0].row).state], [false, false, "snoozed"]);
    const back = await move(t, [gone.to[lunch.id]], "inbox", true);
    assert.equal(msgs[0].folder, "INBOX");
    assert.equal(back.to[gone.to[lunch.id]], lunch.id, "its old id again");
    await refresh(t);
    const again = byS((await list(t)).messages, "Lunch?")!;
    assert.deepEqual([again.id, again.state, again.snooze_until], [lunch.id, "snoozed", until]);
    assert.deepEqual(again.triage, { urgency: "soon", needs_reply: true });
    assert.equal(((await (await t.api(`/mail/messages/${lunch.id}`)).json()) as { no_fold?: boolean }).no_fold, true, "its folding note");
    assert.equal(tasks().filter((e) => e.fields.status !== "done").length, 1, "one reminder again");
    assert.equal((await list(t)).messages.filter((m) => m.subject === "Lunch?").length, 1, "once, not also as new mail");
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM moved_out").get() as { n: number }).n, 0, "nothing remembered after it is back");
  } finally { done(t); }
});

test("review: Undo of Delete puts done mail back as done, in the archive; other mail back as it was", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(2), subject: "Receipt", from: { address: "orders@shop.example" }, messageId: "r1@x", plain: "Thanks" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Hello", from: ALEX, messageId: "h1@x", plain: "Hi" },
    ];
    fake(msgs);
    await refresh(t);
    const before = (await list(t)).messages;
    const receipt = byS(before, "Receipt")!;
    const hello = byS(before, "Hello")!;
    await t.api("/mail/done", { method: "POST", json: { ids: [receipt.id] } });
    assert.equal(msgs[0].folder, "Archive");
    const gone = await move(t, [receipt.id, hello.id], "trash");
    assert.deepEqual(msgs.map((m) => m.folder), ["Deleted Messages", "Deleted Messages"]);
    await move(t, [gone.to[receipt.id], gone.to[hello.id]], "inbox", true);
    assert.equal(msgs[0].folder, "Archive", "done mail is in the archive again, not in the Inbox");
    assert.equal(msgs[1].folder, "INBOX");
    await refresh(t);
    const after = (await list(t)).messages;
    assert.deepEqual([byS(after, "Receipt")!.id, byS(after, "Receipt")!.state], [receipt.id, "done"]);
    assert.deepEqual([byS(after, "Hello")!.id, byS(after, "Hello")!.state], [hello.id, "inbox"]);
    // What a moved mail was is remembered while the mail is in a kept folder, and at most 30 days.
    const remembered = () => (t.hub.mailDb.prepare("SELECT count(*) AS n FROM moved_out").get() as { n: number }).n;
    const again = await move(t, [hello.id, receipt.id], "trash");
    assert.ok(again.to[hello.id]);
    assert.equal(remembered(), 2);
    await refresh(t);
    assert.equal(remembered(), 2, "still in Trash: still remembered");
    // Trash emptied in the mail app for one of them: what it was goes with it.
    msgs.splice(msgs.findIndex((m) => m.messageId === "r1@x"), 1);
    await refresh(t);
    assert.equal(remembered(), 1);
    t.hub.mailDb.prepare("UPDATE moved_out SET moved_at = ?").run(new Date(Date.now() - 31 * 86400_000).toISOString());
    await refresh(t);
    assert.equal(remembered(), 0, "and after 30 days");
  } finally { done(t); }
});

test("review: Move to Inbox is a plain move: only Undo puts a mail back as it was", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(2), subject: "Receipt", from: { address: "orders@shop.example" }, messageId: "r1@x", plain: "Thanks" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?" },
    ];
    fake(msgs);
    await refresh(t);
    const before = (await list(t)).messages;
    const receipt = byS(before, "Receipt")!;
    const lunch = byS(before, "Lunch?")!;
    await t.api("/mail/done", { method: "POST", json: { ids: [receipt.id] } });
    await t.api(`/mail/messages/${lunch.id}/snooze`, { method: "POST", json: { until: new Date(Date.now() + 3 * 86400_000).toISOString() } });
    const gone = await move(t, [receipt.id, lunch.id], "trash");
    // Days later, Move to Inbox pressed in Trash: both are in the Inbox, as plain mail, and nothing is remembered.
    await move(t, [gone.to[receipt.id], gone.to[lunch.id]], "inbox");
    assert.deepEqual(msgs.map((m) => m.folder), ["INBOX", "INBOX"], "neither is archived again");
    await refresh(t);
    const after = (await list(t)).messages;
    assert.deepEqual([byS(after, "Receipt")!.state, byS(after, "Lunch?")!.state, byS(after, "Lunch?")!.snooze_until], ["inbox", "inbox", undefined]);
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM moved_out").get() as { n: number }).n, 0);
  } finally { done(t); }
});

test("review: another mail with the same Message-ID never takes a deleted mail's place on Undo", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(2), subject: "The real one", from: ALEX, messageId: "same@x", plain: "From Alex." }];
    fake(msgs);
    await refresh(t);
    const real = byS((await list(t)).messages, "The real one")!;
    const first = await move(t, [real.id], "trash");
    // Anyone can write any Message-ID: a second mail arrives carrying the same one, and is deleted too.
    msgs.push({ uid: 9, folder: "INBOX", at: ago(1), subject: "An impostor", from: { name: "Prize Desk", address: "win@prize.example" }, messageId: "same@x", plain: "Claim it." });
    await refresh(t);
    const fake2 = byS((await list(t)).messages, "An impostor")!;
    await move(t, [fake2.id], "trash");
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM moved_out").get() as { n: number }).n, 2, "each is remembered by its own place in Trash");
    // Undo of the first: the first mail's own sender and words, under its own id.
    const back = await move(t, [first.to[real.id]], "inbox", true);
    assert.equal(back.to[first.to[real.id]], real.id);
    const again = ((await (await t.api(`/mail/messages/${real.id}`)).json()) as { subject: string; text: string; from: { address: string } });
    assert.deepEqual([again.subject, again.text, again.from.address], ["The real one", "From Alex.", "alex@northwind.example"]);
  } finally { done(t); }
});

test("review: a mailbox unlinked while a Delete is on its way leaves nothing of the mail behind", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?" }];
    const seen = fake(msgs);
    await refresh(t);
    const lunch = byS((await list(t)).messages, "Lunch?")!;
    // The owner removes the account while the mail server is doing the move.
    setImapFactory((login) => {
      const c = seen.factory(login) as ImapClient & { messageMove: (...a: unknown[]) => Promise<unknown> };
      const moveIt = c.messageMove.bind(c);
      c.messageMove = async (...a) => { const r = await moveIt(...a); await t.api(`/connections/accounts/${encodeURIComponent(`icloud:${EMAIL}`)}`, { method: "DELETE" }); return r; };
      return c;
    });
    const r = await move(t, [lunch.id], "trash");
    assert.deepEqual([r.moved, r.failed], [[], 1], "the hub says nothing moved on its side");
    for (const table of ["inbox", "folder_mail", "folders", "moved_out", "mailboxes"]) {
      assert.equal((t.hub.mailDb.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
  } finally { done(t); }
});

test("review: Block sender refuses the owner's own address, a mail provider's whole domain and a shared ending", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(1), subject: "You won!", from: { address: "win@prize.example" }, messageId: "p1@x", plain: "Claim it" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Again", from: { address: "\"a@b\"@prize.example" }, messageId: "p2@x", plain: "Claim it" },
      { uid: 3, folder: "INBOX", at: ago(1), subject: "Hello", from: ALEX, messageId: "h1@x", plain: "Hi" },
    ];
    fake(msgs);
    await refresh(t);
    const block = (sender: string) => t.api("/mail/settings/blocked", { method: "POST", json: { sender } });
    for (const [sender, why] of [[EMAIL, /your own address/], ["@gmail.com", /Many people have an address at gmail\.com/], ["@icloud.com", /Many people/], ["@co.uk", /ending of many sites/], ["@com.au", /ending of many sites/]] as const) {
      const r = await block(sender);
      assert.equal(r.status, 422, sender);
      assert.match(((await r.json()) as { error: string }).error, why);
    }
    assert.equal(msgs.every((m) => m.folder === "INBOX"), true, "nothing moved by a refused block");
    assert.deepEqual((await list(t) as unknown as { blocked: string[] }).blocked, []);
    // One address at a mail provider can be blocked; a domain block takes a sender whose address holds an @ in quotes.
    assert.equal((await block("them@gmail.com")).status, 200);
    const r = (await (await block("@prize.example")).json()) as { moved: number; failed: number; to: Record<string, string>; error?: string };
    assert.deepEqual([r.moved, r.failed, Object.keys(r.to).length, r.error], [2, 0, 2, undefined], "what moved, and where it is now, for an Undo");
    assert.deepEqual(msgs.map((m) => m.folder), ["Junk", "Junk", "INBOX"]);
    assert.equal(isBlocked(["@prize.example"], "\"a@b\"@prize.example"), true);
    assert.equal(isBlocked(["@b"], "\"a@b\"@prize.example"), false);
    assert.equal(blockRefusal("@shop.example", [EMAIL]), null);
    // Another address at the owner's own domain is not their own, and can be blocked (the whole domain cannot:
    // mail-review-second.test.ts).
    assert.equal(blockRefusal("them@icloud.example", [EMAIL]), null);
  } finally { done(t); }
});

test("review: a bundle edited by an app that does not know text words and recipients keeps them", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
    const made = (await (await t.api("/mail/settings/custom-bundles", { method: "POST", json: { name: "School", color: 2, addresses: ["office@school.example"], body_words: ["permission slip"], to: ["family@northwind.example"] } })).json()) as { id: string };
    const edit = (body: unknown) => t.api(`/mail/settings/custom-bundles/${made.id}`, { method: "PUT", json: body });
    // As an app from before those rules sends it: without them.
    const kept = (await (await edit({ name: "School and clubs", color: 3, addresses: ["office@school.example"], domains: [], words: [] })).json()) as { name: string; body_words?: string[]; to?: string[] };
    assert.deepEqual([kept.name, kept.body_words, kept.to], ["School and clubs", ["permission slip"], ["family@northwind.example"]]);
    // Even with every rule it knows taken out, the bundle still has rules.
    assert.equal((await edit({ name: "School", color: 3, addresses: [], domains: [], words: [] })).status, 200);
    // An app that knows them can take them out.
    const cleared = (await (await edit({ name: "School", color: 3, addresses: ["office@school.example"], body_words: [], to: [] })).json()) as { body_words?: string[]; to?: string[] };
    assert.deepEqual([cleared.body_words, cleared.to], [undefined, undefined]);
  } finally { t.cleanup(); }
});

test("review: a newsletter that writes Re: is not people talking; a reply in a list's discussion is", () => {
  const news = { from: { name: "Deals", address: "deals@shop.example" }, subject: "Re: our chat last week", automated: true, unsubscribe: true, list_id: "<deals.shop.example>" };
  assert.equal(bundleOf({ ...news, answers: false }, NO_MODULES), "promos", "it answers nothing");
  assert.equal(bundleOf({ ...news, subject: "Re: Saturday hike", answers: true }, NO_MODULES), null, "a reply to another mail, on a list");
  assert.equal(bundleOf({ ...news, subject: "Re: Saturday hike" }, NO_MODULES), null, "mail kept before the hub knew what it answers: as before");
});

test("review: search finds a word whatever its capitals, in any alphabet, and the owner's reply once", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(3), subject: "Über den Ausflug", from: ALEX, messageId: "g1@x", plain: "Привет, Robin. Samstag?" },
      { uid: 1, folder: "Sent Messages", at: ago(2), subject: "Re: Über den Ausflug", from: { name: "Robin", address: EMAIL }, to: [ALEX], messageId: "me1@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Ja, Samstag passt." },
    ]);
    await refresh(t);
    const search = async (q: string) => ((await (await t.api(`/mail/search?q=${encodeURIComponent(q)}`)).json()) as { hits: SearchHit[] }).hits;
    assert.deepEqual((await search("über")).map((h) => h.subject), ["Re: Über den Ausflug", "Über den Ausflug"]);
    assert.equal((await search("ÜBER AUSFLUG")).length, 2);
    assert.deepEqual((await search("привет")).map((h) => h.subject), ["Über den Ausflug"]);
    const mine = (await search("passt"));
    assert.equal(mine.length, 1, "the reply in its thread and its copy in Sent are one mail");
    assert.equal(mine[0].where, "sent");
    assert.equal(new Set((await search("samstag")).map((h) => h.id)).size, (await search("samstag")).length, "no id twice");
    assert.equal(mine[0].mailbox, EMAIL, "each mail says which mailbox it is in");
    const l = await list(t);
    assert.ok(l.messages.every((m) => m.mailbox === EMAIL));
    assert.deepEqual(l.mailboxes.map((m) => [m.email, m.kind, m.provider]), [[EMAIL, "icloud", "iCloud"]]);
  } finally { done(t); }
});

test("review: pins from before flags are flagged once, and that refresh's flags (read before) take none away", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    fake(msgs);
    await refresh(t);
    // A pin from before pins were flags, on a hub that has not flagged it yet.
    t.hub.mailDb.prepare("UPDATE inbox SET pinned = 1").run();
    t.hub.mailDb.prepare("DELETE FROM settings WHERE key LIKE 'pins_flagged:%'").run();
    await refresh(t);
    assert.equal((await list(t)).messages[0].pinned, true, "flagged now, after the listing: the listing's flags decide no pin");
    assert.equal(msgs[0].flagged, true);
    await refresh(t);
    assert.equal((await list(t)).messages[0].pinned, true, "the next refresh reads the flag");
    // Unflagged in the mail app: unpinned at the next refresh, as before.
    msgs[0].flagged = false;
    await refresh(t);
    assert.equal((await list(t)).messages[0].pinned, false);
  } finally { done(t); }
});

test("review: a mailbox paused after a refused password with old pins can still be refreshed by the owner", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    fake(msgs);
    await refresh(t);
    t.hub.mailDb.prepare("UPDATE inbox SET pinned = 1").run();
    t.hub.mailDb.prepare("DELETE FROM settings WHERE key LIKE 'pins_flagged:%'").run();
    t.hub.connections.update((c) => { c.icloud![0].refused_at = new Date().toISOString(); });
    // The owner's Refresh tries the paused mailbox once: it must get as far as signing in.
    const r = (await (await refresh(t)).json()) as { mailboxes: { error?: string }[] };
    assert.equal(r.mailboxes[0].error, undefined, "refreshed");
    assert.equal(t.hub.connections.get().icloud![0].refused_at ?? null, null, "and no longer paused");
    assert.equal((await list(t)).messages[0].pinned, true);
  } finally { done(t); }
});

test("review: old pins stay while the mailbox cannot take the flag, the refresh still keeps new mail, and it is tried again", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(2), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    const seen = fake(msgs);
    await refresh(t);
    t.hub.mailDb.prepare("UPDATE inbox SET pinned = 1").run();
    t.hub.mailDb.prepare("DELETE FROM settings WHERE key LIKE 'pins_flagged:%'").run();
    msgs.push({ uid: 2, folder: "INBOX", at: ago(1), subject: "New", from: ALEX, messageId: "n1@x", plain: "Hi" });
    // The server takes no flag right now: every try to set one fails.
    let failing = true;
    setImapFactory((login) => {
      const c = seen.factory(login) as ImapClient & { messageFlagsAdd: (...a: unknown[]) => Promise<boolean> };
      const add = c.messageFlagsAdd.bind(c);
      c.messageFlagsAdd = async (...a) => { if (failing) throw new Error("no answer"); return add(...a); };
      return c;
    });
    const r = (await (await refresh(t)).json()) as { mailboxes: { error?: string; kept?: number }[] };
    assert.deepEqual([r.mailboxes[0].error, r.mailboxes[0].kept], [undefined, 1], "the refresh worked, and the new mail is kept");
    assert.equal(byS((await list(t)).messages, "Gutters")?.pinned, true, "no pin taken away");
    assert.equal(msgs[0].flagged ?? false, false);
    await refresh(t);
    assert.equal(byS((await list(t)).messages, "Gutters")?.pinned, true, "still not flagged: still pinned");
    // The server takes flags again: flagged at the next refresh, and from then on the mailbox's flags decide.
    failing = false;
    await refresh(t);
    assert.equal(msgs[0].flagged, true);
    await refresh(t);
    assert.equal(byS((await list(t)).messages, "Gutters")?.pinned, true);
  } finally { done(t); }
});

test("review: done mail unflagged in the mail app is no longer pinned", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(2), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Other", from: ALEX, messageId: "o1@x", plain: "Hi" },
    ];
    fake(msgs);
    await refresh(t);
    const gutters = byS((await list(t)).messages, "Gutters")!;
    await t.api(`/mail/messages/${gutters.id}/pin`, { method: "POST", json: { pinned: true } });
    await t.api("/mail/done", { method: "POST", json: { ids: [gutters.id] } });
    await refresh(t);
    assert.deepEqual([byS((await list(t)).messages, "Gutters")!.state, byS((await list(t)).messages, "Gutters")!.pinned], ["done", true], "flagged in the archive: still pinned");
    msgs.find((m) => m.messageId === "g1@x")!.flagged = false;
    await refresh(t);
    assert.equal(byS((await list(t)).messages, "Gutters")!.pinned, false, "unflagged there: unpinned here");
  } finally { done(t); }
});

test("review: Pin answers without waiting for the mailbox, and says so", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    fake(msgs);
    await refresh(t);
    const id = (await list(t)).messages[0].id;
    const quick = (await (await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: true } })).json()) as { synced: number; pending?: boolean };
    assert.deepEqual([quick.synced, quick.pending], [1, undefined], "the mailbox answered in time");
    assert.equal((await t.api("/mail/messages/nope/pin", { method: "POST", json: { pinned: true } })).status, 404);
    // A mail server that takes a long time to connect (a first refresh running, a slow sign-in).
    let release: () => void = () => {};
    const slow = new Promise<void>((go) => { release = go; });
    setImapFactory(() => ({ async connect() { await slow; throw new Error("gone"); }, async logout() {}, close() {} } as unknown as ImapClient));
    const started = Date.now();
    const r = (await (await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: false } })).json()) as { ok: boolean; pinned: boolean; synced: number; pending?: boolean };
    assert.ok(Date.now() - started < 8000, "answered after a few seconds, not after the mailbox");
    assert.deepEqual([r.ok, r.pinned, r.synced, r.pending], [true, false, 0, true]);
    assert.equal((await list(t)).messages[0].pinned, false, "the pin is off on the hub at once");
    release();
    await new Promise((go) => setTimeout(go, 50));
  } finally { done(t); }
});

test("review: plain words hold no site's name and no long number, also in full-width, other alphabets' digits, with unseen characters or marks between", () => {
  const bad = [
    "Visit corp-login.xyz", "See paypa1.ru/login", "account 1234/5678/9012", "Call 555 010 0199", "PIN １２３４５", "Thanks,\nRobin at evil.example", "Sign in at x.co", "pay 12 34 56 78", "٠١٢٣٤٥",
    // A character that draws nothing inside the name, or a mark between the name and its dot.
    "Visit corp-login\u200b.xyz", "Visit corp-login.\u200dxyz", "Visit corp-login\u034f.xyz", "Visit corp-login\ufe0f.xyz", "Visit corp-login.x\u0301yz", "Visit corp\u00adlogin.xyz", "Read \u202ezyx.nigol-proc",
    // The ideographic full stop, whole and half-width, read as a dot by what resolves names.
    "Visit corp-login。xyz", "Visit corp-login｡xyz", "www。corp-login",
    // Digits in groups with something else between them.
    "code 1234 then 5678", "pay 12 x 34 x 56 x 7", "Call 555 and 010 and 0199", "ref 12ab34cd56ef7",
  ];
  for (const b of bad) {
    assert.equal(checkedReply(b), null, JSON.stringify(b));
    assert.equal(checkedLine(b), null, JSON.stringify(b));
  }
  // A heart drawn in color (a variation selector after it) and a letter with its accent apart are still plain words.
  for (const ok of ["Thanks \u2764\ufe0f", "Merci, a\u0300 bientot.", "See you at 10:30 on the 3rd."]) assert.equal(checkedReply(ok), ok, JSON.stringify(ok));
  for (const ok of ["Saturday at 10 works for me.", "Thanks, see you on the 24th.", "Yes, 2026 is fine.", "Hi Dr. Patel,", "Sounds good, e.g. Friday.", "Thanks,\nRobin"]) {
    assert.equal(checkedReply(ok.replace(/\n/g, " ")), ok.replace(/\n/g, " "), ok);
    assert.equal(checkedLine(ok), ok, ok);
  }
});

test("review: a long file name in another alphabet: no header line a server may refuse, its ending kept, and a mail parser reads it back", async () => {
  const libmime = (await import("libmime")).default as { parseHeaderValue(v: string): { value: string; params: Record<string, string> } };
  const read = (h: string) => libmime.parseHeaderValue(/Content-Disposition: ([^]*)$/.exec(h.replace(/\r\n(?=[ \t])/g, ""))![1]).params.filename;
  // 180 letters of 3 bytes each: on one line its header was over 1,600 bytes.
  const long = fileName(`${"報告書".repeat(60)}.pdf`);
  assert.ok(long.endsWith(".pdf") && long.length <= 120 && Buffer.byteLength(long) <= 240, "cut before its ending");
  const h = fileHeaders({ name: long, type: "application/pdf" });
  for (const line of h.split("\r\n")) assert.ok(line.length <= 76, `a line of ${line.length}: ${line.slice(0, 40)}`);
  assert.match(h, /filename\*0\*=UTF-8''%E5/);
  assert.equal(read(h), long, "the pieces make the name again");
  assert.equal(partName(h), long);
  // Marks a value may not hold as they are, and a name of two alphabets.
  for (const name of ["Robin's (final) plan ünï.pdf", "été 2026 *.txt", "файл 100%.docx", "😀 notes.md"].map((x) => fileName(x))) {
    const one = fileHeaders({ name, type: "text/plain" });
    assert.equal(read(one), name, name);
    assert.doesNotMatch(/filename\*[^=]*=([^;\r\n]*)/.exec(one)![1].replace(/^UTF-8''/, ""), /['()*]/);
  }
  // A plain name is written once, as it is; a long one keeps its ending.
  assert.equal(fileHeaders({ name: "plan.pdf", type: "application/pdf" }), 'Content-Type: application/pdf;\r\n name="plan.pdf"\r\nContent-Disposition: attachment;\r\n filename="plan.pdf"');
  assert.equal(fileName(`${"a".repeat(300)}.numbers`), `${"a".repeat(112)}.numbers`);
  assert.equal(fileName("Report v1.2 final draft"), "Report v1.2 final draft");
  // In a whole message: every header line of every part is within what a server must take.
  const { raw } = buildMessage({ from: { name: "Robin", address: EMAIL }, to: ["alex@northwind.example"], subject: "Files", text: "Here.", files: [{ name: long, type: "application/pdf", bytes: Buffer.from("x") }] });
  for (const line of raw.toString().split("\r\n")) assert.ok(Buffer.byteLength(line) <= 998);
});

test("review: addresses: a domain in another alphabet is taken in its ASCII form, a control character never", () => {
  assert.equal(plainAddress("Robin@Пример.рф"), "robin@xn--e1afmkfd.xn--p1ai");
  assert.deepEqual(checkedNew({ to: ["robin@пример.рф", "alex@northwind.example"], subject: "Hi" }).to, ["robin@xn--e1afmkfd.xn--p1ai", "alex@northwind.example"]);
  assert.equal(isAddress("robin@xn--e1afmkfd.xn--p1ai"), true);
  for (const bad of ["ro\u0001bin@northwind.example", "ro\u007fbin@northwind.example", "robin@northwind.example\r\nBcc: x@y.example", "рobin@northwind.example", "robin@", "@northwind.example", "robin@north wind.example"]) {
    assert.equal(plainAddress(bad), null, JSON.stringify(bad));
    assert.throws(() => checkedNew({ to: [bad], subject: "Hi" }));
  }
});

