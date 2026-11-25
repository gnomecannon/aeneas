import XCTest
@testable import EACore

/// Invitations (Invitations.swift): the list's cases in packages/shared/test/invitation-cases.json, which packages/shared
/// and the web read too, so every device lists the same invitations; the device's own detection of pending invitations
/// in Apple Calendar and what it writes; and declined events left out.
final class InvitationsTests: XCTestCase {
    private struct Cases: Decodable {
        struct Item: Decodable { var id: String; var deleted_at: String?; var updated_at: String?; var fields: [String: JSONValue] }
        struct Case: Decodable { var name: String; var items: [Item]; var pending: [String]; var answered: [String]; var count: Int }
        var now: String
        var cases: [Case]
    }

    private func load() throws -> Cases {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages, apple: the repository
        return try JSONDecoder().decode(Cases.self, from: Data(contentsOf: root.appendingPathComponent("packages/shared/test/invitation-cases.json")))
    }

    private func invitation(_ id: String, _ fields: [String: JSONValue], deleted: String? = nil, updated: String = "2026-11-25T00:00:00.000Z") -> Entity {
        var e = Entity(id: id, kind: .invitation, fields: fields)
        e.deleted_at = deleted
        e.updated_at = updated
        return e
    }

    func testTheSameListAsEveryOtherClient() throws {
        let file = try load()
        let now = try XCTUnwrap(ISO.date(file.now))
        for c in file.cases {
            let items = c.items.map { invitation($0.id, $0.fields, deleted: $0.deleted_at, updated: $0.updated_at ?? "2026-11-25T00:00:00.000Z") }
            let out = Invitations.list(items, now: now)
            XCTAssertEqual(out.pending.map(\.id), c.pending, c.name)
            XCTAssertEqual(out.answered.map(\.id), c.answered, c.name)
            XCTAssertEqual(out.count, c.count, c.name)
        }
    }

    func testRowWords() {
        let e = invitation("a", ["title": "Dinner", "organizer": ["name": "Alex", "address": "alex@example.com"], "answer": "accepted",
                                 "reply": ["outbox": "o", "state": "waiting", "answer": "accepted", "was": "needs_action", "send_at": "2026-11-25T12:00:00.000Z"]])
        XCTAssertEqual(Invitations.organizer(e), "Alex")
        XCTAssertEqual(Invitations.replyLine(e)?.text, "Sending your answer to Alex.")
        XCTAssertEqual(Invitations.replyLine(e)?.undo, true)
        XCTAssertEqual(Invitations.chosen(e), .accepted)
        let failed = invitation("b", ["answer": "declined", "reply": ["outbox": "o", "state": "failed", "answer": "declined", "was": "needs_action", "send_at": "2026-11-25T12:00:00.000Z", "error": "The server could not be reached."]])
        XCTAssertEqual(Invitations.replyLine(failed)?.text, "Not sent: The server could not be reached.")
        XCTAssertEqual(Invitations.replyLine(failed)?.retry, true)
        XCTAssertNil(Invitations.replyLine(invitation("c", ["answer": "accepted", "reply": ["state": "sent"]])))
        XCTAssertEqual(Invitations.Texts.count(1), "1 invitation")
        XCTAssertEqual(Invitations.Texts.count(3), "3 invitations")
        XCTAssertEqual(Invitations.Answer.tentative.label, "Maybe")
        XCTAssertEqual(Invitations.Answer.tentative.done, "Maybe.")
        XCTAssertEqual(Invitations.Texts.none, "No invitations need an answer.")
        // The Calendar app at the event's day: seconds since 2001.
        XCTAssertEqual(Invitations.calshowURL(Date(timeIntervalSinceReferenceDate: 786_000_000))?.absoluteString, "calshow:786000000")
    }

