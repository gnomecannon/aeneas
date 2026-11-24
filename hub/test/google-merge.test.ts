import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { done, fake, GMAIL_PASSWORD, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { dropUnusedGoogleApp, MAIL_QUERY } from "../src/imports/gmail.js";
import { imapSource, listICloud, mergeGoogleSignIns, setMailLookup, type ImapAccount } from "../src/imports/icloud.js";

// Sign in with Google is retired (2026-11-24): app passwords are the one way to add a Google account. An address that
// also has the older sign-in becomes one account, by the hub itself: receipts carry on with the app password from
// where the sign-in stopped, and no mail it listed is listed or read again. Every address, id, token and password here
// is made up; the fake server stands in for Gmail's, and names are looked up by a stand-in for DNS.

const ROBIN = "robin@gmail.example";
const ALEX = "alex@gmail.example";
const KEY = `imap:${ROBIN}`;
const APP = { client_id: "1234567890-abcdefghij.apps.googleusercontent.com", client_secret: "GOCSPX-test-secret-0123456789ab" };
const HUB = "https://hub.example.ts.net:8787";
/** When the sign-in last listed the mailbox. */
const HANDOVER = "2026-11-20T15:00:00.000Z";
const RENEWAL = { type: "charge", vendor: "StreamCo", service: "StreamCo Plus", filed: [{ kind: "watch", id: "w-1", title: "StreamCo Plus", action: "created" }] };

type Internet = { key: string; kind: string; email: string; features: Record<string, boolean | null>; read_only: boolean; receipts?: Record<string, unknown>; google_removed_at?: string };

function setUp(): TestHub {
  setMailLookup(async (host) => {
    if (host !== "imap.gmail.com") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return [{ address: "203.0.113.108" }];
  });
  return makeHub();
}
const tearDown = (t: TestHub) => { setMailLookup(null); done(t); };

/** Robin's address both ways (an app password and the older sign-in), Alex's with the older sign-in only. */
function seed(t: TestHub, mine: Partial<ImapAccount> = {}, sign: { listed_to?: string } = { listed_to: HANDOVER }) {
  const g = (email: string) => ({ email, access_token: `at-${email}`, refresh_token: `rt-${email.split("@")[0]}`, expires_at: "2030-01-01T00:00:00.000Z", linked_at: "2026-10-01T00:00:00.000Z", query: MAIL_QUERY, ...sign });
  t.hub.connections.update((c) => {
    c.google_app = { ...APP };
    c.google = [g(ROBIN), g(ALEX)];
    c.imap = [{ email: ROBIN, preset: "gmail", host: "imap.gmail.com", port: 993, user: ROBIN, password: GMAIL_PASSWORD, linked_at: "2026-11-01T00:00:00.000Z", ...mine }];
  });
}

/** A row of the `mail` table, as the sign-in left it (`account` its bare address, `id` Gmail's hex id). */
function row(t: TestHub, account: string, id: string, state: string, at: string | null = null, result: unknown = null) {
  t.hub.db.prepare("INSERT INTO mail (account, id, at, state, result) VALUES (?, ?, ?, ?, ?)").run(account, id, at, state, result === null ? null : JSON.stringify(result));
}

/** Google's revoke address, recording each token it is told to end; `fail` makes it unreachable. */
function google(t: TestHub, fail = false) {
  const revoked: string[] = [];
  t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      if (fail) throw new Error("no route to Google");
      revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`nothing else is asked of Google here: ${u.host}`);
  }) as typeof fetch;
  return revoked;
}

const internet = async (t: TestHub) => ((await (await t.api("/connections")).json()) as { internet: Internet[] }).internet;
const queued = (t: TestHub) => (t.hub.db.prepare("SELECT id FROM mail WHERE account = ? AND state = 'queued' ORDER BY id").all(KEY) as { id: string }[]).map((r) => r.id);

