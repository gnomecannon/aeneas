import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FieldsByKind, INVITE_TEXTS, InvitationFields, Kind, invitationCount, invitationList, isDeclined, organizerName, replyLine } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The cases EACore's InvitationsTests reads too, so the Apple apps list the same invitations as the web and the hub. */
interface Case { name: string; items: { id: string; deleted_at?: string; updated_at?: string; fields: Record<string, unknown> }[]; pending: string[]; answered: string[]; count: number }
const file = JSON.parse(fs.readFileSync(path.join(here, "invitation-cases.json"), "utf8")) as { now: string; cases: Case[] };

for (const c of file.cases) {
  test(`invitation list: ${c.name}`, () => {
    const out = invitationList(c.items, new Date(file.now));
    assert.deepEqual(out.pending.map((e) => e.id), c.pending);
    assert.deepEqual(out.answered.map((e) => e.id), c.answered);
    assert.equal(out.count, c.count);
  });
}

test("invitation: a kind of its own, with the fields the contract names", () => {
  assert.ok(Kind.options.includes("invitation"));
  assert.equal(FieldsByKind.invitation, InvitationFields);
  const ok = InvitationFields.safeParse({
    title: "Dinner", start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T21:00:00.000Z", answer: "needs_action", answer_by: "mail",
    from: { kind: "mail", mailbox: "robin@example.com", message: "abc" }, uid: "u1", sequence: 0, organizer: { name: "Alex", address: "alex@example.com" },
  });
  assert.ok(ok.success);
  assert.equal(InvitationFields.safeParse({ title: "x", start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T21:00:00.000Z", answer: "maybe", answer_by: "mail", from: { kind: "mail", mailbox: "a", message: "b" }, uid: "u" }).success, false, "Maybe is tentative");
  assert.equal(InvitationFields.safeParse({ title: "x", start: "2026-11-27T19:00:00.000Z", end: "2026-11-27T21:00:00.000Z", answer: "accepted", answer_by: "fax", from: { kind: "mail", mailbox: "a", message: "b" }, uid: "u" }).success, false);
});

test("invitation words: the count, the organizer, the answer being sent", () => {
  assert.equal(invitationCount(1), "1 invitation");
  assert.equal(invitationCount(2), "2 invitations");
  assert.equal(organizerName({ organizer: { name: " Alex ", address: "alex@example.com" } }), "Alex");
  assert.equal(organizerName({ organizer: { address: "alex@example.com" } }), "alex@example.com");
  assert.equal(organizerName({}), "");
  const reply = (state: string, error?: string) => ({ organizer: { name: "Alex" }, reply: { outbox: "o", state, answer: "accepted", was: "needs_action", send_at: "2026-11-25T12:00:00.000Z", ...(error ? { error } : {}) } });
  assert.deepEqual(replyLine(reply("waiting")), { text: "Sending your answer to Alex.", undo: true, retry: false });
  assert.deepEqual(replyLine(reply("sending")), { text: "Sending your answer to Alex.", undo: false, retry: false });
  assert.deepEqual(replyLine(reply("failed", "The server did not answer.")), { text: "Not sent: The server did not answer.", undo: true, retry: true });
  assert.equal(replyLine(reply("sent")), null);
  assert.equal(INVITE_TEXTS.done.tentative, "Maybe.");
  assert.equal(isDeclined({ declined: true }), true);
  assert.equal(isDeclined({}), false);
  for (const v of Object.values(INVITE_TEXTS).flatMap((x) => (typeof x === "string" ? [x] : Object.values(x)))) assert.doesNotMatch(v, /[\u2013\u2014]/);
});
