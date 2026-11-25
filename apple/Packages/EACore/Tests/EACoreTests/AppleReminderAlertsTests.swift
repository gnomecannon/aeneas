import XCTest
@testable import EACore

/// Tasks also in Apple Reminders alert from Aeneas and from Apple's Reminders app (the alarm on the item); the owner
/// keeps either or both (`apple_reminder_alerts` in `GET /modules`, since 1.0.19). Here: the switches decode, this
/// device plans and shows no Aeneas alert for a linked task while Alert from Aeneas is off, and the Reminders merge
/// writes no alarm while Alert from Apple Reminders is off, takes one that came back off, and never fights over it.
@MainActor
final class AppleReminderAlertsTests: XCTestCase {
    // MARK: the setting

    func testTheSwitchesDecodeBesideTheModulesAndAnOlderHubHasNone() throws {
        let r = try JSONCoding.decode(ModulesResponse.self, from: """
        {"modules": [{"id": "apple_reminders", "title": "Apple Reminders", "on": true}], "alerts": [],
         "apple_reminder_alerts": {"aeneas": false, "apple": false, "apple_alarms": true, "needs": "1.0.19",
           "waiting": [{"id": "d1", "name": "Jamie's Mac", "platform": "mac", "version": "1.0.18"}]}}
        """)
        let a = try XCTUnwrap(r.apple_reminder_alerts)
        XCTAssertFalse(a.aeneas)
        XCTAssertFalse(a.apple)
        XCTAssertTrue(a.apple_alarms, "off waits for the Mac")
        XCTAssertEqual(a.waitingLine, "Apple Reminders keeps its alerts until every iPhone, iPad and Mac runs 1.0.19 or later. Still to update: Jamie's Mac (1.0.18).")
        XCTAssertNil(try JSONCoding.decode(ModulesResponse.self, from: #"{"modules": []}"#).apple_reminder_alerts, "an older hub")
        // A thin or broken part never turns an alert off, and never loses the module switches.
        let thin = try JSONCoding.decode(AppleReminderAlerts.self, from: "{}")
        XCTAssertEqual(thin, AppleReminderAlerts())
        XCTAssertTrue(thin.apple_alarms)
        XCTAssertNil(thin.waitingLine)
        XCTAssertNil(try JSONCoding.decode(ModulesResponse.self, from: #"{"modules": [], "apple_reminder_alerts": 4}"#).apple_reminder_alerts)
        // On the live stream too.
        let data = try JSONCoding.string(ModulesResponse(modules: [], alerts: [], apple_reminder_alerts: AppleReminderAlerts(aeneas: false)))
        guard case .modules(_, _, let apple) = HubClient.liveEvent(SSEMessage(event: "modules", data: data)) else { return XCTFail("not a modules event") }
        XCTAssertEqual(apple?.aeneas, false)
    }

    func testOnlyATaskTiedToAnAppleItemIsLeftToApple() {
        let linked = task("a", apple: ["id": "ext-1", "list": "L1", "list_title": "Home"])
        let waiting = task("b", apple: ["id": "", "list": "", "list_title": "Home"])
        let plain = task("c")
        XCTAssertTrue(AppleReminderAlerts.inAppleReminders(linked))
        XCTAssertFalse(AppleReminderAlerts.inAppleReminders(waiting), "made inside a list, its item not made yet")
        XCTAssertFalse(AppleReminderAlerts.inAppleReminders(plain))
        let off = AppleReminderAlerts(aeneas: false)
        XCTAssertEqual([linked, waiting, plain].map { AppleReminderAlerts.aeneasAlerts(for: $0, off) }, [false, true, true])
        XCTAssertEqual([linked, waiting, plain].map { AppleReminderAlerts.aeneasAlerts(for: $0, AppleReminderAlerts()) }, [true, true, true])
        XCTAssertEqual([linked, waiting, plain].map { AppleReminderAlerts.aeneasAlerts(for: $0, nil) }, [true, true, true])
    }

    // MARK: what this device plans and shows

    func testAlertFromAeneasOffTakesOnlyLinkedTasksOutOfThePlanAndOnBringsThemBack() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        for t in [task("linked", apple: ["id": "ext-1", "list": "L1", "list_title": "Home"]), task("waiting", apple: ["id": "", "list": "", "list_title": "Home"]), task("plain")] {
            try await store.upsertFromHub(t)
        }
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        var plans: [[String]] = []
        engine.onReplan = { plans.append($0.map(\.id).sorted()) }
        engine.makeClient = { HubClient(transport: OneHub()) }
        await engine.start()
        XCTAssertEqual(plans.last, ["linked", "plain", "waiting"], "no setting yet: every reminder, as before")

        await engine.applyAppleReminderAlerts(AppleReminderAlerts(aeneas: true, apple: false, apple_alarms: false))
        XCTAssertEqual(plans.last, ["linked", "plain", "waiting"], "Apple's switch changes nothing Aeneas plans")

        await engine.applyAppleReminderAlerts(AppleReminderAlerts(aeneas: false))
        XCTAssertEqual(plans.last, ["plain", "waiting"], "the linked task's alert is taken off")
        XCTAssertEqual(c.appleReminderAlerts?.aeneas, false, "kept for the next launch and the Watch")
        XCTAssertEqual(engine.notificationPlan().map(\.reminderId).sorted(), ["plain", "waiting"])
        await engine.replanNotifications()
        XCTAssertEqual(plans.last, ["plain", "waiting"], "a sync or an edit replans the same way")

        // The hub's announcement of the linked task's time, sent just before the switch: no alert here either.
        var announced: [String] = []
        engine.onNotify = { id, _, _, _ in announced.append(id) }
        engine.handleNotify(NotifyEvent(kind: "reminder", id: "linked", title: "Water the plants"))
        engine.handleNotify(NotifyEvent(kind: "reminder", id: "plain", title: "Call the vet"))
        engine.handleNotify(NotifyEvent(kind: "reminder", id: "not-here-yet", title: "Made elsewhere"))
        XCTAssertEqual(announced, ["plain", "not-here-yet"], "a task this device does not hold yet still alerts")

        await engine.applyAppleReminderAlerts(AppleReminderAlerts())
        XCTAssertEqual(plans.last, ["linked", "plain", "waiting"], "on again, it comes back")
        // A hub without the setting: every task alerts.
        await engine.applyAppleReminderAlerts(AppleReminderAlerts(aeneas: false))
        await engine.applyAppleReminderAlerts(nil)
        XCTAssertEqual(plans.last, ["linked", "plain", "waiting"])
        XCTAssertNil(c.appleReminderAlerts)
        engine.stop()
    }

    func testSwitchingAsksTheHubAndTellsTheRemindersSyncWhenAlarmsChange() async throws {
        let c = config()
        let engine = SyncEngine(config: c, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let t = FakeTransport()
        engine.makeClient = { HubClient(transport: t) }
        await engine.start()
        final class Count: @unchecked Sendable { var n = 0 }
        let count = Count()
        let obs = NotificationCenter.default.addObserver(forName: SyncEngine.reminderAlarmsDidChange, object: engine, queue: nil) { _ in count.n += 1 }
        defer { NotificationCenter.default.removeObserver(obs) }
        var told: Int { count.n }
        t.responses = [(200, try JSONCoding.data(AlertsResponse(alerts: [], apple_reminder_alerts: AppleReminderAlerts(aeneas: true, apple: false, apple_alarms: false))))]
        try await engine.setAppleReminderAlerts(["apple": false])
        XCTAssertEqual(t.calls.last?.path, "modules/alerts")
        XCTAssertEqual(t.calls.last?.method, "PUT")
        let sent = try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: [String: Bool]]
        XCTAssertEqual(sent, ["apple_reminder_alerts": ["apple": false]])
        XCTAssertEqual(engine.appleReminderAlerts?.apple, false)
        XCTAssertFalse(c.writesReminderAlarms)
        XCTAssertEqual(told, 1)
        // Alert from Aeneas changes no alarm.
        await engine.applyAppleReminderAlerts(AppleReminderAlerts(aeneas: false, apple: false, apple_alarms: false))
        XCTAssertEqual(told, 1)
        await engine.applyAppleReminderAlerts(nil)
        XCTAssertTrue(c.writesReminderAlarms, "a hub without the setting: alarms as always")
        XCTAssertEqual(told, 2)
        engine.stop()
    }

    // MARK: the Reminders merge

    let now = ISO.date("2026-11-24T12:00:00.000Z")!
    let ny: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()
    let nine = "2026-11-25T14:00:00.000Z"   // 9 AM in New York
    let ten = "2026-11-25T15:00:00.000Z"
    let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
    var id: String { RemindersMerge.taskId(forExternal: "X1") }

    func item(due: String? = nil, remind: String? = nil, alarm: Bool? = nil, dueAlone: String? = nil, done: Bool = false, list: String = "Personal",
              modified: String = "2026-11-24T11:00:00.000Z") -> ReminderItem {
        ReminderItem(externalId: "X1", localId: "L-X1", listId: "P", listTitle: list, title: "Water the plants", due: due, remindAt: remind,
                     done: done, modified: ISO.date(modified), timedAlarm: alarm, dueAlone: dueAlone)
    }

    func linkedTask(due: String? = nil, remind: String? = nil, status: String = "scheduled", updated: String = "2026-11-24T10:00:00.000Z") -> Entity {
        var f: [String: JSONValue] = ["title": "Water the plants", "status": .string(status), "order": 1, "apple": link]
        if let due { f["due"] = .string(due) }
        if let remind { f["remind_at"] = .string(remind) }
        var e = Entity(id: id, kind: .task, fields: f)
        e.updated_at = updated
        return e
    }

    func record(_ i: ReminderItem, off: Bool = false) -> [String: SyncedReminder] {
        var f = RemindersMerge.fields(of: i)
        f[RemindersMerge.listKey] = "Personal"
        if off { f[RemindersMerge.alarmsKey] = "off" }
        return ["X1": SyncedReminder(taskId: id, localId: "L-X1", fields: f)]
    }

    func plan(_ items: [ReminderItem], _ tasks: [Entity], _ state: [String: SyncedReminder], alarms: Bool, writable: Set<String>? = nil) -> RemindersPlan {
        RemindersMerge.plan(items: items, tasks: tasks, state: state, presentLists: ["P"], createsInApple: true, workOff: false,
                            writableLists: writable, alarms: alarms, now: now, calendar: ny)
    }

    /// Both on is today's behavior exactly: the same plan as with no word about alarms, every write moving alarms
    /// with the dates and no record marked.
    func testBothOnIsTodaysBehaviorExactly() {
        let i = item(remind: nine)
        let cases: [([ReminderItem], [Entity], [String: SyncedReminder])] = [
            ([i], [linkedTask(remind: ten)], record(i)),                       // the time moved in the app
            ([item(remind: ten, modified: "2026-11-24T11:30:00.000Z")], [linkedTask(remind: nine)], record(i)), // moved in Apple
            ([item(due: "2026-11-25", remind: nine)], [], [:]),                 // new in Apple
            ([], [Entity(id: "T2", kind: .task, fields: ["title": "Buy stamps", "status": "scheduled", "order": 1, "remind_at": .string(nine)])], [:]), // new in the app
            ([i], [linkedTask(remind: nine, status: "done")], record(i)),       // done in the app
        ]
        for (items, tasks, state) in cases {
            let today = RemindersMerge.plan(items: items, tasks: tasks, state: state, presentLists: ["P"], createsInApple: true, workOff: false, now: now, calendar: ny)
            let on = plan(items, tasks, state, alarms: true)
            XCTAssertEqual(on, today)
            XCTAssertTrue(on.appleWrites.allSatisfy { $0.alarms == .move })
            XCTAssertTrue(on.state.values.allSatisfy { $0.fields[RemindersMerge.alarmsKey] == nil })
        }
        XCTAssertEqual(plan([i], [linkedTask(remind: ten)], record(i), alarms: true).appleWrites, [.init(localId: "L-X1", fields: ["remind_at": ten])])
        // The date rules too: `move` is what they always did.
        let full = ["title": "", "notes": "", "due": "", "remind_at": ten, "repeat": "", "done": "0"]
        let c = ReminderDates.components(nine, calendar: ny)
        let a = [ReminderAlarm(absolute: ISO.date(nine)), ReminderAlarm(place: true)]
        XCTAssertEqual(ReminderDates.write(full: full, repeatChanged: false, due: c, alarms: a, timed: .move, calendar: ny),
                       ReminderDates.write(full: full, repeatChanged: false, due: c, alarms: a, calendar: ny))
    }

    /// Off: an item's alarm comes off and nothing else changes; the next run reads the item without it as the same
    /// task, and writes nothing.
    func testOffTakesTheAlarmOffAndTheNextRunIsQuiet() {
        let i = item(remind: nine)
        let p = plan([i], [linkedTask(remind: nine)], record(i), alarms: false)
        XCTAssertTrue(p.taskPatches.isEmpty, "nothing about the task changes")
        XCTAssertEqual(p.appleWrites, [.init(localId: "L-X1", fields: [:], alarms: ReminderDates.TimedAlarms.none)], "only the alarm, the due date left as it is")
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.alarmsKey], "off")
        XCTAssertEqual(p.state["X1"]?.fields["remind_at"], nine)
        // The alarm is gone; the due date still says 9 AM.
        let after = item(due: nine, remind: nil, alarm: false, dueAlone: nine)
        let q = plan([after], [linkedTask(remind: nine)], p.state, alarms: false)
        XCTAssertTrue(q.taskPatches.isEmpty, "the reminder time stays on the task")
        XCTAssertTrue(q.appleWrites.isEmpty, "no write, so no change in Apple Reminders, so no loop")
        XCTAssertEqual(q.state, p.state)
        // Alarms tied to a place stay; one with a time goes.
        XCTAssertEqual(ReminderDates.alarms(.none, at: ISO.date(nine), alarms: [ReminderAlarm(absolute: ISO.date(nine)), ReminderAlarm(place: true), ReminderAlarm(offset: -600)]),
                       [.init(from: 1, at: nil)])
    }

    /// Off: the reminder time changed in the app goes to Apple as the due date, with no alarm.
    func testOffWritesANewTimeWithNoAlarm() {
        let i = item(due: nine, alarm: false, dueAlone: nine)
        let state = record(item(remind: nine), off: true)
        let p = plan([i], [linkedTask(remind: ten, updated: "2026-11-24T11:30:00.000Z")], state, alarms: false)
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertEqual(p.appleWrites, [.init(localId: "L-X1", fields: ["remind_at": ten], alarms: ReminderDates.TimedAlarms.none)])
        let full = ["title": "Water the plants", "notes": "", "due": "", "remind_at": ten, "repeat": "", "done": "0"]
        let w = ReminderDates.write(full: full, repeatChanged: false, due: ReminderDates.components(nine, calendar: ny), alarms: [ReminderAlarm(place: true)], timed: .none, calendar: ny)
        XCTAssertEqual(w.alarms, [.init(from: 0, at: nil)], "only the place alarm")
        XCTAssertEqual(w.due?.hour, 10)
        XCTAssertTrue(w.keepsRepeat)
        // Next run: the due date says 10 and the record says 10. Quiet.
        let q = plan([item(due: ten, alarm: false, dueAlone: ten)], [linkedTask(remind: ten)], p.state, alarms: false)
        XCTAssertTrue(q.taskPatches.isEmpty)
        XCTAssertTrue(q.appleWrites.isEmpty)
    }

    /// Off: the owner sets a new time in Apple's app, which adds an alarm with it. The task takes the time, the alarm
    /// comes off, and the run after is quiet. An app from before 1.0.19 writing the alarm back does the same, once.
    func testAnAlarmThatComesBackIsTakenOffWithoutAFight() {
        let state = record(item(remind: nine), off: true)
        let moved = item(remind: ten, modified: "2026-11-24T11:30:00.000Z")   // due 10 AM and an alarm at 10
        let p = plan([moved], [linkedTask(remind: nine)], state, alarms: false)
        XCTAssertEqual(p.taskPatches.first?.fields["remind_at"]?.stringValue, ten, "the owner's new time reaches the task")
        XCTAssertEqual(p.appleWrites, [.init(localId: "L-X1", fields: [:], alarms: ReminderDates.TimedAlarms.none)])
        XCTAssertEqual(p.state["X1"]?.fields["remind_at"], ten)
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.alarmsKey], "off")
        let q = plan([item(due: ten, alarm: false, dueAlone: ten)], [linkedTask(remind: ten)], p.state, alarms: false)
        XCTAssertTrue(q.taskPatches.isEmpty)
        XCTAssertTrue(q.appleWrites.isEmpty)
        // An older app puts the 10 AM alarm back: it comes off again, and the task is not touched.
        let r = plan([item(remind: ten)], [linkedTask(remind: ten)], q.state, alarms: false)
        XCTAssertTrue(r.taskPatches.isEmpty)
        XCTAssertEqual(r.appleWrites, [.init(localId: "L-X1", fields: [:], alarms: ReminderDates.TimedAlarms.none)])
    }

    /// Off, with a deadline and a reminder time: the item holds the deadline only. Moving the deadline in Apple moves
    /// the task's; the reminder time stays; taking the date off in Apple takes both off, as Apple's app does.
    func testOffWithADeadlineKeepsTheReminderTimeInTheApp() {
        let state = record(item(due: "2026-11-26", remind: nine), off: true)
        let same = item(due: "2026-11-26", alarm: false, dueAlone: "2026-11-26")
        XCTAssertTrue(plan([same], [linkedTask(due: "2026-11-26", remind: nine)], state, alarms: false).taskPatches.isEmpty)
        let later = item(due: "2026-11-27", alarm: false, dueAlone: "2026-11-27", modified: "2026-11-24T11:30:00.000Z")
        let p = plan([later], [linkedTask(due: "2026-11-26", remind: nine)], state, alarms: false)
        XCTAssertEqual(p.taskPatches.first?.fields["due"]?.stringValue, "2026-11-27")
        XCTAssertNil(p.taskPatches.first?.fields["remind_at"], "the reminder time is not on the item, so it is not read as gone")
        XCTAssertTrue(p.appleWrites.isEmpty)

        XCTAssertEqual(ReminderDates.readWithoutAlarms(dueAlone: "2026-11-26", record: state["X1"]!.fields, calendar: ny).remindAt, nine)
        XCTAssertTrue(ReminderDates.readWithoutAlarms(dueAlone: "", record: state["X1"]!.fields, calendar: ny) == ("", ""))
        // A task with only a reminder time: a new time on the item is the new reminder time; a day with no time
        // becomes the deadline.
        let only = record(item(remind: nine), off: true)["X1"]!.fields
        XCTAssertTrue(ReminderDates.readWithoutAlarms(dueAlone: nine, record: only, calendar: ny) == ("", nine))
        XCTAssertTrue(ReminderDates.readWithoutAlarms(dueAlone: ten, record: only, calendar: ny) == ("", ten))
        XCTAssertTrue(ReminderDates.readWithoutAlarms(dueAlone: "2026-11-25", record: only, calendar: ny) == ("2026-11-25", ""))
    }

    /// Off: an item made in Apple's app with a time comes in with it as the reminder time and loses its alarm. A
    /// finished item, or one in a list that cannot be changed, is left as it is.
    func testOffNewItemsAndItemsLeftAlone() {
        let p = plan([item(remind: nine)], [], [:], alarms: false)
        XCTAssertEqual(p.taskPatches.first?.fields["remind_at"]?.stringValue, nine)
        XCTAssertEqual(p.appleWrites, [.init(localId: "L-X1", fields: [:], alarms: ReminderDates.TimedAlarms.none)])
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.alarmsKey], "off")

        let i = item(remind: nine, done: true)
        let done = plan([i], [linkedTask(remind: nine, status: "done")], record(i), alarms: false)
        XCTAssertTrue(done.appleWrites.isEmpty, "a finished item alerts no more")
        XCTAssertNil(done.state["X1"]?.fields[RemindersMerge.alarmsKey])

        let sub = item(remind: nine, list: "Holidays")
        var state = record(sub)
        state["X1"]?.fields[RemindersMerge.listKey] = "Holidays"
        var t = linkedTask(remind: nine)
        t.fields["apple"] = .object(["id": "X1", "list": "P", "list_title": "Holidays"])
        let ro = plan([sub], [t], state, alarms: false, writable: ["Personal"])
        XCTAssertTrue(ro.appleWrites.isEmpty, "a subscribed list cannot be changed")
        XCTAssertNil(ro.state["X1"]?.fields[RemindersMerge.alarmsKey])
        XCTAssertTrue(plan([item(remind: nine)], [], [:], alarms: false, writable: ["Other"]).appleWrites.isEmpty)
    }

    /// On again: an item left with no alarm gets one back at the task's reminder time, once; the run after reads it
    /// as always. One with no reminder time, or a finished one, gets none.
    func testOnAgainTheAlarmComesBackFromTheTask() {
        let state = record(item(remind: nine), off: true)
        let bare = item(due: nine, alarm: false, dueAlone: nine)
        let p = plan([bare], [linkedTask(remind: nine)], state, alarms: true)
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertEqual(p.appleWrites, [.init(localId: "L-X1", fields: [:], alarms: .remake)])
        XCTAssertNil(p.state["X1"]?.fields[RemindersMerge.alarmsKey])
        XCTAssertEqual(ReminderDates.alarms(.remake, at: ISO.date(nine), alarms: [ReminderAlarm(place: true)]), [.init(from: nil, at: ISO.date(nine)), .init(from: 0, at: nil)])
        // With the alarm back the item reads as always: due 9 AM and an alarm at 9 is the reminder time.
        let q = plan([item(remind: nine)], [linkedTask(remind: nine)], p.state, alarms: true)
        XCTAssertTrue(q.taskPatches.isEmpty)
        XCTAssertTrue(q.appleWrites.isEmpty)
        // A new time in the app at the same moment: written with the alarm made again.
        let moved = plan([bare], [linkedTask(remind: ten, updated: "2026-11-24T11:30:00.000Z")], state, alarms: true)
        XCTAssertEqual(moved.appleWrites, [.init(localId: "L-X1", fields: ["remind_at": ten], alarms: .remake)])
        // A deadline alone: nothing to put back, and the item still reads as the record says.
        let dayState = record(item(due: "2026-11-26"), off: true)
        let day = plan([item(due: "2026-11-26", alarm: false, dueAlone: "2026-11-26")], [linkedTask(due: "2026-11-26")], dayState, alarms: true)
        XCTAssertTrue(day.appleWrites.isEmpty)
        XCTAssertTrue(day.taskPatches.isEmpty)
        // Finished: no alarm put back, and its reminder time is not read as gone.
        let doneState = record(item(remind: nine, done: true), off: true)
        let done = plan([item(due: nine, alarm: false, dueAlone: nine, done: true)], [linkedTask(remind: nine, status: "done")], doneState, alarms: true)
        XCTAssertTrue(done.appleWrites.isEmpty)
        XCTAssertTrue(done.taskPatches.isEmpty)
        XCTAssertEqual(done.state["X1"]?.fields[RemindersMerge.alarmsKey], "off")
    }

    // MARK: helpers

    private func task(_ id: String, apple: [String: JSONValue]? = nil) -> Entity {
        var f: [String: JSONValue] = ["title": .string(id), "status": "scheduled", "order": 1, "remind_at": .string(ISO.string(Date().addingTimeInterval(86400)))]
        if let apple { f["apple"] = .object(apple) }
        return Entity(id: id, kind: .task, fields: f)
    }

    private func config() -> SharedConfig {
        let c = SharedConfig(suiteName: "eacore-apple-alerts-\(UUID().uuidString)")
        c.hubURL = "http://hub-a.test"
        c.storeDeviceKey("ead1_a")
        c.deviceId = "11111111-1111-4111-8111-111111111111"
        return c
    }
}
