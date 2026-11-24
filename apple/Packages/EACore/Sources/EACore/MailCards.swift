import Foundation

// A mail's key facts (cards: a package, a flight, a bill), the trips in the Trips bundle, and the hub's model's
// sorting of new mail (Needs you): the same rules as the web's (web/src/lib/mail.ts), CONTRACT.md Mail.

/// A mail's key facts, as the hub worked them out (hub/src/mail-cards.ts). Written by the sender: plain text, shown as
/// text; `at` and `until` an ISO time, or a day (`YYYY-MM-DD`) when the sender gave no time. `kind` is a word the hub
/// sends: package, flight, stay, table, event, bill, order or booking.
public struct MailCard: Codable, Equatable, Hashable, Sendable {
    public var kind: String
    public var title: String?
    public var number: String?
    public var from: String?
    public var to: String?
    public var at: String?
    public var until: String?
    public var amount: String?
    public var status: String?
    public var url: String?
    public var source: String

    public init(kind: String, title: String? = nil, number: String? = nil, from: String? = nil, to: String? = nil, at: String? = nil, until: String? = nil,
                amount: String? = nil, status: String? = nil, url: String? = nil, source: String = "sender") {
        self.kind = kind; self.title = title; self.number = number; self.from = from; self.to = to; self.at = at; self.until = until
        self.amount = amount; self.status = status; self.url = url; self.source = source
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        number = try? c.decodeIfPresent(String.self, forKey: .number)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        to = try? c.decodeIfPresent(String.self, forKey: .to)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        until = try? c.decodeIfPresent(String.self, forKey: .until)
        amount = try? c.decodeIfPresent(String.self, forKey: .amount)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "sender"
    }
}

/// The hub's model's triage of an Inbox mail (kept a week): how soon it matters (`today`, `soon`, `fyi`, `low`; a word
/// it does not know is `fyi`), what it is in a line, and whether it needs a reply.
public struct MailTriage: Codable, Equatable, Hashable, Sendable {
    public var urgency: String
    public var summary: String?
    public var needs_reply: Bool

    public init(urgency: String, summary: String? = nil, needs_reply: Bool = false) { self.urgency = urgency; self.summary = summary; self.needs_reply = needs_reply }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let u = (try? c.decodeIfPresent(String.self, forKey: .urgency)) ?? "fyi"
        urgency = ["today", "soon", "fyi", "low"].contains(u) ? u : "fyi"
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        needs_reply = (try? c.decodeIfPresent(Bool.self, forKey: .needs_reply)) ?? false
    }
}

/// Sorting new mail with the hub's model: `waiting` Inbox mail not sorted yet, `running` a run is going, `auto` the hub
/// sorts by itself after each refresh (its owner set it up so), else only when the owner asks; `stopped` the hub's own
/// sentence for why the last asked run ended early.
public struct MailTriageState: Codable, Equatable, Hashable, Sendable {
    public var waiting: Int
    public var running: Bool
    public var auto: Bool
    public var stopped: String?

    public init(waiting: Int, running: Bool = false, auto: Bool = false, stopped: String? = nil) { self.waiting = waiting; self.running = running; self.auto = auto; self.stopped = stopped }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        waiting = (try? c.decodeIfPresent(Int.self, forKey: .waiting)) ?? 0
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        auto = (try? c.decodeIfPresent(Bool.self, forKey: .auto)) ?? false
        stopped = try? c.decodeIfPresent(String.self, forKey: .stopped)
    }
}

/// A folding note (the owner said the fold hid something): the fold's first line, the lines they marked, Don't fold.
public struct MailFoldNote: Codable, Equatable, Hashable, Sendable {
    public var cut: String
    public var lines: [String]
    public var no_fold: Bool
    public var at: String?
}

/// A note in the list of them, with the mail it is on.
public struct MailFoldNoteEntry: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var subject: String
    public var from: String
    public var note: MailFoldNote
}

public struct MailFoldNotes: Decodable, Sendable { public var notes: [MailFoldNoteEntry] }

extension Mail {
    // MARK: Cards

    /// A card's bundle, for its icon and color: packages and orders are Transactions', a bill is Bills', the rest Trips'.
    public static func cardBundle(_ c: MailCard) -> String {
        switch c.kind {
        case "package", "order": return "purchases"
        case "bill": return "bills"
        default: return "trips"
        }
    }

