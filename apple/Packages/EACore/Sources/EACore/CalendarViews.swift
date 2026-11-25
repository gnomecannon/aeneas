import Foundation

/// A view of the Week screen, as Apple's Calendar has them: Day, Week, Month and Year (CONTRACT.md, Planner, Week
/// screen). The same views as `CALENDAR_VIEWS` in web/src/lib/calendarViews.ts.
public enum CalendarViewKind: String, CaseIterable, Codable, Sendable, Identifiable {
    case day, week, month, year

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .day: return "Day"
        case .week: return "Week"
        case .month: return "Month"
        case .year: return "Year"
        }
    }
    /// What the arrows move by, for VoiceOver.
    public var period: String { rawValue }
}

/// The Week screen's views: the period each shows and how the arrows move it, the month and year grids, the events on
/// each day, and search. Pure, in local time. The rules are the ones in web/src/lib/calendarViews.ts, tested against
/// the same cases.
public enum CalendarViews {
    /// A local date as `YYYY-MM-DD` in `calendar`'s time zone.
    public static func dayString(_ d: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func add(_ c: Calendar.Component, _ n: Int, to d: Date, _ calendar: Calendar) -> Date {
        calendar.date(byAdding: c, value: n, to: d) ?? d
    }

    /// The period a view shows around the day looked at, end exclusive: that day; Monday to the next Monday; the first
    /// of the month to the first of the next; January 1 to the next January 1.
    public static func range(_ view: CalendarViewKind, anchor: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
        let d = calendar.startOfDay(for: anchor)
        switch view {
        case .day:
            return (d, add(.day, 1, to: d, calendar))
        case .week:
            let mon = LocalPlanner.monday(of: d, calendar: calendar)
            return (mon, add(.day, 7, to: mon, calendar))
        case .month:
            let first = calendar.date(from: calendar.dateComponents([.year, .month], from: d)) ?? d
            return (first, add(.month, 1, to: first, calendar))
        case .year:
            let first = calendar.date(from: calendar.dateComponents([.year], from: d)) ?? d
            return (first, add(.year, 1, to: first, calendar))
        }
    }

    /// The day looked at after the arrows move `n` periods (negative goes back): by days, weeks, months or years.
    /// Moving by months or years keeps the day of the month, or the month's last day when it has fewer.
    public static func shift(_ view: CalendarViewKind, anchor: Date, by n: Int, calendar: Calendar = .current) -> Date {
        let d = calendar.startOfDay(for: anchor)
        switch view {
        case .day: return add(.day, n, to: d, calendar)
        case .week: return add(.day, 7 * n, to: d, calendar)
        case .month: return add(.month, n, to: d, calendar)
        case .year: return add(.year, n, to: d, calendar)
        }
    }

    /// Whether the period a view shows around `anchor` holds `day`.
    public static func holds(_ view: CalendarViewKind, anchor: Date, day: Date, calendar: Calendar = .current) -> Bool {
        let r = range(view, anchor: anchor, calendar: calendar)
        let t = calendar.startOfDay(for: day)
        return t >= r.start && t < r.end
    }

    /// One day of a month grid: its date, and whether it is in the month shown (the others are drawn faded).
    public struct GridDay: Equatable, Hashable, Identifiable, Sendable {
        public var date: String
        public var inMonth: Bool
        public var id: String { date }
        public init(date: String, inMonth: Bool) { self.date = date; self.inMonth = inMonth }
        /// The day of the month.
        public var number: Int { Int(date.suffix(2)) ?? 0 }
    }

    /// A month as weeks of seven days, Monday first: every week that holds a day of the month (4 to 6), with the days
    /// of the months either side that fill those weeks. `month` is 1 for January.
    public static func monthGrid(year: Int, month: Int, calendar: Calendar = .current) -> [[GridDay]] {
        guard let first = calendar.date(from: DateComponents(year: year, month: month, day: 1)) else { return [] }
        let end = add(.month, 1, to: first, calendar)
        var weeks: [[GridDay]] = []
        var mon = LocalPlanner.monday(of: first, calendar: calendar)
        while mon < end, weeks.count < 6 {
            weeks.append((0..<7).map { i in
                let d = add(.day, i, to: mon, calendar)
                let c = calendar.dateComponents([.year, .month], from: d)
                return GridDay(date: dayString(d, calendar: calendar), inMonth: c.year == year && c.month == month)
            })
            mon = add(.day, 7, to: mon, calendar)
        }
        return weeks
    }

    public struct MonthGrid: Equatable, Identifiable, Sendable {
        /// 1 for January.
        public var month: Int
        public var weeks: [[GridDay]]
        public var id: Int { month }
    }

    /// The twelve months of a year, each as its grid.
    public static func yearGrid(year: Int, calendar: Calendar = .current) -> [MonthGrid] {
        (1...12).map { MonthGrid(month: $0, weeks: monthGrid(year: year, month: $0, calendar: calendar)) }
    }

    /// At most this many days per event: a stray end years away must not fill every cell.
    static let maxSpanDays = 62

    /// The local days an event is on. An all-day one: the date parts of its start and end, end exclusive (stored at
    /// midnight UTC, it is never the evening before west of UTC). A timed one: from its start's day to the day its last
    /// moment is in; one with no length is on its start's day.
    public static func days(_ f: [String: JSONValue], calendar: Calendar = .current) -> [String] {
        let start = f["start"]?.stringValue ?? ""
        let endRaw = (f["end"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? start
        var first: Date
        var last: Date
        if f["all_day"]?.boolValue == true {
            guard let a = LocalPlanner.date(String(start.prefix(10)), in: calendar) else { return [] }
            first = a
            let after = LocalPlanner.date(String(endRaw.prefix(10)), in: calendar) ?? a
            last = after > a ? add(.day, -1, to: after, calendar) : a
        } else {
            guard let s = ISO.date(start) else { return [] }
            let e = ISO.date(endRaw).flatMap { $0 > s ? $0.addingTimeInterval(-0.001) : nil } ?? s
            first = calendar.startOfDay(for: s)
            last = calendar.startOfDay(for: e)
        }
        var out: [String] = []
        var d = first
        while d <= last, out.count < maxSpanDays {
            out.append(dayString(d, calendar: calendar))
            d = add(.day, 1, to: d, calendar)
        }
        return out
    }

    /// Events in the order a day lists them: all-day first, then by start, then by title.
    public static func dayOrder(_ a: Entity, _ b: Entity) -> Bool {
        let ad = a.bool("all_day") == true ? 0 : 1, bd = b.bool("all_day") == true ? 0 : 1
        if ad != bd { return ad < bd }
        let sa = ISO.date(a.str("start")) ?? .distantPast, sb = ISO.date(b.str("start")) ?? .distantPast
        if sa != sb { return sa < sb }
        return a.str("title") < b.str("title")
    }

    /// The events on each local day from `start` to `end` (exclusive), by `YYYY-MM-DD`, each day in `dayOrder`.
    public static func eventsByDay(_ events: [Entity], from start: Date, to end: Date, calendar: Calendar = .current) -> [String: [Entity]] {
        let from = dayString(start, calendar: calendar), to = dayString(end, calendar: calendar)
        var out: [String: [Entity]] = [:]
        for e in events where !e.isDeleted {
            for day in days(e.fields, calendar: calendar) where day >= from && day < to { out[day, default: []].append(e) }
        }
        return out.mapValues { $0.sorted(by: dayOrder) }
    }

    // MARK: search

    /// Text as search compares it: lower case, accents taken off.
    public static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).lowercased()
    }

    /// The words of a search, folded.
    public static func words(_ query: String) -> [String] {
        fold(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// Whether an event has every word of a search somewhere in its title or place. No words matches nothing.
    public static func matches(_ f: [String: JSONValue], words: [String]) -> Bool {
        guard !words.isEmpty else { return false }
        let text = fold("\(f["title"]?.stringValue ?? "") \(f["location"]?.stringValue ?? "")")
        return words.allSatisfy { text.contains($0) }
    }

    public struct DayGroup: Equatable, Identifiable, Sendable {
        public var date: String
        public var events: [Entity]
        public var id: String { date }
    }

    public struct SearchResult: Equatable, Sendable {
        /// From today forward, soonest first.
        public var upcoming: [DayGroup]
        /// The days before today, newest first.
        public var earlier: [DayGroup]
        /// How many events matched, before the limit.
        public var total: Int
        public var shown: Int { (upcoming + earlier).reduce(0) { $0 + $1.events.count } }
    }

    /// The most results a search shows.
    public static let searchLimit = 200

    /// Events found by a search, grouped by the local day they start on: today and the days after first, soonest
    /// first, then the days before, newest first. At most `limit` events, taken in that order.
    public static func search(_ events: [Entity], query: String, today: Date, limit: Int = searchLimit, calendar: Calendar = .current) -> SearchResult {
        let w = words(query)
        let todayStr = dayString(today, calendar: calendar)
        let found: [(e: Entity, day: String)] = events.compactMap { e in
            guard !e.isDeleted, matches(e.fields, words: w), let day = days(e.fields, calendar: calendar).first else { return nil }
            return (e, day)
        }
        let ahead = found.filter { $0.day >= todayStr }.sorted { $0.day != $1.day ? $0.day < $1.day : dayOrder($0.e, $1.e) }
        let before = found.filter { $0.day < todayStr }.sorted { $0.day != $1.day ? $0.day > $1.day : dayOrder($0.e, $1.e) }
        let kept = Array((ahead + before).prefix(max(0, limit)))
        func group(_ xs: [(e: Entity, day: String)]) -> [DayGroup] {
            var out: [DayGroup] = []
            for x in xs {
                if out.last?.date == x.day { out[out.count - 1].events.append(x.e) } else { out.append(DayGroup(date: x.day, events: [x.e])) }
            }
            return out
        }
        return SearchResult(upcoming: group(kept.filter { $0.day >= todayStr }), earlier: group(kept.filter { $0.day < todayStr }), total: found.count)
    }
}

/// Which calendars the Week screen shows: one setting for every device, `hidden_calendars` in the feel setting. The
/// rules are the ones in packages/shared/src/calendars.ts, which the hub checks by and the web client draws by; tests
/// on both sides keep the two and the contract the same.
public enum HiddenCalendars {
    /// The key that stands for events on no calendar: made in Aeneas and kept only here.
    public static let noCalendar = "aeneas"
    /// How many keys the setting may hold.
    public static let maxCount = 300
    /// The longest key, as the feel setting's calendars and an event's `calendar_key` take it.
    public static let maxKeyLength = 300
    /// The group events on no calendar are listed under, last.
    public static let noCalendarAccount = "Aeneas"
    public static let noCalendarName = "Made in Aeneas"

    /// A calendar key as the setting takes it: 1 to 300 characters (UTF-16, as the hub counts), no control characters.
    public static func isKey(_ s: String) -> Bool {
        let n = s.utf16.count
        return n >= 1 && n <= maxKeyLength && !s.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }

    /// Whether a list keeps the rules: at most 300 keys, each named once.
    public static func isValid(_ list: [String]) -> Bool {
        list.count <= maxCount && list.allSatisfy(isKey) && Set(list).count == list.count
    }

    /// The calendar an event is on, for the setting: its calendar's key, or `aeneas` when it is on none.
    public static func key(_ f: [String: JSONValue]) -> String { EventCalendar.key(f) ?? noCalendar }
    public static func key(_ e: Entity) -> String { key(e.fields) }

    /// Whether Week shows an event: its calendar is not one of the hidden ones.
    public static func shown(_ e: Entity, hidden: [String]) -> Bool { hidden.isEmpty || !hidden.contains(key(e)) }

    /// The setting with one calendar shown or hidden; the order of the rest stays.
    public static func with(_ hidden: [String], key: String, shown: Bool) -> [String] {
        let rest = hidden.filter { $0 != key }
        return shown ? rest : Array((rest + [key]).suffix(maxCount))
    }

    /// A calendar's name and account from its key alone, for one the feel setting does not list.
    public static func name(fromKey key: String) -> (name: String, account: String) {
        if key == noCalendar { return (noCalendarName, noCalendarAccount) }
        if key == "work:m365" { return ("Microsoft 365", "Work") }
        if key.hasPrefix("icloud:") { return ("iCloud calendar", "iCloud") }
        if key.hasPrefix("apple:") {
            let rest = String(key.dropFirst("apple:".count))
            if let slash = rest.firstIndex(of: "/"), slash > rest.startIndex, rest.index(after: slash) < rest.endIndex {
                return (String(rest[rest.index(after: slash)...]), String(rest[..<slash]))
            }
            return (rest.isEmpty ? key : rest, "Apple Calendar")
        }
        return (key, "Other")
    }

    /// One row of the Calendars list.
    public struct Row: Equatable, Identifiable, Sendable {
        public var key: String
        public var name: String
        public var account: String
        /// The color its events are drawn in (the owner's choice, else its own); nil for the theme's accent.
        public var color: String?
        public var shown: Bool
        public var id: String { key }
    }

    public struct Group: Equatable, Identifiable, Sendable {
        public var account: String
        public var calendars: [Row]
        public var id: String { account }
    }

    private static func byName(_ a: String, _ b: String) -> Bool {
        let r = a.compare(b, options: [.caseInsensitive, .diacriticInsensitive])
        return r == .orderedSame ? a < b : r == .orderedAscending
    }

    /// The Calendars list: every calendar the events here are on, and every hidden one the feel setting still lists,
    /// grouped by account. Names, accounts and colors come from the feel setting's `calendars`, else from the key.
    /// Groups are in name order with Aeneas (events on no calendar) last; calendars in name order inside each.
    public static func groups(calendars: [CalendarColorEntry], eventKeys: Set<String>, hidden: [String]) -> [Group] {
        var known: [String: CalendarColorEntry] = [:]
        for c in calendars where known[c.key] == nil { known[c.key] = c }
        var keys = eventKeys
        for k in hidden where known[k] != nil { keys.insert(k) }
        var byAccount: [String: [Row]] = [:]
        for key in keys {
            let c = known[key]
            let from = name(fromKey: key)
            let given = c?.account?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let account = key == noCalendar ? noCalendarAccount : (given.isEmpty ? from.account : given)
            let n = c?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            byAccount[account, default: []].append(Row(key: key, name: n.isEmpty ? from.name : n, account: account, color: c?.shown, shown: !hidden.contains(key)))
        }
        return byAccount.map { Group(account: $0.key, calendars: $0.value.sorted { $0.name != $1.name ? byName($0.name, $1.name) : byName($0.key, $1.key) }) }
            .sorted { a, b in
                let la = a.account == noCalendarAccount, lb = b.account == noCalendarAccount
                if la != lb { return lb }
                return byName(a.account, b.account)
            }
    }
}

/// An event's place across its day column: lane `lane` of `lanes` side by side.
public struct EventLane: Equatable, Sendable {
    public let lane: Int
    public let lanes: Int
    public init(lane: Int, lanes: Int) { self.lane = lane; self.lanes = lanes }
}

public extension CalendarViews {
    /// Lanes for timed events that overlap, as calendars draw them side by side; drawn full width, a later event
    /// covered the one under it. Sorted by start (the longer first at the same start), each event takes the first lane
    /// free at its start. A run of events that overlap through any chain shares one lane count, so their widths line
    /// up. An event that ends as the next starts does not overlap it. Times are any one unit (minutes from midnight on
    /// the Week screen). The same rule as `eventLanes` in web/src/lib/calendarViews.ts, tested against the same cases.
    static func lanes(_ spans: [(id: String, start: Double, end: Double)]) -> [String: EventLane] {
        let sorted = spans.sorted { a, b in
            if a.start != b.start { return a.start < b.start }
            if a.end != b.end { return a.end > b.end }
            return a.id < b.id
        }
        var out: [String: EventLane] = [:]
        var run: [(id: String, lane: Int)] = []
        var laneEnds: [Double] = []
        var runEnd = -Double.infinity
        func close() {
            for r in run { out[r.id] = EventLane(lane: r.lane, lanes: laneEnds.count) }
            run = []
            laneEnds = []
        }
        for s in sorted {
            if s.start >= runEnd { close() }
            let lane: Int
            if let free = laneEnds.firstIndex(where: { $0 <= s.start }) {
                lane = free
                laneEnds[free] = s.end
            } else {
                lane = laneEnds.count
                laneEnds.append(s.end)
            }
            run.append((s.id, lane))
            runEnd = max(runEnd, s.end)
        }
        close()
        return out
    }
}
