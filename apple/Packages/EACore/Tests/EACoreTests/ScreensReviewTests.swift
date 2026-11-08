import XCTest
@testable import EACore

/// Defects from the review of the core screens (2026-11-05), each reproduced first. Run with TZ=America/New_York
/// for the clock change cases; the rest hold in any zone.
@MainActor
final class ScreensReviewTests: XCTestCase {
    private func makeEngine(_ platform: Platform = .iphone) throws -> SyncEngine {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-screens-\(UUID().uuidString)"), platform: platform, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        return engine
    }

    private var ny: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }

    // The first notification grant replanned from the old reminder kind and took every task reminder off.
    func testFirstGrantReplanPlansTaskReminders() async throws {
        let engine = try makeEngine()
        _ = await engine.createReminder(title: "Pills", at: Date().addingTimeInterval(3600))
        XCTAssertEqual(engine.notificationPlan().map(\.title), ["Pills"])
    }

    // All-day events are stored as UTC midnights: west of UTC the Watch listed tomorrow's all-day event today.
    func testWatchAgendaKeepsAllDayEventOnItsOwnDay() async throws {
        let engine = try makeEngine(.watch)
        _ = await engine.create(kind: .event, fields: ["title": "Dinner at Luigi's", "start": "2026-11-06T00:00:00.000Z", "end": "2026-11-07T00:00:00.000Z", "all_day": true])
        _ = await engine.create(kind: .event, fields: ["title": "Trip", "start": "2026-11-04T00:00:00.000Z", "end": "2026-11-07T00:00:00.000Z", "all_day": true])
        let thursday = ny.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 9))!
        let friday = ny.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 9))!
        let saturday = ny.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 9))!
        XCTAssertEqual(engine.agendaToday(now: thursday, calendar: ny).map(\.title), ["Trip"])
        XCTAssertEqual(Set(engine.agendaToday(now: friday, calendar: ny).map(\.title)), ["Dinner at Luigi's", "Trip"])
        XCTAssertTrue(engine.agendaToday(now: friday, calendar: ny).allSatisfy(\.allDay))
        // The end date is exclusive.
        XCTAssertEqual(engine.agendaToday(now: saturday, calendar: ny).map(\.title), [])
    }

    // A Health workout logged after an open activity hid it: no End button, and its chip wrote a second start.
    func testWorkoutAfterAnOpenActivityKeepsItOpen() async throws {
        let engine = try makeEngine()
        // Yesterday, so the end written now comes after every log.
        let day = ny.startOfDay(for: Date()).addingTimeInterval(-86400)
        func at(_ h: Int, _ m: Int = 0) -> Date { day.addingTimeInterval(Double(h * 3600 + m * 60)) }
        _ = await engine.log(type: .activity, value: "Work", at: at(9))
        _ = await engine.log(type: .activity, value: "Walk", note: "Apple Health", at: at(12))
        _ = await engine.log(type: .activity, value: "Walk", unit: "min", note: "end", at: at(12, 30))
        XCTAssertEqual(engine.currentActivity?.name, "Work")
        XCTAssertEqual(engine.currentActivity?.start, at(9))
        // Tapping Work ends it rather than starting it again.
        await engine.toggleActivity("Work")
        let work = engine.logs(type: .activity).filter { $0.str("value") == "Work" }.map { $0.str("note").isEmpty ? "start" : $0.str("note") }
        XCTAssertEqual(work, ["start", "end"])
        XCTAssertNil(engine.currentActivity)
    }

    // Two open activities: the newest is current, the older one stays open, and ending the newest shows the older.
    func testOpenActivitiesNewestFirst() async throws {
        let engine = try makeEngine()
        let day = ny.startOfDay(for: Date()).addingTimeInterval(-86400)
        _ = await engine.log(type: .activity, value: "Work", at: day.addingTimeInterval(9 * 3600))
        _ = await engine.log(type: .activity, value: "Music", at: day.addingTimeInterval(10 * 3600))
        // A second start of an open one is the same session; an end with nothing open is ignored.
        _ = await engine.log(type: .activity, value: "Work", at: day.addingTimeInterval(11 * 3600))
        _ = await engine.log(type: .activity, value: "Gaming", unit: "min", note: "end", at: day.addingTimeInterval(11 * 3600))
        XCTAssertEqual(engine.openActivities.map(\.name), ["Music", "Work"])
        XCTAssertEqual(engine.openActivities.last?.start, day.addingTimeInterval(9 * 3600))
        await engine.endActivity()
        XCTAssertEqual(engine.currentActivity?.name, "Work")
    }

    // An end and a start in the same millisecond read the same way every time: a start first, as the hub sorts them.
    func testSameMillisecondEndAndStartAreDeterministic() async throws {
        for _ in 0..<20 {
            let engine = try makeEngine()
            let t = Date(timeIntervalSince1970: 1_793_000_000)
            _ = await engine.log(type: .activity, value: "Work", at: t.addingTimeInterval(-3600))
            _ = await engine.log(type: .activity, value: "Work", unit: "min", note: "end", at: t)
            _ = await engine.log(type: .activity, value: "Music", at: t)
            XCTAssertEqual(engine.currentActivity?.name, "Music")
            XCTAssertEqual(engine.openActivities.count, 1)
            // An end at a start's own moment closes it.
            _ = await engine.log(type: .activity, value: "Music", unit: "min", note: "end", at: t)
            XCTAssertNil(engine.currentActivity)
        }
    }

    // Switching activity writes an end and a start a moment apart, often in one millisecond: the new one is current.
    func testSwitchingActivityKeepsTheNewOne() async throws {
        for _ in 0..<20 {
            let engine = try makeEngine()
            await engine.toggleActivity("Work")
            await engine.toggleActivity("Music")
            XCTAssertEqual(engine.currentActivity?.name, "Music")
            XCTAssertEqual(engine.openActivities.count, 1)
        }
    }

    // Offline Renewed twice moved the due date two periods; the hub ignores a second renewal within three days.
    func testOfflineRenewedTwiceRollsOnePeriod() async throws {
        let engine = try makeEngine()
        let w = await engine.create(kind: .watch, fields: ["title": "Domain", "category": "domain", "due": "2026-11-20", "repeat": "every 1 years"])!
        await engine.renewWatch(w.id)
        let first = engine.get(w.id)!.str("due")
        await engine.renewWatch(w.id)
        XCTAssertEqual(first, "2027-11-20", "a date-only due stays a date, one year on")
        XCTAssertEqual(engine.get(w.id)!.str("due"), first)
    }

    // Offline unschedule made a doing task next; the hub keeps doing (and done).
    func testOfflineUnscheduleKeepsDoingTask() async throws {
        let engine = try makeEngine()
        let t = await engine.createTask(title: "Write", status: .next)!
        await engine.startBlock(t.id)
        XCTAssertEqual(engine.get(t.id)?.str("status"), "doing")
        await engine.unschedule(taskId: t.id)
        XCTAssertEqual(engine.get(t.id)?.str("status"), "doing")
        XCTAssertTrue([nil, .null].contains(engine.get(t.id)?.fields["block"]))
        let s = await engine.createTask(title: "Read", status: .next)!
        let start = Date().addingTimeInterval(7200)
        _ = try await engine.schedule(taskId: s.id, start: start, hours: 1, force: true)
        await engine.unschedule(taskId: s.id)
        XCTAssertEqual(engine.get(s.id)?.str("status"), "next")
    }

    // LocalPlanner.time added minutes to midnight, an hour off on clock change days (and Plan rules saved it so).
    func testLocalPlannerTimeOnDaylightSavingDays() {
        let fallBack = ny.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 12))!
        let springOn = ny.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 12))!
        for day in [fallBack, springOn] {
            let t = LocalPlanner.time(on: day, hhmm: "09:00", calendar: ny)!
            XCTAssertEqual(ny.component(.hour, from: t), 9)
            XCTAssertEqual(ny.component(.minute, from: t), 0)
            XCTAssertEqual(LocalPlanner.hhmm(of: t, calendar: ny), "09:00")
            // 24:00 is the next midnight.
            let end = LocalPlanner.time(on: day, hhmm: "24:00", calendar: ny)!
            XCTAssertEqual(end, ny.date(byAdding: .day, value: 1, to: ny.startOfDay(for: day)))
        }
        let rule = Entity(kind: .plan_rule, fields: ["title": "Work", "type": "blackout", "days": .array([.string("sun")]), "start": "09:00", "end": "17:00"])
        let cs = LocalPlanner.commitments(rules: [rule], on: fallBack, calendar: ny)
        XCTAssertEqual(cs.count, 1)
        XCTAssertEqual(cs.first.flatMap { ISO.date($0.start) }.map { ny.component(.hour, from: $0) }, 9)
        XCTAssertEqual(cs.first.flatMap { ISO.date($0.end) }.map { ny.component(.hour, from: $0) }, 17)
    }

    // The repeat editor took "monday", which no day matches: it never fired again and Done finished the task.
    func testRepeatEditorAcceptsFullWeekdayNames() throws {
        XCTAssertEqual(RepeatRule.editorRule(n: 1, unit: .weeks, on: "monday"), "every 1 weeks on mon")
        XCTAssertEqual(RepeatRule.editorRule(n: 2, unit: .weeks, on: "Thursday, mon"), "every 2 weeks on mon,thu")
        XCTAssertEqual(RepeatRule.editorRule(n: 1, unit: .weeks, on: "tues thurs"), "every 1 weeks on tue,thu")
        XCTAssertEqual(RepeatRule.editorRule(n: 1, unit: .weeks, on: ""), "every 1 weeks")
        XCTAssertNil(RepeatRule.editorRule(n: 1, unit: .weeks, on: "funday"))
        XCTAssertNil(RepeatRule.editorRule(n: 1, unit: .weeks, on: "mo"))
        XCTAssertEqual(RepeatRule.editorRule(n: 1, unit: .months, on: "15"), "every 1 months on day15")
        XCTAssertEqual(RepeatRule.editorRule(n: 1, unit: .months, on: "day 3"), "every 1 months on day3")
        XCTAssertNil(RepeatRule.editorRule(n: 1, unit: .months, on: "40"))
        XCTAssertNil(RepeatRule.editorRule(n: 1, unit: .months, on: "mid"))
        // What the editor builds now fires again on a Monday.
        let rule = RepeatRule.parse(RepeatRule.editorRule(n: 1, unit: .weeks, on: "monday")!)!
        let start = Date()
        let next = rule.next(after: start, start: start)!
        XCTAssertEqual(Calendar.current.component(.weekday, from: next), 2)
        // A stored rule with no day it can match ends at once instead of scanning for seconds.
        let t0 = Date()
        XCTAssertNil(RepeatRule(n: 1, unit: .weeks, on: ["monday"]).next(after: start, start: start))
        XCTAssertLessThan(Date().timeIntervalSince(t0), 0.5)
    }

    // Today's People section read a reminder's time from the old kind's `at`; tasks keep it in remind_at.
    func testPlansTodayKeepsReminderTimes() async throws {
        let engine = try makeEngine()
        let at = Date().addingTimeInterval(3600)
        let r = await engine.createReminder(title: "Call Mia", at: at)!
        let plans = TodayExtras.plansToday(events: [], reminders: [r], tasks: [])
        XCTAssertEqual(plans.first?.at.map { Int($0.timeIntervalSince1970) }, Int(at.timeIntervalSince1970))
    }

    // Reset local cache wiped the store but kept the cursor in memory: nothing came down again, and queued edits
    // vanished. It resets the cursor and keeps the queued edits with their rows.
    func testResetLocalCachePullsFromZeroAndKeepsQueuedEdits() async throws {
        let store = try SyncStore.inMemory()
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-screens-\(UUID().uuidString)"), platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let pulled = Entity(kind: .note, fields: ["title": "From the hub", "body": "x", "path": "Inbox/x.md"])
        _ = try await store.upsertManyFromHub([pulled])
        try await store.setCursor(420)
        // As a launch after the same build: no read from the start for a new build.
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        if !build.isEmpty { try await store.setMeta("synced_build", build) }
        await engine.start()
        XCTAssertEqual(engine.cursor, 420)
        let queued = await engine.createTask(title: "Made offline", status: .next)!
        let before = engine.outboxCount
        XCTAssertGreaterThan(before, 0)
        await engine.resetLocalCache()
        XCTAssertEqual(engine.cursor, 0)
        let storedCursor = try await store.cursor
        XCTAssertEqual(storedCursor, 0)
        XCTAssertNil(engine.get(pulled.id), "the copy from the hub is gone, to come down again")
        XCTAssertEqual(engine.get(queued.id)?.str("title"), "Made offline", "the queued edit keeps its row")
        XCTAssertEqual(engine.outboxCount, before)
        engine.stop()
    }
}

