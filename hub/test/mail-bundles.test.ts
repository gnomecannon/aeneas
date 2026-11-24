import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { bundleContext, bundleOf, domainOf, hasWord, hostOf, NO_MODULES, sameSite, type BundleContext, type BundleMail, type CustomBundle } from "../src/mail-bundles.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { bundleDelivery, mailNotify, openMailDb } from "../src/mail-inbox.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Mail screen's bundles (src/mail-bundles.ts). Every mail here is made up.

/** A mail a system sent, with only what a test cares about set. */
const sys = (from: string, subject: string, over: Partial<BundleMail> = {}): BundleMail =>
  ({ from: { name: "", address: from }, subject, automated: true, unsubscribe: false, list_id: null, ...over });
/** A mail a person wrote. */
const person = (name: string, from: string, subject: string): BundleMail =>
  ({ from: { name, address: from }, subject, automated: false, unsubscribe: false, list_id: null });

/** Every module on, with a few records. */
const ALL: BundleContext = {
  jobs: [{ company: "Contoso", url: "https://careers.contoso.example/jobs/123" }, { company: "Fabrikam", url: null }],
  bills: [{ title: "Fastmail", url: "https://www.fastmail.example/settings/billing" }],
  pets: ["Biscuit"],
};

// ---------------------------------------------------------------------------------------------------------------------
// The helpers (these pass already)

test("mail bundles helpers: domains, hosts, sites and whole words", () => {
  assert.equal(domainOf("Orders@Mail.Northwind.example"), "mail.northwind.example");
  assert.equal(domainOf("not an address"), "");
  assert.equal(hostOf("https://www.fastmail.example/settings"), "fastmail.example");
  assert.equal(hostOf("careers.contoso.example/jobs"), "careers.contoso.example");
  assert.equal(hostOf(null), "");
  assert.ok(sameSite("mail.contoso.example", "careers.contoso.example"));
  assert.ok(!sameSite("contoso.example", "fabrikam.example"));
  assert.ok(!sameSite("", ""));
  assert.ok(hasWord("Your ORDER has shipped", ["order"]));
  assert.ok(!hasWord("Border crossing update", ["order"]));
  assert.ok(hasWord("Payment due: March", ["payment due"]));
});

test("mail bundles context: records come only from modules that are on", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("application", { company: "Contoso", role: "Analyst", stage: "applied", url: "https://careers.contoso.example/1" });
    t.hub.store.create("watch", { title: "Fastmail", category: "subscription", due: new Date().toISOString() });
    t.hub.store.create("pet_event", { pet: "Biscuit", type: "vet", at: new Date().toISOString() });
    await t.api("/modules", { method: "PUT", json: { jobs: true, renewals: true, pet: false } });
    const ctx = bundleContext(t.hub);
    assert.deepEqual(ctx.jobs, [{ company: "Contoso", url: "https://careers.contoso.example/1" }]);
    assert.deepEqual(ctx.bills, [{ title: "Fastmail", url: null }]);
    assert.equal(ctx.pets, null, "Pet is off");
  } finally { t.cleanup(); }
});

