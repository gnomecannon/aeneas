import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { scripted } from "./ai-helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { listMail, MAIL_QUERY } from "../src/imports/gmail.js";
import { fileMessage, htmlToText, looksLikeOffer, MAIL_SYSTEM, mailText, nextDue, serviceKey, type MailRead } from "../src/mail-filer.js";
import { autopayDue, syncWatchReminder, watchDaily } from "../src/watches.js";
import { named } from "../src/profile.js";

const APP = { client_id: "1234567890-abcdefghij.apps.googleusercontent.com", client_secret: "GOCSPX-test-secret-0123456789ab" };
const HUB = "https://core.example.ts.net:8787";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

interface Mail { id: string; at: Date; from: string; subject: string; html: string; read: MailRead }

/** A fake Google: token and profile endpoints, Gmail list and get from `mail`, revoke. Records what was asked. */
function fakeGoogle(t: TestHub, mail: Map<string, Mail>, email = "Robin@Example.com") {
  const seen = { tokens: [] as URLSearchParams[], lists: [] as string[], revoked: [] as string[] };
  t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const p = new URLSearchParams(String(init?.body));
      seen.tokens.push(p);
      if (p.get("code") === "bad") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `at-${seen.tokens.length}`, refresh_token: p.get("grant_type") === "authorization_code" ? "rt-1" : undefined, expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") { seen.revoked.push(new URLSearchParams(String(init?.body)).get("token")!); return json({}); }
    assert.equal(u.host, "gmail.googleapis.com");
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer at-/);
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: email });
    if (u.pathname.endsWith("/messages")) {
      seen.lists.push(u.searchParams.get("q")!);
      return json({ messages: [...mail.values()].sort((a, b) => b.at.getTime() - a.at.getTime()).map((m) => ({ id: m.id })) });
    }
    const id = decodeURIComponent(u.pathname.split("/").pop()!);
    const m = mail.get(id);
    if (!m) return json({ error: { code: 404 } }, 404);
    return json({ id, internalDate: String(m.at.getTime()), payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }], parts: [{ mimeType: "text/html", body: { data: b64(m.html) } }] } });
  }) as typeof fetch;
  return seen;
}

/** A model that answers each mail with the reading the test gave it, found by subject. Records what it was sent. */
function mailModel(mail: Map<string, Mail>): Backend & { sent: AiMessage[][] } {
  const b = {
    name: "ollama" as const, model: "scripted", sent: [] as AiMessage[][],
    chat: async (msgs: AiMessage[], opts?: { json?: boolean }) => {
      assert.equal(opts?.json, true);
      b.sent.push(msgs);
      const subject = /^Subject: (.*)$/m.exec(msgs[1].content)?.[1];
      const m = [...mail.values()].find((x) => x.subject === subject);
      return { text: JSON.stringify(m?.read ?? { type: "none" }), usage: {} };
    },
    stream: async () => ({ text: "", usage: {} }),
  };
  return b;
}

async function link(t: TestHub) {
  assert.equal((await t.api("/connections/google/app", { method: "PUT", json: APP })).status, 200);
  const { url } = await (await t.api("/connections/google/signin", { method: "POST", json: { hub: HUB, client: "web" } })).json() as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const res = await t.app.request(`/connections/google/return?state=${state}&code=good`);
  assert.equal(res.status, 200);
  return res.text();
}

