import XCTest
@testable import EACore

final class WatchHumTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("watch-hum-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func idea(_ fields: String) throws -> Entity {
        try JSONCoding.decode(Entity.self, from: #"{"id":"idea-1","kind":"music_idea","space":"personal","created_at":"2026-11-03T20:00:00.000Z","updated_at":"2026-11-03T20:00:05.000Z","deleted_at":null,"fields":\#(fields),"field_ts":{}}"#)
    }

    private func wav(_ name: String = "take.wav") throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-hum-src-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try Data("RIFF....WAVE".utf8).write(to: url)
        return url
    }

    // MARK: transfer metadata

    func testMetadataRoundTripsAsPropertyListValues() throws {
        let at = ISO.date("2026-11-03T21:14:05.250Z")!
        let hum = WatchHum(id: "4b1c2d3e-aaaa-bbbb-cccc-0123456789ab", mode: .rhythm, seconds: 12.5, recordedAt: at)
        let m = hum.metadata
        XCTAssertEqual(m["kind"] as? String, "hum")
        XCTAssertEqual(m["mode"] as? String, "rhythm")
        // WatchConnectivity refuses anything a property list cannot hold.
        XCTAssertTrue(PropertyListSerialization.propertyList(m, isValidFor: .binary))
        XCTAssertEqual(WatchHum(metadata: m), hum)
    }

    func testMetadataFromOtherTransfersOrWithBadIdsIsRefused() {
        XCTAssertNil(WatchHum(metadata: nil))
        XCTAssertNil(WatchHum(metadata: ["kind": "photo", "id": "abc"]))
        XCTAssertNil(WatchHum(metadata: ["kind": "hum"]))
        XCTAssertNil(WatchHum(metadata: ["kind": "hum", "id": ""]))
        // The id names files on the iPhone.
        XCTAssertNil(WatchHum(metadata: ["kind": "hum", "id": "../../etc"]))
        XCTAssertNil(WatchHum(metadata: ["kind": "hum", "id": "a/b"]))
        XCTAssertNil(WatchHum(metadata: ["kind": "hum", "id": String(repeating: "a", count: 65)]))
    }

    func testMetadataWithMissingOrUnknownFieldsStillReads() throws {
        let hum = try XCTUnwrap(WatchHum(metadata: ["kind": "hum", "id": "abc-123", "mode": "whistle", "seconds": 7]))
        XCTAssertEqual(hum.mode, .melody)
        XCTAssertEqual(hum.seconds, 7)
        let bare = try XCTUnwrap(WatchHum(metadata: ["kind": "hum", "id": "abc-124"]))
        XCTAssertEqual(bare.mode, .melody)
        XCTAssertEqual(bare.seconds, 0)
    }

    // MARK: result message

    func testResultMessageRoundTrips() {
        let r = WatchHumResult(id: "abc-123", state: .done, title: "Melody in A minor, 120 BPM", ideaId: "idea-1")
        let m = r.message
        XCTAssertEqual(m["kind"] as? String, "hum-result")
        XCTAssertNil(m["error"])
        XCTAssertTrue(PropertyListSerialization.propertyList(m, isValidFor: .binary))
        XCTAssertEqual(WatchHumResult(message: m), r)

        let f = WatchHumResult(id: "abc-123", state: .failed, error: "no notes were heard")
        XCTAssertEqual(WatchHumResult(message: f.message), f)
    }

    func testResultMessageRefusesOthers() {
        XCTAssertNil(WatchHumResult(message: [:]))
        XCTAssertNil(WatchHumResult(message: ["kind": "hum-result", "id": "a"]))
        XCTAssertNil(WatchHumResult(message: ["kind": "hum-result", "id": "a", "state": "exploded"]))
        XCTAssertNil(WatchHumResult(message: ["kind": "other", "id": "a", "state": "done"]))
    }

    func testLines() {
        XCTAssertEqual(WatchHumResult(id: "a", state: .done, title: "Melody in A minor, 120 BPM").line, "Melody in A minor, 120 BPM: in Music")
        XCTAssertEqual(WatchHumResult(id: "a", state: .done, title: "  ").line, "In Music")
        XCTAssertEqual(WatchHumResult(id: "a", state: .failed, error: "no notes were heard; hum a little louder or closer").line,
                       "No notes were heard; hum a little louder or closer.")
        XCTAssertEqual(WatchHumResult(id: "a", state: .failed, error: "Music is off. Turn it on in Settings, Modules.").line,
                       "Music is off. Turn it on in Settings, Modules.")
        XCTAssertEqual(WatchHumResult(id: "a", state: .failed).line, "The hub could not hear it.")
        XCTAssertEqual(WatchHumResult(id: "a", state: .listening).line, "The hub is listening")
        XCTAssertFalse(WatchHumResult(id: "a", state: .waiting).line.isEmpty)
        for s in WatchHumResult.State.allCases {
            let line = WatchHumResult(id: "a", state: s, title: "T", error: "e").line
            XCTAssertFalse(line.contains("\u{2014}") || line.contains("\u{2013}"), line)
        }
    }

    func testLaterStepsOutrankEarlierOnes() {
        XCTAssertLessThan(WatchHumResult.State.waiting.rank, WatchHumResult.State.listening.rank)
        XCTAssertLessThan(WatchHumResult.State.listening.rank, WatchHumResult.State.done.rank)
        XCTAssertEqual(WatchHumResult.State.done.rank, WatchHumResult.State.failed.rank)
        // The Watch's own steps (0 sent, 1 delivered) come before anything the iPhone says.
        XCTAssertGreaterThan(WatchHumResult.State.waiting.rank, 1)
        XCTAssertTrue(WatchHumResult(id: "a", state: .done).finished)
        XCTAssertTrue(WatchHumResult(id: "a", state: .failed).finished)
        XCTAssertFalse(WatchHumResult(id: "a", state: .listening).finished)
    }

    // MARK: from the hub

    func testHeardFollowsTheIdeasState() throws {
        let listening = try idea(#"{"title":"Hummed melody","midi":{"source":"hum","mode":"melody","state":"listening","notes":[]}}"#)
        XCTAssertEqual(WatchHumResult.heard(listening, humId: "h"), WatchHumResult(id: "h", state: .listening, ideaId: "idea-1"))

        let done = try idea(#"{"title":"Melody in A minor, 120 BPM","key":"A minor","bpm":120,"midi":{"source":"hum","mode":"melody","state":"done","notes":[{"p":57,"s":0,"d":0.5,"v":90}]}}"#)
        let r = WatchHumResult.heard(done, humId: "h")
        XCTAssertEqual(r.state, .done)
        XCTAssertEqual(r.line, "Melody in A minor, 120 BPM: in Music")
        XCTAssertEqual(r.ideaId, "idea-1")

        let failed = try idea(#"{"title":"Hummed melody","midi":{"source":"hum","mode":"melody","state":"failed","error":"no notes were heard","notes":[]}}"#)
        XCTAssertEqual(WatchHumResult.heard(failed, humId: "h").line, "No notes were heard.")
    }

    func testUploadErrorsKeepTheFileOnlyWhenItMayGoThroughLater() {
        // Music switched off on the hub: the take waits for it to come back on instead of being thrown away.
        let off = WatchHumResult.upload(error: HubError.http(status: 404, message: "Music is off. Turn it on in Settings, Modules."), humId: "h")
        XCTAssertTrue(off.keep)
        XCTAssertEqual(off.result.state, .waiting)
        XCTAssertEqual(off.result.line, "Music is switched off on the hub. The recording waits on your iPhone until it is on.")

        let refused = WatchHumResult.upload(error: HubError.http(status: 422, message: "the recording is under half a second"), humId: "h")
        XCTAssertFalse(refused.keep)
        XCTAssertEqual(refused.result.state, .failed)
        XCTAssertEqual(refused.result.line, "The recording is under half a second.")
        XCTAssertFalse(WatchHumResult.upload(error: HubError.http(status: 404, message: "music idea not found"), humId: "h").keep)
        // An answer that could not be read is sent again: the take's id makes the hub return the same idea.
        XCTAssertTrue(WatchHumResult.upload(error: HubError.decoding("entity"), humId: "h").keep)

        for e: Error in [HubError.transport("The network connection was lost."), HubError.http(status: 502, message: "bad gateway"),
                         HubError.http(status: 401, message: "unauthorized"), HubError.http(status: 429, message: "slow down"),
                         HubError.notConfigured, URLError(.notConnectedToInternet)] {
            let u = WatchHumResult.upload(error: e, humId: "h")
            XCTAssertTrue(u.keep, "\(e)")
            XCTAssertEqual(u.result.state, .waiting)
        }
    }

    // MARK: queue

    func testQueueMovesTheRecordingInAndKeepsOrder() throws {
        let q = WatchHumQueue(folder: folder)
        let first = WatchHum(id: "h-1", mode: .melody, seconds: 4, recordedAt: Date(timeIntervalSince1970: 100))
        let second = WatchHum(id: "h-2", mode: .rhythm, seconds: 9, recordedAt: Date(timeIntervalSince1970: 200))
        let src2 = try wav()
        XCTAssertTrue(try q.add(second, moving: src2))
        XCTAssertTrue(try q.add(first, moving: try wav()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: src2.path), "moved, not copied")
        XCTAssertTrue(q.hasAudio("h-2"))
        XCTAssertEqual(q.all().map(\.hum.id), ["h-1", "h-2"])
        XCTAssertEqual(q.entry("h-2")?.hum, second)

        // A second delivery of the same hum is left alone.
        let again = try wav()
        XCTAssertFalse(try q.add(second, moving: again))
        XCTAssertTrue(FileManager.default.fileExists(atPath: again.path))
        XCTAssertEqual(q.all().count, 2)
    }

    func testQueueSteps() throws {
        let q = WatchHumQueue(folder: folder)
        let hum = WatchHum(id: "h-1", mode: .melody, seconds: 4)
        try q.add(hum, moving: try wav())
        XCTAssertEqual(q.pending().map(\.hum.id), ["h-1"])

        let sent = Date(timeIntervalSince1970: 1_000)
        q.markSent("h-1", ideaId: "idea-1", at: sent)
        XCTAssertFalse(q.hasAudio("h-1"), "the hub keeps the recording")
        XCTAssertEqual(q.entry("h-1")?.ideaId, "idea-1")
        XCTAssertEqual(q.entry("h-1")?.sentAt, sent)
        XCTAssertEqual(q.pending().count, 1)

        let done = Date(timeIntervalSince1970: 2_000)
        q.finish("h-1", at: done)
        XCTAssertTrue(q.pending().isEmpty)
        // Still known, so a repeated transfer is not sent to the hub twice.
        XCTAssertFalse(try q.add(hum, moving: try wav()))

        q.prune(now: done.addingTimeInterval(86_400))
        XCTAssertNotNil(q.entry("h-1"))
        q.prune(now: done.addingTimeInterval(8 * 86_400))
        XCTAssertNil(q.entry("h-1"))
        XCTAssertTrue(q.all().isEmpty)
    }

    func testQueueRemoveAndEmptyFolder() throws {
        let q = WatchHumQueue(folder: folder)
        XCTAssertTrue(q.all().isEmpty)
        q.markSent("missing", ideaId: "x")
        q.finish("missing")
        XCTAssertTrue(q.all().isEmpty)
        try q.add(WatchHum(id: "h-1", mode: .melody, seconds: 2), moving: try wav())
        q.remove("h-1")
        XCTAssertNil(q.entry("h-1"))
        XCTAssertFalse(q.hasAudio("h-1"))
        XCTAssertThrowsError(try q.add(WatchHum(id: "../x", mode: .melody, seconds: 2), moving: try wav()))
    }
}
