import XCTest
@testable import EACore

/// The rules of the Today screen: the same cases as the web app's todayBoard.test.ts.
final class TodayBoardTests: XCTestCase {
    private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/Chicago")!; return c }()
    /// 2026-11-22 at an hour and minute, Chicago time.
    private func at(_ h: Int, _ m: Int = 0, day: Int = 22) -> Date { cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: m))! }
    /// "15:00": one clock for every test, whatever the machine's own.
    private var clock: TodayBoard.Clock {
        let cal = self.cal
        return { d in
            let c = cal.dateComponents([.hour, .minute], from: d)
            return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
    }
    private func span(_ kind: TodayBoard.Span.Kind, _ title: String, _ s: Date, _ e: Date? = nil, allDay: Bool = false, rule: PlanRuleType? = nil) -> TodayBoard.Span {
        TodayBoard.Span(id: "\(kind.rawValue)|\(title)", kind: kind, title: title, start: s, end: e ?? s, allDay: allDay, rule: rule, itemId: title)
    }

    func testDurationWordsSaysWholeMinutesAndHoursWithTheirMinutes() {
        XCTAssertEqual(TodayBoard.durationWords(46 * 60), "46 min")
        XCTAssertEqual(TodayBoard.durationWords(2 * 3600), "2 h")
        XCTAssertEqual(TodayBoard.durationWords(2 * 3600 + 10 * 60), "2 h 10 min")
        XCTAssertEqual(TodayBoard.durationWords(20), "0 min")
        XCTAssertEqual(TodayBoard.durationWords(-500), "0 min")
    }

    func testNowLineNamesWhatIsUnderWayAndHowLongItHasLeft() {
        let items = [span(.event, "Dentist", at(15), at(16)), span(.event, "Dinner", at(18, 30), at(20))]
        XCTAssertEqual(TodayBoard.nowLine(items, now: at(15, 14)), .during(title: "Dentist", until: at(16), left: "46 min", what: .event))
    }

    func testNowLinePutsABlockUnderWayAheadOfAnEventAtTheSameTime() {
        let items = [span(.event, "Standup", at(9), at(10)), span(.block, "Write the report", at(9), at(12)), span(.commitment, "Work hours", at(9), at(17), rule: .commitment)]
        XCTAssertEqual(TodayBoard.nowLine(items, now: at(9, 30)), .during(title: "Write the report", until: at(12), left: "2 h 30 min", what: .block))
        // Of two events under way, the one that ends first.
        let two = [span(.event, "Long", at(9), at(12)), span(.event, "Short", at(9), at(10))]
        XCTAssertEqual(TodayBoard.nowLine(two, now: at(9, 30)), .during(title: "Short", until: at(10), left: "30 min", what: .event))
    }

    func testNowLineElseNamesTheNextThingWithATimeAReminderIncluded() {
        let items = [span(.reminder, "Take the bins out", at(20, 30)), span(.event, "Dinner", at(21), at(22))]
        XCTAssertEqual(TodayBoard.nowLine(items, now: at(19)), .next(title: "Take the bins out", at: at(20, 30), wait: "1 h 30 min", what: .reminder))
    }

    func testNowLineSkipsAllDayPlansFreeTimeAndWhatIsOver() {
        let items = [span(.event, "Market", at(0), at(24), allDay: true), span(.free, "", at(18), at(23)), span(.event, "Coffee", at(9), at(10)),
                     span(.commitment, "Music first", at(18), at(21), rule: .preference), span(.commitment, "Pepper weeks", at(0), at(24), rule: .info)]
        XCTAssertEqual(TodayBoard.nowLine(items, now: at(19)), .clear)
    }

    func testFreeLineSaysFreeTimeFromNowByWhenItEndsAndLaterFreeTimeByBothEnds() {
        let free = [span(.free, "", at(12, 14), at(15)), span(.free, "", at(18), at(23))]
        XCTAssertEqual(TodayBoard.freeLine(free, now: at(12, 14, day: 22).addingTimeInterval(30), clock: clock), "Free until 15:00, 2 h 46 min")
        XCTAssertEqual(TodayBoard.freeLine(free, now: at(16), clock: clock), "Free 18:00 to 23:00, 5 h")
        XCTAssertEqual(TodayBoard.freeLine(free, now: at(19), clock: clock), "Free until 23:00, 4 h")
        XCTAssertNil(TodayBoard.freeLine(free, now: at(23, 30), clock: clock))
    }

    func testOnlyACommitmentOrABlackoutTakesTime() {
        XCTAssertEqual(PlanRuleType.allCases.filter(\.takesTime), [.blackout, .commitment])
    }

    func testARuleFromMidnightToMidnightIsTheWholeDay() {
        XCTAssertTrue(TodayBoard.wholeDay(start: at(0), end: at(0, day: 23)))
        // The day the clocks go forward has 23 hours.
        XCTAssertTrue(TodayBoard.wholeDay(start: at(0), end: at(23)))
        XCTAssertFalse(TodayBoard.wholeDay(start: at(9), end: at(17)))
        XCTAssertTrue(TodayBoard.wholeDay(PlannerCommitment(rule_id: "r", title: "Pepper weeks", start: ISO.string(at(0)), end: ISO.string(at(0, day: 23)), type: .info)))
        XCTAssertFalse(TodayBoard.wholeDay(PlannerCommitment(rule_id: "r", title: "Broken", start: "", end: "", type: .info)))
        // The plan's spans carry it, so the Now line leaves such a rule out.
        let away = PlannerCommitment(rule_id: "r", title: "Away", start: ISO.string(at(0)), end: ISO.string(at(0, day: 23)), type: .blackout)
        let work = PlannerCommitment(rule_id: "w", title: "Work hours", start: ISO.string(at(9)), end: ISO.string(at(17)), type: .commitment)
        XCTAssertEqual(TodayBoard.spans(blocks: [], commitments: [away, work], events: [], reminders: [], freeSlots: []).map(\.allDay), [true, false])
    }

    func testAWholeDayRuleIsNeverWhatIsOnNow() {
        let items = [span(.commitment, "Away", at(0), at(0, day: 23), allDay: true, rule: .blackout), span(.commitment, "Work hours", at(9), at(17), rule: .commitment)]
        XCTAssertEqual(TodayBoard.nowLine([items[0]], now: at(11)), .clear)
        XCTAssertEqual(TodayBoard.nowLine(items, now: at(11)), .during(title: "Work hours", until: at(17), left: "6 h", what: .commitment))
    }

    // MARK: needs you

    private func watch(_ id: String, _ title: String, due: String, autopay: Bool = false, cost: Double? = nil) -> Entity {
        var f: [String: JSONValue] = ["title": .string(title), "due": .string(due), "autopay": .bool(autopay)]
        if let cost { f["cost"] = .number(cost) }
        return Entity(id: id, kind: .watch, fields: f)
    }

    /// Tech's looks are not rows here: they are Tech's own card above Needs you (`Tech.light`), so `needsYou` takes none.
    func testNeedsYouListsOnlyWhatWaitsOnTheOwnerInTheOrderToTakeIt() {
        let now = at(15)
        let reminders = [Mail.DueReminder(id: "t1", title: "Call the vet", at: at(14, 20), friction: "none"), Mail.DueReminder(id: "t2", title: "Stretch", at: at(14, 59, day: 22).addingTimeInterval(40), friction: "none")]
        let watches = [watch("w1", "Plex Pass", due: "2026-11-18"), watch("w2", "Spotify", due: "2026-11-25", autopay: true), watch("w3", "Domain", due: "2026-11-26"), watch("w4", "Passport", due: "2026-11-22")]
        let app = Entity(id: "a1", kind: .application, fields: ["company": "Northwind", "next_step": "Send references", "next_at": .string(ISO.string(at(17)))])
        let lateApp = Entity(id: "a2", kind: .application, fields: ["company": "Harbor", "next_at": .string(ISO.string(at(9, day: 20)))])
        let meds = [TodayExtras.Med(name: "Claritin", takenAt: nil), TodayExtras.Med(name: "Zyrtec", takenAt: at(8))]
        let needs = TodayBoard.needsYou(reminders: reminders, watches: watches, followUps: [app, lateApp], meds: meds, unsorted: 2, now: now, calendar: cal, clock: clock)
        XCTAssertEqual(needs.map(\.id), ["r:t1", "r:t2", "w:w1", "w:w3", "w:w4", "a:a1", "a:a2", "m:claritin", "unsorted"])
        XCTAssertEqual(needs.map(\.title), ["Call the vet", "Stretch", "Renew Plex Pass", "Renew Domain", "Renew Passport", "Follow up with Northwind", "Follow up with Harbor", "Claritin", "2 captures could not be filed"])
        XCTAssertEqual(needs.map(\.detail), ["Reminder, 14:20, 40 min ago", "Reminder, 14:59", "4 days overdue", "Due in 4 days", "Due today", "Send references, today, 17:00", "late", "Not logged today", "Waiting in Unsorted Info"])
        XCTAssertEqual(needs.map(\.late), [false, false, true, false, false, false, true, false, false])
    }

    func testAReminderFromAnEarlierDaySaysTheDayNotOnlyHours() {
        XCTAssertEqual(TodayBoard.cameDue(at(14, 20), now: at(15), calendar: cal, clock: clock), "14:20, 40 min ago")
        XCTAssertEqual(TodayBoard.cameDue(at(14, 59, day: 22).addingTimeInterval(40), now: at(15), calendar: cal, clock: clock), "14:59")
        XCTAssertEqual(TodayBoard.cameDue(at(9, 55, day: 21), now: at(15), calendar: cal, clock: clock), "Nov 21 at 09:55, yesterday")
        XCTAssertEqual(TodayBoard.cameDue(at(16, 8, day: 20), now: at(15), calendar: cal, clock: clock), "Nov 20 at 16:08, 2 days ago")
        // Late last night is yesterday, however few hours ago.
        XCTAssertEqual(TodayBoard.cameDue(at(23, 30, day: 21), now: at(0, 30), calendar: cal, clock: clock), "Nov 21 at 23:30, yesterday")
    }

    func testNeedsYouNamesARenewalOnceAndNeverAChargeOnAutopay() {
        let now = at(15)
        let task = Entity(id: "t9", kind: .task, fields: ["title": "Renew: Plex Pass", "linked_id": "w1"])
        let auto = Entity(id: "t8", kind: .task, fields: ["title": "Renew: Spotify", "linked_id": "w2"])
        let reminders = [Mail.DueReminder(id: "t9", title: "Renew: Plex Pass", at: at(9), friction: "none"), Mail.DueReminder(id: "t8", title: "Renew: Spotify", at: at(9), friction: "none")]
        let needs = TodayBoard.needsYou(reminders: reminders, tasks: [task, auto], watches: [watch("w1", "Plex Pass", due: "2026-11-18"), watch("w2", "Spotify", due: "2026-11-20", autopay: true)],
                                        followUps: [], meds: [], unsorted: 0, now: now, calendar: cal, clock: clock)
        // The autopay renewal is not listed; a reminder someone set for it by hand still is.
        XCTAssertEqual(needs.map(\.id), ["r:t8", "w:w1"])
    }

    func testTodayLeavesOutChargesOnAutopayButKeepsRenewalsToMakeEvenOverdue() {
        // gnomecannon/aeneas#14: a charge on autopay pays itself, so Today, and another day swiped to, never lists it.
        let watches = [watch("w1", "Plex Pass", due: "2026-11-18"), watch("w2", "Spotify", due: "2026-11-20", autopay: true), watch("w3", "Domain", due: "2026-11-30")]
        XCTAssertEqual(TodayBoard.toRenew(watches).map(\.id), ["w1", "w3"])
        let needs = TodayBoard.needsYou(reminders: [], watches: watches, followUps: [], meds: [], unsorted: 0, now: at(15), calendar: cal, clock: clock)
        XCTAssertEqual(needs.map(\.id), ["w:w1", "w:w3"])
        XCTAssertEqual(needs.first.map { if case .renewal(_, _, let overdue) = $0 { overdue } else { false } }, true)
    }

    func testNeedsYouIsEmptyWhenNothingWaitsAndCountsOneOfEach() {
        XCTAssertTrue(TodayBoard.needsYou(reminders: [], watches: [], followUps: [], meds: [], unsorted: 0, now: at(15), calendar: cal, clock: clock).isEmpty)
        let one = TodayBoard.needsYou(reminders: [], watches: [watch("w", "X", due: "2026-11-23"), watch("v", "Y", due: "2026-11-21")], followUps: [], meds: [], unsorted: 1, now: at(15), calendar: cal, clock: clock)
        XCTAssertEqual(one.map(\.detail), ["Due in 1 day", "1 day overdue", "Waiting in Unsorted Info"])
        XCTAssertEqual(one.last?.title, "1 capture could not be filed")
    }

    func testDaysAreCountedByTheLocalCalendar() {
        XCTAssertEqual(TodayBoard.daysUntil("2026-11-25", now: at(23, 50), calendar: cal), 3)
        XCTAssertEqual(TodayBoard.daysUntil("2026-11-22", now: at(0, 5), calendar: cal), 0)
        // 3 AM UTC on the 23rd is 9 PM on the 22nd in Chicago: today.
        XCTAssertEqual(TodayBoard.daysUntil("2026-11-23T03:00:00.000Z", now: at(10), calendar: cal), 0)
        XCTAssertEqual(TodayBoard.daysUntil("2026-11-20", now: at(10), calendar: cal), -2)
        XCTAssertEqual(TodayBoard.daysUntil("soon", now: at(10), calendar: cal), 0)
    }

    // MARK: to do

    func testOpenTasksOffersTheOneBeingDoneThenNextThenTheInbox() {
        func task(_ id: String, _ status: String, _ order: Double?, created: String = "2026-11-01T00:00:00.000Z", deleted: Bool = false) -> Entity {
            var f: [String: JSONValue] = ["title": .string(id), "status": .string(status)]
            if let order { f["order"] = .number(order) }
            return Entity(id: id, kind: .task, created_at: created, deleted_at: deleted ? "2026-11-02T00:00:00.000Z" : nil, fields: f)
        }
        let tasks = [task("inbox2", "inbox", 7), task("next2", "next", 5), task("done", "done", 1), task("doing", "doing", 9), task("parked", "parked", 0), task("scheduled", "scheduled", 0),
                     task("next1", "next", 2), task("inbox1", "inbox", 3), task("gone", "next", 0, deleted: true), task("inboxNoOrderB", "inbox", nil, created: "2026-11-03T00:00:00.000Z"),
                     task("inboxNoOrderA", "inbox", nil, created: "2026-11-02T00:00:00.000Z")]
        XCTAssertEqual(TodayBoard.openTasks(tasks).map(\.id), ["doing", "next1", "next2", "inbox1", "inbox2", "inboxNoOrderA", "inboxNoOrderB"])
    }

    // MARK: today so far

    func testSoFarPutsDiaryLinesFinishedTasksAndLogsWithWordsInTheOrderTheyHappened() {
        let now = at(15)
        let diary = [TodayBoard.DiaryLine(time: "08:10", text: "Ordered the tile set"), TodayBoard.DiaryLine(time: "12:40", text: "Pepper skipped breakfast")]
        let done = Entity(id: "t1", kind: .task, fields: ["title": "Call the vet", "status": "done", "done_at": .string(ISO.string(at(10, 5)))])
        let old = Entity(id: "t0", kind: .task, fields: ["title": "Yesterday", "status": "done", "done_at": .string(ISO.string(at(10, day: 21)))])
        let med = Entity(id: "l1", kind: .log, fields: ["type": "med", "value": "Claritin", "at": .string(ISO.string(at(7, 30)))])
        let walk = Entity(id: "l2", kind: .log, fields: ["type": "activity", "value": "Walk", "at": .string(ISO.string(at(13)))])
        let weight = Entity(id: "l3", kind: .log, fields: ["type": "weight", "value": 158.4, "at": .string(ISO.string(at(7)))])
        let rows = TodayBoard.soFar(diary: diary, tasks: [done, old], logs: [med, walk, weight], now: now, calendar: cal, clock: clock)
        XCTAssertEqual(rows.map(\.text), ["Took Claritin", "Ordered the tile set", "Done: Call the vet", "Pepper skipped breakfast", "Activity: Walk"])
        XCTAssertEqual(rows.map(\.time), ["07:30", "08:10", "10:05", "12:40", "13:00"])
        XCTAssertEqual(rows.map(\.kind), [.log, .capture, .done, .capture, .log])
        XCTAssertEqual(rows[2].itemId, "t1")
    }

    func testSoFarRunsTheDayFourToFourAsTheDiaryDoes() {
        // 1:30 AM on the 23rd is still the 22nd's day: its line reads after the evening's.
        let now = at(1, 30, day: 23)
        let diary = [TodayBoard.DiaryLine(time: "22:15", text: "Evening"), TodayBoard.DiaryLine(time: "01:10", text: "After midnight")]
        let late = Entity(id: "t1", kind: .task, fields: ["title": "Dishes", "done_at": .string(ISO.string(at(0, 20, day: 23)))])
        let rows = TodayBoard.soFar(diary: diary, tasks: [late], logs: [], now: now, calendar: cal, clock: clock)
        XCTAssertEqual(rows.map(\.text), ["Evening", "Done: Dishes", "After midnight"])
        // After midnight a line from before it says so: a bare 10:15 PM read as later today.
        XCTAssertEqual(rows.map(\.time), ["Yesterday 22:15", "00:20", "01:10"])
        XCTAssertEqual(rows.map(\.day), ["Yesterday", nil, nil])
        XCTAssertEqual(rows.map(\.clock), ["22:15", "00:20", "01:10"])
        XCTAssertEqual(TodayBoard.dayStart(now, calendar: cal), at(4, day: 22))
        XCTAssertEqual(TodayBoard.dayStart(at(4, 1, day: 23), calendar: cal), at(4, day: 23))
    }

    func testDiaryIsTheNoteOfTheDayThatStartedAtFour() {
        let body = "# 2026-11-22\n\n- 08:10 Ordered the tile set\n- 12:40 [Pepper] skipped breakfast\nnot a line\n- 9:00 short time\n"
        let note = Entity(id: "n1", kind: .note, fields: ["path": "Diary/2026-11-22.md", "body": .string(body)])
        let other = Entity(id: "n2", kind: .note, fields: ["path": "Diary/2026-11-23.md", "body": "- 01:00 Too early"])
        let d = TodayBoard.diary([other, note], now: at(1, 30, day: 23), calendar: cal)
        XCTAssertEqual(d?.note.id, "n1")
        XCTAssertEqual(d?.lines, [TodayBoard.DiaryLine(time: "08:10", text: "Ordered the tile set"), TodayBoard.DiaryLine(time: "12:40", text: "[Pepper] skipped breakfast")])
        XCTAssertEqual(TodayBoard.diary([other, note], now: at(9, day: 23), calendar: cal)?.note.id, "n2")
        XCTAssertNil(TodayBoard.diary([note], now: at(9, day: 24), calendar: cal))
    }

    func testTodayNumbersGivesOneNumberPerKindInAFixedOrder() {
        let now = at(15)
        func log(_ type: String, _ value: JSONValue, _ h: Int, unit: String? = nil, day: Int = 22) -> Entity {
            var f: [String: JSONValue] = ["type": .string(type), "value": value, "at": .string(ISO.string(at(h, day: day)))]
            if let unit { f["unit"] = .string(unit) }
            return Entity(kind: .log, fields: f)
        }
        let logs = [log("caffeine", 1, 8, unit: "cups"), log("caffeine", 1, 13, unit: "cups"), log("mood", 1, 9), log("weight", 159.0, 6), log("weight", 158.4, 7), log("steps", 4210, 14),
                    log("sleep", 390, 7), log("weight", 170, 7, day: 21), log("med", "Claritin", 7)]
        let n = TodayBoard.todayNumbers(logs, now: now, calendar: cal)
        XCTAssertEqual(n.map(\.label), ["Weight", "Sleep", "Steps", "Caffeine", "Mood"])
        XCTAssertEqual(n.map(\.value), ["158.4 lb", "6 h 30 min", "4,210", "2 cups", "+1"])
        // One cup is a cup; a weight keeps its own unit; sleep logged in hours reads the same way.
        let one = TodayBoard.todayNumbers([log("caffeine", 1, 8, unit: "cups"), log("weight", 72.5, 7, unit: "kg"), log("sleep", 6.5, 7, unit: "h"), log("mood", -2, 9)], now: now, calendar: cal)
        XCTAssertEqual(one.map(\.value), ["72.5 kg", "6 h 30 min", "1 cup", "-2"])
    }

    // MARK: coming up

    func testTomorrowsPlansAllDayOnesFirstAndHowManyMoreThereAre() {
        let now = at(15)
        func event(_ id: String, _ title: String, _ s: Date, _ e: Date) -> Entity {
            Entity(id: id, kind: .event, fields: ["title": .string(title), "start": .string(ISO.string(s)), "end": .string(ISO.string(e))])
        }
        // An all-day plan is stored at midnight UTC, the evening before in Chicago: it is still tomorrow's.
        let allDay = Entity(id: "e0", kind: .event, fields: ["title": "Jamie visiting", "all_day": true, "start": "2026-11-23T00:00:00.000Z", "end": "2026-11-24T00:00:00.000Z"])
        let events = [event("e3", "Lunch", at(12, day: 23), at(13, day: 23)), event("e1", "Standup", at(9, day: 23), at(9, 30, day: 23)), allDay, event("e9", "Today", at(18), at(19)),
                      event("e4", "Gym", at(18, day: 23), at(19, day: 23)), event("e8", "Day after", at(9, day: 24), at(10, day: 24))]
        let t = TodayBoard.tomorrowLines(events, now: now, calendar: cal, clock: clock)
        XCTAssertEqual(t.lines.map(\.title), ["Jamie visiting", "Standup", "Lunch"])
        XCTAssertEqual(t.lines.map(\.time), ["All day", "09:00", "12:00"])
        XCTAssertEqual(t.more, 1)
        XCTAssertEqual(TodayBoard.tomorrowLines([], now: now, calendar: cal, clock: clock).lines, [])
    }

    func testColumnsAreOneOnAPhoneAndUpToFiveAcrossAWideWindow() {
        let usual = TodaySetting.standard.cards
        let noTech = usual.filter { $0 != .tech }
        for (width, count) in [(390.0, 1), (679.0, 1), (680.0, 2), (1039.0, 2), (1040.0, 3), (1499.0, 3), (1500.0, 4), (2099.0, 4), (2100.0, 5), (3000.0, 5)] {
            XCTAssertEqual(TodayBoard.columnCount(width: width), count, "at \(width)")
            let cols = TodayBoard.columns(width: width, cards: noTech)
            XCTAssertEqual(cols.count, count, "at \(width)")
            // Every card in exactly one place.
            XCTAssertEqual(cols.flatMap { $0 }.sorted { $0.rawValue < $1.rawValue }, noTech.sorted { $0.rawValue < $1.rawValue }, "at \(width)")
            XCTAssertEqual(TodayBoard.columns(width: width, cards: usual).flatMap { $0 }.sorted { $0.rawValue < $1.rawValue }, usual.sorted { $0.rawValue < $1.rawValue }, "at \(width)")
        }
        XCTAssertEqual(TodayBoard.columns(width: 390, cards: noTech), [[.needs, .schedule, .todo, .sofar, .coming]])
        XCTAssertEqual(TodayBoard.columns(width: 1100, cards: noTech).first, [.needs, .todo])
    }

    /// The same cases as todayColumns in web/src/lib/todayBoard.test.ts.
    func testTheDefaultIsDrawnAsTodayAlwaysWasWithTechAtTheTopOfNeedsYou() {
        let usual = TodaySetting.standard.cards
        XCTAssertEqual(TodayBoard.columns(width: 358, cards: usual), [[.tech, .needs, .schedule, .todo, .sofar, .coming]])
        XCTAssertEqual(TodayBoard.columns(width: 792, cards: usual), [[.tech, .needs, .todo, .coming], [.schedule, .sofar]])
        XCTAssertEqual(TodayBoard.columns(width: 1048, cards: usual), [[.tech, .needs, .todo], [.schedule], [.sofar, .coming]])
        XCTAssertEqual(TodayBoard.columns(width: 1688, cards: usual), [[.tech, .needs], [.schedule], [.todo], [.sofar, .coming]])
        XCTAssertEqual(TodayBoard.columns(width: 2328, cards: usual), [[.tech, .needs], [.schedule], [.todo], [.sofar], [.coming]])
    }

    func testColumnsAreFilledInACustomOrder() {
        let cards = TodaySetting(order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: []).cards
        XCTAssertEqual(cards, [.coming, .todo, .schedule, .needs, .tech, .sofar])
        XCTAssertEqual(TodayBoard.columns(width: 358, cards: cards), [[.coming, .todo, .schedule, .needs, .tech, .sofar]])
        XCTAssertEqual(TodayBoard.columns(width: 792, cards: cards), [[.coming, .schedule, .tech, .sofar], [.todo, .needs]])
        XCTAssertEqual(TodayBoard.columns(width: 1048, cards: cards), [[.coming, .schedule], [.todo], [.needs, .tech, .sofar]])
        XCTAssertEqual(TodayBoard.columns(width: 1688, cards: cards), [[.coming], [.todo], [.schedule], [.needs, .tech, .sofar]])
        XCTAssertEqual(TodayBoard.columns(width: 2328, cards: cards), [[.coming], [.todo], [.schedule], [.needs], [.tech, .sofar]])
    }

    func testHiddenCardsAreLeftOutAndEachSlotHasAColumnWhileThereIsRoom() {
        // Two hidden, and Tech last: it sits under the Schedule, so three slots.
        let cards = TodaySetting(order: ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], hidden: ["sofar", "needs"]).cards
        XCTAssertEqual(cards, [.coming, .todo, .schedule, .tech])
        XCTAssertEqual(TodayBoard.columns(width: 358, cards: cards), [[.coming, .todo, .schedule, .tech]])
        XCTAssertEqual(TodayBoard.columns(width: 792, cards: cards), [[.coming, .schedule, .tech], [.todo]])
        XCTAssertEqual(TodayBoard.columns(width: 1048, cards: cards), [[.coming], [.todo], [.schedule, .tech]])
        XCTAssertEqual(TodayBoard.columns(width: 1688, cards: cards), [[.coming], [.todo], [.schedule, .tech]])
        XCTAssertEqual(TodayBoard.columns(width: 2328, cards: cards), [[.coming], [.todo], [.schedule, .tech]])
        // Two cards: never more than two columns, however wide.
        XCTAssertEqual(TodayBoard.columns(width: 2328, cards: [.schedule, .todo]), [[.schedule], [.todo]])
        XCTAssertEqual(TodayBoard.columns(width: 358, cards: []), [])
        // The line at the top is never a card.
        XCTAssertEqual(TodayBoard.columns(width: 358, cards: [.now, .needs]), [[.needs]])
    }

    func testTechSitsWithTheCardAfterItElseTheOneBeforeElseAlone() {
        XCTAssertEqual(TodayBoard.slots([.tech, .needs, .schedule]), [[.tech, .needs], [.schedule]])
        // Needs you hidden: Tech sits at the top of the next card.
        XCTAssertEqual(TodayBoard.slots([.tech, .schedule, .todo]), [[.tech, .schedule], [.todo]])
        XCTAssertEqual(TodayBoard.slots([.schedule, .todo, .tech]), [[.schedule], [.todo, .tech]])
        XCTAssertEqual(TodayBoard.slots([.tech]), [[.tech]])
        XCTAssertEqual(TodayBoard.columns(width: 2328, cards: [.tech]), [[.tech]])
        // Tech never takes a column: hidden or shown, the other cards keep theirs.
        let usual = TodaySetting.standard.cards
        XCTAssertEqual(TodayBoard.columns(width: 1048, cards: usual).map { $0.filter { $0 != .tech } },
                       TodayBoard.columns(width: 1048, cards: usual.filter { $0 != .tech }))
    }

    func testSpansAreMadeFromThePlanAndLeaveOutWhatHasNoTime() {
        let block = PlannerBlock(task_id: "t1", title: "Report", start: ISO.string(at(9)), end: ISO.string(at(12)), status: .doing)
        let rule = PlannerCommitment(rule_id: "r1", title: "Work hours", start: ISO.string(at(9)), end: ISO.string(at(17)), type: .commitment)
        let event = Entity(id: "e1", kind: .event, fields: ["title": "Dentist", "start": .string(ISO.string(at(15))), "end": .string(ISO.string(at(16)))])
        let noTime = Entity(id: "e2", kind: .event, fields: ["title": "Broken"])
        let reminder = Entity(id: "t2", kind: .task, fields: ["title": "Bins", "status": "scheduled", "remind_at": .string(ISO.string(at(20, 30)))])
        let free = FreeSlot(start: ISO.string(at(17)), end: ISO.string(at(20)), hours: 3)
        let s = TodayBoard.spans(blocks: [block], commitments: [rule], events: [event, noTime], reminders: [reminder], freeSlots: [free])
        XCTAssertEqual(s.map(\.kind), [.block, .commitment, .event, .reminder, .free])
        XCTAssertEqual(s.map(\.title), ["Report", "Work hours", "Dentist", "Bins", ""])
        XCTAssertEqual(s[1].rule, .commitment)
        XCTAssertEqual(s[3].start, at(20, 30))
        XCTAssertEqual(s[0].itemId, "t1")
    }
}
