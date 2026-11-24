import XCTest
@testable import EACore

@MainActor
final class TaskMoveTests: XCTestCase {
    private func makeEngine() throws -> SyncEngine {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-move-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        return engine
    }

    func testDragMovesBetweenSectionsAndRefusesParkedAndUntimedScheduled() async throws {
        let engine = try makeEngine()
        let a = await engine.createTask(title: "a", status: .inbox)!
        let b = await engine.createTask(title: "b", status: .next)!
        let c = await engine.createTask(title: "c", status: .next)!

        // Into Next at the top.
        let m1 = await engine.moveTask(a.id, to: .next, nextOrder: [a.id, b.id, c.id])
        XCTAssertTrue(m1)
        XCTAssertEqual(engine.tasks(status: .next).map(\.id), [a.id, b.id, c.id])

        // Parked needs a reason; Scheduled needs a time.
        let m2 = await engine.moveTask(a.id, to: .parked)
        XCTAssertFalse(m2)
        let m3 = await engine.moveTask(a.id, to: .scheduled)
        XCTAssertFalse(m3)
        XCTAssertEqual(engine.get(a.id)?.str("status"), "next")

        // Doing takes over from the one doing now; Done finishes.
        let m4 = await engine.moveTask(b.id, to: .doing)
        XCTAssertTrue(m4)
        let m5 = await engine.moveTask(c.id, to: .doing)
        XCTAssertTrue(m5)
        XCTAssertEqual(engine.get(b.id)?.str("status"), "next")
        XCTAssertEqual(engine.get(c.id)?.str("status"), "doing")
        let m6 = await engine.moveTask(c.id, to: .done)
        XCTAssertTrue(m6)
        XCTAssertEqual(engine.get(c.id)?.str("status"), "done")

        // Back to the inbox from done; a dated one can be scheduled.
        let m7 = await engine.moveTask(c.id, to: .inbox)
        XCTAssertTrue(m7)
        XCTAssertEqual(engine.get(c.id)?.str("status"), "inbox")
        let d = await engine.createTask(title: "d", due: "2026-11-02", space: .personal)!
        let m8 = await engine.moveTask(d.id, to: .scheduled)
        XCTAssertTrue(m8)
        XCTAssertEqual(engine.get(d.id)?.str("status"), "scheduled")
    }

    func testDoneNotDoneDeleteAndMoveCanBeTakenBack() async throws {
        let engine = try makeEngine()
        let a = await engine.createTask(title: "Call Robin", status: .next)!
        let b = await engine.createTask(title: "Book the dentist", status: .next)!

        // Done, then Undo: open again as it was.
        let back = await engine.markDoneUndoable(a.id)!
        XCTAssertEqual(engine.get(a.id)?.str("status"), "done")
        _ = await engine.update(a.id, fields: back)
        XCTAssertEqual(engine.get(a.id)?.str("status"), "next")
        XCTAssertEqual(engine.get(a.id)?.fields["done_at"] ?? .null, .null)

        // Not done from the Done list: at the end of Next.
        await engine.markDone(a.id)
        _ = await engine.reopen(a.id)
        XCTAssertEqual(engine.tasks(status: .next).map(\.id), [b.id, a.id])
        XCTAssertEqual(engine.get(a.id)?.fields["done_at"] ?? .null, .null)

        // Delete, then Undo; a personal task tied to Apple Reminders is added there again.
        _ = await engine.update(a.id, fields: ["apple": .object(["id": "X1", "list": "P", "list_title": "Groceries"])])
        await engine.softDelete(a.id)
        XCTAssertFalse(engine.tasks.contains { $0.id == a.id })
        await engine.restore(a.id)
        XCTAssertTrue(engine.tasks.contains { $0.id == a.id })
        XCTAssertEqual(engine.get(a.id)?.fields["apple"]?.objectValue?["id"]?.stringValue, "")
        XCTAssertEqual(engine.get(a.id)?.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Groceries")

        // Moved to Work, then edited: the edit names no space, so it stays in Work.
        await engine.moveToSpace(b.id, .work)
        XCTAssertEqual(engine.get(b.id)?.space, .work)
        XCTAssertNotNil(engine.get(b.id)?.field_ts["space"])
        _ = await engine.update(b.id, fields: ["title": "Book the dentist for Alex"])
        XCTAssertEqual(engine.get(b.id)?.space, .work)
    }
}
