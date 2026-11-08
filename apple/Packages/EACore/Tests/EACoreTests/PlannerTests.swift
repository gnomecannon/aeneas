import XCTest
@testable import EACore

final class PlannerTests: XCTestCase {

    // MARK: kinds

    func testWatchFieldsRoundTrip() throws {
        let json = """
        {"title":"Wildcard cert","category":"cert","due":"2026-12-01T00:00:00.000Z","lead_days":14,"repeat":"every 1 years","probe_url":"https://hub.example","cost":12.5,"url":"https://renew","notes":"n","reminder_id":"r1","last_probe":"2026-10-20T04:00:00.000Z","last_probe_error":"timeout","renewed_at":"2025-12-01T00:00:00.000Z"}
        """
        let w = try JSONCoding.decode(WatchFields.self, from: json)
        XCTAssertEqual(w.category, .cert)
        XCTAssertEqual(w.lead_days, 14)
        XCTAssertEqual(w.repeat, "every 1 years")
        XCTAssertEqual(w.cost, 12.5)
        XCTAssertEqual(w.last_probe_error, "timeout")
        // Encoded keys are the contract's names, verbatim.
        let back = try JSONSerialization.jsonObject(with: try JSONCoding.data(w)) as! [String: Any]
        XCTAssertEqual(Set(back.keys), ["title", "category", "due", "lead_days", "repeat", "probe_url", "cost", "url", "notes", "reminder_id", "last_probe", "last_probe_error", "renewed_at"])
        XCTAssertEqual(back["category"] as? String, "cert")

        // Through an Entity, as the store holds it.
        let e = Entity(kind: .watch, fields: ["title": "Domain", "category": "domain", "due": "2027-01-01"])
        XCTAssertEqual(e.decoded(WatchFields.self)?.category, .domain)
        XCTAssertEqual(try JSONCoding.decode(Entity.self, from: try JSONCoding.data(e)).kind, .watch)
        XCTAssertEqual(Kind(rawValue: "plan_rule"), .plan_rule)
        XCTAssertEqual(WatchCategory.allCases.map(\.rawValue), ["cert", "subscription", "prescription", "insurance", "rma", "warranty", "domain", "other"])
    }

