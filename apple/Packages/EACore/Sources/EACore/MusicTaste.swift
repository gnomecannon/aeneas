import Foundation

/// Music (module `apple_music`; CONTRACT.md section 2, `music_profile`, and section 3, Music): the owner's Apple Music
/// taste. The app's `MusicTasteReader` reads the library with MusicKit on the iPhone, iPad and Mac and hands what it read
/// here, where the sums are made (off the main thread) and the one synced item is written and read back. The web's
/// `packages/shared/src/music.ts` reads the same item.
public enum MusicTaste {
    /// The one profile's id on every device: `stableId("music_profile:apple_music")` (packages/shared `MUSIC_PROFILE_ID`).
    public static let profileId = "205d6111-58d0-56ea-986f-154dad540f88"
    /// A device reads again at launch or on return to the app once the profile is this old, whoever read it.
    public static let staleAfter: TimeInterval = 12 * 3600
    /// How many library songs a device reads, most played first.
    public static let songsRead = 5000
    /// How long each list may be, and a name (the hub refuses more).
    public enum Limit {
        public static let topArtists = 30, topSongs = 30, playlists = 50, recent = 25, genres = 15, text = 200
    }

    /// One library song as MusicKit gives it.
    public struct Song: Sendable, Equatable {
        public var title: String
        public var artist: String
        public var genres: [String]
        public var plays: Int
        public init(title: String, artist: String, genres: [String] = [], plays: Int = 0) {
            self.title = title; self.artist = artist; self.genres = genres; self.plays = plays
        }
    }

    /// A name with a number: an artist's plays, a genre's songs.
    public struct Count: Sendable, Equatable {
        public var name: String
        public var count: Int
        public init(_ name: String, _ count: Int) { self.name = name; self.count = count }
    }

    public struct TopSong: Sendable, Equatable {
        public var title: String
        public var artist: String
        public var plays: Int
        public init(title: String, artist: String, plays: Int) { self.title = title; self.artist = artist; self.plays = plays }
    }

    public struct Playlist: Sendable, Equatable {
        public var name: String
        public var songs: Int
        /// The owner's own playlist, not one added from Apple Music.
        public var own: Bool
        public init(name: String, songs: Int, own: Bool) { self.name = name; self.songs = songs; self.own = own }
    }

    public struct Played: Sendable, Equatable {
        public var title: String
        public var artist: String
        public init(title: String, artist: String) { self.title = title; self.artist = artist }
    }

    /// The `music_profile` item's fields, typed.
    public struct Profile: Sendable, Equatable {
        public var readAt: String
        public var device: String
        /// Whether that device's Apple Music account could play the catalog; nil when it could not be told.
        public var subscription: Bool?
        public var songs: Int, albums: Int, artists: Int, playlistCount: Int
        public var topArtists: [Count]
        public var topSongs: [TopSong]
        public var playlists: [Playlist]
        public var recent: [Played]
        public var genres: [Count]

        public init(readAt: String, device: String, subscription: Bool?, songs: Int, albums: Int, artists: Int, playlistCount: Int,
                    topArtists: [Count] = [], topSongs: [TopSong] = [], playlists: [Playlist] = [], recent: [Played] = [], genres: [Count] = []) {
            self.readAt = readAt; self.device = device; self.subscription = subscription
            self.songs = songs; self.albums = albums; self.artists = artists; self.playlistCount = playlistCount
            self.topArtists = topArtists; self.topSongs = topSongs; self.playlists = playlists; self.recent = recent; self.genres = genres
        }

        /// Nothing in that library: no songs and no playlists.
        public var isEmpty: Bool { songs == 0 && playlistCount == 0 }

