import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MUSIC_NONE_HERE, MUSIC_NO_SUBSCRIPTION, readMusicProfile } from "@everythingapp/shared";
import { MusicTaste, readWhen } from "./Listening";
import { AREAS } from "../components/Shell";
import { moduleOfScreen } from "../lib/modules";
import { linkFor } from "../lib/links";
import { PERMISSION_NAMES } from "./settings/Modules";

const now = new Date(2026, 10, 25, 16, 0);
const profile = readMusicProfile({
  source: "apple_music", read_at: new Date(2026, 10, 25, 9, 15).toISOString(), device: "Robin's iPhone", subscription: true,
  library: { songs: 1204, albums: 96, artists: 120, playlists: 14 },
  top_artists: Array.from({ length: 12 }, (_, i) => ({ name: `Band ${i + 1}`, plays: 100 - i })),
  top_songs: [{ title: "Paper Moons", artist: "The Lantern Moths", plays: 1 }],
  playlists: [{ name: "Acoustic Mornings", songs: 50, own: false }, { name: "Long drive", songs: 112, own: true }],
  recent: [{ title: "Kite Season", artist: "Harbor Kites" }],
  genres: [{ name: "Folk", songs: 204 }],
})!;
const draw = (p: typeof profile | null) => renderToStaticMarkup(createElement(MusicTaste, { profile: p, now }));

describe("Music screen", () => {
  it("with no profile says to turn Music on on an Apple device", () => {
    const html = draw(null);
    expect(html).toContain("<h1");
    expect(html).toContain(MUSIC_NONE_HERE);
    expect(html).not.toContain("Top artists");
  });

  it("shows where and when it was read, the counts, and short lists with the rest behind a button", () => {
    const html = draw(profile);
    expect(html).toContain("From Apple Music on Robin&#x27;s iPhone, today at");
    expect(html).toContain("1,204 songs, 96 albums, 120 artists, 14 playlists");
    expect(html.match(/<li>Band \d+/g)).toHaveLength(10);
    expect(html).toContain("Show all 12");
    expect(html).toContain("Paper Moons <span class=\"muted\">by The Lantern Moths</span><span class=\"muted\"> 1 play</span>");
    // The owner's own playlists first.
    expect(html.indexOf("Long drive")).toBeLessThan(html.indexOf("Acoustic Mornings"));
    expect(html).toContain("50 songs, from Apple Music");
    expect(html).toContain('aria-label="Recently played"');
    expect(html).toContain("Folk");
    expect(html).not.toContain(MUSIC_NO_SUBSCRIPTION);
  });

  it("without a subscription keeps the profile, leaves out Recently played and says why", () => {
    const html = draw({ ...profile, subscription: false, recent: [] });
    expect(html).toContain(MUSIC_NO_SUBSCRIPTION);
    expect(html).not.toContain('aria-label="Recently played"');
    expect(html).toContain("Top artists");
  });

  it("says when in words", () => {
    expect(readWhen(new Date(2026, 10, 25, 9, 15).toISOString(), now)).toMatch(/^today at /);
    expect(readWhen(new Date(2026, 10, 24, 22, 0).toISOString(), now)).toMatch(/^yesterday at /);
    expect(readWhen(new Date(2026, 10, 20, 8, 0).toISOString(), now)).toMatch(/^Nov 20 at /);
  });

  it("is Music in the Media area, after Films and Games, the Apple Music module's screen", () => {
    expect(AREAS.find((a) => a.title === "Media")?.items.map((i) => i.label)).toEqual(["Films", "Games", "Music"]);
    expect(moduleOfScreen("/listening")).toBe("apple_music");
    expect(linkFor("music_profile", "x")).toBe("#/listening");
    expect(PERMISSION_NAMES.music).toBe("Apple Music");
    // Plain words: no dashes in what the screen says.
    const source = fs.readFileSync(path.join(__dirname, "Listening.tsx"), "utf8");
    expect(source).not.toMatch(/[–—]/);
  });
});
