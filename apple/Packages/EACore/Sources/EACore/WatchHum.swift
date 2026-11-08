import Foundation

/// A hum recorded on the Watch. It goes to the iPhone as a WatchConnectivity file transfer with this as the
/// transfer's metadata, so WatchConnectivity keeps it queued until the iPhone is in reach. The iPhone sends it to
/// the hub (`POST /music/hum?from=capture`) and answers with a `WatchHumResult`.
public struct WatchHum: Codable, Equatable, Sendable {
    /// The metadata `kind` that marks a file transfer as a hum.
    public static let kind = "hum"
    /// The longest hum the Watch records: short enough to send over Bluetooth in a few seconds.
    public static let maxSeconds: TimeInterval = 60

    public var id: String
    public var mode: HumMidi.Mode
    public var seconds: Double
    public var recordedAt: Date

    public init(id: String = UUID().uuidString.lowercased(), mode: HumMidi.Mode, seconds: Double, recordedAt: Date = Date()) {
        self.id = id; self.mode = mode; self.seconds = seconds; self.recordedAt = recordedAt
    }

    /// Property list values only, which is all WatchConnectivity carries.
    public var metadata: [String: Any] {
        ["kind": Self.kind, "id": id, "mode": mode.rawValue, "seconds": seconds, "recorded_at": ISO.string(recordedAt)]
    }

    /// Nil for any other transfer. The id names files on the iPhone, so only a plain id is taken.
    public init?(metadata: [String: Any]?) {
        guard let m = metadata, m["kind"] as? String == Self.kind,
              let id = m["id"] as? String, Self.isPlainId(id) else { return nil }
        self.id = id
        // A mode from a newer Watch is heard as a melody, as the hub does.
        mode = (m["mode"] as? String).flatMap(HumMidi.Mode.init(rawValue:)) ?? .melody
        seconds = (m["seconds"] as? NSNumber)?.doubleValue ?? 0
        recordedAt = ISO.date(m["recorded_at"] as? String) ?? Date()
    }

    static func isPlainId(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" }
    }
}

/// What the iPhone tells the Watch about a hum, by `sendMessage` when the Watch is in reach, else `transferUserInfo`.
public struct WatchHumResult: Equatable, Sendable {
    public static let kind = "hum-result"

    public enum State: String, CaseIterable, Sendable {
        /// The iPhone has it but could not reach the hub; it tries again the next time the app is active.
        case waiting
        /// The hub has it and is hearing the notes.
        case listening
        case done
        case failed

        /// Messages can arrive out of order (a queued one after a direct one), so a later step never gives way to an
        /// earlier one. The Watch's own steps come first: 0 sent, 1 delivered to the iPhone.
        public var rank: Int {
            switch self {
            case .waiting: return 2
            case .listening: return 3
            case .done, .failed: return 4
            }
        }
    }

    public var id: String
    public var state: State
    /// The idea's title once the hub has heard it: "Melody in A minor, 120 BPM".
    public var title: String?
    public var error: String?
    public var ideaId: String?

    public init(id: String, state: State, title: String? = nil, error: String? = nil, ideaId: String? = nil) {
        self.id = id; self.state = state; self.title = title; self.error = error; self.ideaId = ideaId
    }

    public var finished: Bool { state == .done || state == .failed }

    public var message: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind, "id": id, "state": state.rawValue]
        if let title { m["title"] = title }
        if let error { m["error"] = error }
        if let ideaId { m["idea_id"] = ideaId }
        return m
    }

    /// Nil for any other message, or a state this Watch does not know.
    public init?(message: [String: Any]) {
        guard message["kind"] as? String == Self.kind, let id = message["id"] as? String, !id.isEmpty,
              let state = (message["state"] as? String).flatMap(State.init(rawValue:)) else { return nil }
        self.init(id: id, state: state, title: message["title"] as? String, error: message["error"] as? String, ideaId: message["idea_id"] as? String)
    }

    /// The line the Watch shows: "Melody in A minor, 120 BPM: in Music".
    public var line: String {
        switch state {
        case .waiting:
            // Music being off is the one wait the owner can end; any other is the network and passes on its own.
            if let e = error, e.hasPrefix(Self.musicOff) { return e }
            return "Your iPhone will send it when it reaches the hub"
        case .listening: return "The hub is listening"
        case .done:
            let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? "In Music" : "\(t): in Music"
        case .failed: return Self.sentence(error) ?? "The hub could not hear it."
        }
    }

    /// Where the hub is with an idea it made from a hum: listening, or done with its title, or failed with its reason.
    public static func heard(_ idea: Entity, humId: String) -> WatchHumResult {
        let title = idea.string("title")
        guard let m = idea.humMidi else { return WatchHumResult(id: humId, state: .done, title: title, ideaId: idea.id) }
        switch m.state {
        case .listening: return WatchHumResult(id: humId, state: .listening, ideaId: idea.id)
        case .done: return WatchHumResult(id: humId, state: .done, title: title, ideaId: idea.id)
        case .failed: return WatchHumResult(id: humId, state: .failed, error: m.error ?? "the hub could not hear it", ideaId: idea.id)
        }
    }

    /// What a failed upload means: `keep` when it may go through later (no hub, no network, the hub busy or
    /// signed out), so the iPhone keeps the file; otherwise the hub refused it and saying why is all that is left.
    public static func upload(error: Error, humId: String) -> (result: WatchHumResult, keep: Bool) {
        switch error as? HubError {
        case .http(404, let message)? where message.contains("Settings, Modules"):
            // Music is switched off on the hub: the recording waits on the iPhone and goes when it is on again.
            return (WatchHumResult(id: humId, state: .waiting, error: Self.musicOff), true)
        case .http(let status, let message)? where (400..<500).contains(status) && ![401, 403, 408, 429].contains(status):
            // The hub says why in a sentence of its own ("the recording is under half a second").
            return (WatchHumResult(id: humId, state: .failed, error: message), false)
        case .decoding?:
            // The hub took it but its answer could not be read. The take carries its id, so sending it again
            // returns the same idea instead of making a second one.
            return (WatchHumResult(id: humId, state: .waiting, error: "Sent, but the hub's answer could not be read. Trying again."), true)
        case .notConfigured?:
            return (WatchHumResult(id: humId, state: .waiting, error: "Your iPhone is not set up with a hub"), true)
        default:
            let e = (error as? HubError)?.errorDescription ?? error.localizedDescription
            return (WatchHumResult(id: humId, state: .waiting, error: e), true)
        }
    }

    static let musicOff = "Music is switched off on the hub. The recording waits on your iPhone until it is on."

    /// "no notes were heard" becomes "No notes were heard."
    static func sentence(_ text: String?) -> String? {
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), let first = t.first else { return nil }
        let s = first.uppercased() + t.dropFirst()
        return ".!?".contains(s.last!) ? s : s + "."
    }
}

