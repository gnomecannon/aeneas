import XCTest
@testable import EACore

/// Music (module apple_music): the sums a device makes from its Apple Music library, the item it writes, and when it
/// reads. Every artist and song here is made up.
final class MusicTasteTests: XCTestCase {
    private let now = ISO.date("2026-11-25T15:00:00.000Z")!

    private var library: [MusicTaste.Song] {
        [
            .init(title: "Paper Moons", artist: "The Lantern Moths", genres: ["Indie Rock", "Music"], plays: 88),
            .init(title: "Moth Hour", artist: "The Lantern Moths", genres: ["Indie Rock", "Music"], plays: 38),
            .init(title: "Tidewater", artist: "Copper Tide Collective", genres: ["Folk", "Music"], plays: 120),
            .init(title: "Kite Season", artist: "Harbor Kites", genres: ["Folk"], plays: 2),
            .init(title: "Never Played", artist: "Quiet Garden", genres: ["Ambient"], plays: 0),
            .init(title: "Paper Moons", artist: "the lantern moths", genres: ["Indie Rock"], plays: 4),
            .init(title: "No Artist", artist: " ", genres: [], plays: 9),
        ]
    }

    func testTopArtistsSumTheirSongsPlaysAndLeaveOutArtistsNeverPlayed() {
        let top = MusicTaste.topArtists(library)
        XCTAssertEqual(top, [.init("The Lantern Moths", 130), .init("Copper Tide Collective", 120), .init("Harbor Kites", 2)],
                       "the same artist written two ways is one; an artist never played and a song with no artist are left out")
        // A library with no play counts at all ranks artists by their songs.
        let unplayed = library.map { MusicTaste.Song(title: $0.title, artist: $0.artist, genres: $0.genres, plays: 0) }
        XCTAssertEqual(MusicTaste.topArtists(unplayed).first, .init("The Lantern Moths", 0))
        XCTAssertEqual(MusicTaste.topArtists(unplayed).count, 4)
        // At most 30.
        let many = (0..<45).map { MusicTaste.Song(title: "Song \($0)", artist: "Band \($0)", plays: $0 + 1) }
        XCTAssertEqual(MusicTaste.topArtists(many).count, 30)
        XCTAssertEqual(MusicTaste.topArtists(many).first, .init("Band 44", 45))
    }

    func testTopSongsArePlayedSongsMostPlayedFirstWithCopiesCountedOnce() {
        let top = MusicTaste.topSongs(library)
        XCTAssertEqual(top.map(\.title), ["Tidewater", "Paper Moons", "Moth Hour", "No Artist", "Kite Season"])
        XCTAssertEqual(top[1].plays, 92, "the same song on two albums: one line, plays summed")
        XCTAssertFalse(top.contains { $0.title == "Never Played" })
    }

    func testGenresCountSongsAndLeaveOutAppleCatchAllMusic() {
        XCTAssertEqual(MusicTaste.genres(library), [.init("Indie Rock", 3), .init("Folk", 2), .init("Ambient", 1)])
        let many = (0..<20).map { MusicTaste.Song(title: "s", artist: "a", genres: ["Genre \($0)"]) }
        XCTAssertEqual(MusicTaste.genres(many).count, 15)
    }

