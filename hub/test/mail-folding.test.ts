import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailMessage, MailSummary } from "../src/mail-inbox.js";

// "Something important missing?": folding notes on a mail, kept with it on the hub, never sent anywhere. Made-up mail.

const box = (): Msg[] => [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: { name: "Alex", address: "alex@example.com" }, messageId: "g1@x",
  plain: "Sounds good.\n\nOn Monday the plumber wrote:\nThe pipe under the sink must be replaced before Friday.\n> Old quote" }];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const open = async (t: TestHub, id: string) => (await (await t.api(`/mail/messages/${id}`)).json()) as MailMessage & { no_fold?: boolean };

test("mail folding: a note keeps lines of the folded part; Don't fold shows the mail and its preview whole", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const id = (await list(t))[0].id;
    assert.ok((await open(t, id)).quote_at! > 0, "folded at the 'wrote' line");
    assert.equal((await list(t))[0].preview, "Sounds good.");
    const note = (body: unknown) => t.api(`/mail/messages/${id}/folding`, { method: "POST", json: body });
    assert.equal((await note({ lines: ["Sounds good."] })).status, 422, "not a folded line");
    assert.equal((await note({ lines: ["Anything I make up"] })).status, 422);
    assert.equal((await note({ lines: Array(9).fill("> Old quote") })).status, 422, "at most 8");
    const saved = await (await note({ lines: ["The pipe under the sink must be replaced before Friday."], no_fold: true })).json() as { cut: string; lines: string[]; no_fold: boolean };
    assert.deepEqual([saved.cut, saved.lines, saved.no_fold], ["On Monday the plumber wrote:", ["The pipe under the sink must be replaced before Friday."], true]);
    const m = await open(t, id);
    assert.equal(m.quote_at, undefined, "not folded");
    assert.equal(m.no_fold, true);
    assert.match((await list(t))[0].preview, /pipe under the sink/, "the preview whole too");
    const notes = ((await (await t.api("/mail/folding-notes")).json()) as { notes: { id: string; subject: string; note: { cut: string } }[] }).notes;
    assert.deepEqual(notes.map((n) => [n.id, n.subject, n.note.cut]), [[id, "Gutters", "On Monday the plumber wrote:"]]);
    assert.equal(((await (await t.api("/mail/folding-notes", { method: "DELETE" })).json()) as { cleared: number }).cleared, 1);
    assert.ok((await open(t, id)).quote_at! > 0, "cleared: folded again");
    // A note goes with its mail.
    await note({ no_fold: true });
    msgs.splice(0, 1);
    await t.api("/mail/refresh", { method: "POST" });
    assert.deepEqual(((await (await t.api("/mail/folding-notes")).json()) as { notes: unknown[] }).notes, []);
  } finally { done(t); }
});
