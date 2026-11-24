import Foundation

/// What the Today screen shows, worked out from the day's plan and the local copy. Same rules as the web app's
/// `lib/todayBoard.ts`, tested here in TodayBoardTests.
///
/// Today is a status report of the day in the order its owner asked every report to take: what needs you (actions
/// only, numbered), what is on now and what is left (the schedule), what is done (today so far), then what is coming
/// and needs nothing from you. An automatic record (a charge on autopay) is never an action, and Today does not list
/// it at all: it pays itself (gnomecannon/aeneas#14); Renewals shows it.
public enum TodayBoard {
    /// How a time of day is written ("3:00 PM"): the device's own short style on screen, a fixed one in tests.
    public typealias Clock = @Sendable (Date) -> String
    public static let deviceClock: Clock = { $0.formatted(date: .omitted, time: .shortened) }

    /// "46 min", "2 h", "2 h 10 min": a length of time in whole minutes, never "about".
    public static func durationWords(_ seconds: TimeInterval) -> String {
        let total = max(0, Int((seconds / 60).rounded()))
        let h = total / 60, m = total % 60
        if h == 0 { return "\(m) min" }
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }

    // MARK: the day's things

    /// One thing on the day, as the rules need it: an event, a block of work, fixed hours from a plan rule, free
    /// time, or a reminder (which has a time and no length).
    public struct Span: Equatable, Identifiable, Sendable {
        public enum Kind: String, Sendable { case event, block, commitment, free, reminder }
        public var id: String
        public var kind: Kind
        public var title: String
        public var start: Date
        /// A reminder's end is its start.
        public var end: Date
        public var allDay: Bool
        /// A plan rule's kind (commitment, blackout, preference, info); nil for anything else.
        public var rule: PlanRuleType?
        /// The event, the block's task or the reminder's task, for a link.
        public var itemId: String

        public init(id: String, kind: Kind, title: String, start: Date, end: Date, allDay: Bool = false, rule: PlanRuleType? = nil, itemId: String = "") {
            self.id = id; self.kind = kind; self.title = title; self.start = start; self.end = end; self.allDay = allDay; self.rule = rule; self.itemId = itemId
        }
    }

    /// The day's plan as spans. Anything without a readable time is left out.
    public static func spans(blocks: [PlannerBlock], commitments: [PlannerCommitment], events: [Entity], reminders: [Entity], freeSlots: [FreeSlot]) -> [Span] {
        var out: [Span] = []
        for b in blocks {
            guard let s = ISO.date(b.start), let e = ISO.date(b.end) else { continue }
            out.append(Span(id: "b|" + b.id, kind: .block, title: b.title, start: s, end: e, itemId: b.task_id))
        }
        for c in commitments {
            guard let s = ISO.date(c.start), let e = ISO.date(c.end) else { continue }
            out.append(Span(id: "c|" + c.id, kind: .commitment, title: c.title, start: s, end: e, allDay: wholeDay(start: s, end: e), rule: c.type, itemId: c.rule_id))
        }
        for ev in events where !ev.isDeleted {
            guard let s = ev.date("start") else { continue }
            out.append(Span(id: "e|" + ev.id, kind: .event, title: ev.str("title"), start: s, end: ev.date("end") ?? s, allDay: ev.bool("all_day") == true, itemId: ev.id))
        }
        for r in reminders where !r.isDeleted {
            guard let at = r.alertDate else { continue }
            out.append(Span(id: "r|" + r.id, kind: .reminder, title: r.str("title"), start: at, end: at, itemId: r.id))
        }
        for f in freeSlots {
            guard let s = ISO.date(f.start), let e = ISO.date(f.end) else { continue }
            out.append(Span(id: "f|" + f.id, kind: .free, title: "", start: s, end: e))
        }
        return out
    }

    /// A rule that lasts the whole day (a custody week runs midnight to midnight): like an all-day event it has no
    /// place in time, so it reads "All day" and is neither "on now" nor a bar on the day. 23 hours counts, the length
    /// of the day the clocks go forward.
    public static func wholeDay(start: Date, end: Date) -> Bool { end.timeIntervalSince(start) >= 23 * 3600 }

