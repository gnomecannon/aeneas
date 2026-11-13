import XCTest
import Combine
@testable import EACore

/// A hub copy merged into the local one: a field the hub cleared goes, local edits not sent yet still win, and a copy
/// that changes nothing changes nothing.
final class HubCopyMergeTests: XCTestCase {
    private let id = "55555555-5555-4555-8555-555555555555"
    private let t1 = "2026-11-13T10:00:00.000Z"
    private let t2 = "2026-11-13T11:00:00.000Z"
    private let t3 = "2026-11-13T12:00:00.000Z"

    private func monitor(fields: [String: JSONValue], ts: [String: String], updated: String) -> Entity {
        Entity(id: id, kind: .monitor, created_at: t1, updated_at: updated, fields: fields, field_ts: ts)
    }

    func testAFieldTheHubClearedGoes() {
        var local = monitor(fields: ["name": "nas ping", "state": "down", "last_error": "timeout"], ts: ["name": t1, "state": t1, "last_error": t1], updated: t1)
        // The machine answers again: the hub clears the error (key gone, stamp kept) and moves the state.
        let hub = monitor(fields: ["name": "nas ping", "state": "up"], ts: ["name": t1, "state": t2, "last_error": t2], updated: t2)
        local.merge(hub: hub)
        XCTAssertNil(local.fields["last_error"])
        XCTAssertEqual(local.field_ts["last_error"], t2)
        XCTAssertEqual(local.str("state"), "up")
        XCTAssertEqual(local.updated_at, t2)
    }

    func testAClearAtTheSameTimeAsTheLocalWriteGoes() {
        // This device cleared the host (sent as null, kept here as null); the hub's echo has no key, same stamp.
        var local = monitor(fields: ["name": "nas ping", "host": .null], ts: ["name": t1, "host": t2], updated: t2)
        let hub = monitor(fields: ["name": "nas ping"], ts: ["name": t1, "host": t2], updated: t2)
        local.merge(hub: hub)
        XCTAssertNil(local.fields["host"])
        XCTAssertEqual(local.field_ts["host"], t2)
    }

    func testANewerLocalEditKeepsItsValueOverAnOlderClear() {
        var local = monitor(fields: ["name": "nas ping", "expect": "200"], ts: ["name": t1, "expect": t3], updated: t3)
        let hub = monitor(fields: ["name": "nas ping"], ts: ["name": t1, "expect": t2], updated: t2)
        local.merge(hub: hub)
        XCTAssertEqual(local.str("expect"), "200")
        XCTAssertEqual(local.field_ts["expect"], t3)
    }

    func testAMissingFieldWithNoStampAndAnUnchangedCopyChangeNothing() {
        // A field the hub has no stamp for was never cleared there: it stays.
        let local = monitor(fields: ["name": "nas ping", "target": "nas"], ts: ["name": t1, "target": t1], updated: t1)
        var merged = local
        merged.merge(hub: monitor(fields: ["name": "nas ping"], ts: ["name": t1], updated: t1))
        XCTAssertEqual(merged, local)
        // The same copy again, and a copy with a clear merged twice, end where they started.
        var same = local
        same.merge(hub: local)
        XCTAssertEqual(same, local)
        let clear = monitor(fields: ["name": "nas ping"], ts: ["name": t1, "target": t2], updated: t2)
        var once = local
        once.merge(hub: clear)
        var twice = once
        twice.merge(hub: clear)
        XCTAssertEqual(twice, once)
        XCTAssertNil(once.fields["target"])
    }

    func testDeletedAtStillFollowsItsOwnRule() {
        // Deleted here at t1; the hub restored it at t2 (no deleted_at, a newer stamp): it comes back, fields and all.
        var restored = Entity(id: id, kind: .monitor, created_at: t1, updated_at: t1, deleted_at: t1, fields: ["name": "nas ping"], field_ts: ["name": t1, "deleted_at": t1])
        restored.merge(hub: Entity(id: id, kind: .monitor, created_at: t1, updated_at: t2, fields: ["name": "nas ping"], field_ts: ["name": t1, "deleted_at": t2]))
        XCTAssertFalse(restored.isDeleted)
        XCTAssertEqual(restored.str("name"), "nas ping")
        // Deleted here at t3 and not sent yet: an older restore does not bring it back.
        var deleted = Entity(id: id, kind: .monitor, created_at: t1, updated_at: t3, deleted_at: t3, fields: ["name": "nas ping"], field_ts: ["name": t1, "deleted_at": t3])
        deleted.merge(hub: Entity(id: id, kind: .monitor, created_at: t1, updated_at: t2, fields: ["name": "nas ping"], field_ts: ["name": t1, "deleted_at": t2]))
        XCTAssertTrue(deleted.isDeleted)
        XCTAssertEqual(deleted.str("name"), "nas ping")
    }

