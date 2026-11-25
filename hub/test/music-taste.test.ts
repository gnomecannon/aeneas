import { test } from "node:test";
import assert from "node:assert/strict";
import { MUSIC_PROFILE_ID, readMusicProfile } from "@everythingapp/shared";
import { makeHub, type TestHub } from "./helpers.js";
import { MODULES, moduleDef, moduleOfKind } from "../src/modules.js";
import { availableTools, musicTasteForModel, runTool, toolGuide, type ToolContext } from "../src/ai/tools.js";
import { seedWorld } from "../scripts/sample-world.js";

// Music (module apple_music, CONTRACT.md: music_profile and Music): an iPhone, iPad or Mac reads Apple Music and writes
// one profile item; the hub keeps it within limits, and the assistant reads it with music_taste.

const profile = {
  source: "apple_music", read_at: "2026-11-25T14:02:00.000Z", device: "Robin's iPhone", subscription: true,
  library: { songs: 1204, albums: 96, artists: 120, playlists: 14 },
  top_artists: [{ name: "The Lantern Moths", plays: 412 }, { name: "Harbor Kites", plays: 1 }],
  top_songs: [{ title: "Paper Moons", artist: "The Lantern Moths", plays: 88 }],
  playlists: [{ name: "Long drive", songs: 112, own: true }, { name: "Acoustic Mornings", songs: 1, own: false }],
  recent: [{ title: "Kite Season", artist: "Harbor Kites" }],
  genres: [{ name: "Indie Rock", songs: 310 }],
};

const api = (t: TestHub) => async (method: string, p: string, body?: unknown) => {
  const r = await t.api(p, { method, json: body });
  return { status: r.status, data: await r.json() };
};
const ctxFor = (t: TestHub): ToolContext => ({ sessionId: "s", lastUser: "", topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null, moduleOn: t.hub.modules.check });
const push = (t: TestHub, fields: Record<string, unknown>, ts: string) =>
  t.api("/sync/push", { method: "POST", json: { device_id: "iphone-1", patches: [{ id: MUSIC_PROFILE_ID, kind: "music_profile", ts, create: true, fields }] } }).then((r) => r.json() as Promise<{ applied: unknown[]; rejected: { reason: string }[] }>);

test("music: Music is in Media, off for a new hub, asks Apple devices for Apple Music and owns the profile", async () => {
  const m = moduleDef("apple_music");
  assert.equal(m.title, "Music");
  assert.equal(m.group, "Media");
  assert.equal(m.default, false);
  assert.deepEqual(m.permissions, ["music"]);
  assert.deepEqual(m.kinds, ["music_profile"]);
  assert.deepEqual(m.prefixes, [], "no hub paths: devices read it");
  assert.equal(moduleOfKind("music_profile"), "apple_music");
  assert.match(m.summary, /Apple Music/);
  assert.match(m.reads ?? "", /subscription/);
  assert.match(m.reads ?? "", /stays there/);
  // Films, Games, then Music in the Library's Media area.
  assert.deepEqual(MODULES.filter((x) => x.group === "Media").map((x) => x.id), ["films", "games", "apple_music"]);

  const fresh = makeHub({ modulesPreset: "" });
  try {
    const listed = (await (await fresh.api("/modules")).json() as { modules: { id: string; group: string; on: boolean; permissions?: string[] }[] }).modules.find((x) => x.id === "apple_music");
    assert.deepEqual([listed?.group, listed?.on, listed?.permissions], ["Media", false, ["music"]]);
  } finally { fresh.cleanup(); }
});

test("music: a device's profile is kept as one item, replaced by the next read, and refused past its limits", async () => {
  const t = makeHub();
  try {
    let r = await push(t, profile, "2026-11-25T14:02:00.000Z");
    assert.equal(r.applied.length, 1);
    r = await push(t, { ...profile, device: "Robin's Mac", read_at: "2026-11-26T08:00:00.000Z", subscription: null, recent: [] }, "2026-11-26T08:00:00.000Z");
    assert.equal(r.applied.length, 1);
    const all = t.hub.store.list({ kind: "music_profile" });
    assert.equal(all.length, 1, "one profile, whichever device read it");
    assert.equal(all[0].fields.device, "Robin's Mac");
    assert.equal("subscription" in all[0].fields, false, "null clears it: not known");
    assert.deepEqual(all[0].fields.recent, []);

    r = await push(t, { ...profile, top_songs: Array.from({ length: 31 }, (_, i) => ({ title: `Song ${i}`, artist: "A", plays: 1 })) }, "2026-11-27T08:00:00.000Z");
    assert.equal(r.rejected.length, 1, "31 top songs is past the limit");
    r = await push(t, { ...profile, playlists: [{ name: "x".repeat(201), songs: 1, own: true }] }, "2026-11-27T08:00:01.000Z");
    assert.equal(r.rejected.length, 1, "a name past 200 characters");
    assert.equal(t.hub.store.get(MUSIC_PROFILE_ID)?.fields.device, "Robin's Mac", "a refused read changes nothing");
  } finally { t.cleanup(); }
});

