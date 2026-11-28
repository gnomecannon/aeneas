import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NotifyEvent } from "../src/bus.js";
import { FAILING_MS, checkConnections, connectionProblems, type ConnectionProblem } from "../src/connection-problems.js";
import { signInEnded } from "../src/imports/gmail.js";
import { KEY_REFUSED, syncSteam } from "../src/imports/steam.js";
import { syncLetterboxd } from "../src/imports/letterboxd.js";
import { makeHub, type TestHub } from "./helpers.js";

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const icloud = (email: string, more: Record<string, unknown> = {}) => ({ email, password: "abcd-efgh-ijkl-mnop", linked_at: ago(30 * 24 * HOUR), ...more });
const ids = (l: ConnectionProblem[]) => l.map((p) => p.id);

function withHub(f: (t: TestHub) => Promise<void> | void) {
  return async () => {
    const t = makeHub();
    try { await f(t); } finally { t.cleanup(); }
  };
}

test("connections: nothing is listed while every connection works", withHub((t) => {
  t.hub.connections.update((c) => {
    c.icloud = [icloud("jamie@icloud.com", { last_error: "iCloud Mail could not be reached" })];
    c.steam = { steam_id: "76561198000000000", last_error: "Steam answered 503", failing_since: ago(HOUR) };
    c.letterboxd = { username: "jamie", last_error: "Letterboxd answered 502", failing_since: ago(2 * HOUR) };
  });
  assert.deepEqual(connectionProblems(t.hub), [], "a password that works and a service down for an hour or two need nobody");
}));

test("connections: a refused mailbox password, an ended Google sign-in and an ended Atlassian sign-in are listed at once", withHub((t) => {
  const refused = ago(5 * 60_000);
  t.hub.connections.update((c) => {
    c.icloud = [icloud("jamie@icloud.com", { refused_at: refused, calendar: { calendars: [], chosen: [], target: null } })];
    c.imap = [
      { ...icloud("alex@gmail.com", { refused_at: refused }), preset: "gmail", host: "imap.gmail.com", port: 993, user: "alex@gmail.com" },
      { ...icloud("robin@mail.example", { refused_at: refused }), preset: "imap", host: "mail.example", port: 993, user: "robin" },
    ];
    c.google = [{ email: "old@gmail.com", access_token: "a", refresh_token: "r", expires_at: ago(0), linked_at: ago(HOUR), last_error: signInEnded("old@gmail.com") }];
    c.atlassian = { access_token: "a", refresh_token: "r", expires_at: ago(0), cloud_id: "c1", site_url: "https://x.atlassian.net", site_name: "x", spaces: ["D"], expired: true, last_error: "ended" };
  });
  const list = connectionProblems(t.hub);
  assert.deepEqual(ids(list), ["account:icloud:jamie@icloud.com", "account:imap:alex@gmail.com", "account:imap:robin@mail.example", "google:old@gmail.com", "atlassian"]);
  const [ic, gm, other, google, atl] = list;
  assert.deepEqual(ic, {
    id: "account:icloud:jamie@icloud.com", service: "iCloud", title: "iCloud stopped signing in for jamie@icloud.com", detail: "Replace its app-specific password.",
    fix: "account", account: "icloud:jamie@icloud.com", button: "Replace password", affects: ["mail", "calendar"], since: refused,
  });
  assert.equal(gm.title, "Gmail stopped signing in for alex@gmail.com");
  assert.equal(gm.detail, "Replace its app password.");
  assert.equal(other.title, "mail.example stopped signing in for robin@mail.example");
  assert.equal(google.account, "old@gmail.com", "an older Google sign-in's key is its address");
  assert.equal(google.button, "Add app password");
  assert.deepEqual([atl.fix, atl.button, atl.title], ["connections", "Reconnect", "Your Confluence sign-in ended"]);
  for (const p of list) assert.doesNotMatch(`${p.title} ${p.detail} ${p.button}`, /[\u2013\u2014]/, "no dashes in what a person reads");
}));

test("connections: a sync failing for hours is listed; Steam's refused key at once, with its own fix", withHub((t) => {
  t.hub.connections.update((c) => {
    c.icloud = [icloud("jamie@icloud.com", { mail: false, calendar: { calendars: [], chosen: [], target: null, last_error: "Calendar sync stopped on an error; the hub tries again later.", failing_since: ago(FAILING_MS + HOUR) } })];
    c.steam = { steam_id: "76561198000000000", last_error: KEY_REFUSED, failing_since: ago(60_000), key_refused: true };
    c.letterboxd = { username: "jamie", last_error: "Letterboxd answered 502", failing_since: ago(FAILING_MS + 1) };
  });
  const list = connectionProblems(t.hub);
  assert.deepEqual(ids(list), ["calendar:jamie@icloud.com", "steam", "letterboxd"]);
  assert.deepEqual(list[0].affects, ["calendar"], "an account only calendars use shows on Week, not Mail");
  assert.equal(list[0].title, "iCloud calendars for jamie@icloud.com stopped syncing");
  assert.equal(list[1].button, "Replace the Steam key");
  assert.equal(list[2].detail, "Letterboxd answered 502", "the hub's own words say what is wrong");
}));

