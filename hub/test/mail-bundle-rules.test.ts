import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { customBundleOf, type CustomBundle } from "../src/mail-bundles.js";
import type { MailSummary } from "../src/mail-inbox.js";

// The owner's bundles matching words in the mail's text, and who it was sent to (an alias). Made-up mail.

const b = (over: Partial<CustomBundle>): CustomBundle => ({ id: "c-1", name: "Family", color: 2, addresses: [], domains: [], words: [], ...over });
const mail = (over: Record<string, unknown>) => ({ from: { name: "", address: "x@shop.example" }, subject: "Hi", automated: true, unsubscribe: false, list_id: null, ...over });

test("mail bundle rules: text words (whole words, the start of the text) and recipients", () => {
  assert.equal(customBundleOf(mail({ text: "Your soccer practice moved to 5 PM." }), [b({ body_words: ["soccer"] })]), "c-1");
  assert.equal(customBundleOf(mail({ text: "Soccerball sale!" }), [b({ body_words: ["soccer"] })]), null, "a whole word");
  assert.equal(customBundleOf(mail({ text: `${"x ".repeat(2000)}soccer` }), [b({ body_words: ["soccer"] })]), null, "only the text's start");
  assert.equal(customBundleOf(mail({ to: ["family@icloud.example"] }), [b({ to: ["family@icloud.example"] })]), "c-1");
  assert.equal(customBundleOf(mail({}), [b({ to: ["family@icloud.example"] })]), null, "mail kept before: no recipients, no match");
});

test("mail bundle rules: saved and checked; recipients kept at refresh and used", async () => {
  const t = makeHub();
  try {
    linked(t);
    const box: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Pictures", from: { name: "Mom", address: "mom@example.com" }, to: [{ address: "family@icloud.example" }], cc: [{ address: EMAIL }], messageId: "f1@x", plain: "From the weekend" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Schedule", from: { address: "coach@club.example" }, headers: "List-Unsubscribe: <https://club.example/u>\r\n", messageId: "c1@x", plain: "Soccer practice is at 5." },
    ];
    fake(box);
    await t.api("/mail/refresh", { method: "POST" });
    const add = (body: unknown) => t.api("/mail/settings/custom-bundles", { method: "POST", json: body });
    assert.equal((await add({ name: "Family", color: 1, to: ["Family@iCloud.example"] })).status, 200);
    assert.equal((await add({ name: "Kids", color: 2, body_words: ["soccer"] })).status, 200);
    assert.equal((await add({ name: "Bad", color: 3, to: ["not an address"] })).status, 422);
    assert.equal((await add({ name: "Empty", color: 3 })).status, 422, "at least one rule");
    const { messages, custom_bundles } = (await (await t.api("/mail")).json()) as { messages: MailSummary[]; custom_bundles: CustomBundle[] };
    const idOf = (n: string) => custom_bundles.find((x) => x.name === n)!.id;
    assert.equal(messages.find((m) => m.subject === "Pictures")!.bundle, idOf("Family"), "sent to the alias");
    assert.equal(messages.find((m) => m.subject === "Schedule")!.bundle, idOf("Kids"), "a word in its text");
  } finally { done(t); }
});