test("google merge: a hub that started with both links has one account per address, its receipts, counts and switches carried over", async () => {
  const t = setUp();
  try {
    fake([], { gmail: true, days: true });
    // Robin's app password reads Mail, with Read only on; its Receipts switch was off while the sign-in read receipts.
    seed(t, { mail: false, inbox: true, read_only: true });
    const revoked = google(t);
    row(t, ROBIN, "18c0000000000001", "filed", "2026-11-10T09:00:00.000Z", RENEWAL);
    row(t, ROBIN, "18c0000000000002", "skipped", "2026-11-12T09:00:00.000Z", { why: "no signal" });
    row(t, ROBIN, "18c0000000000003", "queued");
    const watch = t.hub.store.create("watch", { title: "StreamCo Plus", category: "subscription", due: "2026-12-10", lead_days: 3 });
    const before = await internet(t);
    assert.deepEqual(before.map((a) => [a.kind, a.email]), [["google", ROBIN], ["google", ALEX], ["gmail", ROBIN]], "two accounts for one address");
    const counts = before.find((a) => a.kind === "google" && a.email === ROBIN)!.receipts;
    assert.deepEqual(counts, { listed: 3, to_read: 1, read: 2, failed: 0, filed: { renewals: 1, pet: 0, events: 0 } });

    // As the hub does at start.
    assert.equal(await mergeGoogleSignIns(t.hub, new Date("2026-11-24T08:00:00.000Z")), 1);
    const after = await internet(t);
    assert.deepEqual(after.map((a) => [a.kind, a.email]), [["google", ALEX], ["gmail", ROBIN]]);
    assert.equal(new Set(after.map((a) => a.email)).size, after.length, "one entry per address");
    const robin = after.find((a) => a.email === ROBIN)!;
    assert.deepEqual(robin.features, { inbox: true, receipts: true, calendars: null }, "Receipts on, as the sign-in's was; Mail as it was");
    assert.equal(robin.read_only, true, "Read only as it was");
    assert.deepEqual(robin.receipts, counts, "what receipts came to carries over");
    assert.equal(robin.google_removed_at, "2026-11-24T08:00:00.000Z", "the account says when the sign-in was removed");
    assert.deepEqual(imapSource.accounts(t.hub), [KEY]);
    const c = t.hub.connections.get();
    assert.deepEqual(c.google?.map((g) => g.email), [ALEX]);
    assert.ok(c.google_app, "the Google app stays while Alex's sign-in reads through it");
    assert.deepEqual(revoked, ["rt-robin"], "Google is told to end the sign-in");
    assert.equal(JSON.stringify(c).includes("rt-robin") || JSON.stringify(c).includes(`at-${ROBIN}`), false, "and its tokens are gone from the hub");
    assert.deepEqual([c.imap![0].receipts_from, c.imap![0].listed_to], [HANDOVER, HANDOVER], "receipts are read from where the sign-in stopped");
    assert.equal(t.hub.store.get(watch.id)?.deleted_at, null, "what was filed stays");
    // The next start finds nothing to merge.
    assert.equal(await mergeGoogleSignIns(t.hub), 0);
    assert.deepEqual(revoked, ["rt-robin"]);
  } finally { tearDown(t); }
});