        /// The fields of the item, every one of them: each read replaces the whole profile. An unknown subscription is
        /// sent as null, which clears it on the hub.
        public var fields: [String: JSONValue] {
            func n(_ i: Int) -> JSONValue { .number(Double(i)) }
            return [
                "source": "apple_music",
                "read_at": .string(readAt),
                "device": .string(cut(device)),
                "subscription": subscription.map(JSONValue.bool) ?? .null,
                "library": .object(["songs": n(songs), "albums": n(albums), "artists": n(artists), "playlists": n(playlistCount)]),
                "top_artists": .array(topArtists.prefix(Limit.topArtists).map { .object(["name": .string(cut($0.name)), "plays": n($0.count)]) }),
                "top_songs": .array(topSongs.prefix(Limit.topSongs).map { .object(["title": .string(cut($0.title)), "artist": .string(cut($0.artist)), "plays": n($0.plays)]) }),
                "playlists": .array(playlists.prefix(Limit.playlists).map { .object(["name": .string(cut($0.name)), "songs": n($0.songs), "own": .bool($0.own)]) }),
                "recent": .array(recent.prefix(Limit.recent).map { .object(["title": .string(cut($0.title)), "artist": .string(cut($0.artist))]) }),
                "genres": .array(genres.prefix(Limit.genres).map { .object(["name": .string(cut($0.name)), "songs": n($0.count)]) }),
            ]
        }

        /// Read back from an item's fields; nil without a read time or library counts. A damaged list reads as empty.
        public init?(fields f: [String: JSONValue]) {
            guard let readAt = f["read_at"]?.stringValue, let lib = f["library"]?.objectValue else { return nil }
            func int(_ v: JSONValue?) -> Int? { v?.doubleValue.map { Int($0) } }
            guard let songs = int(lib["songs"]), let albums = int(lib["albums"]), let artists = int(lib["artists"]), let playlists = int(lib["playlists"]) else { return nil }
            func rows(_ key: String) -> [[String: JSONValue]] { f[key]?.arrayValue?.compactMap(\.objectValue) ?? [] }
            self.init(
                readAt: readAt, device: f["device"]?.stringValue ?? "", subscription: f["subscription"]?.boolValue,
                songs: songs, albums: albums, artists: artists, playlistCount: playlists,
                topArtists: rows("top_artists").compactMap { r in r["name"]?.stringValue.map { Count($0, int(r["plays"]) ?? 0) } },
                topSongs: rows("top_songs").compactMap { r in r["title"]?.stringValue.map { TopSong(title: $0, artist: r["artist"]?.stringValue ?? "", plays: int(r["plays"]) ?? 0) } },
                playlists: rows("playlists").compactMap { r in r["name"]?.stringValue.map { Playlist(name: $0, songs: int(r["songs"]) ?? 0, own: r["own"]?.boolValue ?? false) } },
                recent: rows("recent").compactMap { r in r["title"]?.stringValue.map { Played(title: $0, artist: r["artist"]?.stringValue ?? "") } },
                genres: rows("genres").compactMap { r in r["name"]?.stringValue.map { Count($0, int(r["songs"]) ?? 0) } }
            )
        }

        /// The synced profile item, unless it is missing or deleted.
        public init?(entity: Entity?) {
            guard let e = entity, e.kind == .music_profile, !e.isDeleted else { return nil }
            self.init(fields: e.fields)
        }
    }

    // MARK: sums

    /// The whole profile from what a device read: the sums, the order and the limits.
    /// `albums` and `artists` are the library's own counts when MusicKit gave them, else counted from the songs read.
    public static func build(songs: [Song], albums: Int?, artists: Int?, playlists: [Playlist], playlistCount: Int? = nil, recent: [Played],
                             subscription: Bool?, device: String, readAt: Date) -> Profile {
        let named = songs.filter { !$0.artist.trimmingCharacters(in: .whitespaces).isEmpty }
        let distinctArtists = Set(named.map { key($0.artist) }).count
        return Profile(
            readAt: ISO.string(readAt), device: device, subscription: subscription,
            songs: songs.count, albums: albums ?? 0, artists: artists ?? distinctArtists, playlistCount: playlistCount ?? playlists.count,
            topArtists: topArtists(songs), topSongs: topSongs(songs), playlists: ordered(playlists),
            recent: Array(dedupe(recent).prefix(Limit.recent)), genres: genres(songs)
        )
    }