    /// A day written `YYYY-MM-DD` as that day's own midnight here, or nil.
    static func cardDay(_ s: String, calendar cal: Calendar) -> Date? {
        let p = s.split(separator: "-")
        guard s.count == 10, p.count == 3, let y = Int(p[0]), let m = Int(p[1]), let d = Int(p[2]), p[0].count == 4 else { return nil }
        return cal.date(from: DateComponents(year: y, month: m, day: d))
    }

    /// A card's time as a date: a day at this device's own midnight, a time as written; nil if neither.
    public static func cardDate(_ at: String, calendar cal: Calendar = .current) -> Date? { cardDay(at, calendar: cal) ?? ISO.date(at) }

    /// A card's time as words: a day ("Tue, Dec 15"), or a day and time ("Tue, Dec 3, 8:00 AM").
    public static func cardTime(_ at: String, calendar cal: Calendar = .current) -> String {
        let style = Date.FormatStyle(calendar: cal, timeZone: cal.timeZone).weekday(.abbreviated).month(.abbreviated).day()
        if let d = cardDay(at, calendar: cal) { return d.formatted(style) }
        guard let d = ISO.date(at) else { return "" }
        return d.formatted(style.hour().minute())
    }

    /// A card in one line, its facts in the order a person looks for them, joined by " · ".
    public static func cardLine(_ c: MailCard, calendar cal: Calendar = .current) -> String {
        func t(_ x: String?) -> String? { x.map { cardTime($0, calendar: cal) } }
        func ne(_ x: String?) -> String? { x.flatMap { $0.isEmpty ? nil : $0 } }
        let parts: [String?]
        switch c.kind {
        case "package": parts = [c.title, c.number, c.at.map { _ in "Arrives \(t(c.at) ?? "")" }, c.status]
        case "flight": parts = [ne(c.number) ?? c.title, ne(c.from) != nil && ne(c.to) != nil ? "\(c.from!) \u{2192} \(c.to!)" : nil, c.at.map { _ in "Leaves \(t(c.at) ?? "")" }, c.status]
        case "stay": parts = [c.title, c.at.map { _ in c.until != nil ? "\(t(c.at) ?? "") to \(t(c.until) ?? "")" : t(c.at) ?? "" }, c.number.map { "Confirmation \($0)" }]
        case "bill": parts = [c.title, c.amount.map { "\($0) due" }, c.at.map { _ in "By \(t(c.at) ?? "")" }]
        case "order": parts = [c.title, c.number.map { "Order \($0)" }, c.amount, c.status]
        case "booking": parts = [c.title, c.number.map { "Confirmation \($0)" }, t(c.at)]
        default: parts = [c.title, t(c.at), c.status, c.number.map { "Confirmation \($0)" }]
        }
        return parts.compactMap { ne($0) }.joined(separator: " \u{00B7} ")
    }

    /// Where a card's Track or Open button goes: its https link, checked here again, or nil.
    public static func cardLink(_ c: MailCard) -> URL? {
        guard let u = c.url, let link = httpsLink(u) else { return nil }
        return URL(string: link.href)
    }

    // MARK: Trips

    /// One piece of a trip: a card with a date, and the mail it came from.
    public struct TripPart<T: MailRowItem>: Sendable where T: Sendable {
        public var card: MailCard
        public var mail: T
        public var start: Date
        public var end: Date
    }
    /// A trip: a flight's or a stay's mail and the bookings around it, as one. `name`: "Trip to JFK", "Stay at Harbor Inn".
    public struct Trip<T: MailRowItem>: Sendable where T: Sendable {
        public var id: String
        public var name: String
        public var start: Date
        public var end: Date
        public var parts: [TripPart<T>]
    }

