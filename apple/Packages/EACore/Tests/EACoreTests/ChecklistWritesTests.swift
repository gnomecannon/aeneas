import XCTest
@testable import EACore

/// Checklist ticks, adds and deletes are each one whole-list patch through the outbox (Lists, AdminShared.swift). A
/// tick used to go to POST /checklists/:id/toggle by index while adds and deletes were patches, and the probes in
/// the screens review showed a tick landing on the wrong item, a deleted item coming back and a tick being lost.
/// These tests hold what the fix rests on: patches made one after another are stamped in order and land on the hub
/// in order, so the hub ends with exactly the list the phone shows.
@MainActor
final class ChecklistWritesTests: XCTestCase {
    private let id = "c0ffee00-0000-4000-8000-000000000001"
    private let t0 = "2026-11-05T15:00:00.000Z"

    private static func item(_ t: String) -> JSONValue { .object(["text": .string(t)]) }
    private static func texts(_ e: Entity?) -> [String] { (e?.fields["items"]?.arrayValue ?? []).map { $0.objectValue?["text"]?.stringValue ?? "?" } }
    private static func done(_ e: Entity?) -> [String] {
        (e?.fields["items"]?.arrayValue ?? []).compactMap { v in
            let o = v.objectValue ?? [:]
            return (o["done_at"]?.stringValue ?? "").isEmpty ? nil : o["text"]?.stringValue
        }
    }

    /// The same flip as the app's AdminChecklist.toggled and the hub's toggleChecklistItem.
    private static func toggled(_ raw: [JSONValue], text: String, at: String) -> [JSONValue] {
        var done = false
        return raw.map { v in
            guard !done, v.objectValue?["text"]?.stringValue == text else { return v }
            done = true
            var o = v.objectValue ?? [:]
            if !(o["done_at"]?.stringValue ?? "").isEmpty { o.removeValue(forKey: "done_at") } else { o["done_at"] = .string(at) }
            return .object(o)
        }
    }

    private func seed() async throws -> (SyncEngine, SyncStore, Entity) {
        let store = try SyncStore.inMemory()
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-checklist-\(UUID().uuidString)"), platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let hub = Entity(id: id, kind: .checklist, created_at: t0, fields: ["title": "Trip", "items": .array([Self.item("A"), Self.item("B"), Self.item("C")])],
                         field_ts: ["title": t0, "items": t0])
        await engine.absorb(hub)
        return (engine, store, hub)
    }

    /// Replays the outbox on the hub's copy in order, as a push does.
    private func push(_ store: SyncStore, onto hub: inout Entity) async throws -> [String] {
        let items = try await store.outbox()
        for it in items { _ = hub.apply(it.patch) }
        return items.map(\.patch.ts)
    }

    /// Delete A, then tick C before the delete was pushed: the hub ends with B and a ticked C, as the phone shows.
    func testDeleteThenTickLandsInOrder() async throws {
        let (engine, store, seeded) = try await seed(); var hub = seeded
        let live0 = try XCTUnwrap(engine.get(id)?.fields["items"]?.arrayValue)
        _ = await engine.update(id, fields: ["items": .array(Array(live0.dropFirst()))])
        let live1 = try XCTUnwrap(engine.get(id)?.fields["items"]?.arrayValue)
        _ = await engine.update(id, fields: ["items": .array(Self.toggled(live1, text: "C", at: ISO.now()))])
        XCTAssertEqual(Self.texts(engine.get(id)), ["B", "C"])
        XCTAssertEqual(Self.done(engine.get(id)), ["C"])

        let stamps = try await push(store, onto: &hub)
        XCTAssertEqual(stamps.count, 2)
        XCTAssertLessThan(stamps[0], stamps[1], "the later write carries the later stamp")
        XCTAssertEqual(Self.texts(hub), ["B", "C"], "the deleted item stays deleted")
        XCTAssertEqual(Self.done(hub), ["C"], "the tapped item is the ticked one")

        // The hub's answer coming back changes nothing on the phone.
        await engine.absorb(hub)
        XCTAssertEqual(Self.texts(engine.get(id)), ["B", "C"])
        XCTAssertEqual(Self.done(engine.get(id)), ["C"])
    }

    /// Tick B, then add D straight after: the add is written on the ticked list, so the tick survives on the hub.
    func testTickThenAddKeepsTheTick() async throws {
        let (engine, store, seeded) = try await seed(); var hub = seeded
        let live0 = try XCTUnwrap(engine.get(id)?.fields["items"]?.arrayValue)
        _ = await engine.update(id, fields: ["items": .array(Self.toggled(live0, text: "B", at: ISO.now()))])
        let live1 = try XCTUnwrap(engine.get(id)?.fields["items"]?.arrayValue)
        _ = await engine.update(id, fields: ["items": .array(live1 + [Self.item("D")])])

        _ = try await push(store, onto: &hub)
        XCTAssertEqual(Self.texts(hub), ["A", "B", "C", "D"])
        XCTAssertEqual(Self.done(hub), ["B"], "the tick is not lost")
        XCTAssertEqual(Self.done(engine.get(id)), ["B"])
    }

    /// Two writes in the same millisecond still go in order: the second is stamped after the first.
    func testWritesInOneMillisecondStayOrdered() async throws {
        let (engine, store, seeded) = try await seed(); var hub = seeded
        for t in ["D", "E", "F"] {
            let live = try XCTUnwrap(engine.get(id)?.fields["items"]?.arrayValue)
            _ = await engine.update(id, fields: ["items": .array(live + [Self.item(t)])])
        }
        let stamps = try await push(store, onto: &hub)
        XCTAssertEqual(stamps, stamps.sorted())
        XCTAssertEqual(Set(stamps).count, stamps.count)
        XCTAssertEqual(Self.texts(hub), ["A", "B", "C", "D", "E", "F"])
    }
}