    /// Artists by the play counts of their library songs summed, most played first. A library with no play counts at
    /// all (a new one, or counts MusicKit did not give) ranks them by how many songs they have.
    public static func topArtists(_ songs: [Song]) -> [Count] {
        var plays: [String: Int] = [:], tracks: [String: Int] = [:], name: [String: String] = [:]
        for s in songs {
            let a = s.artist.trimmingCharacters(in: .whitespaces)
            guard !a.isEmpty else { continue }
            let k = key(a)
            if name[k] == nil { name[k] = a }
            plays[k, default: 0] += max(0, s.plays)
            tracks[k, default: 0] += 1
        }
        let anyPlays = plays.values.contains { $0 > 0 }
        let keys = name.keys.filter { !anyPlays || plays[$0, default: 0] > 0 }
        let sorted = keys.sorted { a, b in
            let pa = plays[a, default: 0], pb = plays[b, default: 0]
            if pa != pb { return pa > pb }
            let ta = tracks[a, default: 0], tb = tracks[b, default: 0]
            if ta != tb { return ta > tb }
            return name[a]!.localizedCaseInsensitiveCompare(name[b]!) == .orderedAscending
        }
        return sorted.prefix(Limit.topArtists).map { Count(name[$0]!, plays[$0, default: 0]) }
    }

    /// Songs played at least once, most played first; the same song twice in the library (two albums) counts once.
    public static func topSongs(_ songs: [Song]) -> [TopSong] {
        var by: [String: TopSong] = [:]
        var order: [String] = []
        for s in songs where s.plays > 0 && !s.title.trimmingCharacters(in: .whitespaces).isEmpty {
            let k = "\(key(s.title))\u{1f}\(key(s.artist))"
            if var t = by[k] { t.plays += s.plays; by[k] = t } else { by[k] = TopSong(title: cut(s.title), artist: cut(s.artist), plays: s.plays); order.append(k) }
        }
        let sorted = order.compactMap { by[$0] }.sorted { a, b in
            a.plays != b.plays ? a.plays > b.plays : a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
        }
        return Array(sorted.prefix(Limit.topSongs))
    }

    /// Genres by how many library songs carry them, most first. "Music", Apple's genre above every other, is left out.
    public static func genres(_ songs: [Song]) -> [Count] {
        var count: [String: Int] = [:], name: [String: String] = [:]
        for s in songs {
            for g in Set(s.genres.map { $0.trimmingCharacters(in: .whitespaces) }) where !g.isEmpty && key(g) != "music" {
                let k = key(g)
                if name[k] == nil { name[k] = g }
                count[k, default: 0] += 1
            }
        }
        let sorted = count.keys.sorted { a, b in
            count[a]! != count[b]! ? count[a]! > count[b]! : name[a]!.localizedCaseInsensitiveCompare(name[b]!) == .orderedAscending
        }
        return sorted.prefix(Limit.genres).map { Count(name[$0]!, count[$0]!) }
    }

    /// The owner's own playlists first, then the ones added from Apple Music, each by name; cut to the limit.
    public static func ordered(_ playlists: [Playlist]) -> [Playlist] {
        orderedIndices(playlists).map { Playlist(name: cut(playlists[$0].name), songs: playlists[$0].songs, own: playlists[$0].own) }
    }

    /// Where the playlists `ordered` keeps are in the list given, in its order: for a reader that has more to fetch
    /// for each one it keeps (its song count). One with no name is left out.
    public static func orderedIndices(_ playlists: [Playlist]) -> [Int] {
        let named = playlists.indices.filter { !cut(playlists[$0].name).isEmpty }
        let sorted = named.sorted { i, j in
            let a = playlists[i], b = playlists[j]
            if a.own != b.own { return a.own }
            let c = cut(a.name).localizedCaseInsensitiveCompare(cut(b.name))
            return c == .orderedSame ? i < j : c == .orderedAscending
        }
        return Array(sorted.prefix(Limit.playlists))
    }