    /// The same for a rule's hours as the hub sends them. One with a time that cannot be read is not.
    public static func wholeDay(_ c: PlannerCommitment) -> Bool {
        guard let s = ISO.date(c.start), let e = ISO.date(c.end) else { return false }
        return wholeDay(start: s, end: e)
    }

    /// Something that holds its time: an event with hours, a block, or fixed hours from a plan rule. Not a preference
    /// or an info rule (they take no time), and not a rule that lasts the whole day (like an all-day event, it is no
    /// moment).
    private static func isTimed(_ s: Span) -> Bool {
        switch s.kind {
        case .event: return !s.allDay
        case .block: return true
        case .commitment: return s.rule?.takesTime == true && !s.allDay
        default: return false
        }
    }

    // MARK: the Now line

    public enum NowLine: Equatable, Sendable {
        case during(title: String, until: Date, left: String, what: Span.Kind)
        case next(title: String, at: Date, wait: String, what: Span.Kind)
        case clear
    }

    /// The one sentence at the top: what is under way and how long it has left, else the next thing with a time and
    /// how long until it, else that nothing else is scheduled. A block under way leads an event at the same time (it
    /// is what the owner chose to be doing); of two under way, the one that ends first.
    public static func nowLine(_ spans: [Span], now: Date) -> NowLine {
        func rank(_ k: Span.Kind) -> Int { k == .block ? 0 : k == .event ? 1 : 2 }
        let under = spans.filter { isTimed($0) && $0.start <= now && now < $0.end }
            .sorted { a, b in
                if rank(a.kind) != rank(b.kind) { return rank(a.kind) < rank(b.kind) }
                return a.end != b.end ? a.end < b.end : a.id < b.id
            }
        if let d = under.first {
            return .during(title: d.title, until: d.end, left: durationWords(d.end.timeIntervalSince(now)), what: d.kind)
        }
        let ahead = spans.filter { (isTimed($0) || $0.kind == .reminder) && $0.start > now }
            .sorted { a, b in a.start != b.start ? a.start < b.start : a.id < b.id }
        if let n = ahead.first {
            return .next(title: n.title, at: n.start, wait: durationWords(n.start.timeIntervalSince(now)), what: n.kind)
        }
        return .clear
    }

    /// The free time now or next today: "Free until 3:00 PM, 2 h 46 min" or "Free 6:00 PM to 11:00 PM, 5 h". Nil
    /// when none is left.
    public static func freeLine(_ spans: [Span], now: Date, clock: Clock = deviceClock) -> String? {
        guard let free = spans.filter({ $0.kind == .free && $0.end > now }).sorted(by: { $0.start < $1.start }).first else { return nil }
        let from = max(free.start, now)
        let length = durationWords(free.end.timeIntervalSince(from))
        // A slot that has begun (the hub starts today's first one at the moment it answered) is free from now.
        return from.timeIntervalSince(now) < 120 ? "Free until \(clock(free.end)), \(length)" : "Free \(clock(free.start)) to \(clock(free.end)), \(length)"
    }

    // MARK: needs you

    /// The renewals the owner has to make: a charge on autopay pays itself, so Today never shows it, today or on
    /// another day swiped to (gnomecannon/aeneas#14). Renewals lists every one.
    public static func toRenew(_ watches: [Entity]) -> [Entity] {
        watches.filter { !$0.isDeleted && $0.bool("autopay") != true }
    }

    /// One thing waiting on the owner, with what the row needs to act on it.
    public enum Need: Equatable, Identifiable, Sendable {
        case reminder(Mail.DueReminder, detail: String)
        case tech(TechLook)
        case renewal(Entity, detail: String, overdue: Bool)
        case followUp(Entity, detail: String, late: Bool)
        case med(String)
        case unsorted(Int)

