import Foundation

/// ISO-8601 helpers. The contract stores every date as an ISO-8601 string with timezone.
/// We emit UTC with millisecond precision, the same shape as JavaScript's toISOString.
public enum ISO {
    nonisolated(unsafe) private static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()
    nonisolated(unsafe) private static let dateOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone.current
        return f
    }()

    /// The local calendar day as YYYY-MM-DD. `Date.formatted(.iso8601...)` gives the UTC day, which in the Americas
    /// turns over in the evening (7 PM in New York in winter).
    public static func localDay(_ date: Date = Date(), in zone: TimeZone = .current) -> String {
        date.formatted(Date.ISO8601FormatStyle(timeZone: zone).year().month().day())
    }

    public static func string(_ date: Date) -> String { utcString(date) ?? withFractional.string(from: date) }

    /// `string(_:)` written by hand for dates from 1970 to 2999, the same text the formatter writes (ISOTests checks
    /// that): the formatter took tens of microseconds a date, and the Mail list writes one for most of its mails each
    /// time it draws. Other dates go to the formatter.
    static func utcString(_ date: Date) -> String? {
        let u = (date.timeIntervalSinceReferenceDate + Date.timeIntervalBetween1970AndReferenceDate) * 1000
        guard u.isFinite, u >= 0, u < 32_503_680_000_000 else { return nil }
        let ms = Int(u.rounded())
        let secs = ms / 1000, frac = ms % 1000
        let days = secs / 86_400, rem = secs % 86_400
        // The civil date of a day count since 1970-01-01 (H. Hinnant's civil_from_days).
        let z = days + 719_468
        let era = z / 146_097, doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
        guard y <= 2999 else { return nil }
        var out = [UInt8](repeating: 0, count: 24)
        func put(_ v: Int, _ at: Int, _ n: Int) { var v = v; for k in stride(from: at + n - 1, through: at, by: -1) { out[k] = UInt8(48 + v % 10); v /= 10 } }
        put(y, 0, 4); out[4] = 45; put(m, 5, 2); out[7] = 45; put(d, 8, 2); out[10] = 84
        put(rem / 3600, 11, 2); out[13] = 58; put(rem % 3600 / 60, 14, 2); out[16] = 58; put(rem % 60, 17, 2)
        out[19] = 46; put(frac, 20, 3); out[23] = 90
        return String(decoding: out, as: UTF8.self)
    }
    public static func now() -> String { string(Date()) }

    public static func date(_ s: String?) -> Date? {
        guard let s = s, !s.isEmpty else { return nil }
        if let d = utc(s) { return d }
        if let d = withFractional.date(from: s) { return d }
        if let d = plain.date(from: s) { return d }
        if s.count == 10, let d = dateOnly.date(from: s) { return d }
        // Local datetime without zone, e.g. 2026-10-21T09:00
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
            f.dateFormat = fmt
            if let d = f.date(from: s) { return d }
        }
        return nil
    }

    /// The hub's own shape, `2026-11-25T15:04:05.123Z` (JavaScript's toISOString) or the same without the fraction,
    /// read by hand to the same instant the formatters give (ISOTests checks that). The formatters took about 40 µs a
    /// date, and a screen reads thousands of dates each time it draws (every task's, event's and log's): Today took
    /// over a second on a year of data. Anything else (another offset, a date alone, a year before 1900 or after 2999,
    /// a day the month does not have) goes to the formatters as before.
    static func utc(_ s: String) -> Date? {
        let n = s.utf8.count
        guard n == 20 || n == 24 else { return nil }
        let parts = s.utf8.withContiguousStorageIfAvailable { b -> (Int, Int, Int, Int, Int, Int, Int)? in
            func digit(_ i: Int) -> Int? { let c = b[i]; return c >= 48 && c <= 57 ? Int(c - 48) : nil }
            func num(_ i: Int, _ len: Int) -> Int? {
                var v = 0
                for k in i..<(i + len) { guard let d = digit(k) else { return nil }; v = v * 10 + d }
                return v
            }
            guard b[4] == 45, b[7] == 45, b[10] == 84, b[13] == 58, b[16] == 58, b[n - 1] == 90 else { return nil }
            guard let y = num(0, 4), let mo = num(5, 2), let d = num(8, 2), let h = num(11, 2), let mi = num(14, 2), let sec = num(17, 2) else { return nil }
            var ms = 0
            if n == 24 {
                guard b[19] == 46, let f = num(20, 3) else { return nil }
                ms = f
            }
            return (y, mo, d, h, mi, sec, ms)
        }
        guard let p = parts ?? nil else { return nil }
        let (y, mo, d, h, mi, sec, ms) = p
        guard (1900...2999).contains(y), (1...12).contains(mo), h <= 23, mi <= 59, sec <= 59 else { return nil }
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
        let monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
        guard d >= 1, d <= monthDays else { return nil }
        // Days since 1970-01-01 in the Gregorian calendar (H. Hinnant's days_from_civil).
        let yy = mo <= 2 ? y - 1 : y
        let era = yy / 400, yoe = yy - era * 400
        let doy = (153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5 + d - 1
        let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
        let msSince1970 = ((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms
        return Date(timeIntervalSinceReferenceDate: Double(msSince1970) / 1000 - Date.timeIntervalBetween1970AndReferenceDate)
    }

    /// Lexical compare of two ISO strings when both are UTC. Falls back to parsed dates.
    public static func isAfter(_ a: String, _ b: String) -> Bool {
        if let da = date(a), let db = date(b) { return da > db }
        return a > b
    }
}