    func testWhenAndTodaysLine() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        let allDay = invitation("a", ["title": "Retreat", "all_day": true, "start": "2026-11-27T00:00:00.000Z", "end": "2026-11-30T00:00:00.000Z"])
        XCTAssertTrue(Invitations.when(allDay, calendar: cal).hasSuffix(", all day"))
        XCTAssertTrue(Invitations.when(allDay, calendar: cal).contains(" to "), "three days")
        let one = invitation("b", ["title": "Picnic", "all_day": true, "start": "2026-11-27T00:00:00.000Z", "end": "2026-11-28T00:00:00.000Z"])
        XCTAssertFalse(Invitations.when(one, calendar: cal).contains(" to "))
        XCTAssertFalse(Invitations.when(one, calendar: cal).contains("2026"), "no year, as Week names days")
        let now = try XCTUnwrap(ISO.date("2026-11-25T12:00:00.000Z"))
        let rows = [invitation("c", ["title": "Dinner", "answer": "needs_action", "uid": "1", "answer_by": "mail", "start": "2026-11-28T00:00:00.000Z", "end": "2026-11-28T02:00:00.000Z", "organizer": ["name": "Alex"]]),
                    invitation("d", ["title": "Lunch", "answer": "needs_action", "uid": "2", "answer_by": "caldav", "start": "2026-11-29T17:00:00.000Z", "end": "2026-11-29T18:00:00.000Z"])]
        let need = try XCTUnwrap(Invitations.need(rows, now: now, calendar: cal))
        XCTAssertEqual(need.count, 2)
        XCTAssertTrue(need.detail.hasPrefix("Dinner, "))
        XCTAssertTrue(need.detail.hasSuffix(", from Alex"))
        XCTAssertNil(Invitations.need([invitation("e", ["answer": "accepted", "answered_at": "2026-11-25T11:00:00.000Z", "uid": "3", "start": "2026-11-28T00:00:00.000Z", "end": "2026-11-28T02:00:00.000Z"])], now: now))
        // Today's Needs you: one row for them, after the reminders.
        let needs = TodayBoard.needsYou(reminders: [], watches: [], meds: [], unsorted: 1, now: now, invitations: (need.count, need.detail))
        XCTAssertEqual(needs.map(\.id), ["invitations", "unsorted"])
        XCTAssertEqual(needs.first?.title, "2 invitations")
    }

    // MARK: Apple Calendar on this device

    private let now = ISO.date("2026-11-25T12:00:00.000Z")!
    private func found(_ id: String, status: Invitations.DeviceInvite.Status = .pending, start: TimeInterval = 86_400, organizedByMe: Bool = false, cancelled: Bool = false,
                       space: Space = .personal) -> Invitations.DeviceInvite {
        Invitations.DeviceInvite(externalId: id, eventIdentifier: "EK-\(id)", title: "Review \(id)", start: now.addingTimeInterval(start), end: now.addingTimeInterval(start + 3600),
                                 location: "Room 3B", organizerName: "Robin", organizerAddress: "Robin@Example.com", status: status, organizedByMe: organizedByMe, cancelled: cancelled, space: space)
    }

    func testPendingDetection() {
        XCTAssertTrue(found("a").isPending(now: now))
        XCTAssertFalse(found("a", status: .accepted).isPending(now: now), "answered already")
        XCTAssertFalse(found("a", organizedByMe: true).isPending(now: now), "the owner's own meeting")
        XCTAssertFalse(found("a", cancelled: true).isPending(now: now))
        XCTAssertFalse(found("a", start: -7200).isPending(now: now), "over")
        XCTAssertEqual(found("a", status: .tentative).answer, "tentative")
        XCTAssertNil(found("a", status: .other).answer)
    }

    func testWhatTheDeviceWrites() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        // New: a pending one, in its calendar's space; not one answered before the app saw it, nor one iCloud or mail has.
        let hub = invitation("h", ["uid": "from-mail", "answer_by": "mail", "answer": "needs_action"])
        let p1 = Invitations.plan(found: [found("a", space: .work), found("b", status: .accepted), found("from-mail"), found("mine", organizedByMe: true)],
                                  existing: [hub], device: "iphone-1", now: now, calendar: cal)
        XCTAssertEqual(p1.count, 1)
        let made = try XCTUnwrap(p1.first)
        XCTAssertEqual(made.id, Invitations.deviceId("a"))
        XCTAssertEqual(made.create, true)
        XCTAssertEqual(made.space, .work)
        XCTAssertEqual(made.fields["answer"], "needs_action")
        XCTAssertEqual(made.fields["answer_by"], "open_in_calendar")
        XCTAssertEqual(made.fields["uid"], "a")
        XCTAssertEqual(made.fields["organizer"], ["name": "Robin", "address": "robin@example.com"])
        XCTAssertEqual(made.fields["from"], ["kind": "device", "device": "iphone-1", "event": "EK-a"])
        XCTAssertNil(made.fields["notes"])
        XCTAssertNil(made.fields["attendees"], "never the other attendees")
        // The same on every device: from the external identifier.
        XCTAssertEqual(Invitations.deviceId("a"), StableID.uuid("eventkit-invite:a"))

        // Answered already in Google Calendar, which the iPhone shows: the mail copy that still waits takes the answer.
        let p0 = Invitations.plan(found: [found("from-mail", status: .accepted)], existing: [hub], device: "iphone-1", now: now, calendar: cal)
        XCTAssertEqual(p0.map(\.id), ["h"])
        XCTAssertEqual(p0.first?.fields["answer"], "accepted")
        var sending = hub
        sending.fields["reply"] = ["outbox": "o", "state": "waiting", "answer": "declined", "was": "needs_action", "send_at": "2026-11-25T12:00:00.000Z"]
        XCTAssertEqual(Invitations.plan(found: [found("from-mail", status: .accepted)], existing: [sending], device: "iphone-1", now: now, calendar: cal).count, 0, "not over an answer being sent")

        // Answered in Calendar: the answer is written. Gone from the calendar: the one this device wrote is deleted.
        var mine = invitation(Invitations.deviceId("a"), made.fields)
        var theirs = invitation(Invitations.deviceId("z"), made.fields.merging(["uid": "z", "from": ["kind": "device", "device": "mac-1", "event": "EK-z"]]) { _, b in b })
        mine.space = .work
        theirs.space = .work
        let p2 = Invitations.plan(found: [found("a", status: .declined, space: .work)], existing: [mine, theirs], device: "iphone-1", now: now, calendar: cal)
        XCTAssertEqual(p2.count, 1)
        XCTAssertEqual(p2[0].fields["answer"], "declined")
        XCTAssertNotNil(p2[0].fields["answered_at"])
        let p3 = Invitations.plan(found: [], existing: [mine, theirs], device: "iphone-1", now: now, calendar: cal)
        XCTAssertEqual(p3.map(\.id), [mine.id], "only what this device wrote")
        XCTAssertNotNil(p3[0].fields["deleted_at"])
        // Nothing changed: nothing written.
        XCTAssertEqual(Invitations.plan(found: [found("a", space: .work)], existing: [mine], device: "iphone-1", now: now, calendar: cal).count, 0)
    }

    func testAllDayAsTheAppKeepsIt() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        let start = try XCTUnwrap(cal.date(from: DateComponents(year: 2026, month: 11, day: 27)))
        let end = try XCTUnwrap(cal.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 23, minute: 59, second: 59)))
        let d = Invitations.DeviceInvite(externalId: "x", eventIdentifier: "EK", title: "Fair", start: start, end: end, allDay: true, status: .pending)
        let p = Invitations.plan(found: [d], existing: [], device: "d", now: now, calendar: cal)
        XCTAssertEqual(p.first?.fields["start"], "2026-11-27T00:00:00.000Z")
        XCTAssertEqual(p.first?.fields["end"], "2026-11-28T00:00:00.000Z")
    }

    func testDeclinedEventsAreLeftOut() {
        let shows = TaskVisibility(nil)
        XCTAssertTrue(shows.shows(Entity(id: "e", kind: .event, fields: ["title": "Standup"])))
        XCTAssertFalse(shows.shows(Entity(id: "e", kind: .event, fields: ["title": "Standup", "declined": true])))
        XCTAssertTrue(Entity(id: "e", kind: .event, fields: ["declined": true]).isDeclined)
        XCTAssertFalse(Entity(id: "t", kind: .task, fields: ["declined": true]).isDeclined)
    }
}
