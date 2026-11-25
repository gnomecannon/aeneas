import XCTest
@testable import EACore

final class SameDayTests: XCTestCase {
    /// The planner's same-day test gives the calendar's own answer, across daylight saving changes and in zones whose
    /// day does not start at midnight on some dates.
    func testSameDayIsTheCalendarsAnswer() {
        var rng = SystemRandomNumberGenerator()
        for zone in ["America/New_York", "Europe/London", "America/Sao_Paulo", "Asia/Kolkata", "Pacific/Chatham", "America/Havana", "UTC"] {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TimeZone(identifier: zone)!
            // Days around the changes of 2018 (Sao Paulo then changed at midnight) and of 2026.
            for base in [ISO.date("2018-11-04T12:00:00Z")!, ISO.date("2026-03-08T12:00:00Z")!, ISO.date("2026-03-29T12:00:00Z")!, ISO.date("2026-11-01T12:00:00Z")!, ISO.date("2026-11-25T15:00:00Z")!] {
                for dayOffset in -2...2 {
                    let day = base.addingTimeInterval(Double(dayOffset) * 86_400 + Double.random(in: -40_000...40_000, using: &rng))
                    let test = LocalPlanner.sameDay(as: day, calendar: cal)
                    for _ in 0..<400 {
                        let d = day.addingTimeInterval(Double.random(in: -200_000...200_000, using: &rng).rounded())
                        XCTAssertEqual(test(d), cal.isDate(d, inSameDayAs: day), "\(zone) \(d) \(day)")
                    }
                    let start = cal.startOfDay(for: day)
                    XCTAssertEqual(test(start), true)
                    XCTAssertEqual(test(start.addingTimeInterval(-0.001)), cal.isDate(start.addingTimeInterval(-0.001), inSameDayAs: day))
                }
            }
        }
    }
}
