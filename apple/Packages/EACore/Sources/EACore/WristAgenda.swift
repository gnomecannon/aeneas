import Foundation

/// One line of the day on the Watch: a calendar event or a reminder.
public struct AgendaItem: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case event, reminder }
    public var id: String
    public var kind: Kind
    public var title: String
    /// Start of an event, or when a reminder notifies (counting a snooze). Nil for all-day events.
    public var at: Date?
    public var end: Date?
    public var allDay: Bool
    public var friction: Friction
    public var work: Bool
}

/// Homelab state in one line, from the synced monitors and incidents.
public struct HomelabGlance: Equatable, Sendable {
    public var monitors: Int
    /// Names of enabled monitors that are down now.
    public var down: [String]
    /// Open incidents not yet acknowledged.
    public var unacknowledged: Int
    public var allUp: Bool { down.isEmpty }
}

extension SyncEngine {
    /// Today's events and reminders in time order, all-day events first. Reminders already done are left out;
    /// one that came due earlier today and is still open stays, so it can be finished from the wrist.
    public func agendaToday(now: Date = Date(), calendar: Calendar = .current) -> [AgendaItem] {
        let dayStart = calendar.startOfDay(for: now)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        var out: [AgendaItem] = []
        // An all-day event is stored at midnight UTC. Reading it as a local time put it on the evening before west
        // of UTC, so tomorrow's all-day plan showed today. Its days are the date parts (end exclusive), as the
        // phone's planner reads them.
        let ymd = calendar.dateComponents([.year, .month, .day], from: now)
        let key = String(format: "%04d-%02d-%02d", ymd.year ?? 0, ymd.month ?? 0, ymd.day ?? 0)
        for e in list(.event) where !e.isDeleted {
            let allDay = e.bool("all_day") ?? false
            guard let start = e.date("start") else { continue }
            let end = e.date("end") ?? start
            if allDay {
                let s = String(e.str("start").prefix(10)), en = String(e.str("end").prefix(10))
                guard s == key || (s < key && key < en) else { continue }
            } else {
                // Spans any part of today.
                guard start < dayEnd, end > dayStart || start >= dayStart else { continue }
            }
            out.append(AgendaItem(id: e.id, kind: .event, title: e.str("title"), at: allDay ? nil : start, end: allDay ? nil : end,
                                  allDay: allDay, friction: .none, work: e.space == .work))
        }
        for t in reminders {
            guard let r = t.reminderFields, let at = t.alertDate, at < dayEnd else { continue }
            // Older open reminders still show: they are what is left undone.
            out.append(AgendaItem(id: t.id, kind: .reminder, title: r.title, at: at, end: nil, allDay: false, friction: r.friction, work: t.space == .work))
        }
        return out.sorted { a, b in
            if a.allDay != b.allDay { return a.allDay }
            return (a.at ?? .distantPast) < (b.at ?? .distantPast)
        }
    }

    /// The next timed thing today: an event that has not ended, or the earliest open reminder.
    public func nextUp(now: Date = Date(), calendar: Calendar = .current) -> AgendaItem? {
        agendaToday(now: now, calendar: calendar).first { item in
            guard !item.allDay, let at = item.at else { return false }
            if item.kind == .reminder { return true }
            return (item.end ?? at) > now
        }
    }

    public var homelabGlance: HomelabGlance? {
        let monitors = list(.monitor).filter { !$0.isDeleted && ($0.bool("enabled") ?? true) }
        guard !monitors.isEmpty else { return nil }
        let down = monitors.filter { $0.str("state") == "down" }.map { $0.str("name") }.sorted()
        let open = list(.incident).filter { !$0.isDeleted && $0.str("closed_at").isEmpty && $0.str("acknowledged_at").isEmpty }
        return HomelabGlance(monitors: monitors.count, down: down, unacknowledged: open.count)
    }
}
