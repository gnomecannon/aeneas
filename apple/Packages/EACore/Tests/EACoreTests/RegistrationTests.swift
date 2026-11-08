import XCTest
@testable import EACore

@MainActor
final class RegistrationTests: XCTestCase {
    private func makeEngine(platform: Platform, name: String, transport: FakeTransport) throws -> SyncEngine {
        let config = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        config.hubURL = "http://hub.test"
        config.storeDeviceKey("ead1_t")
        config.deviceName = name
        let engine = SyncEngine(config: config, platform: platform, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        engine.makeClient = { HubClient(transport: transport) }
        return engine
    }

    private func deviceRow(_ id: String, platform: String, name: String, lastSeen: String) -> String {
        "{\"id\":\"\(id)\",\"kind\":\"device\",\"space\":\"personal\",\"created_at\":\"\(lastSeen)\",\"updated_at\":\"\(lastSeen)\",\"deleted_at\":null,\"fields\":{\"name\":\"\(name)\",\"platform\":\"\(platform)\",\"last_seen\":\"\(lastSeen)\"},\"field_ts\":{}}"
    }

    func testWatchReusesExistingDeviceRowInsteadOfRegisteringAgain() async throws {
        let t = FakeTransport()
        // GET /entities?kind=device -> two watch rows, newest wins; then changes.
        t.responses = [
            (200, Data("[\(deviceRow("old1", platform: "watch", name: "P Watch", lastSeen: "2026-10-22T02:18:10.000Z")),\(deviceRow("new2", platform: "watch", name: "P Watch", lastSeen: "2026-10-22T02:20:35.000Z"))]".utf8)),
            (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        ]
        let engine = try makeEngine(platform: .watch, name: "Apple Watch", transport: t)
        await engine.start()
        XCTAssertEqual(engine.config.deviceId, "new2")
        XCTAssertFalse(t.calls.contains { $0.path == "devices/register" }, "must not register when a watch row exists")
        XCTAssertEqual(t.calls.first?.path, "entities")
        XCTAssertEqual(t.calls.first?.query["kind"], "device")
    }

    func testPhoneRegistersOnceWhenNoRowMatchesAndReusesStoredId() async throws {
        let t = FakeTransport()
        t.responses = [
            (200, Data("[\(deviceRow("m1", platform: "mac", name: "laptop", lastSeen: "2026-10-22T00:00:00.000Z")),\(deviceRow("p9", platform: "iphone", name: "Other Phone", lastSeen: "2026-10-22T00:00:00.000Z"))]".utf8)),
            (200, Data("{\"device_id\":\"fresh\"}".utf8)),
            (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8)),
            (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        ]
        let engine = try makeEngine(platform: .iphone, name: "Alex-Phone", transport: t)
        await engine.start()
        XCTAssertEqual(engine.config.deviceId, "fresh")
        XCTAssertEqual(t.calls.filter { $0.path == "devices/register" }.count, 1)
        // Later syncs reuse the stored id: no further device lookups or registrations.
        await engine.sync()
        XCTAssertEqual(t.calls.filter { $0.path == "devices/register" }.count, 1)
        XCTAssertEqual(t.calls.filter { $0.path == "entities" }.count, 1)
    }

    func testPhoneUnreachableIsOfflineNotUnconfigured() async throws {
        let t = FakeTransport()
        t.error = HubError.phoneUnreachable
        let engine = try makeEngine(platform: .watch, name: "Apple Watch", transport: t)
        await engine.start()
        XCTAssertEqual(engine.status, .offline)
        XCTAssertTrue(engine.phoneUnreachable)
        XCTAssertEqual(engine.lastError, "iPhone not reachable")
        XCTAssertTrue(engine.config.deviceId.isEmpty)
    }

    func testAnEditMadeWhileASyncIsRunningIsSentBeforeThatSyncEnds() async throws {
        let t = FakeTransport()
        let changes = Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8)
        let engine = try makeEngine(platform: .iphone, name: "Alex-Phone", transport: t)
        engine.config.deviceId = "d1"
        t.responses = [(200, changes)]
        await engine.start()
        t.calls = []
        t.responses = [(200, changes), (200, Data("{\"applied\":[],\"rejected\":[],\"seq\":2}".utf8)), (200, changes)]
        var edited = false
        t.onSend = { call in
            guard call.path.hasSuffix("sync/changes"), !edited else { return }
            edited = true
            await engine.apply(Patch(id: "d1", kind: .device, space: .personal, fields: ["features": .array(["contacts-merge"])]))
        }
        await engine.sync()
        XCTAssertEqual(t.calls.filter { $0.path.hasSuffix("sync/push") }.count, 1)
        XCTAssertEqual(engine.outboxCount, 0)
    }
}
