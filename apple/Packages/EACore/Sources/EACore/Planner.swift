import Foundation

/// A hub (or local) question about a long running activity: "On <name> for <h> h".
public struct ActivityCheckin: Equatable, Identifiable, Sendable {
    public static let categoryId = "EA_ACTIVITY"
    public static let stillAction = "EA_STILL"
    public static let stopAction = "EA_STOP"

    public var logId: String
    public var name: String
    public var hours: Double
    public var title: String
    public var id: String { logId }

    public init(logId: String, name: String, hours: Double, title: String = "") {
        self.logId = logId; self.name = name; self.hours = hours
        self.title = title.isEmpty ? "On \(name) for \(Int(hours.rounded(.down))) h" : title
    }
}

/// Pure planning used when the hub cannot be reached, and for the widget snapshot. It follows
/// the contract's planner rules: the day window is `dayStart` to `dayEnd` local, minus
/// `plan_rule` blackouts and commitments, minus existing task blocks and events.
public enum LocalPlanner {
    public static let dayStart = "09:00"
    public static let dayEnd = "23:00"
    public static let defaultBlockHours: Double = 3

    nonisolated(unsafe) private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone.current
        return f
    }()

    public static func dateString(_ d: Date) -> String { dayFormatter.string(from: d) }
    public static func date(_ s: String) -> Date? { dayFormatter.date(from: s) }

    /// `HH:MM` to minutes after midnight; `24:00` is 1440.
    public static func minutes(_ hhmm: String) -> Int? {
        let p = hhmm.split(separator: ":")
        guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), (0...24).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    public static func hhmm(_ minutes: Int) -> String { String(format: "%02d:%02d", minutes / 60, minutes % 60) }

    /// A local wall-clock time on `day`. It used to add minutes to midnight, which on a clock change day is an hour
    /// off (09:00 on the first Sunday of November came out as 08:00); it sets the hour and minute instead.
    /// `24:00` is the next midnight.
    public static func time(on day: Date, hhmm: String, calendar: Calendar = .current) -> Date? {
        guard let m = minutes(hhmm) else { return nil }
        let start = calendar.startOfDay(for: day)
        if m >= 1440 { return calendar.date(byAdding: .day, value: 1, to: start) }
        return calendar.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: start)
    }

    /// The local wall-clock `HH:MM` of a date, read from its hour and minute (not minutes since midnight, which is
    /// an hour off on a clock change day).
    public static func hhmm(of date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return hhmm((c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    /// Monday of the week containing `d`.
    public static func monday(of d: Date, calendar: Calendar = .current) -> Date {
        let start = calendar.startOfDay(for: d)
        let weekday = calendar.component(.weekday, from: start)   // 1 = Sunday
        let back = (weekday + 5) % 7                               // Monday = 0
        return calendar.date(byAdding: .day, value: -back, to: start) ?? start
    }

    public static func weekday(_ d: Date, calendar: Calendar = .current) -> Weekday {
        let i = calendar.component(.weekday, from: d)
        return [Weekday.sun, .mon, .tue, .wed, .thu, .fri, .sat][i - 1]
    }

    /// Does a rule apply on `day`: active, the weekday is listed, and for an alternating rule the
    /// week is an even number of weeks from the anchor's week.
    public static func applies(_ r: PlanRuleFields, on day: Date, calendar: Calendar = .current) -> Bool {
        guard r.active ?? true, r.days.contains(weekday(day, calendar: calendar)) else { return false }
        if let a = r.alternating_anchor, let anchor = date(a) {
            let weeks = calendar.dateComponents([.day], from: monday(of: anchor, calendar: calendar), to: monday(of: day, calendar: calendar)).day ?? 0
            return (weeks / 7) % 2 == 0
        }
        return true
    }

    public static func commitments(rules: [Entity], on day: Date, calendar: Calendar = .current) -> [PlannerCommitment] {
        var out: [PlannerCommitment] = []
        for e in rules where e.kind == .plan_rule && !e.isDeleted {
            guard let r = e.decoded(PlanRuleFields.self), applies(r, on: day, calendar: calendar),
                  let s = time(on: day, hhmm: r.start, calendar: calendar), let en = time(on: day, hhmm: r.end, calendar: calendar), en > s else { continue }
            out.append(PlannerCommitment(rule_id: e.id, title: r.title, start: ISO.string(s), end: ISO.string(en), type: r.type))
        }
        return out.sorted { $0.start < $1.start }
    }

    public static func blocks(tasks: [Entity], on day: Date, calendar: Calendar = .current) -> [PlannerBlock] {
        var out: [PlannerBlock] = []
        for t in tasks where t.kind == .task && !t.isDeleted {
            guard let f = t.decoded(TaskFields.self), let b = f.block, let s = ISO.date(b.start), calendar.isDate(s, inSameDayAs: day) else { continue }
            if f.status == .done || f.status == .parked { continue }
            out.append(PlannerBlock(task_id: t.id, title: f.title, start: b.start, end: b.end, status: f.status))
        }
        return out.sorted { $0.start < $1.start }
    }

    /// Free gaps of at least `minHours` inside the day window, minus blocks, blackouts,
    /// commitments and timed events. For today the window starts at `now` rounded up to 15 min.
    public static func freeSlots(on day: Date, blocks: [PlannerBlock], commitments: [PlannerCommitment], events: [Entity], minHours: Double, now: Date = Date(), calendar: Calendar = .current) -> [FreeSlot] {
        guard var cursor = time(on: day, hhmm: dayStart, calendar: calendar), let end = time(on: day, hhmm: dayEnd, calendar: calendar) else { return [] }
        if calendar.isDate(day, inSameDayAs: now) {
            let rounded = ceil(now.timeIntervalSince1970 / 900) * 900
            cursor = max(cursor, Date(timeIntervalSince1970: rounded))
        } else if day < calendar.startOfDay(for: now) {
            return []
        }
        var busy: [(Date, Date)] = []
        for b in blocks { if let s = ISO.date(b.start), let e = ISO.date(b.end) { busy.append((s, e)) } }
        for c in commitments where c.type != .preference { if let s = ISO.date(c.start), let e = ISO.date(c.end) { busy.append((s, e)) } }
        for ev in events where ev.kind == .event && !ev.isDeleted && !(ev.bool("all_day") ?? false) {
            if let s = ev.date("start"), let e = ev.date("end") { busy.append((s, e)) }
        }
        busy.sort { $0.0 < $1.0 }
        var out: [FreeSlot] = []
        func emit(_ s: Date, _ e: Date) {
            let hours = e.timeIntervalSince(s) / 3600
            if hours + 0.001 >= minHours { out.append(FreeSlot(start: ISO.string(s), end: ISO.string(e), hours: (hours * 4).rounded() / 4)) }
        }
        for (s, e) in busy {
            if e <= cursor { continue }
            if s > cursor { emit(cursor, min(s, end)) }
            cursor = max(cursor, e)
            if cursor >= end { break }
        }
        if cursor < end { emit(cursor, end) }
        return out
    }

    public static func day(_ day: Date, tasks: [Entity], rules: [Entity], events: [Entity], reminders: [Entity], watches: [Entity], minHours: Double = defaultBlockHours, now: Date = Date(), calendar: Calendar = .current) -> PlannerDay {
        let blocks = blocks(tasks: tasks, on: day, calendar: calendar)
        let commitments = commitments(rules: rules, on: day, calendar: calendar)
        // An all-day event is stored at midnight UTC: its days are the date parts (end exclusive), not local times,
        // which west of UTC would put it on the evening before.
        let ymd = calendar.dateComponents([.year, .month, .day], from: day)
        let key = String(format: "%04d-%02d-%02d", ymd.year ?? 0, ymd.month ?? 0, ymd.day ?? 0)
        let dayEvents = events.filter { e in
            guard e.kind == .event, !e.isDeleted else { return false }
            if e.bool("all_day") == true {
                let s = String(e.str("start").prefix(10)), en = String(e.str("end").prefix(10))
                return s == key || (s < key && key < en)
            }
            return e.date("start").map { calendar.isDate($0, inSameDayAs: day) } == true
        }
            .sorted { ($0.date("start") ?? .distantPast) < ($1.date("start") ?? .distantPast) }
        let dayReminders = reminders.filter { e in
            guard let d = e.alertDate else { return false }
            return calendar.isDate(d, inSameDayAs: day)
        }.sorted { ($0.alertDate ?? .distantPast) < ($1.alertDate ?? .distantPast) }
        let dayWatches = watches.filter { e in
            guard e.kind == .watch, !e.isDeleted, let d = e.date("due") else { return false }
            return calendar.isDate(d, inSameDayAs: day)
        }
        return PlannerDay(date: dateString(day), blocks: blocks, events: dayEvents, commitments: commitments, reminders: dayReminders, watches_due: dayWatches,
                          free_slots: freeSlots(on: day, blocks: blocks, commitments: commitments, events: dayEvents, minHours: minHours, now: now, calendar: calendar))
    }

    public static func week(start: Date, tasks: [Entity], rules: [Entity], events: [Entity], reminders: [Entity], watches: [Entity], minHours: Double = defaultBlockHours, now: Date = Date(), calendar: Calendar = .current) -> PlannerWeek {
        let monday = calendar.startOfDay(for: start)
        let days = (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: monday) }
            .map { day($0, tasks: tasks, rules: rules, events: events, reminders: reminders, watches: watches, minHours: minHours, now: now, calendar: calendar) }
        return PlannerWeek(start: dateString(monday), days: days)
    }

    /// Watches due within `days` from now, overdue included, soonest first.
    public static func watchesDueSoon(_ watches: [Entity], days: Int = 30, now: Date = Date()) -> [Entity] {
        let limit = now.addingTimeInterval(Double(days) * 86400)
        return watches.filter { e in
            guard e.kind == .watch, !e.isDeleted, let d = e.date("due") else { return false }
            return d <= limit
        }.sorted { ($0.date("due") ?? .distantFuture) < ($1.date("due") ?? .distantFuture) }
    }

    /// Two to four plain lines, the shape the hub's `digest` has.
    public static func digest(for day: PlannerDay, now: Entity?, watchesDueSoon: [Entity], capturesUnprocessed: Int) -> String {
        var lines: [String] = []
        if let n = now {
            lines.append((n.str("status") == "doing" ? "Doing: " : "Now: ") + n.str("title"))
        }
        if let first = day.blocks.first, let s = ISO.date(first.start) {
            lines.append("\(day.blocks.count) block\(day.blocks.count == 1 ? "" : "s") today, first at \(s.formatted(date: .omitted, time: .shortened))")
        } else if let free = day.free_slots.first {
            lines.append("Nothing planned, \(free.hours.formatted()) h free from \(ISO.date(free.start)?.formatted(date: .omitted, time: .shortened) ?? "")")
        } else {
            lines.append("Nothing planned today")
        }
        var bits: [String] = []
        if !day.reminders.isEmpty { bits.append("\(day.reminders.count) reminder\(day.reminders.count == 1 ? "" : "s")") }
        if !day.commitments.isEmpty { bits.append("\(day.commitments.count) commitment\(day.commitments.count == 1 ? "" : "s")") }
        if !watchesDueSoon.isEmpty { bits.append("\(watchesDueSoon.count) renewal\(watchesDueSoon.count == 1 ? "" : "s") due soon") }
        if !bits.isEmpty { lines.append(bits.joined(separator: ", ")) }
        if capturesUnprocessed > 0, lines.count < 4 { lines.append("\(capturesUnprocessed) capture\(capturesUnprocessed == 1 ? "" : "s") to sort") }
        return lines.prefix(4).joined(separator: "\n")
    }
}

// MARK: - Engine actions for the planner, watches and plan rules

extension SyncEngine {
    public var watches: [Entity] { list(.watch).sorted { ($0.date("due") ?? .distantFuture) < ($1.date("due") ?? .distantFuture) } }
    public var planRules: [Entity] { list(.plan_rule).sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending } }
    public var events: [Entity] { list(.event) }

    /// The next block today that starts after now, other than the Now task's own block.
    public func nextBlockToday(excluding id: String? = nil, now: Date = Date()) -> PlannerBlock? {
        LocalPlanner.blocks(tasks: tasks, on: now).first { $0.task_id != id && (ISO.date($0.start) ?? .distantPast) > now }
    }

    public func localDay(_ day: Date, minHours: Double = LocalPlanner.defaultBlockHours, now: Date = Date()) -> PlannerDay {
        LocalPlanner.day(day, tasks: tasks, rules: planRules, events: events, reminders: reminders, watches: watches, minHours: minHours, now: now)
    }

    public func localWeek(start: Date, minHours: Double = LocalPlanner.defaultBlockHours, now: Date = Date()) -> PlannerWeek {
        LocalPlanner.week(start: start, tasks: tasks, rules: planRules, events: events, reminders: reminders, watches: watches, minHours: minHours, now: now)
    }

    public func localToday(now: Date = Date()) -> PlannerToday {
        let day = localDay(now, now: now)
        let soon = LocalPlanner.watchesDueSoon(watches, now: now)
        let n = nowTask
        return PlannerToday(date: day.date, now: n, next: upNext, blocks: day.blocks, commitments: day.commitments, reminders_due: day.reminders,
                            watches_due_soon: soon, captures_unprocessed: unprocessedCaptures.count, free_slots: day.free_slots,
                            digest: LocalPlanner.digest(for: day, now: n, watchesDueSoon: soon, capturesUnprocessed: unprocessedCaptures.count))
    }

    /// `GET /planner/today` when the hub answers, else the same shape computed from the local store.
    public func loadToday() async -> (today: PlannerToday, fromHub: Bool) {
        if let c = client, status != .unconfigured, let t = try? await c.plannerToday() {
            if status != .online { status = .online }
            for e in [t.now].compactMap({ $0 }) + t.next + t.reminders_due + t.watches_due_soon { await absorb(e) }
            return (t, true)
        }
        return (localToday(), false)
    }

    /// `GET /planner/week` when the hub answers, else computed locally.
    public func loadWeek(start: Date, minHours: Double = LocalPlanner.defaultBlockHours) async -> (week: PlannerWeek, fromHub: Bool) {
        if let c = client, status != .unconfigured, let w = try? await c.plannerWeek(start: LocalPlanner.dateString(start), minHours: minHours) {
            if status != .online { status = .online }
            return (w, true)
        }
        return (localWeek(start: start, minHours: minHours), false)
    }

    /// Put a task in a block. Online: `POST /planner/schedule` (409 is thrown as `HubError.conflict`).
    /// Offline: the block is checked against local blocks, commitments and blackouts and patched locally.
    @discardableResult
    public func schedule(taskId: String, start: Date, hours: Double = LocalPlanner.defaultBlockHours, force: Bool = false) async throws -> Entity? {
        let end = start.addingTimeInterval(hours * 3600)
        if let c = client, status == .online {
            do {
                let e = try await c.plannerSchedule(taskId: taskId, start: ISO.string(start), hours: hours, force: force)
                await absorb(e)
                Task { await self.sync() }
                return e
            } catch let h as HubError where h.plannerConflict != nil {
                throw h
            } catch let h as HubError where h.isAuth {
                throw h
            } catch {
                // Hub unreachable: fall through to the local path.
            }
        }
        if !force, let conflict = localConflict(taskId: taskId, start: start, end: end) { throw HubError.conflict(conflict) }
        return await update(taskId, fields: ["status": "scheduled", "block": .object(["start": .string(ISO.string(start)), "end": .string(ISO.string(end))])])
    }

    private func localConflict(taskId: String, start: Date, end: Date) -> PlannerConflict? {
        let day = localDay(start)
        for b in day.blocks where b.task_id != taskId {
            if let s = ISO.date(b.start), let e = ISO.date(b.end), s < end, e > start { return PlannerConflict(kind: "block", title: b.title, start: b.start, end: b.end, task_id: b.task_id) }
        }
        for c in day.commitments where c.type != .preference {
            if let s = ISO.date(c.start), let e = ISO.date(c.end), s < end, e > start { return PlannerConflict(kind: c.type.rawValue, title: c.title, start: c.start, end: c.end, rule_id: c.rule_id) }
        }
        for ev in day.events where !(ev.bool("all_day") ?? false) {
            if let s = ev.date("start"), let e = ev.date("end"), s < end, e > start { return PlannerConflict(kind: "event", title: ev.str("title"), start: ev.str("start"), end: ev.str("end")) }
        }
        return nil
    }

    /// Clear a task's block; status becomes `next` unless the task is done or doing, as on the hub
    /// (hub/src/planner.ts, unscheduleTask). Offline it used to make a doing task next as well.
    public func unschedule(taskId: String) async {
        if let c = client, status == .online, let e = try? await c.plannerUnschedule(taskId: taskId) {
            await absorb(e)
            Task { await self.sync() }
            return
        }
        let current = entities[taskId]?.str("status") ?? ""
        let keep = current == "done" || current == "doing"
        _ = await update(taskId, fields: keep ? ["block": .null] : ["status": "next", "block": .null])
    }

    /// Mark a watch renewed: the hub route when online; offline, roll `due` by `repeat` or set `renewed_at`.
    public func renewWatch(_ id: String) async {
        guard let e = entities[id], let w = e.decoded(WatchFields.self) else { return }
        if let c = client, status == .online, (try? await c.watchRenewed(id: id)) != nil {
            Task { await self.sync() }
            return
        }
        // Renewed already in the last three days (the button pressed twice offline, or the button and then the
        // assistant): one renewal, as on the hub (hub/src/watches.ts, renewWatch). Offline it used to roll the due
        // date a second period.
        if let last = ISO.date(e.str("renewed_at")), Date().timeIntervalSince(last) < 3 * 86400 { return }
        var f: [String: JSONValue] = ["renewed_at": .string(ISO.now())]
        if let rep = w.repeat, let rule = RepeatRule.parse(rep), let due = ISO.date(w.due), let next = rule.next(after: due, start: due) {
            // A date-only due stays date-only, as the hub's rollDue keeps it.
            f["due"] = .string(w.due.count == 10 ? LocalPlanner.dateString(next) : ISO.string(next))
        }
        _ = await update(id, fields: f)
    }
}
