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

    public static func string(_ date: Date) -> String { withFractional.string(from: date) }
    public static func now() -> String { string(Date()) }

    public static func date(_ s: String?) -> Date? {
        guard let s = s, !s.isEmpty else { return nil }
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

    /// Lexical compare of two ISO strings when both are UTC. Falls back to parsed dates.
    public static func isAfter(_ a: String, _ b: String) -> Bool {
        if let da = date(a), let db = date(b) { return da > db }
        return a > b
    }
}
