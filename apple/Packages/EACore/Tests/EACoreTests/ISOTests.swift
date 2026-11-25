import XCTest
@testable import EACore

final class ISOTests: XCTestCase {
    /// The hand reading of the hub's dates gives exactly the instant the formatters give, for every shape it takes,
    /// and leaves every other shape to them.
    func testHandReadingGivesTheFormattersInstant() {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        var rng = SystemRandomNumberGenerator()
        func two(_ v: Int) -> String { v < 10 ? "0\(v)" : "\(v)" }
        func three(_ v: Int) -> String { v < 10 ? "00\(v)" : v < 100 ? "0\(v)" : "\(v)" }
        var checked = 0
        for i in 0..<60_000 {
            let y = i < 1000 ? [1900, 1970, 2000, 2024, 2026, 2100, 2400, 2999][i % 8] : Int.random(in: 1900...2999, using: &rng)
            let mo = Int.random(in: 1...12, using: &rng)
            let d = Int.random(in: 1...31, using: &rng)
            let h = Int.random(in: 0...23, using: &rng), mi = Int.random(in: 0...59, using: &rng), s = Int.random(in: 0...59, using: &rng)
            let ms = i % 7 == 0 ? 0 : Int.random(in: 0...999, using: &rng)
            let head = "\(y)-\(two(mo))-\(two(d))T\(two(h)):\(two(mi)):\(two(s))"
            for (text, f) in [("\(head).\(three(ms))Z", fractional), ("\(head)Z", plain)] {
                let want = f.date(from: text)
                let got = ISO.utc(text)
                if let got {
                    XCTAssertEqual(got.timeIntervalSinceReferenceDate.bitPattern, want?.timeIntervalSinceReferenceDate.bitPattern, text)
                    checked += 1
                } else {
                    // Only a day the month does not have is left to the formatter here.
                    XCTAssertGreaterThan(d, 28, text)
                }
                XCTAssertEqual(ISO.date(text), want, text)
            }
        }
        XCTAssertGreaterThan(checked, 100_000)
        for other in ["2026-11-25", "2026-11-25T10:00:00+02:00", "2026-11-25T10:00:00.5Z", "2026-11-25T10:00", "1899-12-31T23:59:59.999Z", "2026-13-01T00:00:00.000Z",
                      "2026-11-25T24:00:00.000Z", "2026-11-25 10:00:00.000Z", "２０２６-11-25T10:00:00.000Z", "2026-02-29T00:00:00.000Z"] {
            XCTAssertNil(ISO.utc(other), other)
        }
        XCTAssertEqual(ISO.date("2026-11-25T10:00:00+02:00"), plain.date(from: "2026-11-25T08:00:00Z"))
        // What the apps write themselves reads back the same way.
        let written = ISO.string(Date(timeIntervalSinceReferenceDate: 786_000_000.123))
        XCTAssertEqual(ISO.utc(written), fractional.date(from: written))
    }

    /// The hand writing of dates gives the formatter's text for every date from 1970 to 2999 (milliseconds rounded as
    /// the formatter rounds them, halves included), and leaves the others to it.
    func testHandWritingGivesTheFormattersText() {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        var rng = SystemRandomNumberGenerator()
        let start = -Date.timeIntervalBetween1970AndReferenceDate, end = 32_503_680_000 - Date.timeIntervalBetween1970AndReferenceDate
        var written = 0
        for i in 0..<200_000 {
            let t: Double
            switch i % 4 {
            case 0: t = Double.random(in: start..<end, using: &rng)
            case 1: t = Double(Int.random(in: 0...32_503_679_999_999, using: &rng)) / 1000 - Date.timeIntervalBetween1970AndReferenceDate
            case 2: t = Double(Int.random(in: 0...32_503_679_999, using: &rng)) + Double(Int.random(in: 0...999, using: &rng)) / 1000 + 0.0005 - Date.timeIntervalBetween1970AndReferenceDate
            default: t = Date().timeIntervalSinceReferenceDate + Double.random(in: -1e8...1e8, using: &rng)
            }
            let d = Date(timeIntervalSinceReferenceDate: t)
            guard let got = ISO.utcString(d) else { continue }
            XCTAssertEqual(got, f.string(from: d), "\(t)")
            written += 1
        }
        XCTAssertGreaterThan(written, 190_000)
        XCTAssertNil(ISO.utcString(Date(timeIntervalSince1970: -1)))
        XCTAssertNil(ISO.utcString(Date(timeIntervalSince1970: 32_503_680_000)))
        XCTAssertEqual(ISO.string(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00.000Z")
        XCTAssertEqual(ISO.string(Date(timeIntervalSince1970: 1_798_761_599.9996)), f.string(from: Date(timeIntervalSince1970: 1_798_761_599.9996)))
    }
}
