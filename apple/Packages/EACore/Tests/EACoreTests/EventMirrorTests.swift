import XCTest
@testable import EACore

final class EventMirrorTests: XCTestCase {
    private func fact(_ key: String, _ value: String) -> Entity {
        Entity(kind: .fact, fields: ["category": "preference", "key": .string(key), "value": .string(value)])
    }

    private let calendars = [
        CalendarInfo(id: "hobby-cal", title: "robin@riverastudio.example", sourceTitle: "robin@riverastudio.example", isExchange: false),
        CalendarInfo(id: "home-cal", title: "robin.home@example.com", sourceTitle: "robin.home@example.com", isExchange: false),
        CalendarInfo(id: "family", title: "Family", sourceTitle: "robin.home@example.com", isExchange: false),
        CalendarInfo(id: "work-cal", title: "Calendar", sourceTitle: "t.rivera@workplace.example", isExchange: true),
        CalendarInfo(id: "holidays", title: "US Holidays", sourceTitle: "Subscribed", isExchange: false),
    ]

    func testTheCalendarForEachSpaceComesFromMemory() {
        let w: Set<String> = ["hobby-cal", "home-cal", "family", "work-cal"]
        let facts = [fact("calendar:personal", "robin.home@example.com"), fact("calendar:work", "t.rivera@workplace.example")]
        XCTAssertEqual(EventMirror.calendar(for: .personal, facts: facts, calendars: calendars, writable: w, defaultId: "hobby-cal", work: ["work-cal"]), "home-cal")
        // The work account's main calendar, matched by its account name.
        XCTAssertEqual(EventMirror.calendar(for: .work, facts: facts, calendars: calendars, writable: w, defaultId: "hobby-cal", work: ["work-cal"]), "work-cal")
        // Without memory: personal events use the default calendar; work events are not guessed.
        XCTAssertEqual(EventMirror.calendar(for: .personal, facts: [], calendars: calendars, writable: w, defaultId: "hobby-cal", work: ["work-cal"]), "hobby-cal")
        XCTAssertNil(EventMirror.calendar(for: .work, facts: [], calendars: calendars, writable: w, defaultId: "hobby-cal", work: ["work-cal"]))
        // A read-only calendar is never chosen.
        XCTAssertNil(EventMirror.calendar(for: .work, facts: facts, calendars: calendars, writable: ["home-cal"], defaultId: nil, work: []))
    }

    func testAnEventInTheWrongCalendarMovesOnceTheDevicesTurnComes() {
        let e = event("s", "Apple picking", "2026-10-31T16:00:00.000Z", "2026-11-01T03:59:00.000Z", apple: "X")
        let a = AppleEvent(externalId: "X", localId: "L", title: "Apple picking", start: "2026-10-31T16:00:00.000Z", end: "2026-11-01T03:59:00.000Z", allDay: false, calendarId: "hobby-cal")
        let p = EventMirror.plan(events: [e], apple: ["X": a], state: [:], now: now, target: { _ in "home-cal" }) { _ in true }
        XCTAssertEqual(p.moves.map(\.calendarId), ["home-cal"])
        XCTAssertEqual(p.moves.first?.localId, "L")
        // The iPhone waits, so the Mac and the iPhone never both move it.
        XCTAssertTrue(EventMirror.plan(events: [e], apple: ["X": a], state: [:], now: now, target: { _ in "home-cal" }) { _ in false }.moves.isEmpty)
        // In the right calendar already: nothing to do.
        var right = a; right.calendarId = "home-cal"
        XCTAssertTrue(EventMirror.plan(events: [e], apple: ["X": right], state: [:], now: now, target: { _ in "home-cal" }) { _ in true }.moves.isEmpty)
    }

