import XCTest
@testable import EACore

@MainActor
final class WristAgendaTests: XCTestCase {
    private func makeEngine() throws -> SyncEngine {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-wrist-\(UUID().uuidString)"), platform: .watch, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        return engine
    }

    func testAgendaOrdersTodayAndSkipsDoneAndOtherDays() async throws {
        let engine = try makeEngine()
        let cal = Calendar.current
        let day = cal.startOfDay(for: Date())
        let at = { (h: Int) in ISO.string(day.addingTimeInterval(Double(h) * 3600)) }
        _ = await engine.create(kind: .event, fields: ["title": "Standup", "start": .string(at(10)), "end": .string(at(11)), "all_day": false, "source": "manual"])
        _ = await engine.create(kind: .event, fields: ["title": "Halloween", "start": .string(at(0)), "end": .string(at(24)), "all_day": true, "source": "manual"])
        _ = await engine.create(kind: .event, fields: ["title": "Tomorrow", "start": .string(at(34)), "end": .string(at(35)), "all_day": false, "source": "manual"])
        _ = await engine.createReminder(title: "Feed Pepper", at: day.addingTimeInterval(8 * 3600))
        let done = await engine.createReminder(title: "Already done", at: day.addingTimeInterval(9 * 3600))!
        _ = await engine.update(done.id, fields: ["status": "done"])

        let items = engine.agendaToday(now: day.addingTimeInterval(9.5 * 3600))
        XCTAssertEqual(items.map(\.title), ["Halloween", "Feed Pepper", "Standup"])
        XCTAssertTrue(items[0].allDay)
        // The open reminder from 8:00 is next: it is still waiting to be finished.
        XCTAssertEqual(engine.nextUp(now: day.addingTimeInterval(9.5 * 3600))?.title, "Feed Pepper")
        // With it finished, the event that has not ended is next; after it ends there is nothing.
        await engine.ack(items[1].id)
        XCTAssertEqual(engine.nextUp(now: day.addingTimeInterval(10.5 * 3600))?.title, "Standup")
        XCTAssertNil(engine.nextUp(now: day.addingTimeInterval(12 * 3600)))
    }

    func testHomelabGlanceCountsDownMonitorsAndUnacknowledgedIncidents() async throws {
        let engine = try makeEngine()
        XCTAssertNil(engine.homelabGlance)
        _ = await engine.create(kind: .monitor, fields: ["name": "core ping", "type": "ping", "target": "core", "state": "down"])
        _ = await engine.create(kind: .monitor, fields: ["name": "hub health", "type": "http", "target": "x", "state": "up"])
        _ = await engine.create(kind: .monitor, fields: ["name": "old", "type": "ping", "target": "y", "state": "down", "enabled": false])
        _ = await engine.create(kind: .incident, fields: ["monitor_id": "m", "name": "core ping", "opened_at": .string(ISO.now()), "checks_failed": 3])
        _ = await engine.create(kind: .incident, fields: ["monitor_id": "m", "name": "core ping", "opened_at": .string(ISO.now()), "checks_failed": 3, "acknowledged_at": .string(ISO.now())])
        let g = try XCTUnwrap(engine.homelabGlance)
        XCTAssertEqual(g.monitors, 2)
        XCTAssertEqual(g.down, ["core ping"])
        XCTAssertEqual(g.unacknowledged, 1)
        XCTAssertFalse(g.allUp)
    }
}