test("gmail: the hub's Google app, then sign-in asks only to read mail and keeps a lasting link per mailbox", async () => {
  const t = makeHub();
  try {
    const seen = fakeGoogle(t, new Map());
    assert.equal((await t.api("/connections/google/signin", { method: "POST", json: { hub: HUB, client: "web" } })).status, 409);
    assert.equal((await t.api("/connections/google/app", { method: "PUT", json: { client_id: "nope", client_secret: APP.client_secret } })).status, 422);
    assert.equal((await t.api("/connections/google/app", { method: "PUT", json: APP })).status, 200);
    assert.equal((await t.api("/connections/google/signin", { method: "POST", json: { hub: "http://core:8787", client: "web" } })).status, 422);
    const { url } = await (await t.api("/connections/google/signin", { method: "POST", json: { hub: HUB, client: "apple" } })).json() as { url: string };
    const q = new URL(url).searchParams;
    assert.equal(q.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("redirect_uri"), `${HUB}/connections/google/return`);
    // The redirect back needs no token; the one-time state guards it.
    const res = await t.app.request(`/connections/google/return?state=${q.get("state")}&code=good`);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location")!, /^everythingapp:\/\/google\?linked=1/);
    assert.equal((await t.app.request(`/connections/google/return?state=${q.get("state")}&code=good`)).status, 200, "a used state shows the expired page");
    const view = await (await t.api("/connections")).json() as any;
    assert.equal(view.google.app, true);
    assert.equal(view.google.accounts.length, 1);
    assert.equal(view.google.accounts[0].email, "robin@example.com");
    assert.equal(JSON.stringify(view).includes("rt-1"), false, "no token leaves the hub");
    assert.equal(JSON.stringify(view).includes(APP.client_secret), false);
    // Signing in to the same mailbox again replaces the link instead of adding a second.
    assert.match(await link(t), /linked again/);
    assert.equal(t.hub.connections.get().google!.length, 1);
    assert.equal(seen.tokens[0].get("redirect_uri"), `${HUB}/connections/google/return`);
  } finally { t.cleanup(); }
});

