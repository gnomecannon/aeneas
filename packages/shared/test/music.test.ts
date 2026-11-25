import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FieldsByKind, Kind, MUSIC_LIMITS, MUSIC_NO_SUBSCRIPTION, MUSIC_PROFILE_ID, MusicProfileFields, musicCountsLine, musicLibraryLine, readMusicProfile } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const profile = {
  source: "apple_music", read_at: "2026-11-25T14:02:00.000Z", device: "Alex's iPhone", subscription: true,
  library: { songs: 1204, albums: 96, artists: 120, playlists: 14 },
  top_artists: [{ name: "The Lantern Moths", plays: 412 }],
  top_songs: [{ title: "Paper Moons", artist: "The Lantern Moths", plays: 88 }],
  playlists: [{ name: "Road trip", songs: 42, own: true }],
  recent: [{ title: "Kite Season", artist: "Harbor Kites" }],
  genres: [{ name: "Indie Rock", songs: 310 }],
};

test("music: a profile is a kind of its own, with the one id every device writes", () => {
  assert.ok(Kind.options.includes("music_profile"));
  assert.equal(FieldsByKind.music_profile, MusicProfileFields);
  assert.match(MUSIC_PROFILE_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The contract and the Apple apps name the same id.
  assert.ok(fs.readFileSync(path.join(here, "../CONTRACT.md"), "utf8").includes(MUSIC_PROFILE_ID));
  const swift = fs.readFileSync(path.join(here, "../../../apple/Packages/EACore/Sources/EACore/MusicTaste.swift"), "utf8");
  assert.ok(swift.includes(`"${MUSIC_PROFILE_ID}"`));
  // And say the same words.
  assert.ok(swift.includes(`"${MUSIC_NO_SUBSCRIPTION}"`));
  assert.ok(swift.includes('"Not read yet"'));
});

test("music: the hub takes a profile within the limits and refuses longer lists and names", () => {
  assert.equal(MusicProfileFields.safeParse(profile).success, true);
  assert.equal(MusicProfileFields.safeParse({ ...profile, subscription: undefined }).success, true, "a subscription that could not be told");
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Artist ${i}`, plays: n - i }));
  assert.equal(MusicProfileFields.safeParse({ ...profile, top_artists: many(MUSIC_LIMITS.topArtists) }).success, true);
  assert.equal(MusicProfileFields.safeParse({ ...profile, top_artists: many(MUSIC_LIMITS.topArtists + 1) }).success, false);
  assert.equal(MusicProfileFields.safeParse({ ...profile, recent: Array.from({ length: 26 }, () => ({ title: "x", artist: "y" })) }).success, false);
  assert.equal(MusicProfileFields.safeParse({ ...profile, device: "x".repeat(201) }).success, false);
  assert.equal(MusicProfileFields.safeParse({ ...profile, read_at: "yesterday!!" }).success, false);
  assert.equal(MusicProfileFields.safeParse({ ...profile, source: "spotify" }).success, false);
  assert.equal(MusicProfileFields.safeParse({ ...profile, library: { songs: -1, albums: 0, artists: 0, playlists: 0 } }).success, false);
});

test("music: a stored profile reads back, a damaged list is left empty, and anything else is no profile", () => {
  assert.deepEqual(readMusicProfile(profile), profile);
  const damaged = readMusicProfile({ ...profile, top_songs: "not a list", subscription: "yes" });
  assert.deepEqual(damaged?.top_songs, []);
  assert.equal(damaged?.subscription, null);
  assert.deepEqual(damaged?.top_artists, profile.top_artists);
  assert.equal(readMusicProfile(null), null);
  assert.equal(readMusicProfile({ read_at: "2026-11-25T14:02:00.000Z" }), null, "no library counts");
});

test("music: the Library line and the counts line", () => {
  const p = readMusicProfile(profile);
  assert.equal(musicLibraryLine(p), "120 artists, 14 playlists");
  assert.equal(musicLibraryLine(readMusicProfile({ ...profile, library: { songs: 1, albums: 1, artists: 1, playlists: 1 } })), "1 artist, 1 playlist");
  assert.equal(musicLibraryLine(null), "Not read yet");
  assert.equal(musicCountsLine(p!), "1,204 songs, 96 albums, 120 artists, 14 playlists");
});
