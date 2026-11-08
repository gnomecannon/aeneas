import XCTest
@testable import EACore

final class RepeatTests: XCTestCase {
    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }
    private func d(_ y: Int, _ mo: Int, _ day: Int, _ h: Int = 9, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: day, hour: h, minute: mi))!
    }

    func testParse() {
        XCTAssertEqual(RepeatRule.parse("every 1 days"), RepeatRule(n: 1, unit: .days))
        XCTAssertEqual(RepeatRule.parse("every 2 weeks on mon,thu"), RepeatRule(n: 2, unit: .weeks, on: ["mon", "thu"]))
        XCTAssertEqual(RepeatRule.parse("every 1 months on day 15"), RepeatRule(n: 1, unit: .months, on: ["day", "15"]))
        XCTAssertEqual(RepeatRule.parse("every 1 months on day15"), RepeatRule(n: 1, unit: .months, on: ["day15"]))
        XCTAssertEqual(RepeatRule.parse("every 1 months on day 15")?.description, "every 1 months on day15")
        XCTAssertEqual(RepeatRule.parse("every 2 weeks on mon,thu")?.description, "every 2 weeks on mon,thu")
        XCTAssertNil(RepeatRule.parse("daily"))
        XCTAssertNil(RepeatRule.parse("every x days"))
    }

    func testDaily() {
        let rule = RepeatRule.parse("every 1 days")!
        let start = d(2026, 10, 21)
        let next = rule.next(after: d(2026, 10, 22, 10), start: start, calendar: cal)
        XCTAssertEqual(next, d(2026, 10, 23))
    }

    func testEveryTwoHoursStrictlyAfter() {
        let rule = RepeatRule.parse("every 2 hours")!
        let start = d(2026, 10, 21, 8)
        XCTAssertEqual(rule.next(after: d(2026, 10, 21, 8), start: start, calendar: cal), d(2026, 10, 21, 10))
        XCTAssertEqual(rule.next(after: d(2026, 10, 21, 9), start: start, calendar: cal), d(2026, 10, 21, 10))
    }

    func testWeeksOnDays() {
        // 2026-10-19 is a Monday
        let rule = RepeatRule.parse("every 1 weeks on mon,thu")!
        let start = d(2026, 10, 19)
        XCTAssertEqual(rule.next(after: d(2026, 10, 19, 12), start: start, calendar: cal), d(2026, 10, 22)) // Thursday
        XCTAssertEqual(rule.next(after: d(2026, 10, 22, 12), start: start, calendar: cal), d(2026, 10, 26)) // Monday
    }

    func testMonthlyOnDay() {
        for form in ["every 1 months on day 15", "every 1 months on day15"] {
            let rule = RepeatRule.parse(form)!
            let start = d(2026, 10, 15)
            XCTAssertEqual(rule.next(after: d(2026, 10, 15, 12), start: start, calendar: cal), d(2026, 11, 15))
            XCTAssertEqual(rule.next(after: d(2026, 11, 20, 12), start: start, calendar: cal), d(2026, 12, 15))
        }
    }

    func testEffectiveAt() {
        XCTAssertEqual(ReminderMath.effectiveAt(at: "2026-10-21T10:00:00.000Z", snoozedUntil: "2026-10-21T10:10:00.000Z"), "2026-10-21T10:10:00.000Z")
        XCTAssertEqual(ReminderMath.effectiveAt(at: "2026-10-21T10:00:00.000Z", snoozedUntil: "2026-10-21T09:00:00.000Z"), "2026-10-21T10:00:00.000Z")
        XCTAssertEqual(ReminderMath.effectiveAt(at: "2026-10-21T10:00:00.000Z", snoozedUntil: nil), "2026-10-21T10:00:00.000Z")
    }

    func testRepeatsKeepTheirDayAndWeekAsOnTheHub() {
        var ny = Calendar(identifier: .gregorian); ny.timeZone = TimeZone(identifier: "America/New_York")!
        let monthly = RepeatRule.parse("every 1 months")!
        let start = ISO.date("2027-01-31T14:00:00.000Z")!
        XCTAssertEqual(monthly.next(after: ISO.date("2027-02-01T00:00:00Z")!, start: start, calendar: ny).map(ISO.string), "2027-02-28T14:00:00.000Z")
        XCTAssertEqual(monthly.next(after: ISO.date("2027-03-01T00:00:00Z")!, start: start, calendar: ny).map(ISO.string), "2027-03-31T13:00:00.000Z")
        let yearly = RepeatRule.parse("every 1 years")!
        XCTAssertEqual(yearly.next(after: ISO.date("2028-03-01T00:00:00Z")!, start: ISO.date("2028-02-29T14:00:00.000Z")!, calendar: ny).map(ISO.string), "2029-02-28T14:00:00.000Z")
        let biweekly = RepeatRule.parse("every 2 weeks on mon,thu")!
        var days: [String] = []
        var after = ISO.date("2026-11-02T13:00:00Z")!
        for _ in 0..<4 {
            let n = biweekly.next(after: after, start: ISO.date("2026-11-02T14:00:00.000Z")!, calendar: ny)!
            days.append(String(ISO.string(n).prefix(10))); after = n
        }
        XCTAssertEqual(days, ["2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19"])
    }
}