    /// The trips in some mail, from its cards' dates (cards read from text have none): flights and stays make trips,
    /// each joining the one before while it starts within a day of where that one ends (the flight out, the hotel, the
    /// flight back); a booking, a table or an event only joins a trip it is within a day of, never makes one; a day
    /// without a time counts at the usual hour (check-in 3 PM, check-out 11 AM, else noon); a trip is at least two
    /// mails. Trips not over yet come first, the soonest first; then past ones, the latest first. `members`: each
    /// mail's messages, whose cards count (a thread's), else the mail's own.
    public static func trips<T: MailRowItem & Sendable>(_ mails: [T], members: (T) -> [MailSummary] = { [$0.summary] }, now: Date = Date(), calendar cal: Calendar = .current) -> [Trip<T>] {
        let kinds: Set<String> = ["flight", "stay", "booking", "table", "event"]
        let day: TimeInterval = 86_400
        var parts: [TripPart<T>] = []
        for m in mails {
            for c in members(m).flatMap({ $0.cards ?? [] }) {
                guard kinds.contains(c.kind), let at = c.at, let s0 = cardDate(at, calendar: cal) else { continue }
                let isDay = cardDay(at, calendar: cal) != nil
                let start = s0.addingTimeInterval(isDay ? Double(c.kind == "stay" ? 15 : 12) * 3600 : 0)
                var end = start
                if let u = c.until, let e0 = cardDate(u, calendar: cal) {
                    let e = e0.addingTimeInterval(cardDay(u, calendar: cal) != nil ? 11 * 3600 : 0)
                    if e >= start { end = e }
                }
                parts.append(TripPart(card: c, mail: m, start: start, end: end))
            }
        }
        parts = parts.enumerated().sorted { $0.element.start == $1.element.start ? $0.offset < $1.offset : $0.element.start < $1.element.start }.map(\.element)
        let seeds = { (p: TripPart<T>) in p.card.kind == "flight" || p.card.kind == "stay" }
        var trips: [Trip<T>] = []
        for p in parts where seeds(p) {
            if let last = trips.indices.last, p.start <= trips[last].end.addingTimeInterval(day) {
                trips[last].parts.append(p)
                trips[last].end = max(trips[last].end, p.end)
            } else {
                trips.append(Trip(id: p.mail.summary.id, name: "", start: p.start, end: p.end, parts: [p]))
            }
        }
        for p in parts where !seeds(p) {
            guard let i = trips.firstIndex(where: { p.start >= $0.start.addingTimeInterval(-day) && p.start <= $0.end.addingTimeInterval(day) }) else { continue }
            trips[i].parts.append(p)
            trips[i].start = min(trips[i].start, p.start)
            trips[i].end = max(trips[i].end, p.end)
        }
        for i in trips.indices {
            trips[i].parts = trips[i].parts.enumerated().sorted { $0.element.start == $1.element.start ? $0.offset < $1.offset : $0.element.start < $1.element.start }.map(\.element)
        }
        var kept = trips.filter { Set($0.parts.map { $0.mail.summary.id }).count >= 2 }
        for i in kept.indices {
            let flight = kept[i].parts.first { $0.card.kind == "flight" && !($0.card.to ?? "").isEmpty }?.card
            let stay = kept[i].parts.first { $0.card.kind == "stay" && !($0.card.title ?? "").isEmpty }?.card
            kept[i].name = flight.map { "Trip to \($0.to!)" } ?? stay.map { "Stay at \($0.title!)" } ?? "Trip"
        }
        let over = { (t: Trip<T>) in t.end.addingTimeInterval(day) < now }
        return kept.filter { !over($0) }.sorted { $0.start < $1.start } + kept.filter(over).sorted { $0.start > $1.start }
    }

    /// A trip's days: "Dec 3 to 6", "Dec 30 to Jan 2", or one day.
    public static func tripDates(start: Date, end: Date, calendar cal: Calendar = .current) -> String {
        let md = Date.FormatStyle(calendar: cal, timeZone: cal.timeZone).month(.abbreviated).day()
        if cal.isDate(start, inSameDayAs: end) { return start.formatted(md) }
        let same = cal.component(.month, from: start) == cal.component(.month, from: end) && cal.component(.year, from: start) == cal.component(.year, from: end)
        return same ? "\(start.formatted(md)) to \(cal.component(.day, from: end))" : "\(start.formatted(md)) to \(end.formatted(md))"
    }

    /// A flat view as listed: in the Trips bundle each trip's mail as one box first, then the mail in no trip.
    public static func flatScreen(_ mails: [MailThread], bundle: String?, now: Date = Date(), calendar cal: Calendar = .current) -> (trips: [Trip<MailThread>], rest: [MailThread]) {
        let trips = bundle == "trips" ? Mail.trips(mails, members: { $0.members }, now: now, calendar: cal) : []
        let inTrips = Set(trips.flatMap { $0.parts.map { $0.mail.id } })
        return (trips, mails.filter { !inTrips.contains($0.id) })
    }

