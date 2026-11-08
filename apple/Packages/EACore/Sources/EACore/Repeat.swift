import Foundation

/// Reminder repeat grammar from section 2 of the contract:
/// `every <n> <minutes|hours|days|weeks|months|years>` optionally `on <mon,tue,...>` (weeks)
/// or `on day <d>` (months). A port of `parseRepeat` and `nextOccurrence` in packages/shared.
public struct RepeatRule: Equatable, Sendable {
    public enum Unit: String, Sendable { case minutes, hours, days, weeks, months, years }
    public var n: Int
    public var unit: Unit
    public var on: [String]?

    public init(n: Int, unit: Unit, on: [String]? = nil) { self.n = n; self.unit = unit; self.on = on }

    /// The hub validates with `^every \d+ (minutes|...)( on [a-z0-9,]+)?$`, which has no space
    /// after `day`. The contract text shows `on day 15`; we parse both and emit `day15`.
    nonisolated(unsafe) private static let regex = try! NSRegularExpression(pattern: "^every (\\d+) (minutes|hours|days|weeks|months|years)(?: on ([a-z0-9, ]+))?$")

    public static func parse(_ s: String) -> RepeatRule? {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let ns = trimmed as NSString
        guard let m = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) else { return nil }
        guard let n = Int(ns.substring(with: m.range(at: 1))), let unit = Unit(rawValue: ns.substring(with: m.range(at: 2))) else { return nil }
        var on: [String]? = nil
        if m.range(at: 3).location != NSNotFound {
            let raw = ns.substring(with: m.range(at: 3))
            let tokens = raw.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
            on = tokens.isEmpty ? nil : tokens
        }
        return RepeatRule(n: n, unit: unit, on: on)
    }

    /// Canonical hub-valid form, e.g. `every 1 months on day15`, `every 2 weeks on mon,thu`.
    public var description: String {
        var s = "every \(n) \(unit.rawValue)"
        if let on = on, !on.isEmpty {
            if unit == .months, on.first == "day", on.count > 1 { s += " on day" + on[1] }
            else { s += " on " + on.joined(separator: ",") }
        }
        return s
    }

    private static let dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    private static let dowNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

    /// Weekdays typed in the repeat editor as the short codes the rule matches: "monday, thu" is `["mon", "thu"]`.
    /// A full name, or any start of one with three letters or more ("tues", "thurs"), becomes its code. Nil when a
    /// word is not a weekday: "monday" used to be kept as it was, which no day matches, so the reminder never came
    /// again and Done finished the task for good.
    public static func weekdayCodes(_ text: String) -> [String]? {
        let words = text.lowercased().split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init)
        guard !words.isEmpty else { return nil }
        var out: [String] = []
        for w in words {
            guard w.count >= 3, let i = dowNames.firstIndex(where: { $0.hasPrefix(w) }) else { return nil }
            if !out.contains(dow[i]) { out.append(dow[i]) }
        }
        // In week order, as the hub and the web write them.
        return dow.filter { out.contains($0) }
    }

    /// The rule the repeat editor builds, or nil when what was typed is not a valid repeat. Weekdays go through
    /// `weekdayCodes`; a day of the month is a number from 1 to 31, with or without the word "day".
    public static func editorRule(n: Int, unit: Unit, on text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespaces).lowercased()
        var on: [String]? = nil
        if unit == .weeks, !trimmed.isEmpty {
            guard let codes = weekdayCodes(trimmed) else { return nil }
            on = codes
        }
        if unit == .months, !trimmed.isEmpty {
            let digits = trimmed.replacingOccurrences(of: "day", with: "").trimmingCharacters(in: .whitespaces)
            guard let d = Int(digits), (1...31).contains(d) else { return nil }
            on = ["day", String(d)]
        }
        guard n >= 1 else { return nil }
        let s = RepeatRule(n: n, unit: unit, on: on).description
        return parse(s) != nil ? s : nil
    }

    private func step(_ d: Date, calendar: Calendar) -> Date {
        switch unit {
        case .minutes: return calendar.date(byAdding: .minute, value: n, to: d) ?? d
        case .hours: return calendar.date(byAdding: .hour, value: n, to: d) ?? d
        case .days: return calendar.date(byAdding: .day, value: n, to: d) ?? d
        case .weeks: return calendar.date(byAdding: .day, value: 7 * n, to: d) ?? d
        case .months: return calendar.date(byAdding: .month, value: n, to: d) ?? d
        case .years: return calendar.date(byAdding: .year, value: n, to: d) ?? d
        }
    }

    /// Next fire time strictly after `after` for a rule that started at `start`. Mirrors the shared TypeScript so hub
    /// and client agree: months and years keep the start's day, or the month's last day when it is shorter (counted
    /// from the start, so Jan 31 goes to Feb 28 and back to Mar 31), and `every 2 weeks on mon,thu` fires on those days
    /// of every second week from the start's week.
    public func next(after: Date, start: Date, calendar: Calendar = .current) -> Date? {
        let monthDay: Int? = {
            guard unit == .months, let on = on, let first = on.first, first.hasPrefix("day") else { return nil }
            if let v = Int(first.dropFirst(3)) { return v }
            if on.count > 1, let v = Int(on[1]) { return v }
            return nil
        }()
        switch unit {
        case .months, .years:
            let per = unit == .years ? 12 * n : n
            let s = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: start)
            for k in 0..<10000 {
                var c = DateComponents()
                c.year = s.year; c.month = (s.month ?? 1) + k * per; c.day = 1
                c.hour = s.hour; c.minute = s.minute; c.second = s.second; c.nanosecond = s.nanosecond
                guard let firstOfMonth = calendar.date(from: c) else { return nil }
                let days = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 28
                c.day = min(monthDay ?? s.day ?? 1, days)
                guard let d = calendar.date(from: c) else { return nil }
                if d > after && (k > 0 || monthDay == nil || d >= start) { return d }
            }
            return nil
        case .weeks where on != nil:
            let on = self.on ?? []
            // No day it can match (a word that is not a weekday code): nothing comes next, without scanning
            // a hundred thousand days to find that out.
            guard on.contains(where: { Self.dow.contains($0) }) else { return nil }
            func weekStart(_ x: Date) -> Date {
                let day = calendar.startOfDay(for: x)
                return calendar.date(byAdding: .day, value: -(calendar.component(.weekday, from: day) - 1), to: day) ?? day
            }
            let first = weekStart(start)
            var d = start
            for _ in 0..<100000 {
                let weeks = Int(((calendar.dateComponents([.day], from: first, to: weekStart(d)).day ?? 0)) / 7)
                if d > after && weeks % n == 0 && on.contains(Self.dow[calendar.component(.weekday, from: d) - 1]) { return d }
                d = calendar.date(byAdding: .day, value: 1, to: d) ?? d
            }
            return nil
        default:
            var d = start
            for _ in 0..<1_000_000 {
                if d > after { return d }
                d = step(d, calendar: calendar)
            }
            return nil
        }
    }
}