    func testUnsentLocalEditsStillWinInTheStore() async throws {
        let store = try SyncStore.inMemory()
        let tid = "66666666-6666-4666-8666-666666666666"
        _ = try await store.applyLocal(Patch(id: tid, kind: .task, ts: t1, fields: ["title": "Swap the UPS battery", "status": "next", "order": 1, "notes": "APC 1500"], create: true))
        // Edited here after the hub's copy was written, not sent yet.
        _ = try await store.applyLocal(Patch(id: tid, kind: .task, ts: t3, fields: ["status": "doing", "notes": "APC 1500, order two"]))
        // The hub's copy: an older status, the notes cleared before this edit, a newer title.
        let hub = Entity(id: tid, kind: .task, created_at: t1, updated_at: t2,
                         fields: ["title": "Swap both UPS batteries", "status": "next", "order": 1],
                         field_ts: ["title": t2, "status": t1, "order": t1, "notes": t2])
        let merged = try await store.upsertFromHub(hub)
        XCTAssertEqual(merged.str("title"), "Swap both UPS batteries")
        XCTAssertEqual(merged.str("status"), "doing")
        XCTAssertEqual(merged.str("notes"), "APC 1500, order two")
        let stored = try await store.get(tid)
        XCTAssertEqual(stored, merged)
        // The same copy again leaves the row as it is.
        let again = try await store.upsertFromHub(hub)
        XCTAssertEqual(again, merged)
    }

    func testAClearFromTheHubReachesTheStoredCopy() async throws {
        let store = try SyncStore.inMemory()
        _ = try await store.upsertFromHub(monitor(fields: ["name": "nas backup", "state": "up", "last_error": "nas unreachable"], ts: ["name": t1, "state": t1, "last_error": t1], updated: t1))
        let merged = try await store.upsertFromHub(monitor(fields: ["name": "nas backup", "state": "up"], ts: ["name": t1, "state": t1, "last_error": t2], updated: t2))
        XCTAssertNil(merged.fields["last_error"])
        let stored = try await store.get(id)
        XCTAssertNil(stored?.fields["last_error"])
    }

    @MainActor
    func testABatchAbsorbPublishesOnceAndNotAtAllWhenNothingChanged() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-absorb-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        var publishes = 0
        let watch = engine.$entities.dropFirst().sink { _ in publishes += 1 }
        defer { watch.cancel() }
        let a = Entity(id: "a", kind: .monitor, created_at: t1, updated_at: t1, fields: ["name": "a", "state": "up", "last_check": .string(t1)], field_ts: ["name": t1, "state": t1, "last_check": t1])
        let b = Entity(id: "b", kind: .monitor, created_at: t1, updated_at: t1, fields: ["name": "b", "state": "up"], field_ts: ["name": t1, "state": t1])
        let inc = Entity(id: "i", kind: .incident, created_at: t1, updated_at: t1, fields: ["monitor_id": "b", "name": "b", "opened_at": .string(t1), "checks_failed": 3], field_ts: ["monitor_id": t1, "name": t1, "opened_at": t1, "checks_failed": t1])
        await engine.absorb([a, b, inc])
        XCTAssertEqual(publishes, 1)
        XCTAssertEqual(engine.list(.monitor).count, 2)
        XCTAssertEqual(engine.list(.incident).count, 1)
        // The same board again: nothing written, nothing redrawn.
        await engine.absorb([a, b, inc])
        XCTAssertEqual(publishes, 1)
        // One monitor checked since: one publish, with the new time.
        var checked = a
        checked.fields["last_check"] = .string(t2)
        checked.field_ts["last_check"] = t2
        await engine.absorb([checked, b, inc])
        XCTAssertEqual(publishes, 2)
        XCTAssertEqual(engine.get("a")?.string("last_check"), t2)
        await engine.absorb([])
        XCTAssertEqual(publishes, 2)
    }
}
