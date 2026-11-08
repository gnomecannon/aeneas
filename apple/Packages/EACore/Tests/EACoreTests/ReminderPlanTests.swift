import XCTest
@testable import EACore

final class ReminderPlanTests: XCTestCase {
    private func reminder(_ id: String, at: Date, repeat: String? = nil, snoozed: Date? = nil, acked: Date? = nil, friction: Friction = .none, deleted: Bool = false) -> Entity {
        var f: [String: JSONValue] = ["title": .string("R \(id)"), "at": .string(ISO.string(at)), "friction": .string(friction.rawValue)]
        if let r = `repeat` { f["repeat"] = .string(r) }
        if let s = snoozed { f["snoozed_until"] = .string(ISO.string(s)) }
        if let a = acked { f["acknowledged_at"] = .string(ISO.string(a)) }
        return Entity(id: id, kind: .reminder, deleted_at: deleted ? ISO.now() : nil, fields: f)
    }

    func testPlanning() {
        let now = Date(timeIntervalSince1970: 1_792_000_000) // fixed instant
        let soon = now.addingTimeInterval(3600)
        let past = now.addingTimeInterval(-3600)
        let snoozeUntil = now.addingTimeInterval(600)

        let oneShot = reminder("a", at: soon)
        let pastOneShot = reminder("b", at: past)                     // overdue, hub fires it; nothing to schedule
        let snoozedPast = reminder("c", at: past, snoozed: snoozeUntil) // fires at snoozed_until
        let acked = reminder("d", at: soon, acked: now)                 // acknowledged one shot: skip
        let repeating = reminder("e", at: past, repeat: "every 1 hours") // next occurrences only
        let deleted = reminder("f", at: soon, deleted: true)
        let needsReason = reminder("g", at: soon.addingTimeInterval(60), friction: .reason)

        let plan = ReminderPlanner.plan(reminders: [oneShot, pastOneShot, snoozedPast, acked, repeating, deleted, needsReason], now: now, perReminder: 3)
        let byReminder = Dictionary(grouping: plan, by: \.reminderId)

        XCTAssertEqual(byReminder["a"]?.map(\.fireAt), [soon])
        XCTAssertNil(byReminder["b"])
        XCTAssertEqual(byReminder["c"]?.map(\.fireAt), [snoozeUntil])
        XCTAssertNil(byReminder["d"])
        XCTAssertNil(byReminder["f"])
        XCTAssertEqual(byReminder["g"]?.first?.friction, .reason)
        // A reminder saved with the removed "witness" option still needs a reason.
        XCTAssertEqual(try JSONDecoder().decode([Friction].self, from: Data(#"["witness","none"]"#.utf8)), [.reason, .none])

        let e = byReminder["e"]!.map(\.fireAt)
        XCTAssertEqual(e.count, 3)
        XCTAssertEqual(e[0], past.addingTimeInterval(2 * 3600))
        XCTAssertEqual(e[1], past.addingTimeInterval(3 * 3600))
        XCTAssertTrue(e.allSatisfy { $0 > now })

        // sorted by fire time and ids unique
        XCTAssertEqual(plan.map(\.fireAt), plan.map(\.fireAt).sorted())
        XCTAssertEqual(Set(plan.map(\.id)).count, plan.count)
    }

    func testLimit() {
        let now = Date()
        let many = (0..<100).map { reminder("r\($0)", at: now.addingTimeInterval(Double($0 + 1) * 60)) }
        XCTAssertEqual(ReminderPlanner.plan(reminders: many, now: now, limit: 60).count, 60)
    }
}

final class TaskReminderTests: XCTestCase {
    func testTaskWithRemindAtIsPlannedAndDoneTaskIsNot() {
        let now = ISO.date("2026-10-28T12:00:00.000Z")!
        let open = Entity(kind: .task, fields: ["title": "Call the vet", "status": "scheduled", "order": 1, "remind_at": "2026-10-28T15:00:00.000Z", "friction": "reason"])
        let done = Entity(kind: .task, fields: ["title": "Old", "status": "done", "order": 2, "remind_at": "2026-10-28T16:00:00.000Z"])
        let plain = Entity(kind: .task, fields: ["title": "No reminder", "status": "next", "order": 3, "due": "2026-10-28T16:00:00.000Z"])
        XCTAssertEqual(open.reminderFields?.friction, .reason)
        XCTAssertNil(done.reminderFields)
        XCTAssertNil(plain.reminderFields)
        let plan = ReminderPlanner.plan(reminders: [open, done, plain], now: now)
        XCTAssertEqual(plan.map(\.title), ["Call the vet"])
        XCTAssertEqual(plan.first?.reminderId, open.id)
    }

    func testCompleteTaskRollsARepeatAndFinishesAOneOff() {
        let now = ISO.date("2026-10-21T09:00:00.000Z")!
        let weekly = Entity(kind: .task, fields: ["title": "B12", "status": "scheduled", "order": 1, "remind_at": "2026-10-20T13:00:00.000Z", "due": "2026-10-20T15:00:00.000Z", "repeat": "every 1 weeks"])
        let p = ReminderMath.completeTask(weekly, now: now)
        XCTAssertEqual(p["remind_at"]?.stringValue, "2026-10-27T13:00:00.000Z")
        XCTAssertEqual(p["due"]?.stringValue, "2026-10-27T15:00:00.000Z")
        XCTAssertNil(p["status"])
        let once = Entity(kind: .task, fields: ["title": "Vet", "status": "scheduled", "order": 1, "remind_at": "2026-10-20T13:00:00.000Z"])
        XCTAssertEqual(ReminderMath.completeTask(once, now: now)["status"]?.stringValue, "done")
    }
}
