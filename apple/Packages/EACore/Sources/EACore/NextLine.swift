import Foundation

/// What the widgets and the Watch keep to draw the Next line themselves as the minutes pass (`TodayBoard.nowLine`;
/// CONTRACT.md, Planner, The Next line): the task you started and the rest of today's plan, written by the app with
/// the rest of the widget snapshot (`SyncEngine.updateSnapshot`) and sent to the Watch with its complications
/// (`ComplicationSnapshot.line`). A widget's timeline asks it for the line at each of its moments.
public struct NextLinePlan: Codable, Equatable, Sendable {
    /// The local day it was made for ("2026-11-25"): its spans are that day's.
    public var day: String
    public var started: TodayBoard.StartedTask?
    /// The day's events with hours, blocks, rule hours, reminders and free time, the whole day's: the free time as the
    /// day began, cut to what is left at each moment it is drawn (`spans(at:)`), so the plan stays the same all day
    /// until the day's items change and nothing is sent or redrawn just because time passed.
    public var spans: [TodayBoard.Span]

    public init(day: String, started: TodayBoard.StartedTask?, spans: [TodayBoard.Span]) {
        self.day = day; self.started = started; self.spans = spans
    }

    /// From the day's plan, worked out as the day began (`SyncEngine.nextLinePlan`). What is never on the line (all-day
    /// events, whole-day rules, preference and info rules) is left out, so the snapshot stays small.
    public init(day: PlannerDay, started: Entity?) {
        let all = TodayBoard.spans(blocks: day.blocks, commitments: day.commitments, events: day.events, reminders: day.reminders, freeSlots: day.free_slots)
        let kept = all.filter { s in
            switch s.kind {
            case .event: return !s.allDay
            case .block, .free, .reminder: return true
            case .commitment: return s.rule?.takesTime == true && !s.allDay
            }
        }
        self.init(day: day.date, started: started.map(TodayBoard.StartedTask.init), spans: kept)
    }

    /// The spans that count at `at`: none from another day, and free time only where enough of it is left for a block
    /// (`LocalPlanner.defaultBlockHours`), as the planner offers it on Today.
    func spans(at: Date, freeHours: Double = LocalPlanner.defaultBlockHours) -> [TodayBoard.Span] {
        guard day == LocalPlanner.dateString(at) else { return [] }
        return spans.filter { s in
            guard s.kind == .free else { return true }
            return s.end.timeIntervalSince(max(s.start, at)) + 0.5 >= freeHours * 3600
        }
    }

    /// The line at `at`, in words: the task you started, else what is on or next, else the free time, else "Nothing
    /// else today".
    public func words(at: Date, clock: @escaping TodayBoard.Clock = TodayBoard.deviceClock) -> TodayBoard.LineWords {
        let s = spans(at: at)
        return TodayBoard.lineWords(TodayBoard.nowLine(s, now: at, started: started), free: TodayBoard.freeLine(s, now: at, clock: clock), clock: clock)
    }

    /// Under a task you started: what is on now or next with a time, when anything is.
    public func then(at: Date, clock: @escaping TodayBoard.Clock = TodayBoard.deviceClock) -> TodayBoard.LineWords? {
        guard started != nil else { return nil }
        let line = TodayBoard.nowLine(spans(at: at), now: at)
        if case .clear = line { return nil }
        return TodayBoard.lineWords(line, free: nil, clock: clock)
    }

    /// The moments a widget's timeline draws, one a minute from `from` for `minutes` (the minutes left count down),
    /// each on the minute.
    public static func moments(from: Date, minutes: Int = 60) -> [Date] {
        let start = Date(timeIntervalSince1970: (from.timeIntervalSince1970 / 60).rounded(.down) * 60)
        return [from] + (1...max(1, minutes)).map { start.addingTimeInterval(Double($0) * 60) }
    }

    public var data: Data? { try? JSONEncoder().encode(self) }
    public init?(data: Data) {
        guard let p = try? JSONDecoder().decode(NextLinePlan.self, from: data) else { return nil }
        self = p
    }
}

extension SyncEngine {
    /// The task you started (CONTRACT.md, Planner, The Next line): status doing, the most recently started first.
    /// Never the first task in Next.
    public var startedTask: Entity? { kept("startedTask", kinds: [.task]) { TodayBoard.startedTask(tasks) } }

    /// The task you started among those `keep` lets through (Today's To do, holding the lists chosen for it).
    public func startedTask(where keep: (Entity) -> Bool) -> Entity? { TodayBoard.startedTask(tasks.filter(keep)) }

    /// The Next line's plan for today, from this device's own copy: the day as it was planned when it began, so the
    /// free time is the whole day's (`NextLinePlan.spans(at:)` cuts it to what is left).
    public func nextLinePlan(now: Date = Date()) -> NextLinePlan {
        NextLinePlan(day: localDay(now, now: Calendar.current.startOfDay(for: now)), started: startedTask)
    }
}
