import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InboxMail } from "../src/imports/icloud.js";
import { deleteAllMail, deleteMailbox, keepInbox, listChanges, listMail, openMailDb, type MailSummary } from "../src/mail-inbox.js";
import { NO_MODULES, type BundleContext } from "../src/mail-bundles.js";
import { makeHub } from "./helpers.js";

const ACCOUNT = "icloud:robin@icloud.example";
const OTHER = "imap:jamie@example.com";

let uid = 0;
function mail(at: Date, over: Partial<InboxMail> = {}): InboxMail {
  uid++;
  return { id: `7:${uid}:INBOX`, at, message_id: `m${uid}@example.com`, from: { name: "Alex", address: "alex@example.com" }, reply_to: null, subject: `Mail ${uid}`, text: "Hello there.", automated: uid % 3 === 0, unsubscribe: uid % 4 === 0, list_id: null, html: null, remote: [], ...over } as InboxMail;
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailchanges-"));
  const db = openMailDb(path.join(dir, "mail.sqlite"));
  return { db, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** What a device does with an answer (web lib/mail.ts applyListChanges, EACore Mail.applyChanges): the same rule. */
function apply(copy: MailSummary[], a: ReturnType<typeof listChanges>): MailSummary[] {
  if (a.messages) return a.messages;
  const gone = new Set(a.gone);
  const byId = new Map(copy.filter((m) => !gone.has(m.id)).map((m) => [m.id, m]));
  for (const m of a.changed ?? []) byId.set(m.id, m);
  const o = (m: MailSummary) => m.back_at ?? m.at;
  return [...byId.values()].sort((x, y) => (o(x) < o(y) ? 1 : o(x) > o(y) ? -1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).slice(0, a.max);
}

test("mail list changes: a device that takes only the changes holds the whole list, through every kind of write", () => {
  const { db, done } = tmpDb();
  try {
    const now = Date.now();
    const hours = (h: number) => new Date(now - h * 3_600_000);
    let rnd = 7;
    const r = (n: number) => { rnd = (rnd * 1_103_515_245 + 12_345) % 2_147_483_648; return rnd % n; };
    const max = 25;
    let ctx: BundleContext = NO_MODULES;
    keepInbox(db, ACCOUNT, { present: null, mails: Array.from({ length: 40 }, (_, i) => mail(hours(i * 3 + 1))), moved: [] });
    let a = listChanges(db, ctx, "", "1.0.24", max);
    assert.ok(a.messages, "no cursor: the whole list");
    let copy = apply([], a);
    let cursor = a.cursor;
    let deltas = 0, fulls = 0;
    for (let step = 0; step < 300; step++) {
      const keys = (db.prepare("SELECT key FROM inbox").all() as { key: string }[]).map((x) => x.key);
      const key = keys[r(keys.length)];
      switch (r(10)) {
        case 0: keepInbox(db, ACCOUNT, { present: null, mails: [mail(hours(r(200)))], moved: [] }); break; // new mail, maybe older than the list
        case 1: db.prepare("UPDATE inbox SET seen = 1 - seen WHERE key = ?").run(key); break;
        case 2: db.prepare("UPDATE inbox SET pinned = 1 - pinned WHERE key = ?").run(key); break;
        case 3: db.prepare("UPDATE inbox SET state = 'done', done_at = ? WHERE key = ?").run(hours(0).toISOString(), key); break;
        case 4: db.prepare("DELETE FROM inbox WHERE key = ?").run(key); break; // left the Inbox; older mail moves up into the list
        case 5: db.prepare("UPDATE inbox SET back_at = ? WHERE key = ?").run(hours(-r(3)).toISOString(), key); break; // back from snooze, to the top
        case 6: db.prepare("UPDATE inbox SET back_at = NULL WHERE key = ?").run(key); break; // down again, maybe out of the list
        case 7: db.prepare("UPDATE inbox SET html = ?, remote = NULL WHERE key = ?").run(`<p>${step}</p>`, key); break; // a picture written in: not listed
        case 8: if (step % 40 === 8) ctx = { ...NO_MODULES, pets: [`Biscuit ${step}`] }; break; // the owner's records changed
        default: db.prepare("UPDATE inbox SET fold_note = ? WHERE key = ?").run(JSON.stringify({ at: 1, lines: [] }), key); break;
      }
      if (r(3) === 0) continue; // several writes between two looks
      a = listChanges(db, ctx, cursor, "1.0.24", max);
      if (a.messages) fulls++; else deltas++;
      copy = apply(copy, a);
      cursor = a.cursor;
      assert.deepEqual(copy, listMail(db, ctx, max), `step ${step}`);
    }
    assert.ok(deltas > 100, `most answers are changes (${deltas} changes, ${fulls} whole lists)`);
    // Nothing changed: an empty answer.
    const quiet = listChanges(db, ctx, cursor, "1.0.24", max);
    assert.deepEqual([quiet.changed, quiet.gone, quiet.messages, quiet.logos], [[], [], undefined, undefined]);
    // Another hub version, or a cursor the hub cannot read: the whole list.
    assert.ok(listChanges(db, ctx, cursor, "1.0.25", max).messages);
    assert.ok(listChanges(db, ctx, "not a cursor", "1.0.24", max).messages);
  } finally { done(); }
});

test("mail list changes: unlinking a mailbox sends its mail as gone, switching Mail off leaves no keys and sends the whole empty list", () => {
  const { db, done } = tmpDb();
  try {
    keepInbox(db, ACCOUNT, { present: null, mails: [mail(new Date(Date.now() - 3_600_000)), mail(new Date(Date.now() - 7_200_000))], moved: [] });
    keepInbox(db, OTHER, { present: null, mails: [mail(new Date(Date.now() - 1_800_000))], moved: [] });
    const first = listChanges(db, NO_MODULES, "", "1.0.24");
    const before = first.messages!;
    deleteMailbox(db, ACCOUNT);
    const a = listChanges(db, NO_MODULES, first.cursor, "1.0.24");
    assert.deepEqual(new Set(a.gone), new Set(before.filter((m) => m.mailbox !== "jamie@example.com").map((m) => m.id)));
    assert.deepEqual(apply(before, a), listMail(db, NO_MODULES));
    deleteAllMail(db);
    assert.equal((db.prepare("SELECT count(*) AS n FROM inbox_gone").get() as { n: number }).n, 0, "no key of a mail stays");
    const b = listChanges(db, NO_MODULES, a.cursor, "1.0.24");
    assert.deepEqual(b.messages, []);
  } finally { done(); }
});

test("mail list changes: an app from before sends no cursor and gets the list as it always did", async () => {
  const t = makeHub();
  try {
    keepInbox(t.hub.mailDb, ACCOUNT, { present: null, mails: [mail(new Date(Date.now() - 3_600_000))], moved: [] });
    const old = (await (await t.api("/mail")).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(old), ["messages", "logos", "mailboxes", "snooze_times", "bundle_delivery", "custom_bundles", "mail_notify", "folders", "blocked", "triage", "triage_state", "outbox"], "the same fields, no cursor");
    const first = (await (await t.api("/mail?since=")).json()) as { messages: unknown[]; cursor: string; max: number };
    assert.deepEqual(first.messages, old.messages);
    assert.equal(first.max, 5000);
    const next = (await (await t.api(`/mail?since=${encodeURIComponent(first.cursor)}`)).json()) as Record<string, unknown>;
    assert.deepEqual([next.changed, next.gone, next.messages, next.logos], [[], [], undefined, undefined]);
    assert.ok(Array.isArray(next.mailboxes) && typeof next.cursor === "string");
  } finally { t.cleanup(); }
});