        public var id: String {
            switch self {
            case .reminder(let r, _): return "r:" + r.id
            case .tech(let l): return "t:" + l.key
            case .renewal(let w, _, _): return "w:" + w.id
            case .followUp(let a, _, _): return "a:" + a.id
            case .med(let name): return "m:" + name.lowercased()
            case .unsorted: return "unsorted"
            }
        }

        public var title: String {
            switch self {
            case .reminder(let r, _): return r.title
            case .tech(let l): return l.title
            case .renewal(let w, _, _): return "Renew \(w.str("title"))"
            case .followUp(let a, _, _): return "Follow up with \(a.str("company"))"
            case .med(let name): return name
            case .unsorted(let n): return "\(n) capture\(n == 1 ? "" : "s") could not be filed"
            }
        }

        public var detail: String {
            switch self {
            case .reminder(_, let d), .renewal(_, let d, _), .followUp(_, let d, _): return d
            case .tech(let l): return l.detail ?? ""
            case .med: return "Not logged today"
            case .unsorted: return "Waiting in Unsorted Info"
            }
        }

        /// Late or overdue: the row is marked.
        public var late: Bool {
            switch self {
            case .renewal(_, _, let overdue): return overdue
            case .followUp(_, _, let late): return late
            default: return false
            }
        }
    }

    /// Everything waiting on the owner right now, in the order to take it: reminders whose time has come (oldest
    /// first), things in Tech that need a look and are not acknowledged, renewals the owner has to make (never the
    /// ones on autopay), job follow ups due, regular meds not yet logged today, and captures the assistant could not
    /// file. A renewal's own reminder says the same as the renewal, so only the renewal is listed (`tasks` are the
    /// tasks the reminders belong to, for the item each is about).
    public static func needsYou(reminders: [Mail.DueReminder], tasks: [Entity] = [], looks: [TechLook], watches: [Entity], followUps: [Entity],
                                meds: [TodayExtras.Med], unsorted: Int, now: Date, calendar: Calendar = .current, clock: Clock = deviceClock) -> [Need] {
        var out: [Need] = []
        let toRenew = toRenew(watches)
        let renewing = Set(toRenew.map(\.id))
        let about = Dictionary(tasks.map { ($0.id, $0.str("linked_id")) }, uniquingKeysWith: { a, _ in a })
        for r in reminders {
            if let linked = about[r.id], renewing.contains(linked) { continue }
            out.append(.reminder(r, detail: "Reminder, " + cameDue(r.at, now: now, calendar: calendar, clock: clock)))
        }
        for l in looks where !l.acknowledged { out.append(.tech(l)) }
        for w in toRenew {
            let days = daysUntil(w.str("due"), now: now, calendar: calendar)
            let detail = days == 0 ? "Due today" : days < 0 ? "\(-days) day\(days == -1 ? "" : "s") overdue" : "Due in \(days) day\(days == 1 ? "" : "s")"
            out.append(.renewal(w, detail: detail, overdue: days < 0))
        }
        for a in followUps {
            let at = a.date("next_at")
            let late = at.map { calendar.startOfDay(for: $0) < calendar.startOfDay(for: now) } ?? false
            let parts = [a.str("next_step"), late ? "late" : at.map { "today, \(clock($0))" } ?? ""].filter { !$0.isEmpty }
            out.append(.followUp(a, detail: parts.joined(separator: ", "), late: late))
        }
        for m in meds where m.takenAt == nil { out.append(.med(m.name)) }
        if unsorted > 0 { out.append(.unsorted(unsorted)) }
        return out
    }

