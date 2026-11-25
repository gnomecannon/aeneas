import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { blockedSenders, blockSender, clearFoldNotes, foldNotes, saveFoldNote, setTriage, triageOn, triageState, requestTriage, bundleDelivery, folderMail, searchMail, unblockSender, unsubscribe, unsubscribeOptions, mailAttachment, mailAttachments, moveMail, listMail, mailFolders, mailboxStates, mailLogos, mailMessage, mailNotify, markDone, MOVE_MAX, refreshMail, saveMailDraft, suggestGreeting, saveBundleDelivery, saveMailNotify, saveSnoozeTimes, setPinned, setPinnedSynced, setSeen, showPictures, SNOOZE_MAX_DAYS, snoozeMail, snoozeTimes, undoDone, unsnoozeMail, wakeSnoozed, SEEN_MAX, setSeenMany } from "../mail-inbox.js";
import { readJsonObject } from "../http.js";
import { addCustomBundle, bundleContext, customBundles, deleteCustomBundle, updateCustomBundle } from "../mail-bundles.js";
import { rfc2231 } from "../mail-compose.js";
import { draftFromOutbox, outboxItem, outboxList, retrySend, sendMail, takeBack } from "../mail-outbox.js";
import { cancelProposal, editProposal, proposalView, retryProposal, sendProposal, undoProposal } from "../mail-proposals.js";

/**
 * The Mail screen (module `mail_inbox`, CONTRACT.md Mail): each linked mailbox's Inbox, sorted into bundles, and its
 * other folders, and since 2026-11-24 sending (mail-outbox.ts). The whole `/mail` prefix is closed to the assistant's
 * tools (ai/api-guard.ts): mail is the owner's to read, and only the owner sends.
 */
/** How long a Pin's answer waits for the mailbox to take the flag. */
const PIN_WAIT_MS = 4000;