test("mail bundles: when each bundle shows in the Inbox is kept on the hub, checked, and sent with the list", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
    const put = (id: string, body: unknown) => t.api(`/mail/settings/bundles/${id}`, { method: "PUT", json: body });
    assert.deepEqual(await (await put("promos", { mode: "daily", time: "07:00" })).json(), { promos: { mode: "daily", time: "07:00" } });
    assert.deepEqual(await (await put("other", { mode: "weekly", day: 0, time: "18:00" })).json(), { promos: { mode: "daily", time: "07:00" }, other: { mode: "weekly", time: "18:00", day: 0 } });
    assert.deepEqual(await (await put("other", { mode: "now" })).json(), { promos: { mode: "daily", time: "07:00" } }, "as it arrives is no setting");
    await put("purchases", { mode: "never" });
    const list = await (await t.api("/mail")).json() as { bundle_delivery: Record<string, unknown> };
    assert.deepEqual(list.bundle_delivery, { promos: { mode: "daily", time: "07:00" }, purchases: { mode: "never" } });
    // The ids are the ones every shipped app knows (purchases, other, promos), whatever the bundles are called now.
    assert.deepEqual(await (await put("promos", { mode: "weekly", day: 1, time: "08:00" })).json(), { promos: { mode: "weekly", time: "08:00", day: 1 }, purchases: { mode: "never" } });
    // An app that still lists Social (no bundle any more) is told so, and nothing is kept for it.
    const social = await put("social", { mode: "never" });
    assert.equal(social.status, 409);
    assert.match(((await social.json()) as { error: string }).error, /in another bundle now/);
    // An id a build of the renaming used for a few days is taken as the bundle's real one.
    assert.deepEqual(await (await put("promotions", { mode: "now" })).json(), { purchases: { mode: "never" } });
    assert.equal((await put("made-up", { mode: "never" })).status, 404);
    assert.equal((await put("__proto__", { mode: "never" })).status, 404);
    for (const bad of [{}, { mode: "sometimes" }, { mode: "daily" }, { mode: "daily", time: "7am" }, { mode: "weekly", time: "07:00" }, { mode: "weekly", time: "07:00", day: 9 }]) {
      assert.equal((await put("promos", bad)).status, 422, JSON.stringify(bad));
    }
  } finally { t.cleanup(); }
});