    func testPlanRuleFieldsRoundTrip() throws {
        let json = """
        {"title":"Kids week","type":"blackout","days":["mon","tue","wed"],"start":"15:00","end":"24:00","alternating_anchor":"2026-10-19","note":"custody","active":false}
        """
        let r = try JSONCoding.decode(PlanRuleFields.self, from: json)
        XCTAssertEqual(r.type, .blackout)
        XCTAssertEqual(r.days, [.mon, .tue, .wed])
        XCTAssertEqual(r.end, "24:00")
        XCTAssertEqual(r.alternating_anchor, "2026-10-19")
        XCTAssertEqual(r.active, false)
        let back = try JSONSerialization.jsonObject(with: try JSONCoding.data(r)) as! [String: Any]
        XCTAssertEqual(back["days"] as? [String], ["mon", "tue", "wed"])
        XCTAssertEqual(back["type"] as? String, "blackout")
        XCTAssertEqual(PlanRuleType.allCases.map(\.rawValue), ["blackout", "commitment", "preference", "info"])
        XCTAssertEqual(Weekday.allCases.map(\.rawValue), ["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
    }

    func testLogCheckins() throws {
        let json = """
        {"type":"activity","value":"Homelab","at":"2026-10-23T09:00:00.000Z","checkins":["2026-10-23T12:00:00.000Z","2026-10-23T15:00:00.000Z"]}
        """
        let l = try JSONCoding.decode(LogFields.self, from: json)
        XCTAssertEqual(l.checkins?.count, 2)
        XCTAssertEqual(l.value.stringValue, "Homelab")
        let plain = LogFields(type: .weight, value: .number(242), unit: "lb", at: "2026-10-23T09:00:00.000Z")
        let back = try JSONSerialization.jsonObject(with: try JSONCoding.data(plain)) as! [String: Any]
        XCTAssertNil(back["checkins"])
    }

    // MARK: planner routes

    func testPlannerRoutesAndConflict() async throws {
        let t = FakeTransport()
        let c = HubClient(transport: t)

        t.responses = [(200, Data("""
        {"start":"2026-10-19","days":[{"date":"2026-10-19","blocks":[{"task_id":"t1","title":"Fix NAS","start":"2026-10-19T14:00:00.000Z","end":"2026-10-19T17:00:00.000Z","status":"scheduled"}],"events":[],"commitments":[{"rule_id":"r1","title":"Work","start":"2026-10-19T13:00:00.000Z","end":"2026-10-19T21:00:00.000Z","type":"commitment"}],"reminders":[],"watches_due":[],"free_slots":[{"start":"2026-10-19T21:00:00.000Z","end":"2026-10-20T03:00:00.000Z","hours":6}]}]}
        """.utf8))]
        let w = try await c.plannerWeek(start: "2026-10-19", minHours: 3)
        XCTAssertEqual(t.calls.last?.path, "planner/week")
        XCTAssertEqual(t.calls.last?.query, ["start": "2026-10-19", "min_hours": "3"])
        XCTAssertEqual(w.days.first?.blocks.first?.task_id, "t1")
        XCTAssertEqual(w.days.first?.commitments.first?.type, .commitment)
        XCTAssertEqual(w.days.first?.free_slots.first?.hours, 6)

        t.responses = [(200, Data("""
        {"date":"2026-10-23","now":null,"next":[],"blocks":[],"commitments":[],"reminders_due":[],"watches_due_soon":[],"captures_unprocessed":2,"free_slots":[],"digest":"Nothing planned today\\n2 captures to sort"}
        """.utf8))]
        let today = try await c.plannerToday()
        XCTAssertEqual(t.calls.last?.path, "planner/today")
        XCTAssertNil(today.now)
        XCTAssertEqual(today.captures_unprocessed, 2)
        XCTAssertEqual(today.digest.split(separator: "\n").count, 2)

        // 409 becomes a typed conflict carrying the payload, from `detail`.
        t.responses = [(409, Data("""
        {"error":"conflict","detail":{"kind":"blackout","title":"Kids week","start":"2026-10-23T15:00:00.000Z","end":"2026-10-24T00:00:00.000Z","rule_id":"r9"}}
        """.utf8))]
        do {
            _ = try await c.plannerSchedule(taskId: "t1", start: "2026-10-23T16:00:00.000Z", hours: 3)
            XCTFail("expected conflict")
        } catch let h as HubError {
            XCTAssertTrue(h.isConflict)
            let conflict = try XCTUnwrap(h.plannerConflict)
            XCTAssertEqual(conflict.kind, "blackout")
            XCTAssertEqual(conflict.title, "Kids week")
            XCTAssertEqual(conflict.rule_id, "r9")
            XCTAssertEqual(conflict.start, "2026-10-23T15:00:00.000Z")
            XCTAssertTrue(h.errorDescription?.contains("Kids week") == true)
        }
        let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(t.calls.last?.body)) as! [String: Any]
        XCTAssertEqual(sent["task_id"] as? String, "t1")
        XCTAssertEqual(sent["hours"] as? Double, 3)
        XCTAssertNil(sent["force"])

        // A top-level conflict body (no `detail`) decodes too; `force` is sent when asked.
        t.responses = [(409, Data("{\"error\":\"conflict\",\"task_id\":\"t2\",\"title\":\"Other block\",\"start\":\"2026-10-23T16:00:00.000Z\",\"end\":\"2026-10-23T19:00:00.000Z\"}".utf8))]
        do { _ = try await c.plannerSchedule(taskId: "t1", start: "2026-10-23T16:00:00.000Z", force: true); XCTFail("expected conflict") }
        catch let h as HubError { XCTAssertEqual(h.plannerConflict?.task_id, "t2"); XCTAssertEqual(h.plannerConflict?.title, "Other block") }
        let forced = try JSONSerialization.jsonObject(with: try XCTUnwrap(t.calls.last?.body)) as! [String: Any]
        XCTAssertEqual(forced["force"] as? Bool, true)

        // A success returns the task with its block.
        t.responses = [(200, Data("{\"id\":\"t1\",\"kind\":\"task\",\"fields\":{\"title\":\"Fix NAS\",\"status\":\"scheduled\",\"order\":1,\"block\":{\"start\":\"2026-10-23T16:00:00.000Z\",\"end\":\"2026-10-23T19:00:00.000Z\"}}}".utf8))]
        let scheduled = try await c.plannerSchedule(taskId: "t1", start: "2026-10-23T16:00:00.000Z")
        XCTAssertEqual(scheduled.decoded(TaskFields.self)?.status, .scheduled)

        t.responses = [(200, Data("{\"id\":\"t1\",\"kind\":\"task\",\"fields\":{\"title\":\"Fix NAS\",\"status\":\"next\",\"order\":1}}".utf8))]
        let un = try await c.plannerUnschedule(taskId: "t1")
        XCTAssertEqual(t.calls.last?.path, "planner/unschedule")
        XCTAssertEqual(un.str("status"), "next")

        t.responses = [(200, Data("{\"id\":\"w1\",\"kind\":\"watch\",\"fields\":{\"title\":\"Cert\",\"category\":\"cert\",\"due\":\"2027-12-01\",\"renewed_at\":\"2026-10-23T00:00:00.000Z\"}}".utf8))]
        let renewed = try await c.watchRenewed(id: "w1")
        XCTAssertEqual(t.calls.last?.method, "POST")
        XCTAssertEqual(t.calls.last?.path, "watches/w1/renewed")
        XCTAssertEqual(renewed?.decoded(WatchFields.self)?.renewed_at, "2026-10-23T00:00:00.000Z")
    }

    func testNotifyKinds() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: "event: notify"))
        XCTAssertNil(p.feed(line: "data: {\"kind\":\"activity\",\"title\":\"On Homelab for 3 h\",\"log_id\":\"l1\"}"))
        let m = p.feed(line: "")!
        XCTAssertEqual(m.event, "notify")
        XCTAssertEqual(SyncEngine.activityName(fromTitle: "On Homelab for 3 h"), "Homelab")
        XCTAssertEqual(SyncEngine.hours(fromTitle: "On Homelab for 3 h"), 3)
        XCTAssertEqual(SyncEngine.activityName(fromTitle: "On Game dev for 4 h"), "Game dev")
    }

    // MARK: local planner

    func testLocalPlannerDayWindowAndRules() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let monday = LocalPlanner.monday(of: Date(), calendar: cal)
        XCTAssertEqual(LocalPlanner.weekday(monday, calendar: cal), .mon)
        let tomorrow = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: Date()))!
        let dayName = LocalPlanner.weekday(tomorrow, calendar: cal)

        let work = Entity(kind: .plan_rule, fields: ["title": "Work", "type": "commitment", "days": .array([.string(dayName.rawValue)]), "start": "09:00", "end": "17:00"])
        let blackout = Entity(kind: .plan_rule, fields: ["title": "Late", "type": "blackout", "days": .array([.string(dayName.rawValue)]), "start": "21:00", "end": "24:00"])
        let off = Entity(kind: .plan_rule, fields: ["title": "Off", "type": "blackout", "days": .array([.string(dayName.rawValue)]), "start": "17:00", "end": "18:00", "active": false])
        let day = LocalPlanner.day(tomorrow, tasks: [], rules: [work, blackout, off], events: [], reminders: [], watches: [], minHours: 3, now: Date(), calendar: cal)
        XCTAssertEqual(day.commitments.map(\.title), ["Work", "Late"])
        XCTAssertEqual(day.free_slots.count, 1)
        XCTAssertEqual(day.free_slots.first?.hours, 4)   // 17:00 to 21:00
        XCTAssertEqual(ISO.date(day.free_slots.first!.start), LocalPlanner.time(on: tomorrow, hhmm: "17:00", calendar: cal))

        // A block inside the free slot splits it; the remainder is under 3 h so no slot is left.
        let s = LocalPlanner.time(on: tomorrow, hhmm: "17:30", calendar: cal)!
        let task = Entity(kind: .task, fields: ["title": "Fix NAS", "status": "scheduled", "order": 1, "block": .object(["start": .string(ISO.string(s)), "end": .string(ISO.string(s.addingTimeInterval(3 * 3600)))])])
        let day2 = LocalPlanner.day(tomorrow, tasks: [task], rules: [work, blackout], events: [], reminders: [], watches: [], minHours: 3, now: Date(), calendar: cal)
        XCTAssertEqual(day2.blocks.first?.title, "Fix NAS")
        XCTAssertTrue(day2.free_slots.isEmpty)
        XCTAssertTrue(LocalPlanner.day(cal.date(byAdding: .day, value: -1, to: tomorrow)!.addingTimeInterval(-86400), tasks: [], rules: [], events: [], reminders: [], watches: [], now: Date(), calendar: cal).free_slots.isEmpty)
    }

    func testAlternatingAnchor() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let anchor = LocalPlanner.dateString(LocalPlanner.monday(of: Date(), calendar: cal))
        let rule = PlanRuleFields(title: "Kids", type: .blackout, days: Weekday.allCases, start: "15:00", end: "24:00", alternating_anchor: anchor)
        let thisWeek = Date()
        let nextWeek = cal.date(byAdding: .day, value: 7, to: thisWeek)!
        let twoWeeks = cal.date(byAdding: .day, value: 14, to: thisWeek)!
        XCTAssertTrue(LocalPlanner.applies(rule, on: thisWeek, calendar: cal))
        XCTAssertFalse(LocalPlanner.applies(rule, on: nextWeek, calendar: cal))
        XCTAssertTrue(LocalPlanner.applies(rule, on: twoWeeks, calendar: cal))
        XCTAssertNil(LocalPlanner.minutes("25:00"))
        XCTAssertEqual(LocalPlanner.minutes("24:00"), 1440)
    }

    func testWatchesDueSoonAndDigest() {
        let now = Date()
        let soon = Entity(kind: .watch, fields: ["title": "Cert", "category": "cert", "due": .string(ISO.string(now.addingTimeInterval(5 * 86400)))])
        let later = Entity(kind: .watch, fields: ["title": "Domain", "category": "domain", "due": .string(ISO.string(now.addingTimeInterval(90 * 86400)))])
        let overdue = Entity(kind: .watch, fields: ["title": "Rx", "category": "prescription", "due": .string(ISO.string(now.addingTimeInterval(-86400)))])
        let due = LocalPlanner.watchesDueSoon([later, soon, overdue], days: 30, now: now)
        XCTAssertEqual(due.map { $0.str("title") }, ["Rx", "Cert"])
        let day = PlannerDay(date: LocalPlanner.dateString(now))
        let digest = LocalPlanner.digest(for: day, now: Entity(kind: .task, fields: ["title": "Fix NAS", "status": "next"]), watchesDueSoon: due, capturesUnprocessed: 3)
        let lines = digest.split(separator: "\n")
        XCTAssertTrue((2...4).contains(lines.count))
        XCTAssertEqual(lines.first, "Now: Fix NAS")
        XCTAssertTrue(digest.contains("2 renewals due soon"))
        XCTAssertFalse(digest.contains("\u{2014}"))
    }
}