/// A hub that receives every request and never answers in time (a reply lost after the hub did the work).
final class LostReplyTransport: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [String] = []
    /// Entities the hub answers GET entities/:id with; nil makes that time out too.
    var hubHas: [String: Entity]?
    var calls: [String] { lock.lock(); defer { lock.unlock() }; return log }
    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        lock.lock(); log.append("\(method) \(path)"); lock.unlock()
        if method == "GET", path.hasPrefix("entities/"), let has = hubHas {
            let id = String(path.dropFirst("entities/".count))
            if let e = has[id] { return (200, try JSONEncoder().encode(e)) }
            return (404, Data("{\"error\":\"not found\"}".utf8))
        }
        throw HubError.transport("The request timed out.")
    }
}

@MainActor
final class ConvertCaptureLostReplyTests: XCTestCase {
    private func makeEngine(_ fake: LostReplyTransport) async throws -> SyncEngine {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-convert-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        engine.makeClient = { HubClient(transport: fake) }
        await engine.start()
        return engine
    }

    // The convert reached the hub, the reply did not, and the app made its own task too. With no answer either,
    // no copy is made: the capture stays and the next sync shows what the hub did.
    func testConvertCaptureAfterLostReplyMakesNoSecondCopy() async throws {
        let fake = LostReplyTransport()
        let engine = try await makeEngine(fake)
        let cap = await engine.create(kind: .capture, fields: ["text": "buy milk", "source": "iphone", "processed": false])!
        engine.status = .online
        let made = await engine.convertCapture(cap.id, to: .task)
        XCTAssertTrue(fake.calls.contains("POST capture/\(cap.id)/convert"))
        XCTAssertNil(made)
        XCTAssertTrue(engine.list(.task).isEmpty)
        XCTAssertEqual(engine.get(cap.id)?.bool("processed"), false)
        engine.stop()
    }