test("gmail: mail files itself into renewals and the pet, newest mail first and never twice, and orders file nothing", async () => {
  const t = makeHub();
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * 86400_000);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ahead = (d: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + d));
  const mail = new Map<string, Mail>();
  const add = (id: string, days: number, subject: string, html: string, read: MailRead, from = "Shop <hi@shop.example>") => mail.set(id, { id, at: ago(days), from, subject, html, read });
  add("n1", 10, "Your Netflix receipt", "<p>Thanks! You paid $15.49 for Netflix Standard.</p>", { type: "charge", vendor: "Netflix", service: "Netflix", category: "subscription", amount: 15.49, period: "month" });
  add("n0", 40, "Your Netflix receipt (old)", "<p>You paid $13.99.</p>", { type: "charge", vendor: "Netflix", service: "Netflix", category: "subscription", amount: 13.99, period: "month" });
  add("d1", 5, "Your domain renews soon", "<p>example.org renews on the date below for $12.00.</p>", { type: "renewal_notice", vendor: "Namecheap", service: "Domain example.org", category: "domain", amount: 12, due: ahead(25), period: "year" });
  add("o1", 3, "Your Amazon order", "<p>Order 111-222. Shure SM58 $99.00, Paper towels $12.99</p>", { type: "order", vendor: "Amazon", order_id: "111-222", items: [{ name: "Shure SM58 microphone", qty: 1, kind: "gear" }, { name: "Paper towels", qty: 2, kind: "consumable" }] });
  add("o2", 2, "Shipped: your Amazon order", "<p>Order 111-222 shipped. Shure SM58 $99.00</p>", { type: "order", vendor: "Amazon", order_id: "111-222", items: [{ name: "Shure SM58 microphone", qty: 1, kind: "gear" }] });
  add("v1", 6, "Your visit receipt", "<p>Pepper: annual exam, rabies vaccine. Total $182.40</p>", { type: "vet_visit", vendor: "Pinecrest", pet: "Pepper", what: "Annual exam and rabies vaccine", amount: 182.4, date: ymd(ago(6)) });
  add("v2", 6, "Pepper is due for Bordetella", "<p>Bordetella vaccine due on the date below. Book an appointment.</p>", { type: "vet_due", vendor: "Pinecrest", pet: "Pepper", what: "Bordetella vaccine", due: ahead(20) });
  add("a1", 1, "Appointment confirmed", "<p>Grooming appointment for Pepper.</p>", { type: "vet_appointment", vendor: "PetSmart Grooming", pet: "Pepper", what: "grooming", date: `${ahead(9)}T10:30` });
  add("x1", 1, "Big sale this weekend", "<p>Everything must go. Shop now.</p>", { type: "none" });
  try {
    t.hub.store.create("pet_event", { pet: "Pepper", type: "weight", at: ago(30).toISOString(), note: "52 lb" });
    const seen = fakeGoogle(t, mail);
    const model = mailModel(mail);
    setBackendOverride(model);
    await link(t);
    // Linking starts the first read by itself; reading again queues nothing twice.
    const listed = await listMail(t.hub, "robin@example.com", now);
    assert.equal(listed.listed, 9);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM mail WHERE state = 'queued'").get() as { n: number }).n, 9);
    assert.ok(seen.lists[0].startsWith(MAIL_QUERY), "Gmail's own search narrows the mailbox first");
    assert.match(seen.lists[0], /after:\d+$/);
    // The filer takes the newest first, like the job.
    const order = (t.hub.db.prepare("SELECT id FROM mail WHERE state = 'queued' ORDER BY n DESC").all() as { id: string }[]).map((r) => r.id);
    assert.equal(order[order.length - 1], "n0", "the oldest mail is read last");
    for (const id of order) await fileMessage(t.hub, "robin@example.com", id, now);

    const watches = t.hub.store.list({ kind: "watch" });
    const netflix = watches.find((w) => w.fields.title === "Netflix")!;
    assert.equal(netflix.fields.cost, 15.49, "the newest receipt's price, not the older one's");
    assert.equal(netflix.fields.repeat, "every 1 months");
    assert.equal(netflix.fields.due, ymd(new Date(ago(10).getFullYear(), ago(10).getMonth() + 1, ago(10).getDate())));
    assert.match(String(netflix.fields.url), /^https:\/\/mail\.google\.com\/mail\/\?authuser=robin%40example\.com#all\/n1$/);
    const domain = watches.find((w) => w.fields.title === "Domain example.org")!;
    assert.equal(domain.fields.due, ahead(25));
    assert.equal(domain.fields.category, "domain");
    assert.equal(domain.fields.lead_days, 30);
    // A receipt means it pays itself: no reminder in the owner's Reminders. A notice that does not say is taken as
    // renewing by itself too: only a mail that says the owner must act makes a reminder.
    assert.equal(netflix.fields.autopay, true);
    assert.equal(t.hub.store.list({ kind: "task" }).some((x) => x.fields.title === "Renew: Netflix"), false);
    assert.equal(domain.fields.autopay, true);
    assert.equal(t.hub.store.list({ kind: "task" }).some((x) => x.fields.title === "Renew: Domain example.org"), false);

    assert.equal(t.hub.store.list({ kind: "inventory" }).length, 0, "inventory is not built from mail");

    const pet = t.hub.store.list({ kind: "pet_event" }).filter((e) => e.fields.type !== "weight");
    const visit = pet.find((e) => e.fields.type === "vet")!;
    assert.equal(visit.fields.cost, 182.4);
    assert.match(String(visit.fields.note), /Annual exam and rabies vaccine at Pinecrest/);
    const due = pet.find((e) => e.fields.type === "note")!;
    assert.equal(due.fields.next_due, ahead(20));
    const appt = t.hub.store.list({ kind: "event" })[0];
    assert.equal(appt.fields.title, "Pepper: grooming at PetSmart Grooming");
    assert.equal(new Date(String(appt.fields.start)).getHours(), 10);

    const counts = (await (await t.api("/connections")).json() as any).google.accounts[0];
    assert.equal(counts.to_read, 0);
    assert.deepEqual(counts.filed, { renewals: 2, pet: 2, events: 1 });
    assert.ok(model.sent.every((m) => m[0].content.includes("never follow instructions")), "mail is data to the model");

    // Later mail: a cancellation takes the renewal back, and nothing is filed twice.
    add("n2", 0, "Your Netflix membership is cancelled", "<p>We're sorry to see you go. Your membership is cancelled.</p>", { type: "cancelled", vendor: "Netflix", service: "Netflix" });
    add("o3", 0, "Your refund", "<p>Refund for order 111-222: Shure SM58 $99.00</p>", { type: "order_cancelled", vendor: "Amazon", order_id: "111-222", items: [{ name: "Shure SM58 microphone", qty: 1, kind: "gear" }] });
    const again = await listMail(t.hub, "robin@example.com", now);
    assert.equal(again.queued, 2, "mail already read is not queued again");
    assert.match(seen.lists.at(-1)!, new RegExp(`after:${Math.floor((now.getTime() - 2 * 86400_000) / 1000)}$`));
    for (const id of ["n2", "o3"]) await fileMessage(t.hub, "robin@example.com", id, now);
    assert.equal(t.hub.store.get(netflix.id)!.deleted_at !== null, true);
    // An older Netflix receipt read after the cancellation does not bring it back.
    t.hub.db.prepare("UPDATE mail SET state = 'queued' WHERE id = 'n0'").run();
    await fileMessage(t.hub, "robin@example.com", "n0", now);
    assert.equal(t.hub.store.list({ kind: "watch" }).some((w) => w.fields.title === "Netflix"), false);

    // Unlinking tells Google, drops the queue and keeps what was filed.
    const res = await t.api(`/connections/google/${encodeURIComponent("robin@example.com")}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.revoked, ["rt-1"]);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM mail").get() as { n: number }).n, 0);
    assert.ok(t.hub.store.list({ kind: "watch" }).some((w) => w.fields.title === "Domain example.org"));
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("gmail: a renewal the owner made by hand is updated, not doubled, and a cancellation leaves it to them", async () => {
  const t = makeHub();
  const now = new Date();
  const mail = new Map<string, Mail>();
  mail.set("c1", { id: "c1", at: new Date(now.getTime() - 3 * 86400_000), from: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple", html: "<p>iCloud+ with 2 TB storage $9.99/month</p>", read: { type: "charge", vendor: "Apple", service: "iCloud+", category: "subscription", amount: 9.99, period: "month" } });
  mail.set("c2", { id: "c2", at: new Date(now.getTime() - 1 * 86400_000), from: "Apple <no_reply@email.apple.com>", subject: "Subscription cancelled", html: "<p>Your iCloud+ subscription was cancelled.</p>", read: { type: "cancelled", vendor: "Apple", service: "iCloud+" } });
  try {
    const mine = t.hub.store.create("watch", { title: "iCloud+", category: "subscription", due: "2030-01-01", lead_days: 3 });
    fakeGoogle(t, mail);
    setBackendOverride(mailModel(mail));
    await link(t);
    await listMail(t.hub, "robin@example.com", now);
    await fileMessage(t.hub, "robin@example.com", "c1", now);
    const w = t.hub.store.list({ kind: "watch" });
    assert.equal(w.length, 1);
    assert.equal(w[0].id, mine.id);
    assert.equal(w[0].fields.cost, 9.99);
    assert.notEqual(w[0].fields.due, "2030-01-01");
    await fileMessage(t.hub, "robin@example.com", "c2", now);
    assert.equal(t.hub.store.get(mine.id)!.deleted_at, null);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("gmail: mail with nothing to file never reaches the model, and receipts read as text", async () => {
  const t = makeHub();
  const mail = new Map<string, Mail>();
  mail.set("q1", { id: "q1", at: new Date(), from: "News <n@news.example>", subject: "This week's plan for the garden club", html: "<style>.x{}</style><p>Meet&nbsp;Saturday&#8217;s volunteers&zwnj;&zwnj;</p>", read: { type: "none" } });
  try {
    fakeGoogle(t, mail);
    const model = mailModel(mail);
    setBackendOverride(model);
    await link(t);
    await listMail(t.hub, "robin@example.com");
    assert.deepEqual(await fileMessage(t.hub, "robin@example.com", "q1"), { state: "skipped", filed: [] });
    assert.equal(model.sent.length, 0);
    assert.equal(htmlToText("<style>.x{}</style><p>Meet&nbsp;Saturday&#8217;s volunteers&zwnj;</p>").trim(), "Meet Saturday’s volunteers");
    const plain = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("short") } }, { mimeType: "text/html", body: { data: b64("<p>Total: <b>$12.00</b></p><p>Thanks</p>") } }] };
    assert.equal(mailText(plain), "Total: $12.00\nThanks", "a stub plain part gives way to the HTML");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("gmail: when the next renewal falls, and when old mail is too old to mean it still renews", () => {
  const now = new Date(2026, 10, 3, 12);
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9);
  assert.deepEqual(nextDue({ type: "charge", period: "month" }, at(2026, 10, 20), now), { due: "2026-11-20", repeat: "every 1 months" });
  assert.deepEqual(nextDue({ type: "charge", period: "month" }, at(2026, 9, 28), now), { due: "2026-11-28", repeat: "every 1 months" }, "a charge just past due rolls to the next one");
  assert.equal(nextDue({ type: "charge", period: "month" }, at(2026, 7, 1), now), null, "no newer receipt in months: likely cancelled");
  assert.deepEqual(nextDue({ type: "charge", period: "year" }, at(2025, 11, 20), now), { due: "2026-11-20", repeat: "every 1 years" });
  assert.deepEqual(nextDue({ type: "renewal_notice", due: "2026-12-01" }, at(2026, 11, 1), now), { due: "2026-12-01" });
  assert.equal(nextDue({ type: "renewal_notice", due: "2026-10-01" }, at(2026, 9, 1), now), null, "a one-off date already past");
  assert.equal(nextDue({ type: "charge" }, at(2026, 11, 1), now), null, "no date and no period: nothing to watch");
});

test("gmail: a chat that starts stops mail reading, and the mail waits in the queue with no attempt counted", async () => {
  const t = makeHub();
  const mail = new Map<string, Mail>();
  mail.set("r1", { id: "r1", at: new Date(), from: "Shop <s@shop.example>", subject: "Your receipt", html: "<p>Total $20.00</p>", read: { type: "none" } });
  try {
    fakeGoogle(t, mail);
    const b = scripted([() => ({ text: "Hello there." })], "Hello there.");
    let reading = false;
    b.chat = (msgs: AiMessage[], opts?: { json?: boolean; signal?: AbortSignal }) => {
      // The model gets the filer prompt with the owner named in it.
      if (msgs[0].content !== named(MAIL_SYSTEM, t.hub.ai.owner())) return Promise.resolve({ text: "Hello there.", usage: {} });
      reading = true;
      return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason)));
    };
    setBackendOverride(b);
    await link(t);
    await listMail(t.hub, "robin@example.com");
    const filing = fileMessage(t.hub, "robin@example.com", "r1");
    while (!reading) await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.hub.ai.quiet(0), true);
    await t.hub.ai.chat({ session_id: "s-chat", message: "what's on today?", task_type: "auto" });
    assert.deepEqual(await filing, { state: "queued", filed: [] });
    const row = t.hub.db.prepare("SELECT state, attempts FROM mail WHERE id = 'r1'").get() as { state: string; attempts: number };
    assert.deepEqual({ ...row }, { state: "queued", attempts: 0 });
    assert.equal(t.hub.ai.quiet(60_000), false, "the filer then waits for the chat to go quiet");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("the privacy page Google's sign-in screen links to opens without the hub token, only once Gmail is set up", async () => {
  const t = makeHub();
  try {
    t.hub.profile.set({ name: "Robin" });
    assert.equal((await t.app.request("/privacy")).status, 404, "no Google app and no mailbox: nobody's name on an open page");
    assert.equal((await t.api("/connections/google/app", { method: "PUT", json: APP })).status, 200);
    const res = await t.app.request("/privacy");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /read-only access \(gmail\.readonly\)/);
    assert.match(html, /The mail itself is not stored/);
  } finally { t.cleanup(); }
});

test("gmail: one renewal under two names is one watch, and autopay keeps it out of Reminders", async () => {
  const t = makeHub();
  const now = new Date();
  const at = (d: number) => new Date(now.getTime() - d * 86400_000);
  const mail = new Map<string, Mail>();
  mail.set("r1", { id: "r1", at: at(3), from: "StreamCo <invoice@streamco.example>", subject: "Your receipt from StreamCo", html: "<p>StreamCo Plus $20.00</p>", read: { type: "charge", vendor: "StreamCo", service: "StreamCo Plus", category: "subscription", amount: 20, period: "month" } });
  mail.set("r2", { id: "r2", at: at(2), from: "StreamCo Billing <billing@streamco.example>", subject: "Your StreamCo Plus receipt", html: "<p>StreamCo Plus - Monthly $20.00</p>", read: { type: "charge", vendor: "StreamCo Billing", service: "StreamCo Plus - Monthly", category: "subscription", amount: 20, period: "month" } });
  mail.set("r3", { id: "r3", at: at(2), from: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple", html: "<p>StreamCo Premium $132.80</p>", read: { type: "charge", vendor: "Apple", service: "StreamCo Premium", category: "subscription", amount: 132.8, period: "month" } });
  mail.set("r4", { id: "r4", at: at(1), from: "Registrar <r@reg.example>", subject: "Your domain expires soon", html: "<p>Renew now or example.net expires.</p>", read: { type: "renewal_notice", vendor: "Registrar", service: "Domain example.net", category: "domain", due: ymdOf(new Date(now.getTime() + 20 * 86400_000)), auto_renews: false } });
  try {
    fakeGoogle(t, mail);
    setBackendOverride(mailModel(mail));
    await link(t);
    await listMail(t.hub, "robin@example.com", now);
    for (const id of ["r1", "r2", "r3", "r4"]) await fileMessage(t.hub, "robin@example.com", id, now);
    const titles = t.hub.store.list({ kind: "watch" }).map((w) => String(w.fields.title)).sort();
    assert.deepEqual(titles, ["Domain example.net", "StreamCo Plus", "StreamCo Premium"], "the monthly receipt joined StreamCo Plus; another plan stays its own");
    const tasks = t.hub.store.list({ kind: "task" }).map((x) => String(x.fields.title));
    assert.deepEqual(tasks, ["Renew: Domain example.net"], "only what the owner has to act on reaches Reminders");
    // Set later, autopay takes an existing reminder away.
    const dom = t.hub.store.list({ kind: "watch" }).find((w) => w.fields.title === "Domain example.net")!;
    t.hub.store.patch(dom.id, { autopay: true });
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0);
    assert.equal(syncWatchReminder(t.hub.store, t.hub.store.get(dom.id)!), null);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("renewal names and autopay due dates", () => {
  assert.equal(serviceKey("StreamCo Plus - Monthly"), "streamco plus");
  assert.equal(serviceKey("Notely - Notes & Lists"), "notely");
  assert.equal(serviceKey("Domain rivera-dapper.com"), "domain rivera dapper com");
  assert.equal(serviceKey("Spotify Premium (Annual Plan)"), "spotify premium");
  assert.equal(serviceKey("CloudBox 2 TB"), "cloudbox");
  assert.equal(serviceKey("iCloud+ 2TB"), serviceKey("iCloud+"));
  const now = new Date(2026, 10, 3, 12);
  assert.equal(autopayDue("2026-10-09", "every 1 months", now), "2026-11-09", "a charge date that passed moves to the next one");
  assert.equal(autopayDue("2026-08-09", "every 1 months", now), "2026-11-09", "several periods at once");
  assert.equal(autopayDue("2026-11-03", "every 1 months", now), null, "due today has not passed");
  assert.equal(autopayDue("2026-12-01", "every 1 years", now), null);
});

function ymdOf(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

test("a renewal's reminder is made only in the two weeks before it fires, so Reminders is not filled months ahead", () => {
  const t = makeHub();
  try {
    const far = new Date(Date.now() + 160 * 86400_000);
    const w = t.hub.store.create("watch", { title: "Gold Star membership", category: "other", due: ymdOf(far), lead_days: 7, repeat: "every 1 years", autopay: false });
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0, "April's renewal lives in Renewals, not in Reminders, in November");
    t.hub.store.patch(w.id, { due: ymdOf(new Date(Date.now() + 15 * 86400_000)) });
    const tasks = t.hub.store.list({ kind: "task" });
    assert.deepEqual(tasks.map((x) => x.fields.title), ["Renew: Gold Star membership"], "eight days before its reminder it is made");
    t.hub.store.patch(w.id, { due: ymdOf(far) });
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0, "moved far again, it goes away");
  } finally { t.cleanup(); }
});

test("gmail: an offer to start something is not a renewal of something the owner has", async () => {
  const t = makeHub();
  const now = new Date();
  const mail = new Map<string, Mail>();
  mail.set("p1", { id: "p1", at: new Date(now.getTime() - 3 * 86400_000), from: "Amazon.com <no-reply@amazon.com>", subject: "Included with your Amazon order: Free 90 days of music", html: "<p>Start your free trial of Amazon Music Unlimited.</p>", read: { type: "renewal_notice", vendor: "Amazon", service: "Amazon Music Unlimited", category: "subscription", period: "month", auto_renews: true } });
  mail.set("p2", { id: "p2", at: new Date(now.getTime() - 2 * 86400_000), from: "Spotify <no-reply@spotify.com>", subject: "Your free trial ends on November 20", html: "<p>Your Premium trial ends on the date above.</p>", read: { type: "renewal_notice", vendor: "Spotify", service: "Spotify Premium", category: "subscription", due: ymdOf(new Date(now.getTime() + 17 * 86400_000)), auto_renews: true } });
  try {
    fakeGoogle(t, mail);
    setBackendOverride(mailModel(mail));
    await link(t);
    await listMail(t.hub, "robin@example.com", now);
    for (const id of ["p1", "p2"]) await fileMessage(t.hub, "robin@example.com", id, now);
    assert.deepEqual(t.hub.store.list({ kind: "watch" }).map((w) => w.fields.title), ["Spotify Premium trial"], "the offer is skipped; a trial the owner started is kept");
  } finally { setBackendOverride(null); t.cleanup(); }
  const notice = (subject: string): boolean => looksLikeOffer(subject, { type: "renewal_notice" });
  assert.equal(notice("Get 3 months free of Audible"), true);
  assert.equal(notice("Try Premium for free"), true);
  assert.equal(notice("Your membership will renew on April 20"), false);
  assert.equal(notice("Your receipt from Apple"), false);
  assert.equal(looksLikeOffer("Free 90 days of music", { type: "charge", amount: 9.99 }), false, "a charge with an amount is real");
});

test("gmail: a new search drops the mail queued under the old one and lists again, never queueing mail already read", async () => {
  const t = makeHub();
  const now = new Date();
  const mail = new Map<string, Mail>();
  mail.set("a1", { id: "a1", at: new Date(now.getTime() - 86400_000), from: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple", html: "<p>iCloud+ $9.99</p>", read: { type: "charge", vendor: "Apple", service: "iCloud+", category: "subscription", amount: 9.99, period: "month" } });
  mail.set("a2", { id: "a2", at: new Date(now.getTime() - 2 * 86400_000), from: "Shop <s@shop.example>", subject: "Your order shipped", html: "<p>Order</p>", read: { type: "none" } });
  try {
    fakeGoogle(t, mail);
    setBackendOverride(mailModel(mail));
    await link(t);
    await listMail(t.hub, "robin@example.com", now);
    await fileMessage(t.hub, "robin@example.com", "a1", now);
    // As if listed before the search changed.
    t.hub.connections.update((c) => { c.google![0].query = "old search"; });
    const again = await listMail(t.hub, "robin@example.com", now);
    assert.equal(again.queued, 1, "a2 queued again under the new search; a1 was read and stays read");
    assert.equal(t.hub.connections.get().google![0].query !== "old search", true);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("gmail: a notice that does not say stays out of Reminders, never undoes a \"renew now\", and older ones are fixed", async () => {
  const t = makeHub();
  const now = new Date();
  const at = (d: number) => new Date(now.getTime() - d * 86400_000);
  const soon = ymdOf(new Date(now.getTime() + 8 * 86400_000));
  const mail = new Map<string, Mail>();
  mail.set("g1", { id: "g1", at: at(2), from: "GameHost <billing@gamehost.example>", subject: "Gamecloud rental renewal", html: "<p>Your server rental is due for renewal on the date below.</p>", read: { type: "renewal_notice", vendor: "GameHost", service: "Gamecloud Example (US East)", category: "other", due: soon } });
  mail.set("k1", { id: "k1", at: at(3), from: "Registrar <r@reg.example>", subject: "Your domain expires soon", html: "<p>Renew now or example.net expires.</p>", read: { type: "renewal_notice", vendor: "Registrar", service: "Domain example.net", category: "domain", due: soon, auto_renews: false } });
  mail.set("k2", { id: "k2", at: at(1), from: "Registrar <r@reg.example>", subject: "Domain renewal reminder", html: "<p>example.net renewal is due on the date below.</p>", read: { type: "renewal_notice", vendor: "Registrar", service: "Domain example.net", category: "domain", due: soon } });
  try {
    fakeGoogle(t, mail);
    setBackendOverride(mailModel(mail));
    await link(t);
    await listMail(t.hub, "robin@example.com", now);
    for (const id of ["g1", "k1", "k2"]) await fileMessage(t.hub, "robin@example.com", id, now);
    const watches = t.hub.store.list({ kind: "watch" });
    assert.equal(watches.find((w) => String(w.fields.title).startsWith("Gamecloud"))!.fields.autopay, true);
    assert.equal(watches.find((w) => w.fields.title === "Domain example.net")!.fields.autopay, false, "a later notice that does not say leaves \"renew now\" as it was");
    assert.deepEqual(t.hub.store.list({ kind: "task" }).map((x) => String(x.fields.title)), ["Renew: Domain example.net"]);

    // A watch filed from mail before this, with autopay unset and its reminder made: the daily job sets autopay and the reminder goes.
    const old = t.hub.store.create("watch", { title: "Old Rental", category: "other", due: soon, lead_days: 7, url: "https://mail.google.com/mail/?authuser=robin%40example.com#all/x1" });
    const byHand = t.hub.store.create("watch", { title: "Passport", category: "other", due: soon, lead_days: 7 });
    assert.ok(t.hub.store.list({ kind: "task" }).some((x) => x.fields.title === "Renew: Old Rental"));
    await watchDaily(t.hub);
    assert.equal(t.hub.store.get(old.id)!.fields.autopay, true);
    assert.equal(t.hub.store.get(byHand.id)!.fields.autopay, undefined, "a renewal the owner made is theirs to set");
    assert.deepEqual(t.hub.store.list({ kind: "task" }).map((x) => String(x.fields.title)).sort(), ["Renew: Domain example.net", "Renew: Passport"]);
  } finally { setBackendOverride(null); t.cleanup(); }
});
