import Foundation
import MusicKit
import EACore
import os
#if canImport(UIKit)
import UIKit
#endif

/// Music (module `apple_music`; CONTRACT.md, Music): reads this device's Apple Music library with MusicKit and writes the
/// owner's taste as one synced item, which the assistant reads on the hub (`music_taste`). `MusicTaste` in EACore makes
/// the sums. It reads only on a device paired with the owner's hub (`hasHubCopy`), never in sample mode, only while
/// the hub lists Music as on and Apple Music is allowed here; nothing asks for Apple Music at launch. Nothing in Apple
/// Music is played, added or changed. The iPhone, iPad and Mac only: the Watch reads nothing.
@MainActor
final class MusicTasteReader: ObservableObject {
    static let shared = MusicTasteReader()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "music")

    enum Access: Equatable { case notAsked, allowed, denied, restricted }

    @Published private(set) var reading = false
    /// What the last read could not do, in plain words; nil after one that worked.
    @Published private(set) var problem: String?
    /// A line about the last read that is not a failure (Recently played could not be read, an empty library kept out).
    @Published private(set) var note: String?
    @Published private(set) var access: Access = MusicTasteReader.currentAccess

    static var currentAccess: Access {
        switch MusicAuthorization.currentStatus {
        case .authorized: return .allowed
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notAsked
        @unknown default: return .notAsked
        }
    }

    func refreshAccess() {
        let now = Self.currentAccess
        if access != now { access = now }
    }

    /// The Music module is on (the hub listed it as on: off on a new hub, and a hub from before it has no such module).
    func moduleOn(_ engine: SyncEngine) -> Bool { engine.config.moduleSaidOn(.appleMusic) }

    /// Whether this device reads now: paired with the owner's hub and holding its copy, not sample mode, Music on and
    /// Apple Music allowed.
    func canRead(_ engine: SyncEngine) -> Bool {
        engine.hasHubCopy && !engine.config.sampleMode && moduleOn(engine) && Self.currentAccess == .allowed
    }

    /// Ask for Apple Music (the permission screen after Music is switched on, or Allow Apple Music on the Music screen).
    /// Allowed, the library is read at once, without holding up the permission screen's next question. True when allowed.
    @discardableResult
    func requestAccess(engine: SyncEngine) async -> Bool {
        let status = await MusicAuthorization.request()
        refreshAccess()
        guard status == .authorized else { return false }
        Task { await readNow(engine: engine) }
        return true
    }

    /// At launch and on return to the app: a read when the profile is more than 12 hours old, whoever read it.
    func readIfDue(engine: SyncEngine) async {
        refreshAccess()
        guard canRead(engine), MusicTaste.isDue(MusicTaste.Profile(entity: engine.get(MusicTaste.profileId))) else { return }
        await readNow(engine: engine)
    }

    /// Read Apple Music now and write the profile. A read that fails keeps the profile there is and says why.
    func readNow(engine: SyncEngine) async {
        refreshAccess()
        guard !reading, canRead(engine) else { return }
        reading = true
        defer { reading = false }
        let device = engine.config.deviceName
        do {
            let read = try await Self.withTimeLimit(120) { try await Self.read(device: device) }
            let profile = read.profile
            let old = MusicTaste.Profile(entity: engine.get(MusicTaste.profileId))
            problem = nil
            guard MusicTaste.replaces(profile, over: old) else {
                note = "Nothing is in Apple Music on this \(Self.deviceWord), so the taste read on \(old?.device ?? "another device") stays."
                return
            }
            // A read is not something to celebrate, and it replaces every field: an update stamps past the last read
            // even when that device's clock ran ahead, so the two never mix.
            engine.beginQuiet()
            if engine.get(MusicTaste.profileId) != nil {
                _ = await engine.update(MusicTaste.profileId, fields: profile.fields)
            } else {
                _ = await engine.create(kind: .music_profile, fields: profile.fields, id: MusicTaste.profileId)
            }
            engine.endQuiet()
            note = read.recentFailed ? "Recently played could not be read this time. The rest is up to date." : nil
            Self.log.notice("read songs=\(profile.songs) playlists=\(profile.playlistCount) recent=\(profile.recent.count)")
        } catch {
            problem = Self.words(for: error)
            Self.log.notice("read failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    static var deviceWord: String {
        #if os(macOS)
        "Mac"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }

    // MARK: reading

    private struct Read: Sendable {
        var profile: MusicTaste.Profile
        /// A subscription, but Apple Music's servers did not answer for Recently played.
        var recentFailed: Bool
    }

    private struct TimedOut: Error {}

    /// The library as MusicKit gives it, then the sums in a task of their own, off the main thread.
    private nonisolated static func read(device: String) async throws -> Read {
        // Whether the account can play the catalog (a subscription). Nil when it cannot be told: no MusicKit service for
        // the app, no account, no network.
        let subscription: Bool? = try? await MusicSubscription.current.canPlayCatalogContent

        // Up to 5,000 songs, most played first.
        var request = MusicLibraryRequest<MusicKit.Song>()
        request.sort(by: \.playCount, ascending: false)
        request.limit = 500
        let first = try await request.response().items
        var songs: [MusicTaste.Song] = first.map(song)
        var batch = first
        while songs.count < MusicTaste.songsRead, batch.hasNextBatch, let next = try await batch.nextBatch(limit: min(500, MusicTaste.songsRead - songs.count)) {
            guard !next.isEmpty else { break }
            songs += next.map(song)
            batch = next
        }
        if songs.count > MusicTaste.songsRead { songs = Array(songs.prefix(MusicTaste.songsRead)) }

        let albums = try? await count(MusicLibraryRequest<MusicKit.Album>())
        let artists = try? await count(MusicLibraryRequest<MusicKit.Artist>())

        // Playlists: every one counted, the 50 kept (the owner's own first) with their song counts.
        var plRequest = MusicLibraryRequest<MusicKit.Playlist>()
        plRequest.limit = 100
        let firstLists = try await plRequest.response().items
        var playlists = Array(firstLists)
        var plBatch = firstLists
        while playlists.count < 2000, plBatch.hasNextBatch, let next = try await plBatch.nextBatch(limit: 100) {
            guard !next.isEmpty else { break }
            playlists += next
            plBatch = next
        }
        let infos = playlists.map { MusicTaste.Playlist(name: $0.name, songs: 0, own: MusicTaste.isOwn(kind: kindName($0.kind), curator: $0.curatorName)) }
        var withCounts: [MusicTaste.Playlist] = []
        let started = Date()
        for i in MusicTaste.orderedIndices(infos) {
            var p = infos[i]
            // Song counts for at most 30 seconds in all: a huge library's playlists never hold up the rest.
            if Date().timeIntervalSince(started) < 30 { p.songs = (try? await trackCount(playlists[i])) ?? 0 }
            withCounts.append(p)
        }
        let keptLists = withCounts

        // Recently played: Apple Music's servers answer it, for the account's own history, only with a subscription.
        var recent: [MusicTaste.Played] = []
        var recentFailed = false
        if subscription == true {
            do {
                var r = MusicRecentlyPlayedRequest<MusicKit.Song>()
                r.limit = MusicTaste.Limit.recent
                recent = try await r.response().items.map { MusicTaste.Played(title: $0.title, artist: $0.artistName) }
            } catch {
                recentFailed = true
            }
        }

        let readAt = Date()
        let library = songs, playlistCount = playlists.count, played = recent
        // The sums over thousands of songs run in a task of their own, never on the main thread.
        let profile = await Task.detached(priority: .utility) {
            MusicTaste.build(songs: library, albums: albums, artists: artists, playlists: keptLists, playlistCount: playlistCount,
                             recent: played, subscription: subscription, device: device, readAt: readAt)
        }.value
        return Read(profile: profile, recentFailed: recentFailed)
    }

    private nonisolated static func song(_ s: MusicKit.Song) -> MusicTaste.Song {
        MusicTaste.Song(title: s.title, artist: s.artistName, genres: s.genreNames, plays: s.playCount ?? 0)
    }

    /// MusicKit's playlist kind as its case name, for `MusicTaste.isOwn`.
    private nonisolated static func kindName(_ k: MusicKit.Playlist.Kind?) -> String? {
        switch k {
        case nil: return nil
        case .editorial?: return "editorial"
        case .external?: return "external"
        case .personalMix?: return "personalMix"
        case .replay?: return "replay"
        case .userShared?: return "userShared"
        @unknown default: return "other"
        }
    }

    /// How many items a library request finds, paged, up to 20,000.
    private nonisolated static func count<T: MusicLibraryRequestable>(_ base: MusicLibraryRequest<T>) async throws -> Int {
        var request = base
        request.limit = 500
        var batch = try await request.response().items
        var n = batch.count
        while n < 20_000, batch.hasNextBatch, let next = try await batch.nextBatch(limit: 500) {
            guard !next.isEmpty else { break }
            n += next.count
            batch = next
        }
        return n
    }

    /// A playlist's songs, counted up to 5,000.
    private nonisolated static func trackCount(_ p: MusicKit.Playlist) async throws -> Int {
        guard let tracks = try await p.with([.tracks]).tracks else { return 0 }
        var n = tracks.count
        var batch = tracks
        while n < 5000, batch.hasNextBatch, let next = try await batch.nextBatch(limit: 300) {
            guard !next.isEmpty else { break }
            n += next.count
            batch = next
        }
        return n
    }

    private nonisolated static func withTimeLimit<T: Sendable>(_ seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }

    /// What went wrong, in plain words: never MusicKit's own error text.
    static func words(for error: Error) -> String {
        if error is TimedOut { return "Reading Apple Music took too long. Try again in a moment." }
        if let e = error as? MusicTokenRequestError {
            switch e {
            case .userNotSignedIn: return "Sign in to Apple Music on this \(deviceWord) (open the Music app), then read again."
            case .privacyAcknowledgementRequired: return "Open the Music app once and accept Apple's privacy notice, then read again."
            case .permissionDenied: return "Apple Music is not allowed for Aeneas. Allow it in \(settingsPlace)."
            case .developerTokenRequestFailed: return "Apple Music is not available to Aeneas yet, so nothing was read. Try again after the next update of the app."
            default: return "Apple Music could not be read on this \(deviceWord). Try again later."
            }
        }
        if error is URLError { return "Apple Music could not be reached. Check the internet connection and read again." }
        return "Apple Music could not be read on this \(deviceWord). Try again later."
    }

    /// Where the person allows Apple Music for the app.
    static var settingsPlace: String {
        #if os(macOS)
        "System Settings, Privacy and Security, Media and Apple Music"
        #else
        "Settings, Privacy and Security, Media and Apple Music"
        #endif
    }
}