    /// When a reminder came due, in words: "2:20 PM, 40 min ago" today, "Nov 20 at 4:08 PM, 2 days ago" from an
    /// earlier day (hours alone, "51 h 49 min ago", made the owner work out which day that was).
    static func cameDue(_ at: Date, now: Date, calendar: Calendar = .current, clock: Clock = deviceClock) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: now)).day ?? 0
        if days >= 1 {
            let c = calendar.dateComponents([.month, .day], from: at)
            let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
            let month = months[min(max((c.month ?? 1) - 1, 0), 11)]
            return "\(month) \(c.day ?? 0) at \(clock(at)), \(days == 1 ? "yesterday" : "\(days) days ago")"
        }
        let late = now.timeIntervalSince(at)
        return late >= 60 ? "\(clock(at)), \(durationWords(late)) ago" : clock(at)
    }

    /// Whole local days from today to a date ("2026-11-25" or a full time); negative when it has passed, 0 when it
    /// cannot be read.
    public static func daysUntil(_ due: String, now: Date, calendar: Calendar = .current) -> Int {
        guard let d = localDay(due, calendar: calendar) ?? ISO.date(due) else { return 0 }
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: d)).day ?? 0
    }

    /// The local midnight of a date that starts "YYYY-MM-DD" and says nothing more: a day, not a moment.
    private static func localDay(_ s: String, calendar: Calendar) -> Date? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count == 10 else { return nil }
        let p = t.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    // MARK: to do

    /// Open tasks in the order to offer them: the one being done, then Next in its order, then the rest (the Inbox,
    /// which is where tasks from Reminders and captures arrive) in theirs. Tasks that are only a reminder for later
    /// (scheduled) and parked ones are not offered: the first shows at its time, the second was set aside on purpose.
    public static func openTasks(_ tasks: [Entity]) -> [Entity] {
        let rank: [String: Int] = ["doing": 0, "next": 1, "inbox": 2]
        func order(_ e: Entity) -> Double { e.number("order") ?? .greatestFiniteMagnitude }
        return tasks.filter { !$0.isDeleted && rank[$0.str("status")] != nil }
            .sorted { a, b in
                let ra = rank[a.str("status")] ?? 9, rb = rank[b.str("status")] ?? 9
                if ra != rb { return ra < rb }
                if order(a) != order(b) { return order(a) < order(b) }
                return a.created_at != b.created_at ? a.created_at < b.created_at : a.id < b.id
            }
    }

    // MARK: today so far

    public struct DiaryLine: Equatable, Sendable {
        /// "17:05", as the diary writes it.
        public var time: String
        public var text: String
        public init(time: String, text: String) { self.time = time; self.text = text }
    }

    /// The start of the day `now` is in when days start at `startHour` (4 for the diary: 1 AM belongs to the day
    /// before).
    public static func dayStart(_ now: Date, startHour: Int = 4, calendar: Calendar = .current) -> Date {
        let midnight = calendar.startOfDay(for: now)
        let day = calendar.component(.hour, from: now) < startHour ? calendar.date(byAdding: .day, value: -1, to: midnight) ?? midnight : midnight
        return calendar.date(bySettingHour: startHour, minute: 0, second: 0, of: day) ?? day
    }

    /// Today's diary note (every capture, timestamped) and its lines, oldest first. Before 4 AM it is still the day
    /// before, as on the hub: late night captures go to that day's note.
    public static func diary(_ notes: [Entity], now: Date = Date(), calendar: Calendar = .current) -> (note: Entity, lines: [DiaryLine])? {
        let day = dayStart(now, calendar: calendar)
        let c = calendar.dateComponents([.year, .month, .day], from: day)
        let path = String(format: "diary/%04d-%02d-%02d.md", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        guard let n = notes.first(where: { !$0.isDeleted && $0.str("path").lowercased() == path }) else { return nil }
        let lines = n.str("body").split(separator: "\n").compactMap { raw -> DiaryLine? in
            let l = raw.trimmingCharacters(in: .whitespaces)
            guard l.hasPrefix("- "), l.count > 8 else { return nil }
            let rest = l.dropFirst(2)
            let time = String(rest.prefix(5))
            guard time.range(of: #"^\d{2}:\d{2}$"#, options: .regularExpression) != nil else { return nil }
            return DiaryLine(time: time, text: String(rest.dropFirst(6)))
        }
        return (n, lines)
    }

    public struct SoFarRow: Equatable, Identifiable, Sendable {
        public enum Kind: String, Sendable { case capture, done, log }
        public var id: String
        /// When it happened, for the order.
        public var at: Date
        public var time: String
        public var text: String
        public var kind: Kind
        /// The task or log it is, for its link.
        public var itemId: String?
    }

    /// What was said and done today, oldest first: the diary's lines (every capture, as the assistant filed it),
    /// tasks finished, and logs with words in them (a med taken, an activity). Numbers logged today are
    /// `todayNumbers`. The day runs 4 AM to 4 AM, as the diary's does.
    public static func soFar(diary: [DiaryLine], tasks: [Entity], logs: [Entity], now: Date, startHour: Int = 4, calendar: Calendar = .current,
                             clock: Clock = deviceClock) -> [SoFarRow] {
        let start = dayStart(now, startHour: startHour, calendar: calendar)
        let to = start.addingTimeInterval(86400)
        let midnight = calendar.startOfDay(for: start)
        var rows: [SoFarRow] = []
        for (i, l) in diary.enumerated() {
            let p = l.time.split(separator: ":").compactMap { Int($0) }
            guard p.count == 2, var d = calendar.date(bySettingHour: p[0], minute: p[1], second: 0, of: midnight) else { continue }
            // A line before the day's first hour was said after midnight: it is on the next calendar day.
            if p[0] < startHour { d = calendar.date(byAdding: .day, value: 1, to: d) ?? d }
            rows.append(SoFarRow(id: "c:\(i)", at: d.addingTimeInterval(Double(i) / 1000), time: clock(d), text: l.text, kind: .capture, itemId: nil))
        }
        for t in tasks where !t.isDeleted {
            guard let done = t.date("done_at"), done >= start, done < to else { continue }
            rows.append(SoFarRow(id: "d:" + t.id, at: done, time: clock(done), text: "Done: \(t.str("title"))", kind: .done, itemId: t.id))
        }
        for l in logs where !l.isDeleted {
            guard let at = l.date("at"), at >= start, at < to else { continue }
            let type = l.str("type"), value = (l.fields["value"]?.displayString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, type == "med" || type == "activity" || type == "workout" else { continue }
            rows.append(SoFarRow(id: "l:" + l.id, at: at, time: clock(at), text: type == "med" ? "Took \(value)" : "\(type.prefix(1).uppercased() + type.dropFirst()): \(value)", kind: .log, itemId: l.id))
        }
        return rows.sorted { a, b in a.at != b.at ? a.at < b.at : a.id < b.id }
    }

    public struct Number: Equatable, Identifiable, Sendable {
        public var type: String
        public var label: String
        public var value: String
        public var id: String { type }
    }

    /// The numbers logged today, one per kind, in a fixed order: "Weight 158.4 lb", "Sleep 6 h 30 min", "Steps
    /// 4,210", "Caffeine 2 cups", "Mood +1". Units are read as the Logs screen reads them (LogUnits): a weight in its
    /// own unit, sleep in minutes unless the log says hours.
    public static func todayNumbers(_ logs: [Entity], now: Date, startHour: Int = 4, calendar: Calendar = .current) -> [Number] {
        let from = dayStart(now, startHour: startHour, calendar: calendar), to = from.addingTimeInterval(86400)
        let order = ["weight", "sleep", "steps", "caffeine", "mood", "bp"]
        let label = ["weight": "Weight", "sleep": "Sleep", "steps": "Steps", "caffeine": "Caffeine", "mood": "Mood", "bp": "Blood pressure"]
        var by: [String: [Entity]] = [:]
        for l in logs where !l.isDeleted {
            guard let at = l.date("at"), at >= from, at < to, order.contains(l.str("type")) else { continue }
            by[l.str("type"), default: []].append(l)
        }
        return order.compactMap { type -> Number? in
            guard let list = by[type]?.sorted(by: { $0.str("at") < $1.str("at") }), let last = list.last else { return nil }
            let unit = last.str("unit").trimmingCharacters(in: .whitespaces)
            let value: String
            switch type {
            case "caffeine":
                // Every cup is a log of its own: the day's total is what matters. One of them is a cup.
                let sum = list.reduce(0.0) { $0 + ($1.number("value") ?? 1) }
                let word = unit.isEmpty ? "cups" : unit
                value = "\(fmtNumber(sum)) \(sum == 1 && word.hasSuffix("s") ? String(word.dropLast()) : word)"
            case "mood":
                if let v = last.number("value") { value = (v > 0 ? "+" : "") + fmtNumber(v) } else { value = last.str("value") }
            case "sleep":
                if let m = LogUnits.sleepMinutes(last) { value = durationWords(m * 60) } else { value = last.str("value") }
            case "weight":
                if let v = last.number("value") { value = "\(fmtNumber(v)) \(LogUnits.weightUnit(last))" } else { value = last.str("value") }
            default:
                if let v = last.number("value") { value = fmtNumber(v) + (unit.isEmpty ? "" : " \(unit)") }
                else { value = (last.fields["value"]?.displayString ?? "") + (unit.isEmpty ? "" : " \(unit)") }
            }
            return Number(type: type, label: label[type] ?? type, value: value)
        }
    }

    /// 4210 as "4,210"; 158.4 stays "158.4"; whole numbers have no decimals.
    public static func fmtNumber(_ n: Double) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.maximumFractionDigits = 1
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    // MARK: coming up

    public struct TomorrowLine: Equatable, Identifiable, Sendable {
        public var id: String
        public var time: String
        public var title: String
    }

    /// Tomorrow's plans from the local copy: all-day ones first, then by time; at most `limit`, with how many more.
    public static func tomorrowLines(_ events: [Entity], now: Date, limit: Int = 3, calendar: Calendar = .current, clock: Clock = deviceClock) -> (lines: [TomorrowLine], more: Int) {
        guard let start = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else { return ([], 0) }
        let end = start.addingTimeInterval(86400)
        struct Row { var e: Entity; var allDay: Bool; var s: Date; var en: Date }
        var day: [Row] = []
        for e in events where !e.isDeleted {
            let allDay = e.bool("all_day") == true
            // An all-day plan is kept as a date: it is that whole local day, whatever the stored time zone says.
            let s = allDay ? localDay(String(e.str("start").prefix(10)), calendar: calendar) : e.date("start")
            guard let s else { continue }
            let en: Date
            if allDay {
                let last = localDay(String((e.string("end") ?? e.str("start")).prefix(10)), calendar: calendar) ?? s
                en = max(last, s).addingTimeInterval(1)
            } else {
                en = e.date("end") ?? s
            }
            guard s < end, en > start, allDay || s >= start else { continue }
            day.append(Row(e: e, allDay: allDay, s: s, en: en))
        }
        day.sort { a, b in
            if a.allDay != b.allDay { return a.allDay }
            return a.s != b.s ? a.s < b.s : a.e.id < b.e.id
        }
        let lines = day.prefix(limit).map { TomorrowLine(id: $0.e.id, time: $0.allDay ? "All day" : clock($0.s), title: $0.e.str("title")) }
        return (Array(lines), max(0, day.count - limit))
    }

    // MARK: columns

    public enum Section: String, CaseIterable, Sendable { case needs, schedule, todo, sofar, coming }

    /// Which sections go in which column at a width (of the screen's own area, in points): one column on a phone, up
    /// to five across a wide window. Each section keeps its column at a given width whatever it holds, so nothing
    /// moves when a list grows: a status board is read by position.
    public static func columns(width: Double) -> [[Section]] {
        if width >= 2100 { return [[.needs], [.schedule], [.todo], [.sofar], [.coming]] }
        if width >= 1500 { return [[.needs], [.schedule], [.todo], [.sofar, .coming]] }
        if width >= 1040 { return [[.needs, .todo], [.schedule], [.sofar, .coming]] }
        if width >= 680 { return [[.needs, .todo, .coming], [.schedule, .sofar]] }
        return [[.needs, .schedule, .todo, .sofar, .coming]]
    }
}
