import XCTest
@testable import EACore

@MainActor
final class FakeCalendarSource: CalendarEventSource {
    var cals: [CalendarInfo] = []
    var events: [CalendarOccurrence] = []
    var lastQuery: (Set<String>, Date, Date)?
    func calendars() -> [CalendarInfo] { cals }
    func occurrences(calendarIds: Set<String>, from: Date, to: Date) -> [CalendarOccurrence] {
        lastQuery = (calendarIds, from, to)
        return events.filter { calendarIds.contains($0.calendarId) && $0.end > from && $0.start < to }
    }
}

@MainActor
final class CalendarSyncTests: XCTestCase {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/New_York")!; return c }
    private let now = ISO.date("2026-10-26T14:00:00.000Z")!   // Monday 10:00 New York
    private func at(_ dayOffset: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        let d = cal.date(byAdding: .day, value: dayOffset, to: cal.startOfDay(for: now))!
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: d)!
    }
    private func occ(_ id: String, _ title: String, day: Int, hour: Int, minutes: Int = 60, cal calId: String = "work") -> CalendarOccurrence {
        CalendarOccurrence(eventIdentifier: id, calendarId: calId, title: title, start: at(day, hour), end: at(day, hour).addingTimeInterval(Double(minutes) * 60))
    }

    private func makeEngine() throws -> SyncEngine {
        let config = SharedConfig(suiteName: "eacore-cal-\(UUID().uuidString)")
        let engine = SyncEngine(config: config, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        return engine
    }

    // MARK: pure diff

    func testInsertCarriesOnlyAllowedFieldsInWorkSpace() {
        var n = 0
        let plan = CalendarDiff.plan(previous: [:], existing: { _ in nil }, occurrences: [occ("E1", "Design review", day: 0, hour: 14)],
                                     selected: ["work"], window: CalendarDiff.window(now: now, calendar: cal), now: now, newId: { _ in n += 1; return "id\(n)" })
        XCTAssertEqual(plan.inserted, 1)
        let p = plan.patches[0]
        XCTAssertEqual(p.kind, .event)
        XCTAssertEqual(p.space, .work)
        XCTAssertEqual(p.create, true)
        XCTAssertEqual(Set(p.fields.keys), ["title", "start", "end", "all_day", "source", "external_id"])
        XCTAssertEqual(p.fields["source"], "eventkit")
        XCTAssertEqual(p.fields["external_id"]?.stringValue, "E1|" + ISO.string(at(0, 14)))
        XCTAssertEqual(plan.map["E1|" + ISO.string(at(0, 14))]?.entity_id, "id1")
    }

    func testWindowIsSevenBackThirtyAhead() {
        let w = CalendarDiff.window(now: now, calendar: cal)
        XCTAssertEqual(w.from, cal.date(byAdding: .day, value: -7, to: cal.startOfDay(for: now)))
        XCTAssertEqual(w.to, cal.date(byAdding: .day, value: 31, to: cal.startOfDay(for: now)))
    }

    // MARK: through the engine and outbox

    func testRunnerInsertUpdateMoveDeleteAndRecurring() async throws {
        let engine = try makeEngine()
        let src = FakeCalendarSource()
        let runner = CalendarImportRunner(engine: engine, source: src)
        let key = { (o: CalendarOccurrence) in o.externalId }

        // Single event plus a daily recurring standup with three occurrences.
        let review = occ("E1", "Design review", day: 0, hour: 14)
        let standups = (1...3).map { occ("R1", "Standup", day: $0, hour: 9, minutes: 15) }
        src.events = [review] + standups
        var r = await runner.run(selected: ["work"], now: now)
        XCTAssertEqual(r.inserted, 4)
        XCTAssertEqual(r.live, 4)
        var map = await runner.loadMap()
        XCTAssertEqual(Set(map.keys), Set(([review] + standups).map(key)), "recurring occurrences are keyed separately")
        XCTAssertEqual(Set(map.values.map(\.entity_id)).count, 4)
        let events = engine.list(.event)
        XCTAssertEqual(events.count, 4)
        XCTAssertTrue(events.allSatisfy { $0.space == .work && $0.str("source") == "eventkit" })
        XCTAssertEqual(engine.outboxCount, 4)
        let reviewId = map[key(review)]!.entity_id

        // Same data again: nothing to write.
        r = await runner.run(selected: ["work"], now: now)
        XCTAssertEqual(r.unchanged, 4)
        XCTAssertEqual(engine.outboxCount, 4)

        // Title change and end change update the same entity.
        var renamed = review; renamed.title = "Design review, v2"; renamed.end = review.end.addingTimeInterval(1800)
        src.events = [renamed] + standups
        r = await runner.run(selected: ["work"], now: now.addingTimeInterval(1))
        XCTAssertEqual(r.updated, 1)
        XCTAssertEqual(engine.get(reviewId)?.str("title"), "Design review, v2")
        XCTAssertEqual(engine.get(reviewId)?.date("end"), renamed.end)

        // Start moved on a single event: same entity, new occurrence key.
        var moved = renamed; moved.start = at(1, 16); moved.end = at(1, 17)
        src.events = [moved] + standups
        r = await runner.run(selected: ["work"], now: now.addingTimeInterval(2))
        XCTAssertEqual(r.updated, 1)
        XCTAssertEqual(r.deleted, 0)
        map = await runner.loadMap()
        XCTAssertEqual(map[key(moved)]?.entity_id, reviewId)
        XCTAssertNil(map[key(review)])
        XCTAssertEqual(engine.get(reviewId)?.str("external_id"), key(moved))
        XCTAssertFalse(engine.get(reviewId)!.isDeleted)

        // One recurring occurrence cancelled: only that one is soft-deleted.
        let gone = standups[1]
        let goneId = map[key(gone)]!.entity_id
        src.events = [moved, standups[0], standups[2]]
        r = await runner.run(selected: ["work"], now: now.addingTimeInterval(3))
        XCTAssertEqual(r.deleted, 1)
        XCTAssertTrue(engine.get(goneId)!.isDeleted)
        XCTAssertFalse(engine.get(map[key(standups[0])]!.entity_id)!.isDeleted)
        XCTAssertEqual(engine.list(.event).count, 3)
    }

    func testAgedOutIsForgottenNotDeletedAndDeselectedIsDeleted() async throws {
        let engine = try makeEngine()
        let src = FakeCalendarSource()
        let runner = CalendarImportRunner(engine: engine, source: src)
        let old = occ("OLD", "Last week planning", day: -6, hour: 10)
        let personal = occ("P1", "Dentist", day: 2, hour: 8, cal: "home")
        src.events = [old, personal]
        _ = await runner.run(selected: ["work", "home"], now: now)
        XCTAssertEqual(engine.list(.event).count, 2)
        let oldId = (await runner.loadMap())[old.externalId]!.entity_id

        // Two days later the old meeting is before the window: forgotten, still on record.
        let later = now.addingTimeInterval(2 * 86400)
        let r1 = await runner.run(selected: ["work", "home"], now: later)
        XCTAssertEqual(r1.deleted, 0)
        let mapAfter = await runner.loadMap()
        XCTAssertNil(mapAfter[old.externalId])
        XCTAssertFalse(engine.get(oldId)!.isDeleted)

        // Unticking a calendar removes its events.
        let r2 = await runner.run(selected: ["work"], now: later)
        XCTAssertEqual(r2.deleted, 1)
        XCTAssertEqual(engine.list(.event).map { $0.str("title") }, ["Last week planning"])
    }

    func testReappearingOccurrenceIsRestored() async throws {
        let engine = try makeEngine()
        let src = FakeCalendarSource()
        let runner = CalendarImportRunner(engine: engine, source: src)
        let o = occ("E9", "Offsite", day: 3, hour: 13)
        src.events = [o]
        _ = await runner.run(selected: ["work"], now: now)
        let id = (await runner.loadMap())[o.externalId]!.entity_id
        src.events = []
        _ = await runner.run(selected: ["work"], now: now.addingTimeInterval(1))
        XCTAssertTrue(engine.get(id)!.isDeleted)
        // Same key comes back (undo in Calendar): its stable id finds the deleted entity, which is restored.
        src.events = [o]
        let r = await runner.run(selected: ["work"], now: now.addingTimeInterval(2))
        XCTAssertEqual(r.inserted, 0)
        XCTAssertEqual(r.updated, 1)
        XCTAssertFalse(engine.get(id)!.isDeleted)
        XCTAssertEqual(engine.list(.event).count, 1)
    }

    // MARK: selection

    func testPreselectExchangeOrWorkDomain() {
        let cals = [
            CalendarInfo(id: "a", title: "Calendar", sourceTitle: "Exchange", isExchange: true),
            CalendarInfo(id: "b", title: "Work", sourceTitle: "robin@acme-corp.com", isExchange: false),
            CalendarInfo(id: "c", title: "Home", sourceTitle: "iCloud", isExchange: false)
        ]
        let fact = Entity(kind: .fact, fields: ["category": "identity", "key": "job", "value": "Sysadmin at Acme, robin@ACME-corp.com"])
        let domain = CalendarSelection.workDomain(facts: [fact])
        XCTAssertEqual(domain, "acme-corp.com")
        XCTAssertEqual(CalendarSelection.preselect(cals, workDomain: domain), ["a", "b"])
        XCTAssertEqual(CalendarSelection.preselect(cals, workDomain: nil), ["a"])
        XCTAssertEqual(CalendarSelection.preselect([cals[2]], workDomain: nil), [])
        let other = Entity(kind: .fact, fields: ["category": "preference", "key": "job", "value": "x@y.com"])
        XCTAssertNil(CalendarSelection.workDomain(facts: [other]))
    }

    // MARK: planner

    func testWorkEventsCountAsBusyInLocalPlanner() {
        let day = at(0, 0)
        let meeting = Entity(kind: .event, space: .work, fields: ["title": "Design review", "start": .string(ISO.string(at(0, 13))), "end": .string(ISO.string(at(0, 14))), "source": "eventkit"])
        let allDay = Entity(kind: .event, space: .work, fields: ["title": "Conference", "start": .string(ISO.string(at(0, 0))), "end": .string(ISO.string(at(1, 0))), "all_day": true])
        let slots = LocalPlanner.freeSlots(on: day, blocks: [], commitments: [], events: [meeting, allDay], minHours: 1, now: at(0, 8), calendar: cal)
        let ranges = slots.map { (ISO.date($0.start)!, ISO.date($0.end)!) }
        XCTAssertFalse(ranges.contains { $0.0 < at(0, 14) && $0.1 > at(0, 13) }, "free time must not overlap the work meeting")
        XCTAssertEqual(ranges.first?.0, at(0, 9))
        XCTAssertEqual(ranges.first?.1, at(0, 13))
    }

    func testPersonalRepeatingOccurrencesLandInThePersonalSpace() {
        let w = CalendarDiff.window(now: now)
        let o = CalendarOccurrence(eventIdentifier: "R", calendarId: "home-cal", title: "Climbing", start: now.addingTimeInterval(86400), end: now.addingTimeInterval(90000), recurring: true)
        let p = CalendarDiff.plan(previous: [:], existing: { _ in nil }, occurrences: [o], selected: ["home-cal"], window: w, now: now, space: .personal)
        XCTAssertEqual(p.patches.map(\.space), [.personal])
        XCTAssertEqual(p.patches.first?.fields["source"], "eventkit")
    }

    func testAMeetingTheOtherDeviceMovedIsNotMadeAgain() {
        // The Mac moved E1 to 15:00 and rekeyed its entity; this device never saw it at 14:00.
        let o = occ("E1", "Design review", day: 0, hour: 15)
        let held = Entity(id: "E1-entity", kind: .event, space: .work, fields: o.fields)
        let plan = CalendarDiff.plan(previous: [:], existing: { $0 == "E1-entity" ? held : nil }, occurrences: [o], selected: ["work"],
                                     window: CalendarDiff.window(now: now, calendar: cal), now: now, byExternalId: { $0 == o.externalId ? held : nil })
        XCTAssertEqual(plan.inserted, 0)
        XCTAssertEqual(plan.map[o.externalId]?.entity_id, "E1-entity")
    }

}