/// A task's deadline as the screens show it. A deadline that is a date alone ("2026-11-06") is due all that local
/// day: it used to read as midnight, so it was red from the start of its own day and showed "Due 12:00 AM".
public enum TaskDue {
    public static func isDateOnly(_ due: String) -> Bool {
        due.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
    }

    /// Past due: a date alone only once its day is over, a date and time once that moment has passed.
    public static func isOverdue(_ due: String, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        if isDateOnly(due) {
            guard let day = LocalPlanner.date(due), let next = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: day)) else { return false }
            return now >= next
        }
        guard let d = ISO.date(due) else { return false }
        return d < now
    }

    /// "Today", "Nov 6" for a date alone; a time today, else a date and time, for a moment.
    public static func label(_ due: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        if isDateOnly(due) {
            guard let day = LocalPlanner.date(due) else { return due }
            if calendar.isDate(day, inSameDayAs: now) { return "today" }
            return day.formatted(.dateTime.month(.abbreviated).day())
        }
        guard let d = ISO.date(due) else { return due }
        if calendar.isDate(d, inSameDayAs: now) { return d.formatted(date: .omitted, time: .shortened) }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
}

public enum ReminderMath {
    /// Effective fire time considering snooze (shared `effectiveAt`).
    public static func effectiveAt(at: String, snoozedUntil: String?) -> String {
        if let s = snoozedUntil, !s.isEmpty, ISO.isAfter(s, at) { return s }
        return at
    }

