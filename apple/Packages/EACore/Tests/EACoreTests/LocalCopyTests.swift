import XCTest
@testable import EACore

/// What an app update does with the local copy (SyncEngine.copyPlan), and what the Watch keeps.
@MainActor
final class LocalCopyTests: XCTestCase {
    private let all = Kind.allCases.map(\.rawValue).sorted().joined(separator: ",")

    func testAnUpdateKeepsTheCopyUnlessItLearnsAKindOrTheFormatChanged() {
        let kinds = Kind.allCases
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: all, storedFormat: "1", kinds: kinds, format: 1).readAgain, false, "the same kinds and format: kept")
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: all, storedFormat: "1", kinds: kinds, format: 1).dropOthers, false)
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: nil, storedFormat: nil, kinds: kinds, format: 1).readAgain, true, "a copy from before the marks: read again once")
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: all, storedFormat: nil, kinds: kinds, format: 1).readAgain, true)
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: all, storedFormat: "1", kinds: kinds, format: 2).readAgain, true, "a new store format")
        let older = Kind.allCases.filter { $0 != .film }.map(\.rawValue).joined(separator: ",")
        XCTAssertEqual(SyncEngine.copyPlan(storedKinds: older, storedFormat: "1", kinds: kinds, format: 1).readAgain, true, "a kind the copy has not held")
        // The Watch, from a copy of every kind: nothing to read again, the other kinds go.
        let w = SyncEngine.copyPlan(storedKinds: all, storedFormat: "1", kinds: SyncEngine.watchKinds, format: 1)
        XCTAssertEqual(w.readAgain, false)
        XCTAssertEqual(w.dropOthers, true)
        // The Watch from before the marks: read again (with its kinds) and drop the rest.
        let old = SyncEngine.copyPlan(storedKinds: nil, storedFormat: nil, kinds: SyncEngine.watchKinds, format: 1)
        XCTAssertEqual(old.readAgain, true)
        XCTAssertEqual(old.dropOthers, true)
    }

    func testAStartKeepsTheCursorOfAMarkedCopyAndReadsAnUnmarkedOneAgain() async throws {
        for marked in [true, false] {
            let store = try SyncStore.inMemory()
            _ = try await store.upsertManyFromHub([Entity(kind: .task, fields: ["title": "Kept", "status": "next", "order": 1])])
            try await store.setCursor(77)
            if marked {
                try await store.setMeta(SyncEngine.storedKindsKey, all)
                try await store.setMeta(SyncEngine.storeFormatKey, String(SyncEngine.storeFormat))
            }
            let engine = SyncEngine(config: SharedConfig(suiteName: "copy-\(UUID().uuidString)"), platform: .iphone, store: store)
            engine.schedulesNotifications = false
            await engine.start()
            XCTAssertEqual(engine.cursor, marked ? 77 : 0)
            XCTAssertEqual(engine.list(.task).count, 1, "the items stay either way; a read from the start merges into them")
            let kept = try await store.meta(SyncEngine.storedKindsKey)
            XCTAssertEqual(kept, all, "the start writes what the copy holds")
            engine.stop()
        }
    }

    func testTheWatchAsksForItsKindsAndDropsTheRest() async throws {
        let store = try SyncStore.inMemory()
        let task = Entity(kind: .task, fields: ["title": "Call back", "status": "next", "order": 1])
        let note = Entity(kind: .note, fields: ["title": "Long note", "body": "x", "path": "Inbox/a.md"])
        _ = try await store.upsertManyFromHub([task, note])
        try await store.setCursor(5)
        try await store.setMeta(SyncEngine.storedKindsKey, all)
        try await store.setMeta(SyncEngine.storeFormatKey, String(SyncEngine.storeFormat))
        let c = SharedConfig(suiteName: "watch-kinds-\(UUID().uuidString)")
        c.deviceId = "w1"
        let engine = SyncEngine(config: c, platform: .watch, store: store)
        engine.schedulesNotifications = false
        let hub = FakeTransport()
        hub.responses = [(200, Data(#"{"changes":[],"seq":9,"more":false}"#.utf8))]
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        XCTAssertEqual(engine.get(task.id)?.id, task.id)
        XCTAssertNil(engine.get(note.id), "a note is not kept on the Watch")
        XCTAssertEqual(engine.cursor, 9, "the copy was kept: no read from the start")
        let pull = try XCTUnwrap(hub.calls.first { $0.path.hasSuffix("sync/changes") })
        XCTAssertEqual(pull.query["kinds"], "task,event,log,monitor,incident")
        XCTAssertEqual(pull.query["since"], "5")
        engine.stop()
    }
}
