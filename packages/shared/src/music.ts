import { z } from "zod";

/**
 * Music (module `apple_music`, CONTRACT.md section 2, `music_profile`, and section 3, Music): the owner's Apple Music
 * taste, read on an iPhone, iPad or Mac with MusicKit (EACore `MusicTaste`, the app's `MusicTasteReader`) and kept as
 * one synced item. The web, Windows and Android apps and the assistant's `music_taste` tool read it from here.
 */

/** The one profile's id, the same on every device: `stableId("music_profile:apple_music")`. */
export const MUSIC_PROFILE_ID = "205d6111-58d0-56ea-986f-154dad540f88";

/** How long each list may be, how long a name may be, and how many library songs a device reads. */
export const MUSIC_LIMITS = { topArtists: 30, topSongs: 30, playlists: 50, recent: 25, genres: 15, text: 200, songsRead: 5000 } as const;

const text = z.string().max(MUSIC_LIMITS.text);
const count = z.number().int().min(0).max(100_000_000);

export const MusicProfileFields = z.object({
  source: z.enum(["apple_music"]),
  read_at: z.string().min(10).max(40).refine((s) => Number.isFinite(Date.parse(s)), "read_at is not a date and time"),
  device: text,
  /** Whether that device's Apple Music account could play the catalog; absent or null when it could not be told. */
  subscription: z.boolean().nullable().optional(),
  library: z.object({ songs: count, albums: count, artists: count, playlists: count }),
  top_artists: z.array(z.object({ name: text, plays: count })).max(MUSIC_LIMITS.topArtists).default([]),
  top_songs: z.array(z.object({ title: text, artist: text, plays: count })).max(MUSIC_LIMITS.topSongs).default([]),
  playlists: z.array(z.object({ name: text, songs: count, own: z.boolean() })).max(MUSIC_LIMITS.playlists).default([]),
  recent: z.array(z.object({ title: text, artist: text })).max(MUSIC_LIMITS.recent).default([]),
  genres: z.array(z.object({ name: text, songs: count })).max(MUSIC_LIMITS.genres).default([]),
});
export type MusicProfile = z.infer<typeof MusicProfileFields>;

/**
 * The profile from an item's fields as stored (a synced copy, a hub row), or null when it is not one: a damaged list
 * is left empty rather than dropping the whole profile.
 */
export function readMusicProfile(fields: unknown): MusicProfile | null {
  if (!fields || typeof fields !== "object") return null;
  const f = fields as Record<string, unknown>;
  const lib = MusicProfileFields.shape.library.safeParse(f.library);
  if (typeof f.read_at !== "string" || !lib.success) return null;
  const list = <T>(schema: z.ZodType<T[]>, v: unknown): T[] => {
    const r = schema.safeParse(v);
    return r.success ? r.data : [];
  };
  return {
    source: "apple_music",
    read_at: f.read_at,
    device: typeof f.device === "string" ? f.device : "",
    subscription: typeof f.subscription === "boolean" ? f.subscription : null,
    library: lib.data,
    top_artists: list(MusicProfileFields.shape.top_artists.unwrap(), f.top_artists),
    top_songs: list(MusicProfileFields.shape.top_songs.unwrap(), f.top_songs),
    playlists: list(MusicProfileFields.shape.playlists.unwrap(), f.playlists),
    recent: list(MusicProfileFields.shape.recent.unwrap(), f.recent),
    genres: list(MusicProfileFields.shape.genres.unwrap(), f.genres),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The Library row's line: "120 artists, 14 playlists", or "Not read yet". EACore `MusicTaste.libraryLine` says the same. */
export function musicLibraryLine(p: MusicProfile | null): string {
  if (!p) return "Not read yet";
  return `${plural(p.library.artists, "artist", "artists")}, ${plural(p.library.playlists, "playlist", "playlists")}`;
}

/** The library counts in words: "1,204 songs, 96 albums, 120 artists, 14 playlists". */
export function musicCountsLine(p: MusicProfile): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const l = p.library;
  return [`${n(l.songs)} ${l.songs === 1 ? "song" : "songs"}`, `${n(l.albums)} ${l.albums === 1 ? "album" : "albums"}`, `${n(l.artists)} ${l.artists === 1 ? "artist" : "artists"}`, `${n(l.playlists)} ${l.playlists === 1 ? "playlist" : "playlists"}`].join(", ");
}

/** What every screen says with no subscription: the profile is there, without Recently played. */
export const MUSIC_NO_SUBSCRIPTION = "Recently played needs an Apple Music subscription, so it is left out.";
/** The web, Windows and Android apps with no profile yet. */
export const MUSIC_NONE_HERE = "Turn on Music on your iPhone, iPad or Mac to bring your Apple Music taste here.";