    func testOwnPlaylistsComeFirstAndAppleListsAreNotOwn() {
        XCTAssertTrue(MusicTaste.isOwn(kind: nil, curator: nil))
        XCTAssertTrue(MusicTaste.isOwn(kind: "userShared", curator: ""))
        XCTAssertFalse(MusicTaste.isOwn(kind: "userShared", curator: "A friend"))
        XCTAssertFalse(MusicTaste.isOwn(kind: "editorial", curator: "Apple Music"))
        XCTAssertFalse(MusicTaste.isOwn(kind: "personalMix", curator: nil))
        XCTAssertFalse(MusicTaste.isOwn(kind: "replay", curator: nil))
        XCTAssertFalse(MusicTaste.isOwn(kind: nil, curator: "Apple Music Indie"))
        let lists = MusicTaste.ordered([
            .init(name: "Acoustic Mornings", songs: 50, own: false), .init(name: "long drive", songs: 112, own: true),
            .init(name: "Bouldering", songs: 45, own: true), .init(name: " ", songs: 1, own: true),
        ])
        XCTAssertEqual(lists.map(\.name), ["Bouldering", "long drive", "Acoustic Mornings"])
        // Where those are in the list as read, for the reader that fetches each kept one's song count.
        XCTAssertEqual(MusicTaste.orderedIndices([
            .init(name: "Acoustic Mornings", songs: 0, own: false), .init(name: "long drive", songs: 0, own: true),
            .init(name: "Bouldering", songs: 0, own: true), .init(name: " ", songs: 0, own: true), .init(name: "Bouldering", songs: 0, own: true),
        ]), [2, 4, 1, 0], "two of the same name keep their order")
        XCTAssertEqual(MusicTaste.ordered((0..<80).map { .init(name: "List \($0)", songs: 1, own: true) }).count, 50)
    }

    func testTheProfileGoesToTheItemAndComesBackTheSame() throws {
        let p = MusicTaste.build(songs: library, albums: 3, artists: nil, playlists: [.init(name: "Long drive", songs: 112, own: true)],
                                 recent: [.init(title: "Kite Season", artist: "Harbor Kites"), .init(title: "Kite Season", artist: "Harbor Kites"), .init(title: "Tidewater", artist: "Copper Tide Collective")],
                                 subscription: true, device: "Robin's iPhone", readAt: now)
        XCTAssertEqual(p.songs, 7)
        XCTAssertEqual(p.artists, 4, "counted from the songs when MusicKit gave no count")
        XCTAssertEqual(p.recent.map(\.title), ["Kite Season", "Tidewater"], "played twice in a row: once")
        let f = p.fields
        XCTAssertEqual(f["source"], "apple_music")
        XCTAssertEqual(f["read_at"]?.stringValue, "2026-11-25T15:00:00.000Z")
        XCTAssertEqual(f["library"]?.objectValue?["playlists"], 1)
        XCTAssertEqual(MusicTaste.Profile(fields: f), p)
        // Through JSON, as the hub and the web read it.
        let json = try JSONCoding.string(JSONValue.object(f))
        let back = try JSONCoding.decode(JSONValue.self, from: json)
        XCTAssertEqual(MusicTaste.Profile(fields: back.objectValue ?? [:]), p)

        // An unknown subscription is sent as null, which clears it on the hub.
        var unknown = p
        unknown.subscription = nil
        XCTAssertEqual(unknown.fields["subscription"], .null)
        XCTAssertNil(MusicTaste.Profile(fields: unknown.fields)?.subscription)
        XCTAssertNil(MusicTaste.Profile(fields: ["read_at": "2026-11-25T15:00:00.000Z"]), "no library counts: not a profile")

        let e = Entity(id: MusicTaste.profileId, kind: .music_profile, fields: f)
        XCTAssertEqual(MusicTaste.Profile(entity: e), p)
        XCTAssertNil(MusicTaste.Profile(entity: Entity(id: MusicTaste.profileId, kind: .music_profile, deleted_at: ISO.string(now), fields: f)))
        XCTAssertEqual(AppModule.of(kind: .music_profile), .appleMusic)
    }

    func testNamesAreCutToWhatTheHubTakes() {
        XCTAssertEqual(MusicTaste.cut(String(repeating: "a", count: 250)).count, 200)
        // An emoji is two UTF-16 units: never cut in half.
        let cut = MusicTaste.cut(String(repeating: "\u{1F3B5}", count: 150))
        XCTAssertEqual(cut.utf16.count, 200)
        XCTAssertEqual(cut.count, 100)
        let long = MusicTaste.Profile(readAt: "2026-11-25T15:00:00.000Z", device: String(repeating: "d", count: 300), subscription: nil, songs: 0, albums: 0, artists: 0, playlistCount: 0,
                                      topArtists: (0..<40).map { .init("Band \($0)", 1) })
        XCTAssertEqual(long.fields["device"]?.stringValue?.count, 200)
        XCTAssertEqual(long.fields["top_artists"]?.arrayValue?.count, 30)
    }