/// Hums kept on a device until the next step has them: on the Watch until WatchConnectivity has delivered the
/// file, on the iPhone until the hub has heard it and the Watch has been told. Each hum is `<id>.json` with its
/// recording `<id>.wav` beside it while there is one. Kept in Application Support, not the temporary folder, which
/// the system may empty while a hum waits for the hub.
public struct WatchHumQueue: Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var hum: WatchHum
        /// The music idea the hub made, once the iPhone has sent it.
        public var ideaId: String?
        public var sentAt: Date?
        /// When the Watch was told how it ended. The record stays a while so a repeated transfer is not sent twice.
        public var finishedAt: Date?

        public init(hum: WatchHum, ideaId: String? = nil, sentAt: Date? = nil, finishedAt: Date? = nil) {
            self.hum = hum; self.ideaId = ideaId; self.sentAt = sentAt; self.finishedAt = finishedAt
        }
    }

    public let folder: URL

    public init(folder: URL) { self.folder = folder }

    /// This device's queue.
    public static var local: WatchHumQueue {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return WatchHumQueue(folder: base.appendingPathComponent("watch-hums", isDirectory: true))
    }

    public func audioURL(_ id: String) -> URL { folder.appendingPathComponent("\(id).wav") }
    func recordURL(_ id: String) -> URL { folder.appendingPathComponent("\(id).json") }

    public func hasAudio(_ id: String) -> Bool { FileManager.default.fileExists(atPath: audioURL(id).path) }

    /// Moves the recording in. False when this hum is already here (sent twice), and then the file is left alone.
    @discardableResult
    public func add(_ hum: WatchHum, moving file: URL) throws -> Bool {
        guard WatchHum.isPlainId(hum.id) else { throw HubError.transport("Bad hum id") }
        guard entry(hum.id) == nil else { return false }
        let fm = FileManager.default
        DataProtection.folder(folder, .untilFirstUnlock)
        let dest = audioURL(hum.id)
        try? fm.removeItem(at: dest)
        do { try fm.moveItem(at: file, to: dest) } catch { try fm.copyItem(at: file, to: dest) }
        // A moved file keeps its own class, so it is set here.
        DataProtection.protect(dest, .untilFirstUnlock)
        do { try save(Entry(hum: hum)) } catch { try? fm.removeItem(at: dest); throw error }
        return true
    }

    public func entry(_ id: String) -> Entry? {
        guard let data = try? Data(contentsOf: recordURL(id)) else { return nil }
        return try? JSONCoding.decode(Entry.self, from: data)
    }

    /// Every hum here, oldest first.
    public func all() -> [Entry] {
        guard let names = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return names.filter { $0.pathExtension == "json" }
            .compactMap { (try? Data(contentsOf: $0)).flatMap { try? JSONCoding.decode(Entry.self, from: $0) } }
            .sorted { $0.hum.recordedAt != $1.hum.recordedAt ? $0.hum.recordedAt < $1.hum.recordedAt : $0.hum.id < $1.hum.id }
    }

    /// Hums whose outcome the Watch has not been told yet.
    public func pending() -> [Entry] { all().filter { $0.finishedAt == nil } }

    /// The hub has it; the recording leaves this device, as it does after a hum sent from the iPhone itself.
    public func markSent(_ id: String, ideaId: String, at date: Date = Date()) {
        guard var e = entry(id) else { return }
        e.ideaId = ideaId
        e.sentAt = date
        try? save(e)
        try? FileManager.default.removeItem(at: audioURL(id))
    }

    public func finish(_ id: String, at date: Date = Date()) {
        guard var e = entry(id) else { return }
        e.finishedAt = date
        try? save(e)
        try? FileManager.default.removeItem(at: audioURL(id))
    }

    public func remove(_ id: String) {
        try? FileManager.default.removeItem(at: audioURL(id))
        try? FileManager.default.removeItem(at: recordURL(id))
    }

    /// Forgets finished hums after a week.
    public func prune(now: Date = Date(), keep: TimeInterval = 7 * 86_400) {
        for e in all() { if let f = e.finishedAt, now.timeIntervalSince(f) > keep { remove(e.hum.id) } }
    }

    /// Complete until first user authentication: WatchConnectivity hands hums over and the iPhone sends them to the hub
    /// in the background, often with the phone locked in a pocket.
    private func save(_ e: Entry) throws {
        DataProtection.folder(folder, .untilFirstUnlock)
        try DataProtection.write(JSONCoding.data(e), to: recordURL(e.hum.id), .untilFirstUnlock)
    }
}