test("connections: a module that is off lists none of its connections", withHub((t) => {
  t.hub.connections.update((c) => {
    c.icloud = [icloud("jamie@icloud.com", { refused_at: ago(0) })];
    c.atlassian = { access_token: "a", refresh_token: "r", expires_at: ago(0), cloud_id: "c1", site_url: "https://x.atlassian.net", site_name: "x", spaces: [], expired: true };
    c.steam = { steam_id: "76561198000000000", key_refused: true, last_error: KEY_REFUSED };
  });
  assert.equal(connectionProblems(t.hub).length, 3);
  t.hub.modules.set({ mail: false, mail_inbox: false, wiki: false, games: false });
  assert.deepEqual(connectionProblems(t.hub), []);
}));

test("connections: one alert when a connection breaks, none again after a restart, and again when it breaks after a fix", withHub((t) => {
  const file = path.join(t.dir, "connection-alerts.json");
  const seen: NotifyEvent[] = [];
  t.hub.bus.on("notify", (n) => { seen.push(n); });
  assert.deepEqual(checkConnections(t.hub, file), []);
  t.hub.connections.update((c) => { c.icloud = [icloud("jamie@icloud.com", { refused_at: ago(0) })]; });
  checkConnections(t.hub, file);
  checkConnections(t.hub, file);
  assert.equal(seen.length, 1, "once, not every look");
  assert.equal(seen[0].kind, "connection");
  assert.equal(seen[0].name, "iCloud");
  assert.equal(seen[0].title, "iCloud stopped signing in for jamie@icloud.com. Replace its app-specific password.");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { told: ["account:icloud:jamie@icloud.com"] }, "kept, so a restart does not tell it again");
  t.hub.connections.update((c) => { c.icloud![0].refused_at = null; });
  checkConnections(t.hub, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { told: [] });
  t.hub.connections.update((c) => { c.icloud![0].refused_at = ago(0); });
  checkConnections(t.hub, file);
  assert.equal(seen.length, 2, "broken again after a fix: told again");
}));

test("connections: the alert is a kind of its own that Settings, Notifications can switch off", withHub(async (t) => {
  const kinds = (await (await t.api("/modules")).json()) as { alerts: { id: string; title: string; on: boolean }[] };
  const k = kinds.alerts.find((a) => a.id === "connection");
  assert.deepEqual(k && [k.title, k.on], ["Accounts and connections", true]);
}));

test("connections: Steam marks a refused key and when reads started failing, and a good read clears both", withHub(async (t) => {
  t.hub.connections.update((c) => { c.steam_key = "0123456789ABCDEF0123456789ABCDEF"; c.steam = { steam_id: "76561198000000000" }; });
  let status = 403;
  t.hub.fetch = async () => (status === 200 ? new Response(JSON.stringify({ response: { games: [] } }), { status: 200 }) : new Response("", { status }));
  await assert.rejects(syncSteam(t.hub));
  const first = t.hub.connections.get().steam!;
  assert.equal(first.key_refused, true);
  assert.ok(first.failing_since);
  status = 503;
  await assert.rejects(syncSteam(t.hub));
  const second = t.hub.connections.get().steam!;
  assert.equal(second.key_refused, undefined, "another failure is not the key");
  assert.equal(second.failing_since, first.failing_since, "the run of failures keeps its start");
  const v = (await (await t.api("/connections")).json()) as { steam: { key_refused?: boolean } };
  assert.equal(v.steam.key_refused, false);
  status = 200;
  await syncSteam(t.hub);
  const ok = t.hub.connections.get().steam!;
  assert.deepEqual([ok.failing_since, ok.key_refused, ok.last_error], [undefined, undefined, undefined]);
}));

test("connections: Letterboxd keeps when its reads started failing until one works", withHub(async (t) => {
  t.hub.connections.update((c) => { c.letterboxd = { username: "jamie" }; });
  t.hub.fetch = async () => new Response("", { status: 502 });
  await assert.rejects(syncLetterboxd(t.hub));
  const since = t.hub.connections.get().letterboxd!.failing_since;
  assert.ok(since);
  await assert.rejects(syncLetterboxd(t.hub));
  assert.equal(t.hub.connections.get().letterboxd!.failing_since, since);
  t.hub.fetch = async () => new Response("<rss><channel></channel></rss>", { status: 200, headers: { "content-type": "application/rss+xml" } });
  await syncLetterboxd(t.hub);
  assert.equal(t.hub.connections.get().letterboxd!.failing_since, undefined);
}));

test("connections: Today, Week, Settings and Mail get the problems with what they already fetch", withHub(async (t) => {
  t.hub.connections.update((c) => { c.icloud = [icloud("jamie@icloud.com", { refused_at: ago(0), inbox: true })]; });
  const today = (await (await t.api("/planner/today")).json()) as { connection_problems: ConnectionProblem[] };
  assert.deepEqual(ids(today.connection_problems), ["account:icloud:jamie@icloud.com"]);
  const week = (await (await t.api("/planner/week")).json()) as { connection_problems: ConnectionProblem[] };
  assert.deepEqual(ids(week.connection_problems), ["account:icloud:jamie@icloud.com"]);
  const conns = (await (await t.api("/connections")).json()) as { problems: ConnectionProblem[] };
  assert.deepEqual(ids(conns.problems), ["account:icloud:jamie@icloud.com"]);
  const mail = (await (await t.api("/mail")).json()) as { mailboxes: { email: string; signin_refused: boolean }[] };
  assert.deepEqual(mail.mailboxes.map((m) => [m.email, m.signin_refused]), [["jamie@icloud.com", true]]);
}));