    func testWorkEventsMadeInTheAppAreMirroredButImportedOnesAreNot() {
        XCTAssertTrue(EventMirror.mirrors(event("w", "1:1", "2026-11-02T14:00:00.000Z", "2026-11-02T14:30:00.000Z", space: .work)))
        XCTAssertFalse(EventMirror.mirrors(event("i", "Standup", "2026-11-02T14:00:00.000Z", "2026-11-02T14:30:00.000Z", source: "eventkit", space: .work)))
    }

    private let now = ISO.date("2026-10-30T05:00:00.000Z")!

    private func event(_ id: String, _ title: String, _ start: String, _ end: String, allDay: Bool = false, apple: String? = nil,
                       source: String? = nil, space: Space = .personal, deleted: Bool = false, updated: String = "2026-10-30T04:00:00.000Z") -> Entity {
        var f: [String: JSONValue] = ["title": .string(title), "start": .string(start), "end": .string(end), "all_day": .bool(allDay)]
        if let a = apple { f["apple"] = .object(["id": .string(a)]) }
        if let s = source { f["source"] = .string(s) }
        return Entity(id: id, kind: .event, space: space, created_at: "2026-10-30T03:00:00.000Z", updated_at: updated, deleted_at: deleted ? ISO.now() : nil, fields: f)
    }

    func testNewAppEventsAreCreatedButImportedAndWorkEventsAreNot() {
        let events = [
            event("a", "Apple picking and movie night with Devon", "2026-10-31T12:00:00-04:00", "2026-10-31T23:59:00-04:00"),
            event("w", "Standup", "2026-10-31T10:00:00-04:00", "2026-10-31T10:15:00-04:00", source: "eventkit", space: .work),
            event("m", "1:1 with Dana", "2026-10-31T11:00:00-04:00", "2026-10-31T11:30:00-04:00", space: .work),
            event("o", "Old dinner", "2026-09-01T18:00:00-04:00", "2026-09-01T20:00:00-04:00"),
        ]
        let p = EventMirror.plan(events: events, apple: [:], state: [:], now: now, target: { $0.space == .work ? nil : "home" }) { _ in true }
        XCTAssertEqual(p.creates.map(\.entityId), ["a"])
        XCTAssertEqual(p.creates[0].calendarId, "home")
        XCTAssertEqual(p.creates[0].fields["start"], "2026-10-31T16:00:00.000Z")
        // The iPhone waits for the Mac's copy.
        XCTAssertTrue(EventMirror.plan(events: events, apple: [:], state: [:], now: now) { _ in false }.creates.isEmpty)
    }

