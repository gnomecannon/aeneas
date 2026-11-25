import XCTest
@testable import EACore

/// The iPhone sends what the Watch complications show whenever it changes; the Watch keeps it where they read it.
final class ComplicationSnapshotTests: XCTestCase {
    func testTheMessageCarriesEverythingTheComplicationsShow() throws {
        let start = Date(timeIntervalSince1970: 1_792_000_000)
        let plan = NextLinePlan(day: "2026-10-15", started: TodayBoard.StartedTask(id: "t1", title: "Order filament"),
                                spans: [TodayBoard.Span(id: "e", kind: .event, title: "Dentist", start: start.addingTimeInterval(3600), end: start.addingTimeInterval(7200))])
        let s = ComplicationSnapshot(nowTitle: "Order filament", activity: "Writing", activityStart: start, nextUpTitle: "Dentist", nextUpAt: start.addingTimeInterval(3600), line: plan)
        // WatchConnectivity carries property lists only.
        XCTAssertNoThrow(try PropertyListSerialization.data(fromPropertyList: s.message, format: .binary, options: 0))
        XCTAssertEqual(ComplicationSnapshot(message: s.message), s)
        let empty = ComplicationSnapshot(nowTitle: nil, activity: nil, activityStart: nil, nextUpTitle: nil, nextUpAt: nil)
        XCTAssertEqual(ComplicationSnapshot(message: empty.message), empty)
        XCTAssertNil(ComplicationSnapshot(message: ["id": "hum-1", "state": "done"]), "a hum's result is not a snapshot")
        // A Watch app from before the Next line reads `now` as it always did: the task you started.
        XCTAssertEqual(s.message["now"] as? String, "Order filament")
        XCTAssertNotNil(s.message["line"] as? Data, "the line travels in a field of its own")

        let watch = SharedConfig(suiteName: "complications-\(UUID().uuidString)")
        watch.nextUpTitle = "Old meeting"
        s.apply(to: watch)
        XCTAssertEqual(watch.nowTaskTitle, "Order filament")
        XCTAssertEqual(watch.currentActivity, "Writing")
        XCTAssertEqual(watch.currentActivityStart, start)
        XCTAssertEqual(watch.nextUpTitle, "Dentist")
        XCTAssertEqual(watch.nextLinePlan, plan)
        empty.apply(to: watch)
        XCTAssertNil(watch.nowTaskTitle)
        XCTAssertNil(watch.nextLinePlan)
        XCTAssertNil(watch.nextUpTitle, "what the iPhone no longer shows goes")
    }

    @MainActor
    func testTheIPhoneSendsOnlyWhenWhatTheyShowChanged() async throws {
        let config = SharedConfig(suiteName: "complications-\(UUID().uuidString)")
        let engine = SyncEngine(config: config, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        var sent: [ComplicationSnapshot] = []
        engine.onComplicationSnapshot = { sent.append($0) }
        // A task first in Next is not on the line; starting it puts it there.
        await engine.absorb(Entity(id: "t1", kind: .task, fields: ["title": "Order filament", "status": "next", "order": 1]))
        engine.updateSnapshot()
        XCTAssertEqual(sent.map(\.nowTitle), [nil])
        await engine.absorb(Entity(id: "t1", kind: .task, updated_at: ISO.string(Date().addingTimeInterval(30)),
                                   fields: ["title": "Order filament", "status": "doing", "order": 1], field_ts: ["status": ISO.string(Date().addingTimeInterval(30))]))
        sent = []
        engine.updateSnapshot()
        engine.updateSnapshot()
        XCTAssertEqual(sent.map(\.nowTitle), ["Order filament"])
        XCTAssertEqual(sent.last?.line?.started?.title, "Order filament")
        await engine.absorb(Entity(id: "n1", kind: .note, fields: ["title": "Shopping"]))
        engine.updateSnapshot()
        XCTAssertEqual(sent.count, 1, "a change the complications do not show sends nothing")
        await engine.absorb(Entity(id: "t1", kind: .task, updated_at: ISO.string(Date().addingTimeInterval(60)),
                                   fields: ["title": "Order filament", "status": "done", "order": 1], field_ts: ["status": ISO.string(Date().addingTimeInterval(60))]))
        engine.updateSnapshot()
        XCTAssertEqual(sent.count, 2)
        XCTAssertNil(sent.last?.nowTitle, "the task was finished on the iPhone")
        XCTAssertNil(sent.last?.line?.started)
    }
}