    // MARK: Sorting new mail (Needs you)

    /// The quiet line above the Inbox about mail that is not sorted yet, or nil for none: an older hub (no state), the
    /// switch off, nothing waiting, or a hub that sorts by itself. While a run goes it says how much is left, with no
    /// button; after a run that ended early, the hub's sentence for why; else how much waits. `button`: Sort new mail.
    public static func triageRow(on: Bool?, _ s: MailTriageState?) -> (text: String, button: Bool)? {
        guard let s, on != false else { return nil }
        if s.running { return ("Sorting new mail: \(s.waiting) left.", false) }
        if let why = s.stopped?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty { return (why, s.waiting > 0) }
        if s.auto || s.waiting <= 0 { return nil }
        return (s.waiting == 1 ? "1 new mail is not sorted yet." : "\(s.waiting) new mails are not sorted yet.", true)
    }

    /// The Inbox's "Needs you" digest: threads the Inbox shows now that the model marked for today or as needing a
    /// reply, today's first, then those needing a reply, newest first in each; at most `max`. Mail a bundle holds back
    /// (it shows later, or never in the Inbox) is left out: the digest only names mail the Inbox lists.
    public static func needsYou<T: MailRowItem>(_ mails: [T], shown: [Bundle], delivery: [String: MailBundleDelivery] = [:], now: Date = Date(), max: Int = 5, calendar: Calendar = .current) -> [T] {
        let held = shownDelivery(delivery, shown: shown)
        func rank(_ m: MailSummary) -> Int { m.triage?.urgency == "today" ? 0 : 1 }
        return mails.enumerated().filter { _, t in
            let m = t.summary
            return m.state == .inbox && !m.isMine && (m.triage?.urgency == "today" || m.triage?.needs_reply == true)
                && inboxAt(m, delivery: held, now: now, calendar: calendar) != nil
        }.sorted { a, b in
            let ra = rank(a.element.summary), rb = rank(b.element.summary)
            if ra != rb { return ra < rb }
            if a.element.summary.at != b.element.summary.at { return a.element.summary.at > b.element.summary.at }
            return a.offset < b.offset
        }.prefix(max).map(\.element)
    }

    /// Snoozed threads coming back later today (after `now`, before midnight), soonest first: "Back later today".
    public static func backLaterToday<T: MailRowItem>(_ mails: [T], now: Date = Date(), calendar cal: Calendar = .current) -> [T] {
        let end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now
        return mails.filter { t in
            guard t.summary.state == .snoozed, let u = t.summary.snooze_until, let d = ISO.date(u) else { return false }
            return d > now && d < end
        }.sorted { ($0.summary.snooze_until ?? "") < ($1.summary.snooze_until ?? "") }
    }

    /// Where a thread (by its `key`) is in the Inbox as listed: on its own (`row` nil), or inside a bundle's row (`row`:
    /// that row's key, `<day>:<bundle>`, to open before the mail can show). Not `found` when the Inbox does not list it.
    public static func inboxPlace(_ sections: [DaySection<MailThread>], key: String) -> (row: String?, found: Bool) {
        for s in sections {
            for r in s.rows {
                switch r {
                case .mail(let t): if t.key == key { return (nil, true) }
                case .bundle(let b, let ms): if ms.contains(where: { $0.key == key }) { return ("\(s.title):\(b.id)", true) }
                }
            }
        }
        return (nil, false)
    }

    /// The first lines (at most 8, not empty, trimmed) of what a mail's fold hides, for the owner to mark. `quoteAt`
    /// counts UTF-16 units, as JavaScript does.
    public static func foldedLines(_ text: String, quoteAt: Int?, max: Int = 8) -> [String] {
        guard let q = quoteAt, q >= 0 else { return [] }
        let u = text.utf16
        guard q <= u.count, let start = u.index(u.startIndex, offsetBy: q, limitedBy: u.endIndex), let rest = String(u[start...]) else { return [] }
        return rest.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(max).map { $0 }
    }
}
