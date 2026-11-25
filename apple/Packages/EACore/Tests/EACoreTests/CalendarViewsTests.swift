import XCTest
@testable import EACore

/// The Week screen's rules, against the same cases as web/src/lib/calendarViews.test.ts and
/// packages/shared/test/calendars.test.ts, so the apps and the web draw the same views.
final class CalendarViewsTests: XCTestCase {
    private let cal = Calendar.current

    private func day(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
    }
    private func iso(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> String { ISO.string(day(y, m, d, h, min)) }
    private func s(_ d: Date) -> String { CalendarViews.dayString(d) }
    private func range(_ v: CalendarViewKind, _ d: Date) -> [String] {
        let r = CalendarViews.range(v, anchor: d)
        return [s(r.start), s(r.end)]
    }
    private var n = 0
    private func ev(_ fields: [String: JSONValue], deleted: Bool = false) -> Entity {
        n += 1
        var e = Entity(id: String(format: "00000000-0000-4000-8000-%012d", n), kind: .event, fields: fields)
        if deleted { e.deleted_at = "2026-11-01T00:00:00.000Z" }
        return e
    }

    // MARK: periods

    func testEachViewsPeriodEndExclusive() {
        let tue = day(2026, 11, 24, 15)
        XCTAssertEqual(range(.day, tue), ["2026-11-24", "2026-11-25"])
        XCTAssertEqual(range(.week, tue), ["2026-11-23", "2026-11-30"])
        XCTAssertEqual(range(.week, day(2026, 11, 29)), ["2026-11-23", "2026-11-30"], "Sunday is the week's last day")
        XCTAssertEqual(range(.month, tue), ["2026-11-01", "2026-12-01"])
        XCTAssertEqual(range(.year, tue), ["2026-01-01", "2027-01-01"])
        XCTAssertEqual(range(.month, day(2026, 12, 31)), ["2026-12-01", "2027-01-01"])
    }

    func testArrowsMoveByThePeriodKeepingTheDayOfTheMonthWhereTheyCan() {
        let d = day(2026, 1, 31)
        XCTAssertEqual(s(CalendarViews.shift(.day, anchor: d, by: 1)), "2026-02-01")
        XCTAssertEqual(s(CalendarViews.shift(.day, anchor: d, by: -1)), "2026-01-30")
        XCTAssertEqual(s(CalendarViews.shift(.week, anchor: d, by: 1)), "2026-02-07")
        XCTAssertEqual(s(CalendarViews.shift(.week, anchor: d, by: -2)), "2026-01-17")
        XCTAssertEqual(s(CalendarViews.shift(.month, anchor: d, by: 1)), "2026-02-28")
        XCTAssertEqual(s(CalendarViews.shift(.month, anchor: d, by: -1)), "2025-12-31")
        XCTAssertEqual(s(CalendarViews.shift(.month, anchor: day(2026, 3, 31), by: -1)), "2026-02-28")
        XCTAssertEqual(s(CalendarViews.shift(.month, anchor: day(2026, 11, 15), by: 14)), "2028-01-15")
        XCTAssertEqual(s(CalendarViews.shift(.year, anchor: day(2028, 2, 29), by: 1)), "2029-02-28")
        XCTAssertEqual(s(CalendarViews.shift(.year, anchor: day(2026, 11, 24), by: -1)), "2025-11-24")
    }

    func testWhetherAPeriodHoldsToday() {
        let today = day(2026, 11, 24)
        XCTAssertTrue(CalendarViews.holds(.week, anchor: day(2026, 11, 29), day: today))
        XCTAssertFalse(CalendarViews.holds(.week, anchor: day(2026, 11, 30), day: today))
        XCTAssertFalse(CalendarViews.holds(.day, anchor: day(2026, 11, 25), day: today))
        XCTAssertTrue(CalendarViews.holds(.month, anchor: day(2026, 11, 1), day: today))
        XCTAssertFalse(CalendarViews.holds(.year, anchor: day(2025, 11, 24), day: today))
        XCTAssertEqual(CalendarViewKind.allCases.map(\.title), ["Day", "Week", "Month", "Year"])
    }

    // MARK: grids

    func testAMonthIsTheWeeksThatHoldItsDaysMondayFirst() {
        let nov = CalendarViews.monthGrid(year: 2026, month: 11)
        XCTAssertEqual(nov.count, 6)
        XCTAssertEqual(nov[0][0], .init(date: "2026-10-26", inMonth: false))
        XCTAssertEqual(nov[0][6], .init(date: "2026-11-01", inMonth: true))
        XCTAssertEqual(nov[5][0], .init(date: "2026-11-30", inMonth: true))
        XCTAssertEqual(nov[5][6], .init(date: "2026-12-06", inMonth: false))
        XCTAssertTrue(nov.allSatisfy { $0.count == 7 })
        // February 2027 starts on a Monday and has 28 days: four rows exactly.
        let feb = CalendarViews.monthGrid(year: 2027, month: 2)
        XCTAssertEqual(feb.count, 4)
        XCTAssertEqual(feb[0][0], .init(date: "2027-02-01", inMonth: true))
        XCTAssertEqual(feb[3][6], .init(date: "2027-02-28", inMonth: true))
        XCTAssertEqual(CalendarViews.monthGrid(year: 2026, month: 2).count, 5)
        let inMonth = nov.flatMap { $0 }.filter(\.inMonth).map(\.date)
        XCTAssertEqual(inMonth.count, 30)
        XCTAssertEqual(inMonth.first, "2026-11-01")
        XCTAssertEqual(inMonth.last, "2026-11-30")
        XCTAssertEqual(nov[5][0].number, 30)
    }

    func testAYearIsItsTwelveMonths() {
        let y = CalendarViews.yearGrid(year: 2026)
        XCTAssertEqual(y.map(\.month), Array(1...12))
        XCTAssertEqual(y[0].weeks[0][3], .init(date: "2026-01-01", inMonth: true))
        XCTAssertEqual(y.reduce(0) { $0 + $1.weeks.flatMap { $0 }.filter(\.inMonth).count }, 365)
    }

    // MARK: events on days

    func testTheDaysAnEventIsOn() {
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 11, 24, 9)), "end": .string(iso(2026, 11, 24, 10))]), ["2026-11-24"])
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 11, 24, 22)), "end": .string(iso(2026, 11, 25, 1))]), ["2026-11-24", "2026-11-25"])
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 11, 24, 22)), "end": .string(iso(2026, 11, 25, 0))]), ["2026-11-24"], "ending at midnight is not on the next day")
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 11, 24, 9)), "end": .string(iso(2026, 11, 24, 9))]), ["2026-11-24"])
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 11, 24, 9))]), ["2026-11-24"])
        XCTAssertEqual(CalendarViews.days(["start": "2026-11-20T00:00:00.000Z", "end": "2026-11-22T00:00:00.000Z", "all_day": true]), ["2026-11-20", "2026-11-21"])
        XCTAssertEqual(CalendarViews.days(["start": "2026-11-20", "end": "2026-11-20", "all_day": true]), ["2026-11-20"])
        XCTAssertEqual(CalendarViews.days(["start": "nonsense"]), [])
        XCTAssertEqual(CalendarViews.days(["start": .string(iso(2026, 1, 1)), "end": .string(iso(2030, 1, 1))]).count, 62)
    }

    func testEachDaysEventsAllDayFirstThenByStart() {
        let lunch = ev(["title": "Lunch", "start": .string(iso(2026, 11, 24, 12)), "end": .string(iso(2026, 11, 24, 13))])
        let trip = ev(["title": "Trip", "start": "2026-11-23T00:00:00.000Z", "end": "2026-11-26T00:00:00.000Z", "all_day": true])
        let early = ev(["title": "Run", "start": .string(iso(2026, 11, 24, 7)), "end": .string(iso(2026, 11, 24, 8))])
        let gone = ev(["title": "Gone", "start": .string(iso(2026, 11, 24, 9)), "end": .string(iso(2026, 11, 24, 10))], deleted: true)
        let outside = ev(["title": "Later", "start": .string(iso(2026, 12, 2, 9)), "end": .string(iso(2026, 12, 2, 10))])
        let r = CalendarViews.range(.week, anchor: day(2026, 11, 24))
        let by = CalendarViews.eventsByDay([lunch, trip, early, gone, outside], from: r.start, to: r.end)
        XCTAssertEqual(by["2026-11-24"]?.map { $0.str("title") }, ["Trip", "Run", "Lunch"])
        XCTAssertEqual(by["2026-11-23"]?.map { $0.str("title") }, ["Trip"])
        XCTAssertEqual(by["2026-11-25"]?.map { $0.str("title") }, ["Trip"])
        XCTAssertNil(by["2026-11-26"])
        XCTAssertNil(by["2026-12-02"])
    }

    func testAHiddenCalendarsEventsAreLeftOutBeforeTheyArePlaced() {
        let home = ev(["title": "Dinner", "start": .string(iso(2026, 11, 24, 19)), "end": .string(iso(2026, 11, 24, 21)), "calendar_key": "apple:iCloud/Home"])
        let work = ev(["title": "Standup", "start": .string(iso(2026, 11, 24, 9)), "end": .string(iso(2026, 11, 24, 10)), "calendar_key": "apple:Work/Team"])
        let mine = ev(["title": "Climbing", "start": .string(iso(2026, 11, 24, 17)), "end": .string(iso(2026, 11, 24, 18))])
        let hidden = ["apple:Work/Team", "aeneas"]
        let r = CalendarViews.range(.day, anchor: day(2026, 11, 24))
        let by = CalendarViews.eventsByDay([home, work, mine].filter { HiddenCalendars.shown($0, hidden: hidden) }, from: r.start, to: r.end)
        XCTAssertEqual(by["2026-11-24"]?.map { $0.str("title") }, ["Dinner"])
    }

    // MARK: search

    func testEveryWordInTheTitleOrThePlaceIgnoringCaseAndAccents() {
        XCTAssertEqual(CalendarViews.fold("Café CRÈME"), "cafe creme")
        XCTAssertEqual(CalendarViews.words("  Dentist   maple "), ["dentist", "maple"])
        let f: [String: JSONValue] = ["title": "Dentist cleaning", "location": "Maple Street Dental"]
        XCTAssertTrue(CalendarViews.matches(f, words: CalendarViews.words("dentist")))
        XCTAssertTrue(CalendarViews.matches(f, words: CalendarViews.words("maple dentist")))
        XCTAssertTrue(CalendarViews.matches(f, words: CalendarViews.words("street")))
        XCTAssertFalse(CalendarViews.matches(f, words: CalendarViews.words("dentist oak")))
        XCTAssertTrue(CalendarViews.matches(["title": "Coffee at Café Rose"], words: CalendarViews.words("cafe")))
        XCTAssertTrue(CalendarViews.matches(["title": "Cafe"], words: CalendarViews.words("CAFÉ")))
        XCTAssertFalse(CalendarViews.matches(f, words: []))
        XCTAssertFalse(CalendarViews.matches(["title": "Lunch", "notes": "dentist"], words: CalendarViews.words("dentist")), "events carry no notes")
    }

    func testResultsByTheDayTheyStartTodayOnThenEarlierNewestFirst() {
        let today = day(2026, 11, 24, 10)
        let a = ev(["title": "Dentist", "start": .string(iso(2026, 11, 24, 15)), "end": .string(iso(2026, 11, 24, 16))])
        let b = ev(["title": "Dentist again", "start": .string(iso(2026, 12, 8, 9)), "end": .string(iso(2026, 12, 8, 10))])
        let c = ev(["title": "Dentist", "start": .string(iso(2026, 11, 24, 8)), "end": .string(iso(2026, 11, 24, 9))])
        let d = ev(["title": "Old dentist", "start": .string(iso(2026, 6, 1, 9)), "end": .string(iso(2026, 6, 1, 10))])
        let e = ev(["title": "Dentist long ago", "start": .string(iso(2025, 6, 1, 9)), "end": .string(iso(2025, 6, 1, 10))])
        let other = ev(["title": "Lunch", "start": .string(iso(2026, 11, 25, 12)), "end": .string(iso(2026, 11, 25, 13))])
        let r = CalendarViews.search([e, other, b, a, d, c], query: "dentist", today: today)
        XCTAssertEqual(r.total, 5)
        XCTAssertEqual(r.upcoming.map(\.date), ["2026-11-24", "2026-12-08"])
        XCTAssertEqual(r.upcoming[0].events.map(\.id), [c.id, a.id], "earlier start first inside a day")
        XCTAssertEqual(r.upcoming[1].events.map { $0.str("title") }, ["Dentist again"])
        XCTAssertEqual(r.earlier.map(\.date), ["2026-06-01", "2025-06-01"])
        let few = CalendarViews.search([e, b, a, d, c], query: "dentist", today: today, limit: 3)
        XCTAssertEqual(few.total, 5)
        XCTAssertEqual(few.shown, 3)
        XCTAssertEqual(few.earlier.map(\.date), [], "the limit takes upcoming ones first")
        let none = CalendarViews.search([a], query: "   ", today: today)
        XCTAssertEqual(none.total, 0)
        XCTAssertTrue(none.upcoming.isEmpty && none.earlier.isEmpty)
    }

    // MARK: the calendars setting (packages/shared/test/calendars.test.ts)

    func testAListOfAtMost300KeysEachNamedOnce() {
        XCTAssertTrue(HiddenCalendars.isValid([]))
        XCTAssertTrue(HiddenCalendars.isValid(["apple:iCloud/Home", "aeneas"]))
        let full = (0..<HiddenCalendars.maxCount).map { "apple:A/\($0)" }
        XCTAssertTrue(HiddenCalendars.isValid(full))
        for bad in [["a", "a"], [""], [String(repeating: "x", count: 301)], ["tab\there"], full + ["one-more"]] {
            XCTAssertFalse(HiddenCalendars.isValid(bad), "\(bad.prefix(2))")
        }
        XCTAssertTrue(HiddenCalendars.isKey(String(repeating: "x", count: 300)))
    }

    func testTheSettingReadsFromTheFeelAndABrokenOneHidesNothing() throws {
        let ok = try JSONDecoder().decode(FeelSettings.self, from: Data(#"{"hidden_calendars":["apple:iCloud/Home","aeneas"]}"#.utf8))
        XCTAssertEqual(ok.hiddenCalendars, ["apple:iCloud/Home", "aeneas"])
        for bad in [#"{"hidden_calendars":["a","a"]}"#, #"{"hidden_calendars":"aeneas"}"#, #"{}"#] {
            let f = try JSONDecoder().decode(FeelSettings.self, from: Data(bad.utf8))
            XCTAssertNil(f.hidden_calendars, bad)
            XCTAssertEqual(f.hiddenCalendars, [])
        }
        // Sent back as it came.
        let back = try JSONDecoder().decode(FeelSettings.self, from: JSONEncoder().encode(ok))
        XCTAssertEqual(back.hidden_calendars, ["apple:iCloud/Home", "aeneas"])
    }

    func testAnEventIsOnItsCalendarsKeyOrOnAeneas() {
        let icloud: [String: JSONValue] = ["title": "Dinner", "caldav": .object(["account": "you@icloud.com", "calendar": "https://x/cal/home/", "uid": "1"])]
        let apple: [String: JSONValue] = ["title": "Standup", "calendar_key": "apple:Work/Team"]
        let older: [String: JSONValue] = ["title": "Lunch", "apple": .object(["id": "9", "calendar": "Home"])]
        let m365: [String: JSONValue] = ["title": "Review", "source": "m365"]
        let mine: [String: JSONValue] = ["title": "Climbing"]
        XCTAssertEqual(HiddenCalendars.key(icloud), "icloud:https://x/cal/home/")
        XCTAssertEqual(HiddenCalendars.key(apple), "apple:Work/Team")
        XCTAssertEqual(HiddenCalendars.key(older), "apple:Home")
        XCTAssertEqual(HiddenCalendars.key(m365), "work:m365")
        XCTAssertEqual(HiddenCalendars.key(mine), HiddenCalendars.noCalendar)
        let hidden = ["apple:Work/Team", "aeneas"]
        let shown = [icloud, apple, older, m365, mine].map { ev($0) }.filter { HiddenCalendars.shown($0, hidden: hidden) }.map { $0.str("title") }
        XCTAssertEqual(shown, ["Dinner", "Lunch", "Review"])
        XCTAssertTrue(HiddenCalendars.shown(ev(apple), hidden: []))
    }

    func testNamesFromAKeyAlone() {
        XCTAssertTrue(HiddenCalendars.name(fromKey: "apple:iCloud/Family") == ("Family", "iCloud"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "apple:jamie@work.example/Team/Ops") == ("Team/Ops", "jamie@work.example"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "apple:Home") == ("Home", "Apple Calendar"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "icloud:https://p42-caldav.icloud.com/1/calendars/home/") == ("iCloud calendar", "iCloud"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "work:m365") == ("Microsoft 365", "Work"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "aeneas") == ("Made in Aeneas", "Aeneas"))
        XCTAssertTrue(HiddenCalendars.name(fromKey: "something:else") == ("something:else", "Other"))
    }

    func testTheListHoldsTheCalendarsEventsAreOnAndTheHiddenOnesStillKnownByAccountAeneasLast() {
        let calendars = [
            CalendarColorEntry(key: "icloud:https://x/home/", name: "Home", account: "jamie@icloud.com", color: "#FF2968"),
            CalendarColorEntry(key: "icloud:https://x/family/", name: "Family", account: "jamie@icloud.com", color: "#34C759", chosen: "#5856D6"),
            CalendarColorEntry(key: "apple:Exchange/Calendar", name: "Calendar", account: "Exchange", color: "#0A84FF"),
            CalendarColorEntry(key: "apple:Exchange/Holidays", name: "Holidays", account: "Exchange"),
            CalendarColorEntry(key: "icloud:https://x/empty/", name: "Empty", account: "jamie@icloud.com"),
        ]
        let groups = HiddenCalendars.groups(calendars: calendars,
                                            eventKeys: ["icloud:https://x/home/", "icloud:https://x/family/", "apple:Exchange/Calendar", "aeneas", "apple:Robin/Book club"],
                                            hidden: ["apple:Exchange/Holidays", "apple:Gone/Old", "aeneas"])
        XCTAssertEqual(groups.map(\.account), ["Exchange", "jamie@icloud.com", "Robin", "Aeneas"])
        XCTAssertEqual(groups[0].calendars.map { "\($0.name) \($0.color ?? "-") \($0.shown)" }, ["Calendar #0A84FF true", "Holidays - false"])
        XCTAssertEqual(groups[1].calendars.map { "\($0.name) \($0.color ?? "-") \($0.shown)" }, ["Family #5856D6 true", "Home #FF2968 true"])
        XCTAssertEqual(groups[2].calendars.map { "\($0.name) \($0.color ?? "-") \($0.shown)" }, ["Book club - true"])
        XCTAssertEqual(groups[3].calendars.map { "\($0.name) \($0.color ?? "-") \($0.shown)" }, ["Made in Aeneas - false"])
        XCTAssertFalse(groups.flatMap(\.calendars).contains { $0.name == "Empty" || $0.key == "apple:Gone/Old" })
        XCTAssertEqual(HiddenCalendars.groups(calendars: [], eventKeys: [], hidden: []), [])
    }

    func testShowingAndHidingOneKeepsTheRestInOrder() {
        XCTAssertEqual(HiddenCalendars.with([], key: "a", shown: false), ["a"])
        XCTAssertEqual(HiddenCalendars.with(["a", "b"], key: "c", shown: false), ["a", "b", "c"])
        XCTAssertEqual(HiddenCalendars.with(["a", "b", "c"], key: "b", shown: true), ["a", "c"])
        XCTAssertEqual(HiddenCalendars.with(["a"], key: "a", shown: false), ["a"])
        let full = (0..<HiddenCalendars.maxCount).map { "k\($0)" }
        let more = HiddenCalendars.with(full, key: "new", shown: false)
        XCTAssertEqual(more.count, HiddenCalendars.maxCount)
        XCTAssertEqual(more.last, "new")
        XCTAssertTrue(HiddenCalendars.isValid(more))
    }

    func testTheContractNamesTheSettingAndItsRules() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages, apple: the repository
        let text = try String(contentsOf: root.appendingPathComponent("packages/shared/CONTRACT.md"), encoding: .utf8)
        XCTAssertTrue(text.contains("`hidden_calendars` (since 2026-11-24)"))
        XCTAssertTrue(text.contains("at most 300 calendar keys, each named once"))
        XCTAssertTrue(text.contains("EACore `CalendarViews.swift`"))
    }

    // The same cases as "calendar views: events side by side" in web/src/lib/calendarViews.test.ts.
    private func lanes(_ spans: [(String, Double, Double)]) -> [String: String] {
        CalendarViews.lanes(spans.map { (id: $0.0, start: $0.1, end: $0.2) }).mapValues { "\($0.lane)/\($0.lanes)" }
    }

    func testEventsThatDoNotOverlapTakeTheFullWidth() {
        XCTAssertEqual(lanes([("a", 540, 600), ("b", 600, 660)]), ["a": "0/1", "b": "0/1"])
    }

    func testTwoThatOverlapShareTheWidthTheEarlierOnTheLeft() {
        XCTAssertEqual(lanes([("board", 1140, 1320), ("climb", 1080, 1170)]), ["climb": "0/2", "board": "1/2"])
    }

    func testAChainOfOverlapsSharesOneLaneCountAndALaneIsUsedAgain() {
        XCTAssertEqual(lanes([("a", 540, 660), ("b", 600, 720), ("c", 660, 780)]), ["a": "0/2", "b": "1/2", "c": "0/2"])
    }

    func testThreeAtOnceTakeThreeLanesAndALaterEventTakesTheFullWidth() {
        XCTAssertEqual(lanes([("a", 540, 600), ("b", 540, 600), ("c", 540, 600), ("d", 720, 780)]), ["a": "0/3", "b": "1/3", "c": "2/3", "d": "0/1"])
    }

    func testAtTheSameStartTheLongerGoesFirst() {
        XCTAssertEqual(lanes([("short", 540, 600), ("long", 540, 720)]), ["long": "0/2", "short": "1/2"])
    }
}
