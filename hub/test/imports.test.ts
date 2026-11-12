import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub, fileMode } from "./helpers.js";
import { norm, stableId } from "../src/imports/util.js";
import { filmsFromRss } from "../src/imports/letterboxd.js";
import { TOOLS } from "../src/ai/tools.js";

type Route = (url: URL) => { status?: number; json?: unknown; text?: string };
function fakeFetch(route: Route, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    const r = route(url);
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, { status: r.status ?? 200 });
  }) as typeof fetch;
}

test("sync helpers: stable ids and name matching", () => {
  assert.equal(stableId("steam:440"), stableId("steam:440"));
  assert.notEqual(stableId("steam:440"), stableId("steam:441"));
  assert.match(stableId("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(norm("Pokémon: Let's Go & Friends!"), norm("pokemon lets go and friends"));
});

test("steam: the hub holds the key, a member signs in through Steam, games come in and merge with hand-typed ones", async () => {
  const t = makeHub();
  try {
    const manual = t.hub.store.create("game", { name: "Deep Rock Galactic", max_players: 4, owned_by: ["jamie"] });
    let minutes = 1200;
    let valid = true;
    const posts: string[] = [];
    t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (u.pathname.includes("GetSupportedAPIList")) return json({}, u.searchParams.get("key")?.startsWith("BAD") ? 403 : 200);
      if (u.pathname === "/openid/login" && init?.method === "POST") {
        posts.push(String(init.body));
        return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`);
      }
      if (u.pathname.includes("GetPlayerSummaries")) return json({ response: { players: [{ personaname: "Gnome", profileurl: "https://steamcommunity.com/id/gnome/" }] } });
      if (u.pathname.includes("GetOwnedGames")) return json({ response: { game_count: 3, games: [
        { appid: 548430, name: "Deep Rock Galactic", playtime_forever: minutes, playtime_2weeks: 90, rtime_last_played: 1761600000 },
        { appid: 1145360, name: "Hades", playtime_forever: 3000, rtime_last_played: 1750000000 },
        { appid: 620, name: "Portal 2", playtime_forever: 0, rtime_last_played: 0 },
      ] } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const key = "ABCDEF0123456789ABCDEF0123456789";
    const hubUrl = "https://hub.example.ts.net:8787";

    // No key yet: sign-in cannot start.
    assert.equal((await t.api("/connections/steam/signin", { method: "POST", json: { hub: hubUrl, client: "web" } })).status, 409);
    assert.equal((await t.api("/connections/steam/key", { method: "PUT", json: { api_key: "BAD" + key.slice(3) } })).status, 422);
    const k = await (await t.api("/connections/steam/key", { method: "PUT", json: { api_key: key } })).json() as any;
    assert.deepEqual(k, { connected: false, hub_key: true });

    const start = async (client: string) => {
      const { url } = await (await t.api("/connections/steam/signin", { method: "POST", json: { hub: hubUrl, client } })).json() as any;
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, "https://steamcommunity.com/openid/login");
      assert.equal(u.searchParams.get("openid.realm"), hubUrl);
      return u.searchParams.get("openid.return_to")!;
    };
    // What Steam sends back after the member signs in (no bearer token: it is a browser redirect).
    const back = (returnTo: string, over: Record<string, string> = {}) => {
      const q = new URLSearchParams({ "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "id_res", "openid.op_endpoint": "https://steamcommunity.com/openid/login",
        "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000001", "openid.identity": "https://steamcommunity.com/openid/id/76561198000000001",
        "openid.return_to": returnTo, "openid.response_nonce": "2026-10-28T20:00:00Zabc", "openid.assoc_handle": "1234567890", "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle", "openid.sig": "sig=", ...over });
      const u = new URL(returnTo);
      for (const [k2, v] of q) u.searchParams.set(k2, v);
      return t.app.request(u.pathname + u.search);
    };

    // A forged answer (Steam says not valid) links nothing.
    valid = false;
    const forged = await back(await start("web"));
    assert.equal(forged.status, 200);
    assert.match(await forged.text(), /Steam not linked/);
    assert.equal(((await (await t.api("/connections")).json()) as any).steam.connected, false);

    valid = true;
    const returnTo = await start("web");
    const ok = await back(returnTo);
    assert.match(await ok.text(), /Steam linked as Gnome: 3 games/);
    assert.match(posts[posts.length - 1], /openid\.mode=check_authentication/, "the answer is checked with Steam");
    // The same link again is refused: each sign-in works once.
    assert.match(await (await back(returnTo)).text(), /expired/);

    const view = await (await t.api("/connections")).json() as any;
    assert.equal(view.steam.persona, "Gnome");
    assert.equal(view.steam.games, 3);
    assert.equal(JSON.stringify(view).includes(key), false, "the key never leaves the hub");
    assert.equal(fileMode(path.join(t.hub.cfg.dataDir, "connections.json")), 0o600);

    const games = t.hub.store.list({ kind: "game" });
    assert.equal(games.length, 3, "the hand-typed game gained Steam's numbers instead of a copy");
    const drg = t.hub.store.get(manual.id)!.fields as any;
    assert.equal(drg.steam_appid, 548430);
    assert.equal(drg.playtime_min, 1200);
    assert.deepEqual(drg.owned_by, ["jamie"], "hand-typed fields stay");

    // The next sync writes only what moved.
    minutes = 1300;
    assert.deepEqual(await (await t.api("/connections/steam/sync", { method: "POST" })).json(), { games: 3, created: 0, updated: 1 });
    const lib = await (await t.api("/library/games?sort=playtime&limit=2")).json() as any;
    assert.deepEqual(lib.games.map((g: any) => [g.name, g.hours]), [["Hades", 50], ["Deep Rock Galactic", 21.7]]);
    const never = await (await t.api("/library/games?played=no")).json() as any;
    assert.deepEqual(never.games.map((g: any) => g.name), ["Portal 2"]);
    assert.ok(TOOLS.some((x) => x.name === "library"));

    // The apps get the answer back through their own address.
    const apple = await back(await start("apple"));
    assert.equal(apple.status, 302);
    assert.match(apple.headers.get("location")!, /^everythingapp:\/\/steam\?linked=1/);

    assert.equal(((await (await t.api("/connections/steam", { method: "DELETE" })).json()) as any).connected, false);
    assert.equal(t.hub.store.list({ kind: "game" }).length, 3, "unlinking keeps the games");
  } finally {
    t.cleanup();
  }
});

const RSS = `<?xml version="1.0"?><rss><channel><title>Letterboxd - gnome</title>
<item><title>Alien, 1979 - ★★★★½</title><link>https://letterboxd.com/gnome/film/alien/</link>
<letterboxd:watchedDate>2026-10-26</letterboxd:watchedDate><letterboxd:rewatch>Yes</letterboxd:rewatch>
<letterboxd:filmTitle>Alien</letterboxd:filmTitle><letterboxd:filmYear>1979</letterboxd:filmYear><letterboxd:memberRating>4.5</letterboxd:memberRating>
<letterboxd:memberLike>Yes</letterboxd:memberLike><tmdb:movieId>348</tmdb:movieId>
<description><![CDATA[ <p><img src="https://a.ltrbxd.com/poster.jpg"/></p> <p>Still perfect &amp; tense.</p> ]]></description></item>
<item><title>Spooky picks</title><link>https://letterboxd.com/gnome/list/spooky/</link><description>a list</description></item>
<item><title>Heat, 1995</title><link>https://letterboxd.com/gnome/film/heat/</link><letterboxd:watchedDate>2026-10-20</letterboxd:watchedDate>
<letterboxd:filmTitle>Heat</letterboxd:filmTitle><letterboxd:filmYear>1995</letterboxd:filmYear>
<description><![CDATA[ <p><img src="x"/></p> <p>Watched on Monday October 20, 2026.</p> ]]></description></item>
</channel></rss>`;

test("letterboxd: the diary feed brings films, and the next read adds new watches to the same film", async () => {
  const t = makeHub();
  try {
    assert.equal(filmsFromRss(RSS).length, 2, "the list post is not a film");
    let feed = RSS;
    t.hub.fetch = fakeFetch((u) => (u.pathname === "/gnome/rss/" ? { text: feed } : { status: 404 }));
    assert.equal((await t.api("/connections/letterboxd", { method: "PUT", json: { username: "nobody" } })).status, 422);
    const c = await (await t.api("/connections/letterboxd", { method: "PUT", json: { username: "https://letterboxd.com/gnome/" } })).json() as any;
    assert.equal(c.connection.username, "gnome");
    assert.deepEqual({ entries: c.sync.entries, created: c.sync.created, updated: c.sync.updated }, { entries: 2, created: 2, updated: 0 });
    const alien = t.hub.store.list({ kind: "film" }).find((e) => e.fields.title === "Alien")!.fields as any;
    assert.deepEqual(alien.watched_on, ["2026-10-26"]);
    assert.equal(alien.rating, 4.5);
    assert.equal(alien.liked, true);
    assert.equal(alien.review, "Still perfect & tense.");
    assert.equal(alien.tmdb_id, 348);
    const heat = t.hub.store.list({ kind: "film" }).find((e) => e.fields.title === "Heat")!.fields as any;
    assert.equal(heat.review, undefined, "\"Watched on\" is not a review");

    // The same feed again writes nothing; a rewatch in a later feed adds its date to the same film.
    assert.deepEqual(await (await t.api("/connections/letterboxd/sync", { method: "POST" })).json(), { entries: 2, created: 0, updated: 0 });
    feed = RSS.replace("2026-10-26", "2026-11-02");
    await t.api("/connections/letterboxd/sync", { method: "POST" });
    const again = t.hub.store.list({ kind: "film" }).find((e) => e.fields.title === "Alien")!.fields as any;
    assert.deepEqual(again.watched_on, ["2026-10-26", "2026-11-02"]);
    assert.equal(again.last_watched, "2026-11-02");
    assert.equal(t.hub.store.list({ kind: "film" }).length, 2);

    const year = await (await t.api("/library/films?year=2026&sort=rating")).json() as any;
    assert.deepEqual(year.films.map((f: any) => [f.title, f.times_watched]), [["Alien", 2], ["Heat", 1]]);
    assert.equal(((await (await t.api("/connections/letterboxd", { method: "DELETE" })).json()) as any).connected, false);
    assert.equal(t.hub.store.list({ kind: "film" }).length, 2, "unlinking keeps the films");
  } finally {
    t.cleanup();
  }
});

test("apple health: samples become logs once, change in place, and go when deleted in Health", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("log", { type: "weight", value: 181.4, unit: "lb", at: "2026-10-27T12:00:00Z", note: "healthkit", source: "iphone" });
    t.hub.store.create("log", { type: "weight", value: 180, unit: "lb", at: "2026-10-26T12:00:00Z", source: "iphone" });
    const samples = [
      { key: "A1B2C3D4-0000-0000-0000-000000000001", type: "weight", value: 181.4, unit: "lb", at: "2026-10-27T12:00:00Z" },
      { key: "bp:A1B2", type: "bp", value: "121/79", unit: "mmHg", at: "2026-10-27T13:00:00Z" },
      { key: "steps:2026-10-27", type: "steps", value: 6012, unit: "count", at: "2026-10-27T04:00:00Z" },
      { key: "junk", type: "nope", value: 1, at: "2026-10-27T13:00:00Z" },
    ];
    const r = await (await t.api("/imports/health", { method: "POST", json: { samples } })).json() as any;
    assert.deepEqual({ created: r.created, updated: r.updated, rejected: r.rejected, legacy: r.legacy_removed }, { created: 3, updated: 0, rejected: 1, legacy: 1 }, "the old importer's copy goes, a typed weight stays");
    const again = await (await t.api("/imports/health", { method: "POST", json: { samples: [{ ...samples[2], value: 8450 }, samples[0]] } })).json() as any;
    assert.deepEqual({ created: again.created, updated: again.updated }, { created: 0, updated: 1 }, "the day's steps grew; the weight is unchanged");
    const logs = t.hub.store.list({ kind: "log" }).filter((l) => l.fields.note === "Apple Health");
    assert.equal(logs.length, 3);
    assert.equal(t.hub.store.list({ kind: "log" }).length, 4);
    assert.equal(logs.find((l) => l.fields.type === "steps")!.fields.value, 8450);
    assert.ok(logs.every((l) => l.fields.note === "Apple Health" && l.fields.source === "iphone"));
    const gone = await (await t.api("/imports/health", { method: "POST", json: { removed: [samples[0].key] } })).json() as any;
    assert.equal(gone.deleted, 1);
    assert.equal(t.hub.store.list({ kind: "log" }).length, 3);
    const summary = await (await t.api("/health/summary")).json() as any;
    assert.equal(summary.bp.latest, "121/79");
    assert.deepEqual(summary.steps.latest, { at: "2026-10-27T04:00:00.000Z", value: 8450 });
    assert.equal(((await (await t.api("/connections")).json()) as any).health.total, 2);
    // A workout is a start and an end log, so the activity hours count it.
    const start = new Date(Date.now() - 3 * 3600_000).toISOString();
    const end = new Date(Date.now() - 2 * 3600_000).toISOString();
    await t.api("/imports/health", { method: "POST", json: { samples: [{ key: "W1", type: "activity", value: "Running", unit: "min", at: start, end }] } });
    assert.equal(((await (await t.api("/health/summary")).json()) as any).activity_hours_7d, 1);
  } finally {
    t.cleanup();
  }
});