test("google merge: no mail the sign-in listed is listed or read again, none after its last listing is lost, whatever day SINCE asks from", async () => {
  const t = setUp();
  try {
    const msg = (uid: number, at: string, subject: string): Msg => ({ uid, folder: "INBOX", at: new Date(at), subject, from: { name: "Shop", address: "billing@shop.example" }, messageId: `m${uid}@shop.example`, plain: `${subject}. Total $9.99`, gmailId: `18c00000000000${String(uid).padStart(2, "0")}` });
    const seen = fake([
      msg(1, "2026-11-18T03:00:00.000Z", "Receipt early on the day the search starts"),
      msg(2, "2026-11-19T10:00:00.000Z", "Receipt the sign-in read"),
      msg(3, "2026-11-19T20:00:00.000Z", "Receipt the sign-in listed and had not read"),
      msg(4, "2026-11-20T11:00:00.000Z", "Receipt from hours before the last listing"),
      msg(5, "2026-11-20T14:50:00.000Z", "Receipt the sign-in listed minutes before it stopped"),
      msg(6, "2026-11-20T14:55:00.000Z", "Receipt Gmail's search had not found yet"),
      msg(7, "2026-11-20T15:00:20.000Z", "Receipt that came while the last listing ran"),
      msg(8, "2026-11-20T17:00:00.000Z", "Receipt after the sign-in stopped"),
    ], { gmail: true, days: true });
    seed(t);
    google(t);
    row(t, ROBIN, "18c0000000000002", "filed", "2026-11-19T10:00:00.000Z", RENEWAL);
    row(t, ROBIN, "18c0000000000003", "queued");
    row(t, ROBIN, "18c0000000000005", "skipped", "2026-11-20T14:50:00.000Z", { why: "no signal" });
    row(t, ROBIN, "18c0000000000007", "queued");
    await mergeGoogleSignIns(t.hub);

    const first = await listICloud(t.hub, KEY, new Date("2026-11-21T15:00:00.000Z"));
    // The hub asks from two days before the last listing; the server reads that as the whole day, 18 Nov from midnight.
    assert.deepEqual(seen.searches.at(-1)!.since, new Date("2026-11-18T15:00:00.000Z"));
    // Found by the search: all eight. Listed: only 6 (arrived before the sign-in stopped, but its search had not found
    // it) and 8 (after). 1 and 4 are older than the last listing; 2, 3, 5 and 7 are the sign-in's, told by Gmail's id.
    assert.deepEqual(first, { listed: 2, queued: 2 });
    assert.deepEqual(queued(t), ["18c0000000000003", "18c0000000000007", "7:6:INBOX", "7:8:INBOX"]);
    // Every listing after finds the same days again and queues nothing more.
    assert.deepEqual(await listICloud(t.hub, KEY, new Date("2026-11-21T15:15:00.000Z")), { listed: 2, queued: 0 });
    assert.deepEqual(await listICloud(t.hub, KEY, new Date("2026-11-23T15:15:00.000Z")), { listed: 2, queued: 0 });

    // What the sign-in queued is read through IMAP, found by its Gmail id, read-only.
    const m3 = await imapSource.read(t.hub, KEY, "18c0000000000003");
    assert.equal(m3?.subject, "Receipt the sign-in listed and had not read");
    assert.ok(seen.searches.some((q) => q.emailId === BigInt("0x18c0000000000003").toString()));
    assert.equal(await imapSource.read(t.hub, KEY, "18c00000000fffff"), null, "a mail gone from the mailbox is gone, not an error");
    assert.ok(seen.opened.every((o) => o.readOnly === true));

    // A new search lists 400 days again: what the sign-in queued stays queued, and nothing older than its last listing
    // comes back.
    t.hub.connections.update((c) => { c.imap![0].query = "an older search"; });
    assert.deepEqual(await listICloud(t.hub, KEY, new Date("2026-11-23T15:30:00.000Z")), { listed: 2, queued: 2 });
    assert.deepEqual(queued(t), ["18c0000000000003", "18c0000000000007", "7:6:INBOX", "7:8:INBOX"]);
  } finally { tearDown(t); }
});

test("google merge: a server that gives no Gmail ids is told by the time alone", async () => {
  const t = setUp();
  try {
    const msg = (uid: number, at: string): Msg => ({ uid, folder: "INBOX", at: new Date(at), subject: `Receipt ${uid}`, from: { address: "billing@shop.example" }, messageId: `n${uid}@shop.example`, plain: "Total $9.99" });
    fake([msg(1, "2026-11-19T09:00:00.000Z"), msg(2, "2026-11-20T14:59:59.000Z"), msg(3, "2026-11-20T15:00:00.000Z"), msg(4, "2026-11-20T18:00:00.000Z")], { days: true });
    seed(t);
    google(t);
    await mergeGoogleSignIns(t.hub);
    await listICloud(t.hub, KEY, new Date("2026-11-21T15:00:00.000Z"));
    assert.deepEqual(queued(t), ["7:3:INBOX", "7:4:INBOX"], "from the second the sign-in last listed the mailbox");
  } finally { tearDown(t); }
});

test("google merge: a sign-in whose last listing was lost reads on from the newest mail it read", async () => {
  const t = setUp();
  try {
    fake([], { gmail: true, days: true });
    seed(t, {}, {});
    google(t);
    row(t, ROBIN, "18c0000000000001", "filed", "2026-11-18T09:00:00.000Z", RENEWAL);
    row(t, ROBIN, "18c0000000000002", "skipped", "2026-11-19T09:30:00.000Z", { why: "no signal" });
    await mergeGoogleSignIns(t.hub);
    const mine = t.hub.connections.get().imap![0];
    assert.deepEqual([mine.receipts_from, mine.listed_to], ["2026-11-19T09:30:00.000Z", "2026-11-19T09:30:00.000Z"], "not 400 days of mail read again");
  } finally { tearDown(t); }
});

