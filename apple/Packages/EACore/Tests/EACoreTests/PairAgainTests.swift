import XCTest
@testable import EACore

/// A hub that lost its keys file: every request is refused with `unknown_key` until `accepts` is set.
final class KeyLosingHub: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _accepts = false
    private var _pushed: [Patch] = []
    var accepts: Bool { get { lock.withLock { _accepts } } set { lock.withLock { _accepts = newValue } } }
    var pushed: [Patch] { lock.withLock { _pushed } }
    var body = #"{"error":"unauthorized","unknown_key":true}"#

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        guard accepts else { return (401, Data(self.body.utf8)) }
        switch path {
        case "sync/push":
            let req = try JSONCoding.decode(PushRequest.self, from: body!)
            lock.withLock { _pushed.append(contentsOf: req.patches) }
            let applied = req.patches.enumerated().map { "{\"id\":\"\($0.element.id)\",\"seq\":\($0.offset + 1)}" }.joined(separator: ",")
            return (200, Data("{\"applied\":[\(applied)],\"rejected\":[],\"seq\":1}".utf8))
        case "sync/changes":
            return (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        default:
            return (200, Data("{}".utf8))
        }
    }
}

final class PairAgainTests: XCTestCase {
    @MainActor
    private func engine(_ hub: KeyLosingHub) -> SyncEngine {
        let config = SharedConfig(suiteName: "pair-again-\(UUID().uuidString)")
        config.deviceId = "phone-1"
        let engine = SyncEngine(config: config, platform: .iphone, store: try! SyncStore.inMemory())
        engine.schedulesNotifications = false
        engine.makeClient = { HubClient(transport: hub) }
        return engine
    }

    /// The hub lost its keys file: the banner said "The hub did not accept this device's key" with only Retry, and
    /// nothing offered a way back. Now it says the device needs pairing again and offers Pair again, while the queued
    /// capture, the copy and the device stay as they were (not a removal).
    @MainActor
    func testAnUnknownKeyAsksToPairAgainAndKeepsTheQueue() async throws {
        let hub = KeyLosingHub()
        let engine = engine(hub)
        await engine.start()
        await engine.create(kind: .capture, fields: ["text": "made while refused", "source": "iphone"], id: "cap-1")
        await engine.sync()
        XCTAssertEqual(engine.status, .offline)
        XCTAssertEqual(engine.pairingProblem, .keyRefused)
        XCTAssertEqual(engine.lastError, SyncEngine.keyRefusedMessage)
        XCTAssertTrue(engine.offersPairAgain)
        XCTAssertFalse(engine.deviceRemoved, "a key the hub does not know is no removal")
        XCTAssertEqual(engine.outboxCount, 1, "the queued capture stays")
        XCTAssertNotNil(engine.get("cap-1"))
        // The keys file came back: the queue goes and Pair again is no longer offered.
        hub.accepts = true
        await engine.sync()
        XCTAssertEqual(engine.status, .online)
        XCTAssertNil(engine.pairingProblem)
        XCTAssertFalse(engine.offersPairAgain)
        XCTAssertTrue(hub.pushed.contains { $0.id == "cap-1" })
        engine.stop()
    }

    /// An older hub says only 401: the same.
    @MainActor
    func testAPlain401AsksToPairAgain() async throws {
        let hub = KeyLosingHub()
        hub.body = #"{"error":"unauthorized"}"#
        let engine = engine(hub)
        await engine.start()
        XCTAssertEqual(engine.pairingProblem, .keyRefused)
        XCTAssertFalse(engine.deviceRemoved)
        engine.stop()
    }

    func testPairAgainShowsOnlyWhilePairingWouldHelp() {
        XCTAssertTrue(SyncFreshness.offersPairAgain(.keyRefused, status: .offline, platform: .iphone))
        XCTAssertTrue(SyncFreshness.offersPairAgain(.otherHub, status: .offline, platform: .mac))
        XCTAssertFalse(SyncFreshness.offersPairAgain(nil, status: .offline, platform: .iphone), "plain offline: Retry only")
        XCTAssertFalse(SyncFreshness.offersPairAgain(.keyRefused, status: .online, platform: .iphone))
        XCTAssertFalse(SyncFreshness.offersPairAgain(.keyRefused, status: .offline, platform: .watch), "the Watch pairs through its iPhone")
    }

    func testLastSyncedIsSaidAfterAnHour() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(SyncFreshness.lastSynced(nil, now: now))
        XCTAssertNil(SyncFreshness.lastSynced(now.addingTimeInterval(-59 * 60), now: now))
        XCTAssertNil(SyncFreshness.lastSynced(now.addingTimeInterval(-3600), now: now))
        XCTAssertEqual(SyncFreshness.lastSynced(now.addingTimeInterval(-61 * 60), now: now), "Last synced 1 h ago")
        XCTAssertEqual(SyncFreshness.lastSynced(now.addingTimeInterval(-47.5 * 3600), now: now), "Last synced 47 h ago")
        XCTAssertEqual(SyncFreshness.lastSynced(now.addingTimeInterval(-48 * 3600), now: now), "Last synced 2 days ago")
        XCTAssertEqual(SyncFreshness.lastSynced(now.addingTimeInterval(-10.4 * 86400), now: now), "Last synced 10 days ago")
    }

    func testTheBannerLineJoinsReasonAndLastSync() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let old = now.addingTimeInterval(-3 * 3600)
        XCTAssertNil(SyncFreshness.line(nil, lastSync: nil, now: now))
        XCTAssertEqual(SyncFreshness.line(nil, lastSync: old, now: now), "Last synced 3 h ago.")
        XCTAssertEqual(SyncFreshness.line("Could not reach the hub", lastSync: old, now: now), "Could not reach the hub. Last synced 3 h ago.")
        XCTAssertEqual(SyncFreshness.line("Nothing was sent to it.", lastSync: now, now: now), "Nothing was sent to it.")
    }
}