test("mail bundles: the owner's own bundles are checked first, take a person's mail, and are checked when saved", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
    const add = (body: unknown) => t.api("/mail/settings/custom-bundles", { method: "POST", json: body });
    const school = await (await add({ name: " School ", color: 2, domains: ["@school.example"], words: ["field trip"] })).json() as CustomBundle;
    assert.match(school.id, /^c-[0-9a-f]{10}$/);
    assert.deepEqual({ ...school, id: "" }, { id: "", name: "School", color: 2, addresses: [], domains: ["school.example"], words: ["field trip"] });
    const family = await (await add({ name: "Family", color: 5, addresses: ["Sam@Example.com"] })).json() as CustomBundle;
    const ctx = { ...NO_MODULES, custom: [school, family] };
    assert.equal(bundleOf(sys("news@mail.school.example", "Weekly news", { unsubscribe: true }), ctx), school.id, "a domain under it; before Promos");
    assert.equal(bundleOf(sys("deals@shop.example", "Field trip gear sale", { unsubscribe: true }), ctx), school.id, "a word in the subject");
    assert.equal(bundleOf(person("Sam", "sam@example.com", "Dinner?"), ctx), family.id, "a person's mail, by address");
    assert.equal(bundleOf(person("Alex", "alex@example.com", "Dinner?"), ctx), null);
    assert.equal(bundleOf(sys("x@notschool.example", "Hi", { unsubscribe: true }), ctx), "promos", "notschool.example is not under school.example");

    assert.equal((await t.api(`/mail/settings/bundles/${school.id}`, { method: "PUT", json: { mode: "never" } })).status, 200, "a bundle of yours has Show in Inbox too");
    const list = await (await t.api("/mail")).json() as { custom_bundles: CustomBundle[]; bundle_delivery: Record<string, unknown> };
    assert.deepEqual(list.custom_bundles.map((b) => b.name), ["School", "Family"]);
    assert.equal((await t.api(`/mail/settings/custom-bundles/${school.id}`, { method: "PUT", json: { name: "School stuff", color: 3, words: ["pta"] } })).status, 200);
    assert.equal((await t.api(`/mail/settings/custom-bundles/${school.id}`, { method: "DELETE" })).status, 200);
    const after = await (await t.api("/mail")).json() as { custom_bundles: CustomBundle[]; bundle_delivery: Record<string, unknown> };
    assert.deepEqual(after.custom_bundles.map((b) => b.name), ["Family"]);
    assert.equal(after.bundle_delivery[school.id], undefined, "its setting went with it");

    for (const bad of [{ color: 1, words: ["x"] }, { name: "x".repeat(41), color: 1, words: ["x"] }, { name: "A", color: 8, words: ["x"] }, { name: "A", color: 1 }, { name: "A", color: 1, addresses: ["not an address"] }, { name: "A", color: 1, domains: ["no spaces.example"] }]) {
      assert.equal((await add(bad)).status, 422, JSON.stringify(bad));
    }
    assert.equal((await t.api("/mail/settings/custom-bundles/c-0000000000", { method: "DELETE" })).status, 404);
    assert.ok(refuseToolCall("POST", "/mail/settings/custom-bundles"));
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// The rules

test("mail bundles: a person's mail stands alone, whatever its subject says", () => {
  assert.equal(bundleOf(person("Alex", "alex@example.com", "Hike Saturday?"), ALL), null);
  assert.equal(bundleOf(person("Alex", "alex@example.com", "Did you order the pizza?"), ALL), null);
  assert.equal(bundleOf(person("Sam", "sam@example.com", "Flight details for the trip"), ALL), null);
});

test("mail bundles: transactions, buying and money moving", () => {
  assert.equal(bundleOf(sys("orders@northwind.example", "Your order has shipped"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("receipts@larkspur.example", "Your receipt from Larkspur Books"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("ship@parcel.example", "DELIVERED: your package"), NO_MODULES), "purchases", "any case");
  assert.equal(bundleOf(sys("lockers@shop.example", "You have a package to pick up at the Main St locker"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("store@shop.example", "Ready for pick up"), NO_MODULES), "purchases");
  assert.notEqual(bundleOf(sys("no-reply@maps.example", "Border crossing times this week"), NO_MODULES), "purchases", "whole words only");
});

test("mail bundles: a shop's notice with a plain subject is a purchase by its order-status phrases, a sale is not", () => {
  const next = sys("support@beans.example", "Robin, meet your next coffee", { unsubscribe: true, text: "Selection Shipping Delivery\n\nEstimated arrival: Sun, Nov 29\nMake changes by Sat, Nov 21" } as Partial<BundleMail>);
  assert.equal(bundleOf(next, NO_MODULES), "purchases", "before promos, though it has an unsubscribe link");
  const sale = sys("deals@beans.example", "Our winter blends are here", { unsubscribe: true, text: "Free shipping on every order this week. Fast delivery." } as Partial<BundleMail>);
  assert.equal(bundleOf(sale, NO_MODULES), "promos", "shipping and delivery alone are not an order");
});

test("mail bundles: trips", () => {
  assert.equal(bundleOf(sys("no-reply@airline.example", "Your boarding pass for Friday"), NO_MODULES), "trips");
  assert.equal(bundleOf(sys("stay@hotels.example", "Reservation confirmed: 2 nights"), NO_MODULES), "trips");
  assert.equal(bundleOf(sys("trips@travel.example", "Your itinerary"), NO_MODULES), "trips");
});

test("mail bundles: social networks are updates", () => {
  assert.equal(bundleOf(sys("notification@facebookmail.com", "Sam commented on your photo"), NO_MODULES), "other");
  assert.equal(bundleOf(sys("messages-noreply@linkedin.com", "You have 1 new message", { unsubscribe: true }), NO_MODULES), "other", "updates before promotions");
});

test("mail bundles: promotions, and updates for every other notice", () => {
  assert.equal(bundleOf(sys("deals@shop.example", "50% off this weekend only", { unsubscribe: true }), NO_MODULES), "promos");
  assert.equal(bundleOf(sys("security@account.example", "Your password was changed"), NO_MODULES), "other", "no Other: a notice nothing else claims is an update");
});

test("mail bundles: money moving is a transaction, a message notice is not", () => {
  assert.equal(bundleOf(sys("alerts@bank.example", "Your transfer to Savings is complete"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("alerts@bank.example", "A deposit was made to your account"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("money@pay.example", "Jordan paid you $20.00"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("help@shop.example", "Your refund has been processed"), NO_MODULES), "purchases");
  assert.equal(bundleOf(sys("alerts@bank.example", "Account alert", { text: "Transfer amount: $250.00 from Checking." }), NO_MODULES), "purchases", "a money phrase in the text");
  assert.equal(bundleOf(sys("notice@linkedin.com", "Sam sent you a message", { unsubscribe: true }), NO_MODULES), "other", "sent you alone is no payment");
});

test("mail bundles: a developer tool's notice is an update and a list's discussion stands alone, though they carry unsubscribe", () => {
  const comment = sys("notifications@github.com", "Re: [alex/notes] Fix the sync (PR #12)", { unsubscribe: true, list_id: "alex/notes <notes.alex.github.com>" });
  assert.equal(bundleOf(comment, NO_MODULES), "other", "a code host's notice");
  const list = sys("garden-club@lists.example", "Re: Spring planting day", { unsubscribe: true, list_id: "garden-club.lists.example" });
  assert.equal(bundleOf(list, NO_MODULES), null, "a reply in a mailing list's discussion: people talking");
  const news = sys("news@lists.example", "Spring planting day", { unsubscribe: true, list_id: "news.lists.example" });
  assert.equal(bundleOf(news, NO_MODULES), "promos", "a list's newsletter, not a reply");
});

test("mail bundles: jobs, from the applications and from hiring systems, a recruiter's own mail too", () => {
  assert.equal(bundleOf(person("Dana Lee", "dana@talent.contoso.example", "Next steps"), ALL), "jobs", "same site as the posting");
  assert.equal(bundleOf(sys("no-reply@fabrikam.example", "Thanks for applying"), ALL), "jobs", "the company's name in the domain");
  assert.equal(bundleOf(sys("no-reply@greenhouse.io", "Thank you for applying to Woodgrove"), ALL), "jobs", "a hiring system");
  assert.equal(bundleOf(sys("no-reply@fabrikam.example", "Thanks for applying"), NO_MODULES), "other", "Job search off: no jobs bundle");
});

test("mail bundles: job phrases in the subject or the text's start, a recruiter's signature too; never single words", () => {
  const jobsOn: BundleContext = { ...NO_MODULES, jobs: [] };
  const recruiter = { ...person("Jordan Avery", "javery@newtonco.example", "Following up"),
    text: "Hi Robin,\n\nWe have received your application for Newton's Sr. Systems Administrator position and would like to talk.\n\nBest,\nJordan Avery\nLead Recruiter\nNewton Co." };
  assert.equal(bundleOf(recruiter, jobsOn), "jobs", "Job search on with no applications yet");
  assert.equal(bundleOf({ ...recruiter, text: "Hi Robin, quick note.\n\nJordan Avery\nSenior Technical\nRecruiter" }, jobsOn), "jobs", "the signature alone, split across lines");
  assert.equal(bundleOf(sys("no-reply@hr.example", "Application status update"), jobsOn), "jobs", "in the subject");
  assert.equal(bundleOf(recruiter, NO_MODULES), null, "Job search off: a person's mail again");
  const newsletter = sys("news@books.example", "This week", { unsubscribe: true, text: "Our interview with the author, and our position on e-books." } as Partial<BundleMail>);
  assert.equal(bundleOf(newsletter, jobsOn), "promos", "interview and position alone are not job words");
  assert.equal(bundleOf({ ...recruiter, text: `${"x ".repeat(2000)}Lead Recruiter` }, jobsOn), null, "only the text's start is read");
  assert.equal(bundleOf({ ...recruiter, text: "Thanks!\n\nAre you free to schedule a phone screen this week?" }, jobsOn), "jobs");
});

test("mail bundles: everyday uses of hiring words are not jobs", () => {
  const jobsOn: BundleContext = { ...NO_MODULES, jobs: [] };
  const aid = sys("noreply@studentaid.example", "The new aid form is available", { unsubscribe: true, text: "You can now submit your Free Application for Federal Student Aid form." } as Partial<BundleMail>);
  assert.equal(bundleOf(aid, jobsOn), "promos", "an application form is not a job application");
  const locker = sys("lockers@shop.example", "You have a package to pick up", { text: "Make sure your phone screen is clean and crack-free before scanning." } as Partial<BundleMail>);
  assert.equal(bundleOf(locker, jobsOn), "purchases", "a phone's screen is not a phone screen; a package to pick up is a purchase");
});

test("mail bundles: a short company name is looked for only as a whole sender name or by its posting's site", () => {
  const box: BundleContext = { ...NO_MODULES, jobs: [{ company: "Box", url: "https://jobs.box.example/42" }, { company: "EA", url: null }] };
  assert.equal(bundleOf(sys("no-reply@dropbox.example", "Your files"), box), "other", "box is inside dropbox, but that is not Box");
  assert.equal(bundleOf(sys("news@eastbank.example", "Rates this month", { unsubscribe: true }), box), "promos", "ea is inside eastbank");
  assert.equal(bundleOf(sys("talent@box.example", "Interview times"), box), "jobs", "the posting's site");
  assert.equal(bundleOf(person("EA Recruiting", "sam@mail.example", "Your application"), box), "jobs", "the sender's name, as a whole word");
  assert.equal(bundleOf(person("Sean", "sean@example.com", "Lunch?"), box), null, "EA is not a word in Sean");
});

test("mail bundles: pet, from the pets' names and vet words", () => {
  assert.equal(bundleOf(sys("reminders@clinic.example", "Biscuit is due for vaccines"), ALL), "pet");
  assert.equal(bundleOf(sys("frontdesk@clinic.example", "Your appointment", { from: { name: "Riverside Animal Hospital", address: "frontdesk@clinic.example" } }), ALL), "pet");
  assert.notEqual(bundleOf(sys("reminders@clinic.example", "Biscuit is due for vaccines"), NO_MODULES), "pet", "Pet off");
});

test("mail bundles: bills, from the renewals and bill words, before purchases", () => {
  assert.equal(bundleOf(sys("billing@fastmail.example", "Your account update"), ALL), "bills", "same site as a renewal");
  assert.equal(bundleOf(sys("alerts@bank.example", "Your statement is ready"), ALL), "bills");
  assert.equal(bundleOf(sys("billing@power.example", "Payment due: order of service changes"), ALL), "bills", "bills is checked before purchases");
  assert.equal(bundleOf(sys("alerts@bank.example", "Your statement is ready"), NO_MODULES), "other", "Renewals off: no bills bundle");
});

test("mail bundles: Social's settings are dropped (Updates keeps Other's), and settings under the short-lived ids move back at start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-ids-"));
  try {
    const file = path.join(dir, "mail.sqlite");
    let db = openMailDb(file);
    const set = (key: string, value: unknown) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
    // As 1.0.14 kept them: Social never shown, Other as it arrives (no setting), Promos once a day.
    set("bundle_delivery", { promos: { mode: "daily", time: "07:00" }, social: { mode: "never" }, trips: { mode: "never" } });
    set("mail_notify", { people: true, bundles: ["purchases", "social", "jobs"], detail: "sender" });
    db.close();
    db = openMailDb(file);
    assert.deepEqual(bundleDelivery(db), { promos: { mode: "daily", time: "07:00" }, trips: { mode: "never" } }, "Social's never is not moved onto Updates: a changed password still shows");
    assert.deepEqual(mailNotify(db), { people: true, bundles: ["purchases", "jobs"], detail: "sender" });
    // A hub that ran a build of the renaming: its ids move back, and the real id's own setting wins.
    set("bundle_delivery", { promotions: { mode: "weekly", time: "18:00", day: 0 }, updates: { mode: "never" }, other: { mode: "daily", time: "09:00" }, transactions: { mode: "never" } });
    set("mail_notify", { people: false, bundles: ["transactions", "updates", "purchases"], detail: "count" });
    db.close();
    db = openMailDb(file);
    assert.deepEqual(bundleDelivery(db), { other: { mode: "daily", time: "09:00" }, promos: { mode: "weekly", time: "18:00", day: 0 }, purchases: { mode: "never" } });
    assert.deepEqual(mailNotify(db), { people: false, bundles: ["purchases", "other"], detail: "count" });
    db.close();
    // Nothing odd kept: nothing rewritten.
    db = openMailDb(file);
    assert.deepEqual(bundleDelivery(db), { other: { mode: "daily", time: "09:00" }, promos: { mode: "weekly", time: "18:00", day: 0 }, purchases: { mode: "never" } });
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