    // The hub has converted it: its task is the one, read back through converted_to.
    func testConvertCaptureAfterLostReplyTakesTheHubsCopy() async throws {
        let fake = LostReplyTransport()
        let engine = try await makeEngine(fake)
        let cap = await engine.create(kind: .capture, fields: ["text": "buy milk", "source": "iphone", "processed": false])!
        let hubTask = Entity(kind: .task, fields: ["title": "buy milk", "status": "inbox", "order": 1])
        var hubCap = cap
        hubCap.fields["processed"] = true
        hubCap.fields["converted_to"] = .array([.string(hubTask.id)])
        fake.hubHas = [cap.id: hubCap, hubTask.id: hubTask]
        engine.status = .online
        let made = await engine.convertCapture(cap.id, to: .task)
        XCTAssertEqual(made?.id, hubTask.id)
        XCTAssertEqual(engine.list(.task).map(\.id), [hubTask.id])
        XCTAssertEqual(engine.get(cap.id)?.bool("processed"), true)
        engine.stop()
    }

    // The hub has the capture unconverted: the request did not arrive, so the local convert goes ahead.
    func testConvertCaptureNotConvertedOnTheHubConvertsLocally() async throws {
        let fake = LostReplyTransport()
        let engine = try await makeEngine(fake)
        let cap = await engine.create(kind: .capture, fields: ["text": "buy milk", "source": "iphone", "processed": false])!
        fake.hubHas = [cap.id: cap]
        engine.status = .online
        let made = await engine.convertCapture(cap.id, to: .task)
        XCTAssertEqual(made?.str("title"), "buy milk")
        XCTAssertEqual(engine.list(.task).count, 1)
        engine.stop()
    }
}

