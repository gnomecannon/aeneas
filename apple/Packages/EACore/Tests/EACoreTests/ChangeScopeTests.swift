import XCTest
@testable import EACore

/// A change that comes in reworks only what reads its kind: lists of other kinds, the values kept from them (Today's
/// plan, the reminders), the widgets and the planned notifications stay as they were. A sensor's reading or a monitor's
/// check used to make all of them again.
@MainActor
final class ChangeScopeTests: XCTestCase {
    private func engine() async throws -> SyncEngine {
        let e = SyncEngine(config: SharedConfig(suiteName: "scope-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        e.schedulesNotifications = false
        let soon = ISO.string(Date().addingTimeInterval(3600))
        var items: [Entity] = []
        for i in 0..<40 {
            items.append(Entity(kind: .task, fields: ["title": .string("Task \(i)"), "status": .string(i % 3 == 0 ? "next" : "inbox"), "order": .number(Double(i)),
                                                      "remind_at": .string(i % 4 == 0 ? ISO.string(Date().addingTimeInterval(Double(i) * 600)) : "")]))
        }
        items.append(Entity(kind: .event, fields: ["title": "Lunch", "start": .string(soon), "end": .string(ISO.string(Date().addingTimeInterval(7200)))]))
        for i in 0..<5 { items.append(Entity(kind: .sensor, fields: ["name": .string("probe\(i)"), "last_value": .number(Double(i))])) }
        items.append(Entity(kind: .monitor, fields: ["name": "web", "state": "up"]))
        await e.absorb(items)
        return e
    }

    func testASensorChangeKeepsWhatIsWorkedOutFromTasksAndATaskChangeDoesNot() async throws {
        let e = try await engine()
        var made = 0
        let now = Date()
        func plan() -> PlannerDay { e.kept("test.plan", kinds: [.task, .event]) { made += 1; return e.localDay(now, now: now) } }
        let first = plan()
        XCTAssertEqual(made, 1)
        let reminders = e.reminders
        XCTAssertEqual(reminders.count, 10)

        // A sensor and a monitor change: nothing that reads tasks or events is worked out again.
        var probe = try XCTUnwrap(e.list(.sensor).first)
        probe.fields["last_value"] = .number(99)
        probe.updated_at = ISO.now()
        var web = try XCTUnwrap(e.list(.monitor).first)
        web.fields["state"] = .string("down")
        await e.absorb([probe, web])
        XCTAssertEqual(e.list(.sensor).first { $0.id == probe.id }?.number("last_value"), 99, "the sensor's list shows the change")
        XCTAssertEqual(e.list(.monitor).first?.str("state"), "down")
        XCTAssertEqual(plan(), first)
        XCTAssertEqual(made, 1, "Today's plan is kept through a sensor's change")

        // A task change: worked out again, and it shows.
        let t = try XCTUnwrap(e.list(.task).first { $0.str("status") == "inbox" && $0.str("remind_at").isEmpty })
        _ = await e.update(t.id, fields: ["remind_at": .string(ISO.string(Date().addingTimeInterval(-3600)))])
        _ = plan()
        XCTAssertEqual(made, 2)
        XCTAssertEqual(e.reminders.count, 11)
        XCTAssertEqual(e.reminders.first?.id, t.id, "the new reminder is the soonest")
    }

    func testAListRebuiltForOneKindIsTheListAWholeRebuildGives() async throws {
        let e = try await engine()
        _ = e.list(.task)
        var changed: [Entity] = []
        for (i, t) in e.list(.task).prefix(6).enumerated() {
            var c = t
            c.fields["title"] = .string("Renamed \(i)")
            c.updated_at = ISO.now()
            changed.append(c)
        }
        // One deleted, one new.
        var gone = try XCTUnwrap(e.list(.task).last)
        gone.deleted_at = ISO.now()
        changed.append(gone)
        changed.append(Entity(kind: .task, fields: ["title": "New one", "status": "next", "order": 100]))
        await e.absorb(changed)
        let scoped = e.list(.task).map(\.id)
        let sensors = e.list(.sensor).map(\.id)
        e.byKind = nil
        XCTAssertEqual(e.list(.task).map(\.id), scoped, "same items in the same order")
        XCTAssertEqual(e.list(.sensor).map(\.id), sensors)
        XCTAssertFalse(scoped.contains(gone.id))
        XCTAssertEqual(scoped.count, 40)
    }

    func testAKeptValueFollowsItsStampAndEveryKindWhenNoneAreNamed() async throws {
        let e = try await engine()
        var made = 0
        _ = e.kept("test.stamped", kinds: [.task], stamp: "Monday") { made += 1; return 1 }
        _ = e.kept("test.stamped", kinds: [.task], stamp: "Monday") { made += 1; return 1 }
        XCTAssertEqual(made, 1)
        _ = e.kept("test.stamped", kinds: [.task], stamp: "Tuesday") { made += 1; return 1 }
        XCTAssertEqual(made, 2, "another day: worked out again")
        // No kinds named: any change counts.
        _ = e.kept("test.any") { made += 1; return 1 }
        var probe = try XCTUnwrap(e.list(.sensor).first)
        probe.fields["last_value"] = .number(7)
        await e.absorb([probe])
        _ = e.kept("test.any") { made += 1; return 1 }
        XCTAssertEqual(made, 4)
    }

    func testReadingEventsStartNoSyncOnPhonesAndTheWatchPullsOnlyItsKinds() throws {
        let phone = SyncEngine(config: SharedConfig(suiteName: "scope-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        XCTAssertFalse(phone.pulls(.reading), "readings are not in the feed")
        XCTAssertTrue(phone.pulls(.sensor))
        XCTAssertTrue(phone.pulls(.task))
        let watch = SyncEngine(config: SharedConfig(suiteName: "scope-\(UUID().uuidString)"), platform: .watch, store: try SyncStore.inMemory())
        XCTAssertTrue(watch.pulls(.task))
        XCTAssertFalse(watch.pulls(.note))
        XCTAssertFalse(watch.pulls(.reading))
    }

    func testNotificationsArePlannedAgainOnlyWhenWhatTheyReadChanged() async throws {
        let e = try await engine()
        e.schedulesNotifications = true
        var replans = 0
        e.onReplan = { _ in replans += 1 }
        await e.afterChange()
        XCTAssertEqual(replans, 1)
        await e.afterChangeIfNeeded()
        XCTAssertEqual(replans, 1, "nothing changed")
        var web = try XCTUnwrap(e.list(.monitor).first)
        web.fields["state"] = .string("down")
        await e.absorb([web])
        await e.afterChangeIfNeeded()
        XCTAssertEqual(replans, 1, "a monitor is not read by the widgets or the reminders")
        var t = try XCTUnwrap(e.list(.task).first)
        t.fields["title"] = .string("Changed on another device")
        t.updated_at = ISO.now()
        await e.absorb([t])
        await e.afterChangeIfNeeded()
        XCTAssertEqual(replans, 2)
    }
}