test("google merge: adding an app password for an older sign-in merges it at once, and the last one takes the Google app with it", async () => {
  const t = setUp();
  try {
    fake([], { gmail: true, days: true });
    seed(t);
    const revoked = google(t);
    await mergeGoogleSignIns(t.hub);
    t.hub.profile.set({ name: "Robin" });
    assert.equal((await t.app.request("/privacy")).status, 200, "the page Google's sign-in screen links to, while a sign-in uses it");
    // Alex's row offers Add an app password: the normal add flow, with the address filled in.
    const r = await t.api("/connections/imap", { method: "PUT", json: { email: ALEX, preset: "gmail", password: "abcd efgh ijkl mnop" } });
    assert.equal(r.status, 200, await r.clone().text());
    const c = t.hub.connections.get();
    assert.equal(c.google?.length ?? 0, 0);
    assert.equal(c.google_app, undefined, "no sign-in is left to use the Google app");
    assert.deepEqual(revoked, ["rt-robin", "rt-alex"]);
    const list = await internet(t);
    assert.deepEqual(list.map((a) => [a.kind, a.email, a.features.receipts, !!a.google_removed_at]), [["gmail", ROBIN, true, true], ["gmail", ALEX, true, true]]);
    assert.equal(c.imap!.find((a) => a.email === ALEX)?.receipts_from, HANDOVER);
    assert.equal((await t.app.request("/privacy")).status, 404, "and the page that names the owner closes");
    // Linking starts a refresh and a listing behind the answer: waited for, so they do not outlive this hub.
    await t.api("/mail/refresh", { method: "POST" });
    await t.api("/connections/google/sync", { method: "POST", json: {} });
  } finally { tearDown(t); }
});

test("google merge: Google out of reach never holds up or fails the merge", async () => {
  const t = setUp();
  try {
    fake([], { gmail: true, days: true });
    seed(t);
    google(t, true);
    assert.equal(await mergeGoogleSignIns(t.hub), 1);
    assert.deepEqual(t.hub.connections.get().google?.map((g) => g.email), [ALEX]);
    assert.equal(JSON.stringify(t.hub.connections.get()).includes("rt-robin"), false, "the tokens are deleted all the same");
  } finally { tearDown(t); }
});

test("google merge: a Google sign-in is not kept for an address that has an app password", async () => {
  const t = setUp();
  try {
    fake([]);
    t.hub.connections.update((c) => { c.imap = [{ email: ROBIN, preset: "gmail", host: "imap.gmail.com", port: 993, user: ROBIN, password: GMAIL_PASSWORD, linked_at: "2026-11-01T00:00:00.000Z" }]; });
    // An older app on another device can still start one, while the hub has a Google app.
    const revoked: string[] = [];
    t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/token") return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
      if (u.pathname === "/revoke") { revoked.push(new URLSearchParams(String(init?.body)).get("token")!); return json({}); }
      if (u.pathname.endsWith("/profile")) return json({ emailAddress: "Robin@Gmail.example" });
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    assert.equal((await t.api("/connections/google/app", { method: "PUT", json: APP })).status, 200);
    const { url } = (await (await t.api("/connections/google/signin", { method: "POST", json: { hub: HUB, client: "web" } })).json()) as { url: string };
    const page = await (await t.app.request(`/connections/google/return?state=${new URL(url).searchParams.get("state")}&code=good`)).text();
    assert.match(page, /Gmail not linked/);
    assert.match(page, /robin@gmail\.example is already added with an app password, which reads its mail for Receipts and renewals too\. The Google sign-in was not kept\./);
    assert.deepEqual(revoked, ["rt-1"], "handed back to Google");
    assert.equal(t.hub.connections.get().google?.length ?? 0, 0);
  } finally { tearDown(t); }
});

