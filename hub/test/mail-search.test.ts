import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { snippetOf } from "../src/mail-inbox.js";

// Search every kept mail (whole texts, Inbox and folders), and all mail with one person. Made-up mail.

const ALEX = { name: "Alex Kim", address: "alex@example.com" };
const ME = { name: "Robin", address: EMAIL };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: `${"Hello. ".repeat(80)}The ladder is in the garage, by the blue bike.` },
  { uid: 2, folder: "INBOX", at: ago(2), subject: "Receipt", from: { name: "Shop", address: "orders@shop.example" }, messageId: "r1@x", plain: "Thanks for your order: a 100% wool blanket." },
  { uid: 1, folder: "Sent Messages", at: ago(1), subject: "Photos", from: ME, to: [ALEX], messageId: "s1@x", plain: "Here are the garage photos." },
  { uid: 1, folder: "Junk", at: ago(1), subject: "Win", from: { address: "win@prize.example" }, messageId: "j1@x", plain: "Claim your garage door prize" },
];
type Hit = { subject: string; where: string; snippet: string };
const search = async (t: TestHub, q: string, person = "") => ((await (await t.api(`/mail/search?q=${encodeURIComponent(q)}${person ? `&with=${encodeURIComponent(person)}` : ""}`)).json()) as { hits: Hit[] }).hits;

test("mail search: every word, in whole texts, across the Inbox and the folders, newest first, with where each is", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const hits = await search(t, "garage");
    assert.deepEqual(hits.map((h) => [h.subject, h.where]).sort(), [["Gutters", "inbox"], ["Photos", "sent"], ["Win", "junk"]].sort());
    assert.deepEqual((await search(t, "GARAGE blue")).map((h) => h.subject), ["Gutters"], "every word, case aside");
    const g = (await search(t, "ladder"))[0];
    assert.match(g.snippet, /^….*The ladder is in the garage/, "a snippet around the match, deep in the text");
    assert.deepEqual((await search(t, "shop.example")).map((h) => h.subject), ["Receipt"], "the sender's address");
    assert.deepEqual((await search(t, "100%")).map((h) => h.subject), ["Receipt"], "% is a character, not a wildcard");
    assert.deepEqual(await search(t, "10%0"), []);
    assert.deepEqual(await search(t, "'; DROP TABLE inbox; --"), [], "words are parameters");
    assert.equal((await t.api(`/mail/search?q=${"x".repeat(301)}`)).status, 422);
  } finally { done(t); }
});

test("mail search: with a person, their mail and the owner's to them", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    assert.deepEqual((await search(t, "", "alex@example.com")).map((h) => [h.subject, h.where]).sort(), [["Gutters", "inbox"], ["Photos", "sent"]].sort());
    assert.deepEqual((await search(t, "photos", "alex@example.com")).map((h) => h.subject), ["Photos"]);
    assert.deepEqual(await search(t, ""), [], "nothing asked, nothing found");
  } finally { done(t); }
});

test("mail search: snippets", () => {
  assert.equal(snippetOf("See https://evil.example/x for the plan.", "plan"), "See for the plan.");
  assert.equal(snippetOf("short", "absent"), "short");
});