    func testEditsFlowTheWayTheyWereMade() {
        let synced = ["title": "Dentist", "start": "2026-11-02T14:00:00.000Z", "end": "2026-11-02T15:00:00.000Z", "all_day": "0"]
        let state = ["e": SyncedEvent(appleId: "X", fields: synced)]
        let same = AppleEvent(externalId: "X", localId: "L", title: "Dentist", start: "2026-11-02T14:00:00.000Z", end: "2026-11-02T15:00:00.000Z", allDay: false)
        // Moved in the app: Apple Calendar is updated.
        let moved = event("e", "Dentist", "2026-11-02T15:00:00.000Z", "2026-11-02T16:00:00.000Z", apple: "X")
        let p1 = EventMirror.plan(events: [moved], apple: ["X": same], state: state, now: now) { _ in true }
        XCTAssertEqual(p1.writes.first?.fields["start"], "2026-11-02T15:00:00.000Z")
        XCTAssertTrue(p1.patches.isEmpty)
        // Renamed in Apple Calendar: the app is updated.
        var renamed = same; renamed.title = "Dentist (cleaning)"
        let p2 = EventMirror.plan(events: [event("e", "Dentist", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z", apple: "X")], apple: ["X": renamed], state: state, now: now) { _ in true }
        XCTAssertEqual(p2.patches.first?.fields["title"], .string("Dentist (cleaning)"))
        XCTAssertTrue(p2.writes.isEmpty)
    }

    func testDeletionsGoBothWaysButOnlyFromADeviceThatSawTheEvent() {
        let synced = ["e": SyncedEvent(appleId: "X", fields: [:])]
        let e = event("e", "Dentist", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z", apple: "X")
        // Gone from Apple Calendar on a device that had it: removed in the app.
        XCTAssertEqual(EventMirror.plan(events: [e], apple: [:], state: synced, now: now) { _ in true }.entityDeletes, ["e"])
        // A device that never saw it (iCloud has not caught up) leaves it alone.
        XCTAssertTrue(EventMirror.plan(events: [e], apple: [:], state: [:], now: now) { _ in true }.entityDeletes.isEmpty)
        // Deleted in the app: removed from Apple Calendar.
        let a = AppleEvent(externalId: "X", localId: "L", title: "Dentist", start: "2026-11-02T14:00:00.000Z", end: "2026-11-02T15:00:00.000Z", allDay: false)
        let gone = event("e", "Dentist", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z", apple: "X", deleted: true)
        XCTAssertEqual(EventMirror.plan(events: [gone], apple: ["X": a], state: synced, now: now) { _ in true }.appleDeletes, ["L"])
    }

    func testAllDayEventsMatchAcrossTheTwoEndConventions() {
        // The app ends an all-day event at the next midnight; EventKit at 23:59:59 the same day.
        let day = Calendar.current.startOfDay(for: ISO.date("2026-10-31T12:00:00.000Z")!)
        let next = day.addingTimeInterval(86400)
        let e = event("h", "Halloween", ISO.string(day), ISO.string(next), allDay: true, apple: "H")
        let a = AppleEvent(externalId: "H", localId: "L", title: "Halloween", start: ISO.string(day), end: ISO.string(next.addingTimeInterval(-1)), allDay: true)
        let p = EventMirror.plan(events: [e], apple: ["H": a], state: [:], now: now) { _ in true }
        XCTAssertTrue(p.writes.isEmpty && p.patches.isEmpty)
        XCTAssertEqual(p.state["h"]?.fields["start"], p.state["h"]?.fields["end"])
        let d = EventMirror.dates(p.state["h"]!.fields)!
        XCTAssertEqual(d.start, day); XCTAssertEqual(d.end, next)
    }
    func testAnAllDayEventStoredAtUTCMidnightKeepsItsDate() {
        // The web stores all-day events at UTC midnight; read as instants they fell on the evening before here.
        let e = event("w", "Tonight: dinner at Luigi's", "2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z", allDay: true)
        XCTAssertEqual(EventMirror.fields(of: e)["start"], "2026-10-31")
        XCTAssertEqual(EventMirror.fields(of: e)["end"], "2026-10-31")
        let offset = event("o", "Trip", "2026-11-07T00:00:00-05:00", "2026-11-09T00:00:00-05:00", allDay: true)
        XCTAssertEqual(EventMirror.fields(of: offset)["start"], "2026-11-07")
        XCTAssertEqual(EventMirror.fields(of: offset)["end"], "2026-11-08")
        let d = EventMirror.dates(EventMirror.fields(of: e))!
        XCTAssertEqual(LocalPlanner.dateString(d.start), "2026-10-31")
    }

    func testEventsMadeInThePersonalCalendarComeInOnceAndStayWhereTheyAre() {
        let mine = AppleEvent(externalId: "G1", localId: "L1", title: "Dinner with Mia", start: "2026-11-02T23:00:00.000Z", end: "2026-11-03T01:00:00.000Z",
                              allDay: false, modified: ISO.date("2026-10-30T04:00:00.000Z"), calendarId: "home-cal")
        let fresh = AppleEvent(externalId: "G2", localId: "L2", title: "Haircut", start: "2026-11-04T15:00:00.000Z", end: "2026-11-04T16:00:00.000Z",
                               allDay: false, modified: ISO.date("2026-10-30T04:59:30.000Z"), calendarId: "home-cal")
        let made = event("app", "Apple picking", "2026-10-31T16:00:00.000Z", "2026-10-31T20:00:00.000Z", apple: "G3")
        let madeCopy = AppleEvent(externalId: "G3", localId: "L3", title: "Apple picking", start: "2026-10-31T16:00:00.000Z", end: "2026-10-31T20:00:00.000Z", allDay: false, calendarId: "home-cal")
        // An app event whose link has not reached this device yet: same title and start.
        let pending = event("p", "Climbing", "2026-11-05T22:00:00.000Z", "2026-11-05T23:00:00.000Z")
        let pendingCopy = AppleEvent(externalId: "G4", localId: "L4", title: "Climbing", start: "2026-11-05T22:00:00.000Z", end: "2026-11-05T23:00:00.000Z", allDay: false, calendarId: "home-cal")
        let gone = event("gone", "Old plan", "2026-11-06T22:00:00.000Z", "2026-11-06T23:00:00.000Z", apple: "G5", deleted: true)
        let goneCopy = AppleEvent(externalId: "G5", localId: "L5", title: "Old plan", start: "2026-11-06T22:00:00.000Z", end: "2026-11-06T23:00:00.000Z", allDay: false, calendarId: "home-cal")
        let found = [mine, fresh, madeCopy, pendingCopy, goneCopy]
        let iPhone = EventMirror.adopt(found: found, calendarTitle: "robin.home@example.com", events: [made, pending, gone], now: now) {
            ($0.modified ?? .distantPast) < self.now.addingTimeInterval(-120)
        }
        XCTAssertEqual(iPhone.map(\.patch.id), [EventMirror.adoptedId("G1")])
        let p = iPhone[0].patch
        XCTAssertEqual(p.space, .personal)
        XCTAssertEqual(p.create, true)
        XCTAssertEqual(p.fields["title"], "Dinner with Mia")
        XCTAssertEqual(p.fields["apple"], .object(["id": "G1", "calendar": "robin.home@example.com", "from_apple": .bool(true)]))
        XCTAssertEqual(iPhone[0].state, SyncedEvent(appleId: "G1", fields: EventMirror.fields(of: mine), calendarId: mine.calendarId))
        // The Mac takes it at once; both devices make the same entity.
        XCTAssertEqual(EventMirror.adopt(found: found, calendarTitle: "x", events: [made, pending, gone], now: now).map(\.patch.id),
                       [EventMirror.adoptedId("G1"), EventMirror.adoptedId("G2")])

        // Once here it syncs like an app event, but moving it to another calendar in Apple Calendar is the owner's call.
        let here = Entity(id: p.id, kind: .event, space: .personal, created_at: "2026-10-30T05:00:00.000Z", updated_at: "2026-10-30T05:00:00.000Z", fields: p.fields)
        XCTAssertTrue(EventMirror.adopt(found: [mine], calendarTitle: "x", events: [here], now: now).isEmpty)
        var elsewhere = mine; elsewhere.calendarId = "family"
        let plan = EventMirror.plan(events: [here], apple: ["G1": elsewhere], state: [p.id: iPhone[0].state], now: now, target: { _ in "home-cal" }) { _ in true }
        XCTAssertTrue(plan.moves.isEmpty)
        var renamed = elsewhere; renamed.title = "Dinner with Mia and Devon"
        let edit = EventMirror.plan(events: [here], apple: ["G1": renamed], state: [p.id: iPhone[0].state], now: now, target: { _ in "home-cal" }) { _ in true }
        XCTAssertEqual(edit.patches.first?.fields["title"], "Dinner with Mia and Devon")
        XCTAssertEqual(EventMirror.plan(events: [here], apple: [:], state: [p.id: iPhone[0].state], now: now) { _ in true }.entityDeletes, [p.id])
    }
    func testAnEventMissingFromACalendarThisDeviceNoLongerHasIsNotDeleted() {
        let e = event("s", "Dentist", "2026-11-10T14:00:00.000Z", "2026-11-10T15:00:00.000Z", apple: "X")
        let snap = SyncedEvent(appleId: "X", fields: EventMirror.fields(of: e), calendarId: "gone")
        // The calendar went with its account (signed out, or switched off on this device): not a deletion.
        XCTAssertTrue(EventMirror.plan(events: [e], apple: [:], state: ["s": snap], now: now, present: ["home-cal"]) { _ in true }.entityDeletes.isEmpty)
        // The calendar is here and the event is not: deleted there, so in the app too.
        var here = snap; here.calendarId = "home-cal"
        XCTAssertEqual(EventMirror.plan(events: [e], apple: [:], state: ["s": here], now: now, present: ["home-cal"]) { _ in true }.entityDeletes, ["s"])
    }

    func testOnlyAChosenCalendarMovesAnEvent() {
        let e = event("s", "Apple picking", "2026-10-31T16:00:00.000Z", "2026-11-01T03:59:00.000Z", apple: "X")
        let a = AppleEvent(externalId: "X", localId: "L", title: "Apple picking", start: "2026-10-31T16:00:00.000Z", end: "2026-11-01T03:59:00.000Z", allDay: false, calendarId: "hobby-cal")
        // With no calendar named in memory, each device has its own default: no move, or two devices would ping-pong.
        XCTAssertTrue(EventMirror.plan(events: [e], apple: ["X": a], state: [:], now: now, target: { _ in "home-cal" }, moveTarget: { _ in nil }) { _ in true }.moves.isEmpty)
    }

    func testAnAllDayEventFromAppleKeepsItsDayEastOfUTC() {
        let saved = NSTimeZone.default
        NSTimeZone.default = TimeZone(identifier: "Europe/Berlin")!
        defer { NSTimeZone.default = saved }
        // Nov 10 all day in Berlin: local midnight is 23:00 UTC the day before.
        let a = AppleEvent(externalId: "G9", localId: "L9", title: "Trip", start: "2026-11-09T23:00:00.000Z", end: "2026-11-10T22:59:59.000Z", allDay: true, calendarId: "home-cal")
        let p = EventMirror.adopt(found: [a], calendarTitle: "x", events: [], now: now)[0].patch
        XCTAssertEqual(p.fields["start"], "2026-11-10T00:00:00.000Z")
        XCTAssertEqual(p.fields["end"], "2026-11-11T00:00:00.000Z")
        // Read back, it is still Nov 10.
        let e = Entity(id: p.id, kind: .event, fields: p.fields)
        XCTAssertEqual(EventMirror.fields(of: e)["start"], "2026-11-10")
        XCTAssertEqual(EventMirror.fields(of: e)["end"], "2026-11-10")
    }

}

@MainActor
final class EventMirrorEngineTests: XCTestCase {
    /// The engine's lists leave out deleted items; the mirror reads deletions from the store so they reach Apple Calendar.
    func testDeletedEventsAreStillReadableForTheMirror() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-mirror-\(UUID().uuidString)"), platform: .mac, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let e = await engine.create(kind: .event, fields: ["title": "Dentist", "start": "2026-11-02T14:00:00.000Z", "end": "2026-11-02T15:00:00.000Z", "apple": .object(["id": "X"])])!
        await engine.softDelete(e.id)
        XCTAssertTrue(engine.list(.event).isEmpty)
        let stored = try await engine.store.all(kind: .event, includeDeleted: true)
        XCTAssertEqual(stored.first?.id, e.id)
        XCTAssertTrue(stored.first?.isDeleted ?? false)
        let p = EventMirror.plan(events: stored, apple: ["X": AppleEvent(externalId: "X", localId: "L", title: "Dentist", start: "2026-11-02T14:00:00.000Z", end: "2026-11-02T15:00:00.000Z", allDay: false)],
                                 state: [e.id: SyncedEvent(appleId: "X", fields: [:])]) { _ in true }
        XCTAssertEqual(p.appleDeletes, ["L"])
    }
}