test("google merge: at start a Google app no sign-in uses is deleted; removing the last sign-in deletes it too", async () => {
  const t = setUp();
  try {
    t.hub.connections.update((c) => { c.google_app = { ...APP }; });
    assert.equal(dropUnusedGoogleApp(t.hub), true);
    assert.equal(t.hub.connections.get().google_app, undefined);
    assert.equal(dropUnusedGoogleApp(t.hub), false);
    seed(t);
    t.hub.connections.update((c) => { c.imap = []; });
    google(t);
    assert.equal(dropUnusedGoogleApp(t.hub), false, "kept while a sign-in reads through it");
    for (const email of [ROBIN, ALEX]) assert.equal((await t.api(`/connections/accounts/${encodeURIComponent(email)}`, { method: "DELETE" })).status, 200);
    assert.equal(t.hub.connections.get().google_app, undefined, "gone with the last sign-in");
  } finally { tearDown(t); }
});

test("one account per address: iCloud refuses an address added as another mail account, and the other way round", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    t.hub.connections.update((c) => { c.imap = [{ email: "robin@icloud.example", preset: "imap", host: "imap.mail.me.com", port: 993, user: "robin@icloud.example", password: PASSWORD, linked_at: "2026-11-01T00:00:00.000Z" }]; });
    const r = await t.api("/connections/icloud", { method: "PUT", json: { email: "Robin@iCloud.example", password: PASSWORD } });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, "robin@icloud.example is already added as another mail account. Remove that account in Settings, Accounts first, then add it as iCloud.");
    assert.equal(seen.connects, 0, "refused before any sign-in");
    assert.equal(t.hub.connections.get().icloud?.length ?? 0, 0);
    t.hub.connections.update((c) => { c.imap = []; });
    linked(t);
    const back = await t.api("/connections/imap", { method: "PUT", json: { email: "robin@icloud.example", host: "imap.mail.me.com", password: PASSWORD } });
    assert.equal(back.status, 409);
    assert.equal(((await back.json()) as { error: string }).error, "robin@icloud.example is already added as an iCloud account. Remove that account in Settings, Accounts first, then add it here.");
    assert.equal(t.hub.connections.get().imap?.length ?? 0, 0);
  } finally { tearDown(t); }
});

test("one account per address: an iCloud account for calendars alone counts too, both ways, and an address linked both ways before keeps working", async () => {
  const t = setUp();
  try {
    t.hub.modules.set({ calendars: true, mail_inbox: true });
    const other = { email: "robin@icloud.example", preset: "imap" as const, host: "imap.mail.me.com", port: 993, user: "robin@icloud.example", password: PASSWORD, linked_at: "2026-11-01T00:00:00.000Z" };
    t.hub.connections.update((c) => { c.imap = [other]; });
    const cal = await t.api("/calendars/icloud", { method: "PUT", json: { email: "Robin@iCloud.example", password: "abcd-efgh-ijkl-mnop" } });
    assert.equal(cal.status, 409);
    assert.equal(((await cal.json()) as { error: string }).error, "robin@icloud.example is already added as another mail account. Remove that account in Settings, Accounts first, then add it as iCloud.");
    assert.equal(t.hub.connections.get().icloud?.length ?? 0, 0, "refused before iCloud is asked");
    // An iCloud account kept for its calendars alone: the same address is not added as another mail account.
    const calendarOnly = { email: "robin@icloud.example", password: "abcd-efgh-ijkl-mnop", linked_at: "2026-11-01T00:00:00.000Z", mail: false, calendar: { calendars: [], chosen: [], target: null } };
    t.hub.connections.update((c) => { c.imap = []; c.icloud = [calendarOnly]; });
    const back = await t.api("/connections/imap", { method: "PUT", json: { email: "robin@icloud.example", host: "imap.mail.me.com", password: PASSWORD } });
    assert.equal(back.status, 409);
    assert.equal(((await back.json()) as { error: string }).error, "robin@icloud.example is already added as an iCloud account. Remove that account in Settings, Accounts first, then add it here.");
    // Linked both ways before the rule: a new password for either is not refused for being the other (here the
    // stand-in for DNS finds no iCloud server, so it fails later, at the sign-in).
    t.hub.connections.update((c) => { c.imap = [other]; c.icloud = [calendarOnly]; });
    const again = await t.api("/connections/imap", { method: "PUT", json: { email: "robin@icloud.example", host: "imap.mail.me.com", password: PASSWORD } });
    assert.notEqual(again.status, 409);
    assert.equal(t.hub.connections.get().imap?.length, 1);
  } finally { tearDown(t); }
});