    /// Whether a library playlist is the owner's own, from MusicKit's `Playlist.kind` (its case name, nil when it gives
    /// none) and `curatorName`: Apple's own lists (editorial, personal mixes, Replay, external) are not, nor one someone
    /// else shares under their name. A playlist the owner made has no kind, or is shared by them, with no curator.
    public static func isOwn(kind: String?, curator: String?) -> Bool {
        guard kind == nil || kind == "userShared" else { return false }
        return (curator ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The same song played twice in a row is listed once, in the order it was first played.
    static func dedupe(_ played: [Played]) -> [Played] {
        var seen = Set<String>()
        return played.filter { p in
            !p.title.trimmingCharacters(in: .whitespaces).isEmpty && seen.insert("\(key(p.title))\u{1f}\(key(p.artist))").inserted
        }.map { Played(title: cut($0.title), artist: cut($0.artist)) }
    }

    static func key(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }

    /// A name cut to what the hub takes: 200 UTF-16 units (JavaScript's length), whole characters only.
    public static func cut(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.utf16.count > Limit.text else { return t }
        var out = ""
        for c in t {
            if out.utf16.count + String(c).utf16.count > Limit.text { break }
            out.append(c)
        }
        return out
    }

    // MARK: when to read

    /// Read at launch or on return to the app: never read, or read more than 12 hours ago (on any device).
    public static func isDue(_ p: Profile?, now: Date = Date()) -> Bool {
        guard let p, let at = ISO.date(p.readAt) else { return true }
        return now.timeIntervalSince(at) >= staleAfter
    }

    /// Whether a read replaces the profile there is: always, but for an empty library replacing one another device read
    /// with something in it (an iPad with no Apple Music must not wipe the iPhone's taste).
    public static func replaces(_ new: Profile, over old: Profile?) -> Bool {
        guard let old, new.isEmpty, !old.isEmpty else { return true }
        return old.device == new.device
    }

    // MARK: words

    /// The Library row's line (packages/shared `musicLibraryLine`).
    public static func libraryLine(_ p: Profile?) -> String {
        guard let p else { return "Not read yet" }
        return "\(plural(p.artists, "artist", "artists")), \(plural(p.playlistCount, "playlist", "playlists"))"
    }

    /// "1,204 songs, 96 albums, 120 artists, 14 playlists" (packages/shared `musicCountsLine`).
    public static func countsLine(_ p: Profile) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        func n(_ v: Int, _ one: String, _ many: String) -> String { "\(f.string(from: NSNumber(value: v)) ?? String(v)) \(v == 1 ? one : many)" }
        return [n(p.songs, "song", "songs"), n(p.albums, "album", "albums"), n(p.artists, "artist", "artists"), n(p.playlistCount, "playlist", "playlists")].joined(separator: ", ")
    }

    /// "Read on Alex's iPhone, 2 hours ago".
    public static func readLine(_ p: Profile, now: Date = Date()) -> String {
        let device = p.device.isEmpty ? "an Apple device" : p.device
        guard let at = ISO.date(p.readAt) else { return "Read on \(device)" }
        return "Read on \(device), \(ago(at, now: now))"
    }

    /// "just now", "5 minutes ago", "an hour ago", "3 hours ago", "yesterday", "4 days ago".
    public static func ago(_ at: Date, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince(at))
        switch s {
        case ..<60: return "just now"
        case ..<120: return "a minute ago"
        case ..<3600: return "\(Int(s / 60)) minutes ago"
        case ..<7200: return "an hour ago"
        case ..<86_400: return "\(Int(s / 3600)) hours ago"
        case ..<172_800: return "yesterday"
        default: return "\(Int(s / 86_400)) days ago"
        }
    }

    /// With no subscription the profile has no Recently played (packages/shared `MUSIC_NO_SUBSCRIPTION`).
    public static let noSubscription = "Recently played needs an Apple Music subscription, so it is left out."

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
}