test("music: music_taste gives the model short lines, says when none was read, and is offered only while Music is on", async () => {
  const t = makeHub();
  try {
    const a = api(t);
    let out = await runTool(a, { name: "music_taste", arguments: {} }, ctxFor(t));
    assert.equal(out.ok, false);
    assert.match(out.text, /has not been read yet/);
    assert.match(out.text, /Read Apple Music now/);

    t.hub.store.create("music_profile", profile, "personal", MUSIC_PROFILE_ID);
    out = await runTool(a, { name: "music_taste", arguments: {} }, ctxFor(t));
    assert.equal(out.ok, true);
    const v = JSON.parse(out.text) as Record<string, unknown>;
    assert.deepEqual(v.top_artists, ["The Lantern Moths: 412 plays", "Harbor Kites: 1 play"]);
    assert.deepEqual(v.top_songs, ["Paper Moons by The Lantern Moths: 88 plays"]);
    assert.deepEqual(v.playlists, ["Long drive (112 songs)", "Acoustic Mornings (1 song, from Apple Music)"]);
    assert.deepEqual(v.recently_played, ["Kite Season by Harbor Kites"]);
    assert.deepEqual(v.genres, ["Indie Rock: 310 songs"]);
    assert.equal(v.library, "1,204 songs, 96 albums, 120 artists, 14 playlists");
    assert.match(String(v.read), /^Wednesday 2026-11-25T09:02-05:00 \(.+\) on Robin's iPhone$/);

    // The assistant cannot change it; the next read would replace it anyway.
    const upd = await runTool(a, { name: "update_item", arguments: { id: MUSIC_PROFILE_ID, fields: { device: "x" } } }, ctxFor(t));
    assert.equal(upd.ok, false);
    assert.match(upd.text, /cannot be changed here/);

    // Off: no tool and no guide line.
    t.hub.modules.set({ apple_music: false });
    assert.ok(!availableTools(t.hub.cfg, undefined, t.hub.modules.check).some((x) => x.name === "music_taste"));
    assert.doesNotMatch(toolGuide(t.hub.modules.check), /music_taste|their music/);
    t.hub.modules.set({ apple_music: true });
    assert.ok(availableTools(t.hub.cfg, undefined, t.hub.modules.check).some((x) => x.name === "music_taste"));
    assert.match(toolGuide(t.hub.modules.check), /call music_taste first/);
  } finally { t.cleanup(); }
});

test("music: with no subscription the model is told why Recently played is empty, and the age reads in hours or days", () => {
  const p = readMusicProfile({ ...profile, subscription: false, recent: [] })!;
  const now = new Date("2026-11-25T15:10:00.000Z");
  assert.equal(musicTasteForModel(p, now).recently_played, "not read: that device has no Apple Music subscription");
  assert.match(String(musicTasteForModel(p, now).read), /\(an hour ago\)/);
  assert.match(String(musicTasteForModel(p, new Date("2026-11-28T15:00:00.000Z")).read), /\(3 days ago\)/);
  assert.equal(musicTasteForModel(readMusicProfile({ ...profile, subscription: null, recent: [] })!, now).recently_played, "none read");
});

test("music: the sample world has a made-up profile the hub accepts", () => {
  const t = makeHub();
  try {
    seedWorld(t.hub);
    const p = readMusicProfile(t.hub.store.get(MUSIC_PROFILE_ID)?.fields);
    assert.ok(p);
    assert.ok(p.top_artists.length > 5 && p.top_songs.length > 5 && p.playlists.some((l) => l.own) && p.recent.length > 0);
    assert.equal(p.device, "Alex's iPhone");
  } finally { t.cleanup(); }
});