    func testAReadIsDueAfterTwelveHoursAndAnEmptyLibraryNeverWipesAnotherDevicesTaste() {
        XCTAssertTrue(MusicTaste.isDue(nil, now: now))
        let fresh = MusicTaste.Profile(readAt: ISO.string(now.addingTimeInterval(-3600)), device: "Robin's iPhone", subscription: true, songs: 10, albums: 1, artists: 1, playlistCount: 1)
        XCTAssertFalse(MusicTaste.isDue(fresh, now: now))
        var old = fresh
        old.readAt = ISO.string(now.addingTimeInterval(-13 * 3600))
        XCTAssertTrue(MusicTaste.isDue(old, now: now))

        let emptyIPad = MusicTaste.Profile(readAt: ISO.string(now), device: "Robin's iPad", subscription: nil, songs: 0, albums: 0, artists: 0, playlistCount: 0)
        XCTAssertFalse(MusicTaste.replaces(emptyIPad, over: fresh))
        XCTAssertTrue(MusicTaste.replaces(emptyIPad, over: nil))
        var emptyPhone = emptyIPad
        emptyPhone.device = "Robin's iPhone"
        XCTAssertTrue(MusicTaste.replaces(emptyPhone, over: fresh), "the same device emptied its own library")
        XCTAssertTrue(MusicTaste.replaces(fresh, over: emptyIPad))
    }

    func testTheWordsMatchTheWebAndTheLibraryLine() {
        let p = MusicTaste.Profile(readAt: ISO.string(now.addingTimeInterval(-7200)), device: "Robin's Mac", subscription: false, songs: 1204, albums: 96, artists: 120, playlistCount: 14)
        XCTAssertEqual(MusicTaste.libraryLine(p), "120 artists, 14 playlists")
        XCTAssertEqual(MusicTaste.libraryLine(nil), "Not read yet")
        XCTAssertEqual(MusicTaste.countsLine(p), "1,204 songs, 96 albums, 120 artists, 14 playlists")
        XCTAssertEqual(MusicTaste.readLine(p, now: now), "Read on Robin's Mac, 2 hours ago")
        XCTAssertEqual(MusicTaste.ago(now.addingTimeInterval(-30), now: now), "just now")
        XCTAssertEqual(MusicTaste.ago(now.addingTimeInterval(-3700), now: now), "an hour ago")
        XCTAssertEqual(MusicTaste.ago(now.addingTimeInterval(-30 * 3600), now: now), "yesterday")
        XCTAssertEqual(MusicTaste.ago(now.addingTimeInterval(-4 * 86_400), now: now), "4 days ago")
    }

    func testMusicAsksForAppleMusicOnTheIPhoneIPadAndMacOnly() {
        let modules = [ModuleInfo(id: "apple_music", title: "Music", group: "Media", on: true, permissions: ["music"])]
        XCTAssertEqual(PermissionPlan.needs(modules, platform: .iphone).map(\.permission), [.music])
        XCTAssertEqual(PermissionPlan.needs(modules, platform: .ipad).map(\.permission), [.music])
        XCTAssertEqual(PermissionPlan.needs(modules, platform: .mac).map(\.permission), [.music])
        XCTAssertEqual(PermissionPlan.needs(modules, platform: .watch).map(\.permission), [])
        // A hub that does not say what it asks for: the same, from the fallback.
        XCTAssertEqual(PermissionPlan.needs([ModuleInfo(id: "apple_music", title: "Music", on: true)], platform: .iphone).map(\.permission), [.music])
        XCTAssertEqual(PermissionPlan.needs([ModuleInfo(id: "apple_music", title: "Music", on: false, permissions: ["music"])], platform: .iphone), [])
        XCTAssertEqual(DevicePermission.music.title, "Apple Music")
        XCTAssertFalse(DevicePermission.music.purpose.contains("\u{2014}"))
        // Off on a new hub: the app reads and shows it only once the hub lists it as on.
        XCTAssertFalse([ModuleInfo]().isOnListed(.appleMusic))
        XCTAssertTrue(modules.isOnListed(.appleMusic))
    }
}