final class ScreensReviewHelperTests: XCTestCase {
    // A date-only deadline was red from midnight of its own day and showed "Due 12:00 AM".
    func testDateOnlyDeadlineIsDueAllDay() {
        var ny = Calendar(identifier: .gregorian); ny.timeZone = TimeZone(identifier: "America/New_York")!
        let morning = ny.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 9))!
        let lateEvening = ny.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 23, minute: 59))!
        let nextMorning = ny.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 0, minute: 1))!
        XCTAssertTrue(TaskDue.isDateOnly("2026-11-06"))
        XCTAssertFalse(TaskDue.isOverdue("2026-11-06", now: morning, calendar: ny))
        XCTAssertFalse(TaskDue.isOverdue("2026-11-06", now: lateEvening, calendar: ny))
        XCTAssertTrue(TaskDue.isOverdue("2026-11-06", now: nextMorning, calendar: ny))
        XCTAssertEqual(TaskDue.label("2026-11-06", now: morning, calendar: ny), "today")
        // A date and time is overdue once its moment has passed.
        let at = ISO.string(morning.addingTimeInterval(3600))
        XCTAssertFalse(TaskDue.isOverdue(at, now: morning, calendar: ny))
        XCTAssertTrue(TaskDue.isOverdue(at, now: morning.addingTimeInterval(7200), calendar: ny))
    }

    // Text typed while a capture saved was wiped when the save returned; only what was sent is cleared.
    func testCaptureBoxKeepsWordsTypedWhileSaving() {
        XCTAssertEqual(CaptureDraft.remainder(after: "buy milk", now: "buy milk").text, "")
        XCTAssertTrue(CaptureDraft.remainder(after: "buy milk", now: "buy milk").unchanged)
        XCTAssertEqual(CaptureDraft.remainder(after: "buy milk", now: "buy milk and eggs").text, "and eggs")
        XCTAssertFalse(CaptureDraft.remainder(after: "buy milk", now: "buy milk and eggs").unchanged)
        // Changed some other way (cleared and retyped): nothing is lost.
        XCTAssertEqual(CaptureDraft.remainder(after: "buy milk", now: "call Mia").text, "call Mia")
    }

    // A kg weight showed as lb and joined the lb chart; sleep logged in hours was read as minutes.
    func testLogUnitsReadEachLogInItsOwnUnit() {
        let kg = Entity(kind: .log, fields: ["type": "weight", "value": 72, "unit": "kg"])
        let lb = Entity(kind: .log, fields: ["type": "weight", "value": 116.4, "unit": "lb"])
        let bare = Entity(kind: .log, fields: ["type": "weight", "value": 120])
        XCTAssertEqual(LogUnits.valueText(kg), "72 kg")
        XCTAssertEqual(LogUnits.valueText(lb), "116.4 lb")
        XCTAssertEqual(LogUnits.valueText(bare), "120 lb")
        XCTAssertEqual(LogUnits.weightLb(kg)!, 158.7, accuracy: 0.1)
        XCTAssertEqual(LogUnits.weightLb(lb)!, 116.4, accuracy: 0.001)
        let hours = Entity(kind: .log, fields: ["type": "sleep", "value": 7.5, "unit": "hours"])
        let minutes = Entity(kind: .log, fields: ["type": "sleep", "value": 450])
        XCTAssertEqual(LogUnits.sleepMinutes(hours), 450)
        XCTAssertEqual(LogUnits.valueText(hours), "7 h 30 min")
        XCTAssertEqual(LogUnits.valueText(minutes), "7 h 30 min")
    }
}