export function mailRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  // Mail is kept on the hub only: no device, browser or proxy may store an answer. (The Apple apps used to write every
  // answer, mail included, to their URL cache on disk.)
  r.use("/mail/*", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });
  r.use("/mail", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });

  r.get("/mail", (c) => {
    const hub = c.get("hub");
    wakeSnoozed(hub);
    return c.json({ messages: listMail(hub.mailDb, bundleContext(hub)), logos: mailLogos(hub.mailDb), mailboxes: mailboxStates(hub), snooze_times: snoozeTimes(hub.mailDb), bundle_delivery: bundleDelivery(hub.mailDb), custom_bundles: customBundles(hub.mailDb), mail_notify: mailNotify(hub.mailDb), folders: mailFolders(hub.mailDb), blocked: blockedSenders(hub.mailDb), triage: triageOn(hub.mailDb), triage_state: triageState(hub), outbox: outboxList(hub) });
  });

  // The owner's snooze times (what "Tomorrow" and the rest mean).
  // The owner's own bundles: a name, a color and rules, checked before the built-in ones.
  r.post("/mail/settings/custom-bundles", async (c) => c.json(addCustomBundle(c.get("hub").mailDb, await readJsonObject(c))));
  r.put("/mail/settings/custom-bundles/:id", async (c) => c.json(updateCustomBundle(c.get("hub").mailDb, c.req.param("id"), await readJsonObject(c))));
  r.delete("/mail/settings/custom-bundles/:id", (c) => {
    const db = c.get("hub").mailDb;
    const id = c.req.param("id");
    // Its "Show in Inbox" setting and its alerts switch go with it (cleared first: that needs the bundle to exist).
    // Only for one of the owner's own: a built-in bundle's id here changes nothing and is answered as not found.
    // (The alerts switch was sent as a list the settings do not read, so a deleted bundle's id stayed in them.)
    if (customBundles(db).some((b) => b.id === id)) {
      if (bundleDelivery(db)[id]) saveBundleDelivery(db, id, { mode: "now" });
      if (mailNotify(db).bundles.includes(id)) saveMailNotify(db, { bundle: id, on: false });
    }
    deleteCustomBundle(db, id);
    return c.json({ ok: true });
  });

  // New-mail notifications: mail from people, each bundle's switch, and what a notification says.
  r.put("/mail/settings/notify", async (c) => c.json(saveMailNotify(c.get("hub").mailDb, await readJsonObject(c))));

  // When a bundle's mail shows in the Inbox (as it arrives, once a day, once a week, never).
  r.put("/mail/settings/bundles/:id", async (c) => c.json(saveBundleDelivery(c.get("hub").mailDb, c.req.param("id"), await readJsonObject(c))));
  r.put("/mail/settings/snooze", async (c) => c.json(saveSnoozeTimes(c.get("hub").mailDb, await readJsonObject(c))));

  r.get("/mail/messages/:id", (c) => {
    const hub = c.get("hub");
    const m = mailMessage(hub.mailDb, c.req.param("id"), !!hub.cfg.torSocks);
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json(m);
  });

  // Show pictures, on a hub without Tor: this one mail's web pictures, fetched straight from the hub because the person
  // asked (its sender then sees the home's internet address). A hub with Tor fetches them itself and refuses this.
  // A folder's kept mail (Drafts, Sent, Junk, Trash, the owner's own), newest first; read-only.
  // Search every kept mail (whole texts, the Inbox and folders), or all mail with one person. Read-only, on the hub.
  r.get("/mail/search", (c) => {
    const q = c.req.query("q") ?? "";
    const person = c.req.query("with") ?? "";
    if (q.length > 300 || person.length > 254) throw new StoreError(422, "the search is too long");
    return c.json({ hits: searchMail(c.get("hub").mailDb, { q, with: person }) });
  });

  r.get("/mail/folders/:key", (c) => {
    const messages = folderMail(c.get("hub").mailDb, c.req.param("key"));
    if (!messages) throw new StoreError(404, "there is no such folder");
    return c.json({ messages });
  });

  r.post("/mail/messages/:id/pictures", async (c) => {
    const m = await showPictures(c.get("hub"), c.req.param("id"));
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json(m);
  });

  // Several at once (a thread's unread mails, a selection): one sign-in to the mailbox for all of them.
  r.post("/mail/seen", async (c) => {
    const body = await readJsonObject(c);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (typeof body.seen !== "boolean") throw new StoreError(422, "seen is true or false");
    if (!ids.length || ids.length > SEEN_MAX || !Array.isArray(body.ids) || ids.length !== body.ids.length) throw new StoreError(422, `ids is a list of 1 to ${SEEN_MAX} message ids`);
    const r2 = await setSeenMany(c.get("hub"), ids, body.seen);
    return c.json({ ok: r2.ok, seen: body.seen, synced: r2.synced });
  });
  // Read or unread: on the hub, and in the mailbox (only its \Seen flag, fenced in the source).
  r.post("/mail/messages/:id/seen", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.seen !== "boolean") throw new StoreError(422, "seen is true or false");
    const r2 = await setSeen(c.get("hub"), c.req.param("id"), body.seen);
    if (!r2.ok) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json({ ok: true, seen: body.seen, synced: r2.synced });
  });

  // A draft (a reply or a new mail): with preview, what would be saved (or sent); else saved to the mailbox's Drafts folder.
  r.post("/mail/drafts", async (c) => c.json(await saveMailDraft(c.get("hub"), await readJsonObject(c))));
  // Send (since 2026-11-24): the same mail into the outbox, sent 10 seconds later unless taken back (Undo). Only the
  // owner's screen sends: the assistant's tools cannot reach any of `/mail`.
  r.post("/mail/send", async (c) => c.json(await sendMail(c.get("hub"), await readJsonObject(c))));
  r.get("/mail/outbox/:id", (c) => {
    const item = outboxItem(c.get("hub"), c.req.param("id"));
    if (!item) throw new StoreError(404, "This mail is not in the outbox any more.");
    return c.json(item);
  });
  // Undo while it waits; Edit or Discard once it was not sent: it leaves the outbox, back to the writing box.
  r.post("/mail/outbox/:id/undo", (c) => c.json(takeBack(c.get("hub"), c.req.param("id"))));
  r.post("/mail/outbox/:id/retry", (c) => c.json(retrySend(c.get("hub"), c.req.param("id"))));
  r.post("/mail/outbox/:id/draft", async (c) => c.json(await draftFromOutbox(c.get("hub"), c.req.param("id"))));
  // A mail the assistant wrote (since 2026-11-24, mail-proposals.ts): its card, and the owner's Send, Undo, Try again,
  // Edit and Cancel. The assistant's tools reach none of these (ai/api-guard.ts): only the owner's tap sends.
  r.get("/mail/proposals/:id", (c) => {
    const v = proposalView(c.get("hub"), c.req.param("id"));
    if (!v) throw new StoreError(404, "This mail is not kept any more: after 24 hours it is gone. Nothing was sent.");
    return c.json(v);
  });
  r.post("/mail/proposals/:id/send", async (c) => c.json(await sendProposal(c.get("hub"), c.req.param("id"))));
  r.post("/mail/proposals/:id/undo", (c) => c.json(undoProposal(c.get("hub"), c.req.param("id"))));
  r.post("/mail/proposals/:id/retry", (c) => c.json(retryProposal(c.get("hub"), c.req.param("id"))));
  r.post("/mail/proposals/:id/edit", (c) => c.json(editProposal(c.get("hub"), c.req.param("id"))));
  r.post("/mail/proposals/:id/cancel", (c) => c.json(cancelProposal(c.get("hub"), c.req.param("id"))));
  // A reply's greeting and sign-off, suggested by the local model (or the plain ones), for the owner to edit or drop.
  r.post("/mail/messages/:id/greeting", async (c) => c.json(await suggestGreeting(c.get("hub"), c.req.param("id"))));

  // Attachments: the list with pictures' previews, read when a mail opens; one file as a download. Read-only.
  r.get("/mail/messages/:id/attachments", async (c) => {
    const list = await mailAttachments(c.get("hub"), c.req.param("id"));
    if (!list) throw new StoreError(404, "This mail is not in the mailbox any more. Refresh and try again.");
    return c.json({ attachments: list });
  });
  r.get("/mail/messages/:id/attachments/:part", async (c) => {
    const file = await mailAttachment(c.get("hub"), c.req.param("id"), c.req.param("part"));
    if (!file) throw new StoreError(404, "This attachment is not in the mailbox any more. Refresh and try again.");
    // A file to save, never a page to show: its own type is not trusted (an "image" may be HTML), the browser must not
    // guess one, and nothing in it may run if it is opened here anyway.
    return new Response(new Uint8Array(file.bytes), { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${rfc2231(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "no-store",
    } });
  });

  // Unsubscribe: the ways the mail's headers offer now; then one of them, as the owner chose (confirmed on the screen).
  r.get("/mail/messages/:id/unsubscribe", async (c) => {
    const o = await unsubscribeOptions(c.get("hub"), c.req.param("id"));
    if (!o) throw new StoreError(404, "This mail is not in the mailbox any more. Refresh and try again.");
    return c.json(o);
  });
  r.post("/mail/messages/:id/unsubscribe", async (c) => {
    const body = await readJsonObject(c);
    return c.json(await unsubscribe(c.get("hub"), c.req.param("id"), body.how, body.direct === true));
  });
  // "Something important missing?": a folding note on a mail, the notes, and clearing them. Kept on the hub only.
  r.post("/mail/messages/:id/folding", async (c) => c.json(saveFoldNote(c.get("hub").mailDb, c.req.param("id"), await readJsonObject(c))));
  r.get("/mail/folding-notes", (c) => c.json({ notes: foldNotes(c.get("hub").mailDb) }));
  r.delete("/mail/folding-notes", (c) => c.json({ cleared: clearFoldNotes(c.get("hub").mailDb) }));
  // Triage on or off (off erases every kept triage).
  r.put("/mail/settings/triage", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.on !== "boolean") throw new StoreError(422, "on is true or false");
    return c.json({ triage: setTriage(c.get("hub").mailDb, body.on) });
  });
  // Sort new mail: the owner asks, and the local model triages what waits (it runs for nothing else on a hub that does
  // not do model work on its own). Answers at once with how many wait; the list says when the run is over.
  r.post("/mail/triage", (c) => c.json(requestTriage(c.get("hub"))));
  // Block and unblock a sender (an address or @domain).
  r.post("/mail/settings/blocked", async (c) => c.json(await blockSender(c.get("hub"), (await readJsonObject(c)).sender)));
  r.post("/mail/settings/unblock", async (c) => c.json({ blocked: unblockSender(c.get("hub").mailDb, (await readJsonObject(c)).sender) }));

  // Pin: on the hub at once, then as the mailbox's own flag. The answer does not wait long for the mailbox: the flag
  // is set behind a refresh that may be running (minutes, the first time), and an app gives a request 20 seconds.
  // `pending`: the mailbox had not answered yet when this did. The pin shows on the hub meanwhile and the flag is
  // still being set, this one time: if the mailbox does not take it, the next refresh shows the pin as the mailbox
  // has it.
  r.post("/mail/messages/:id/pin", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.pinned !== "boolean") throw new StoreError(422, "pinned is true or false");
    const hub = c.get("hub");
    if (!hub.mailDb.prepare("SELECT 1 FROM inbox WHERE key = ?").get(c.req.param("id"))) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    const syncing = setPinnedSynced(hub, c.req.param("id"), body.pinned);
    let timer: NodeJS.Timeout | undefined;
    const r2 = await Promise.race([syncing, new Promise<null>((done) => { timer = setTimeout(() => done(null), PIN_WAIT_MS); })]);
    clearTimeout(timer);
    if (r2 && !r2.ok) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json({ ok: true, pinned: body.pinned, synced: r2?.synced ?? 0, ...(r2 ? {} : { pending: true }) });
  });

  // Done (a Sweep is many at once) and Undo: a MOVE between the Inbox and the archive folder, nothing else.
  const ids = async (c: Parameters<typeof readJsonObject>[0]) => {
    const body = await readJsonObject(c);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MOVE_MAX || !body.ids.every((x) => typeof x === "string" && x.length <= 64)) {
      throw new StoreError(422, `ids is a list of 1 to ${MOVE_MAX} message ids`);
    }
    return body.ids as string[];
  };
  r.post("/mail/done", async (c) => c.json(await markDone(c.get("hub"), await ids(c))));
  r.post("/mail/undo", async (c) => c.json(await undoDone(c.get("hub"), await ids(c))));
  // Delete (to Trash), Spam (to Junk), Not spam and Move to Inbox, or Move to one of your folders: MOVE only, nothing erased.
  r.post("/mail/move", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.to !== "string") throw new StoreError(422, "to is inbox, trash, junk or one of your own folders");
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MOVE_MAX || !body.ids.every((x) => typeof x === "string")) throw new StoreError(422, `ids is a list of 1 to ${MOVE_MAX} mail ids`);
    // `undo: true` (the screen's Undo of a Delete, a Spam, a Move or a block): mail going back to the Inbox is put
    // back as it was. Without it, a move to the Inbox is a plain one.
    return c.json(await moveMail(c.get("hub"), body.ids as string[], body.to, new Date(), { undo: body.undo === true }));
  });

  // Snooze: on the hub only (the mail stays in the mailbox's Inbox); a task called "Snoozed mail" reminds at `until`.
  r.post("/mail/messages/:id/snooze", async (c) => {
    const body = await readJsonObject(c);
    const until = typeof body.until === "string" ? new Date(body.until) : new Date(NaN);
    const now = Date.now();
    if (Number.isNaN(until.getTime()) || until.getTime() < now + 30_000 || until.getTime() > now + SNOOZE_MAX_DAYS * 86_400_000) {
      throw new StoreError(422, `until is a time from now to ${SNOOZE_MAX_DAYS} days ahead`);
    }
    if (!snoozeMail(c.get("hub"), c.req.param("id"), until)) throw new StoreError(404, "that message is not in the Inbox");
    return c.json({ ok: true, until: until.toISOString() });
  });
  r.post("/mail/messages/:id/unsnooze", (c) => {
    if (!unsnoozeMail(c.get("hub"), c.req.param("id"))) throw new StoreError(404, "that message is not snoozed");
    return c.json({ ok: true });
  });

  r.post("/mail/refresh", async (c) => c.json(await refreshMail(c.get("hub"), { owner: true })));

  return r;
}