    public static func effectiveDate(_ r: ReminderFields) -> Date? {
        ISO.date(effectiveAt(at: r.at, snoozedUntil: r.snoozed_until))
    }

    /// The fields that finish a task. A repeating one stays open and moves its reminder and deadline to the next
    /// occurrence after `now`; anything else is done. Same rule as the hub's `completeTaskPatch`.
    public static func completeTask(_ e: Entity, now: Date = Date()) -> [String: JSONValue] {
        // A deadline that is a date alone is that local day (not UTC midnight, 7 PM the evening before in New York),
        // and stays a date.
        let dueText = e.str("due")
        let dateOnly = dueText.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        let remind = ISO.date(e.str("remind_at")), due = dateOnly ? LocalPlanner.date(dueText) : ISO.date(dueText)
        if let rep = e.fields["repeat"]?.stringValue, let rule = RepeatRule.parse(rep), let base = remind ?? due,
           let next = rule.next(after: max(now, base), start: base) {
            var out: [String: JSONValue] = ["snoozed_until": .null, "done_at": .string(ISO.string(now))]
            let shift = next.timeIntervalSince(base)
            if remind != nil { out["remind_at"] = .string(ISO.string(next)) }
            if let d = due {
                if dateOnly {
                    let days = remind == nil ? Calendar.current.dateComponents([.day], from: d, to: Calendar.current.startOfDay(for: next)).day ?? 0
                                             : Int((shift / 86400).rounded())
                    let moved = Calendar.current.date(byAdding: .day, value: days, to: d) ?? d
                    out["due"] = .string(LocalPlanner.dateString(moved))
                } else {
                    out["due"] = .string(ISO.string(d.addingTimeInterval(shift)))
                }
            }
            return out
        }
        return ["status": "done", "done_at": .string(ISO.string(now)), "snoozed_until": .null]
    }
}

extension Entity {
    /// The reminder side of a task: its reminder time, repeat, snooze and friction, in the shape the notification
    /// planner reads. Nil for a task without a reminder time or that is done. The older `reminder` kind reads as itself.
    public var reminderFields: ReminderFields? {
        switch kind {
        case .reminder:
            guard !isDeleted, let r = decoded(ReminderFields.self), (r.acknowledged_at ?? "").isEmpty || r.repeat != nil else { return nil }
            return r
        case .task:
            let at = str("remind_at")
            guard !isDeleted, !at.isEmpty, str("status") != "done" else { return nil }
            return ReminderFields(title: str("title"), at: at, repeat: fields["repeat"]?.stringValue,
                                  friction: Friction(rawValue: str("friction")) ?? .none, snoozed_until: fields["snoozed_until"]?.stringValue,
                                  snooze_log: (fields["snooze_log"]).flatMap { try? JSONCoding.decode([SnoozeEntry].self, from: JSONCoding.data($0)) },
                                  fired: nil, acknowledged_at: nil, linked_id: fields["linked_id"]?.stringValue)
        default:
            return nil
        }
    }

    /// When it notifies next, counting a snooze.
    public var alertDate: Date? { reminderFields.flatMap { ReminderMath.effectiveDate($0) } }
}
