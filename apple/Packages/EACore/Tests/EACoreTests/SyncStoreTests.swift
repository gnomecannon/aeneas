import XCTest
@testable import EACore

final class SyncStoreTests: XCTestCase {
    func testPatchLWWMergeInStore() async throws {
        let store = try SyncStore.inMemory()
        let id = "11111111-1111-4111-8111-111111111111"
        // Local create at t1
        let t1 = "2026-10-21T10:00:00.000Z"
        let created = try await store.applyLocal(Patch(id: id, kind: .task, ts: t1, fields: ["title": "Order filament", "status": "next", "order": 1], create: true))
        XCTAssertEqual(created.str("title"), "Order filament")
        XCTAssertEqual(created.field_ts["title"], t1)

        // Older patch must not overwrite
        let t0 = "2026-10-21T09:00:00.000Z"
        let after = try await store.applyLocal(Patch(id: id, kind: .task, ts: t0, fields: ["title": "stale"]), enqueue: false)
        XCTAssertEqual(after.str("title"), "Order filament")

        // Newer patch wins per field, leaves other fields alone
        let t2 = "2026-10-21T11:00:00.000Z"
        let newer = try await store.applyLocal(Patch(id: id, kind: .task, ts: t2, fields: ["status": "doing"]))
        XCTAssertEqual(newer.str("status"), "doing")
        XCTAssertEqual(newer.str("title"), "Order filament")
        XCTAssertEqual(newer.field_ts["status"], t2)
        XCTAssertEqual(newer.field_ts["title"], t1)

        // Outbox has the two enqueued patches, in order
        let outbox = try await store.outbox()
        XCTAssertEqual(outbox.count, 2)
        XCTAssertEqual(outbox[0].patch.create, true)
        XCTAssertEqual(outbox[1].patch.fields["status"], "doing")

        // Hub echo with an older status ts must not clobber the local newer status,
        // but a newer hub title must win.
        let hubTs = "2026-10-21T12:00:00.000Z"
        let hub = Entity(id: id, kind: .task, created_at: t1, updated_at: hubTs, fields: ["title": "Order PETG filament", "status": "next", "order": 1], field_ts: ["title": hubTs, "status": t1, "order": t1])
        let merged = try await store.upsertFromHub(hub)
        XCTAssertEqual(merged.str("title"), "Order PETG filament")
        XCTAssertEqual(merged.str("status"), "doing")

        // deleted_at as an ordinary field
        let t3 = "2026-10-21T13:00:00.000Z"
        let deleted = try await store.applyLocal(Patch(id: id, kind: .task, ts: t3, fields: ["deleted_at": .string(t3)]))
        XCTAssertTrue(deleted.isDeleted)
        let visible = try await store.all(kind: .task)
        XCTAssertEqual(visible.count, 0)
        let all = try await store.all(kind: .task, includeDeleted: true)
        XCTAssertEqual(all.count, 1)

        try await store.removeOutbox(rowids: outbox.map(\.rowid))
        let remaining = try await store.outboxCount()
        XCTAssertEqual(remaining, 1)

        try await store.setCursor(42)
        let c = try await store.cursor
        XCTAssertEqual(c, 42)
    }

    func testEntityCodableFieldNames() throws {
        let json = """
        {"id":"22222222-2222-4222-8222-222222222222","kind":"reminder","space":"personal","created_at":"2026-10-21T10:00:00.000Z","updated_at":"2026-10-21T10:00:00.000Z","deleted_at":null,"fields":{"title":"Claritin","at":"2026-10-22T08:00:00.000Z","repeat":"every 1 days","friction":"reason"},"field_ts":{"title":"2026-10-21T10:00:00.000Z"}}
        """
        let e = try JSONCoding.decode(Entity.self, from: json)
        let r = try e.decode(ReminderFields.self)
        XCTAssertEqual(r.title, "Claritin")
        XCTAssertEqual(r.repeat, "every 1 days")
        XCTAssertEqual(r.friction, .reason)
        let out = try JSONCoding.string(e)
        XCTAssertTrue(out.contains("\"field_ts\""))
        XCTAssertTrue(out.contains("\"deleted_at\":null"))
    }

    func testAfterAResetOnlyWhatTheHubSentStays() async throws {
        let store = try SyncStore.inMemory()
        let kept = Entity(id: "11111111-1111-4111-8111-111111111111", kind: .task, created_at: "2026-10-21T10:00:00.000Z", updated_at: "2026-10-21T10:00:00.000Z", fields: ["title": "Kept", "status": "next", "order": 1], field_ts: [:])
        let gone = Entity(id: "22222222-2222-4222-8222-222222222222", kind: .task, created_at: "2026-10-21T10:00:00.000Z", updated_at: "2026-10-21T10:00:00.000Z", fields: ["title": "Gone on the hub", "status": "next", "order": 2], field_ts: [:])
        _ = try await store.upsertManyFromHub([kept, gone])
        // Made here and not sent yet: stays.
        let mine = try await store.applyLocal(Patch(id: "33333333-3333-4333-8333-333333333333", kind: .task, ts: "2026-10-21T11:00:00.000Z", fields: ["title": "Mine", "status": "next", "order": 3], create: true))
        var work = Entity(id: "44444444-4444-4444-8444-444444444444", kind: .task, created_at: "2026-10-21T10:00:00.000Z", updated_at: "2026-10-21T10:00:00.000Z", fields: ["title": "Work item", "status": "next", "order": 4], field_ts: [:])
        work.space = .work
        _ = try await store.upsertManyFromHub([work])
        let removed = try await store.removeStale(keeping: [kept.id])
        let workLeft = try await store.get(work.id)
        XCTAssertNotNil(workLeft)
        XCTAssertEqual(removed, [gone.id])
        let left = try await store.get(gone.id)
        XCTAssertNil(left)
        let stays = try await store.get(mine.id)
        XCTAssertNotNil(stays)
    }

    func testTheResetFlagDecodes() throws {
        let r = try JSONCoding.decode(ChangesResponse.self, from: #"{"changes":[],"seq":3,"more":false,"reset":true}"#)
        XCTAssertTrue(r.reset)
        XCTAssertFalse(try JSONCoding.decode(ChangesResponse.self, from: #"{"changes":[],"seq":3,"more":false}"#).reset)
    }
}
