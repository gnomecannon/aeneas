#if os(iOS) || os(macOS)
import Foundation
import EventKit
import os

/// Keeps tasks and Apple Reminders the same, both ways, on the iPhone and the Mac. Every list syncs; lists from a
/// work account (Exchange, or the work email's domain) go into the work space. New tasks made in the app are added
/// to the default Reminders list by the iPhone only, so the two devices never add the same one twice.
/// The merge rules are in `RemindersMerge`; this class reads and writes EventKit and runs it.
@MainActor
public final class RemindersSync: ObservableObject {
    public static let shared = RemindersSync()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "reminders")
    private static let stateKey = "ea.remindersSync.state"
    private static let enabledKey = "ea.remindersSync.enabled"

    @Published public private(set) var access: CalendarImporter.Access = .notDetermined
    @Published public private(set) var running = false
    @Published public private(set) var lastRun: Date?
    @Published public private(set) var lastSummary: String?
    @Published public private(set) var lastError: String?
    @Published public private(set) var itemCount = 0
    /// Every Reminders list on this device, empty ones too, so the Tasks screen can offer them.
    @Published public private(set) var lists: [ReminderList] = []
    /// The title of the list new reminders go to on this device, so the task editor's "Default list" can move a
    /// linked task there (an empty list name on a linked task changes nothing).
    @Published public private(set) var defaultListTitle: String?

    public struct ReminderList: Hashable, Sendable {
        public var title: String
        public var isWork: Bool
    }

    /// Supplies a started engine; set by the app.
    public var engineProvider: (() async -> SyncEngine)?
    /// Only one device adds Apple items for tasks made in the app.
    public var createsInApple: Bool = {
        #if os(iOS)
        return true
        #else
        return false
        #endif
    }()

    /// Replaced once access is granted: a store made before that never answers its first fetch.
    private var store = EKEventStore()
    private var observer: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var rerun = false
    #if os(macOS)
    private var hourly: Timer?
    #endif

    public init() { refreshAccess() }

    public var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey); objectWillChange.send() }
    }

    /// The Apple Reminders module (Settings, Modules) is on. Off, nothing is read from or written to Reminders.
    public var moduleOn: Bool { SharedConfig.shared.moduleSaidOn(.appleReminders) }

    public func refreshAccess() {
        let before = access
        switch EKEventStore.authorizationStatus(for: .reminder) {
        case .fullAccess: access = .full
        case .writeOnly: access = .writeOnly
        case .denied: access = .denied
        case .restricted: access = .restricted
        // A grant from this launch counts even while the system still says "not determined".
        default: if access != .full { access = .notDetermined }
        }
        // Access just granted (here or in Settings): start over with a fresh store.
        if access == .full && before != .full && before != .notDetermined { resetStore() }
    }

    private func resetStore() {
        store = EKEventStore()
        if let o = observer {
            NotificationCenter.default.removeObserver(o)
            observer = nil
            startObserving()
        }
    }

    public func requestAccess() async {
        var granted = false
        do { granted = try await store.requestFullAccessToReminders() } catch { lastError = error.localizedDescription }
        refreshAccess()
        // Right after the prompt iOS can still report "not determined"; the prompt's own answer is the truth.
        if granted { access = .full }
        Self.log.notice("access after asking: \(String(describing: self.access), privacy: .public)")
        if access == .full { resetStore() }
        if access == .full { startObserving(); await runNow(reason: "access granted") }
    }

    /// Launch: sync when access was given. Access is never asked for here (release rule 2): only from the
    /// permission screen after setup or when the module is switched on, or from Connections, Apple Reminders.
    public func autoStart() async {
        refreshAccess()
        guard enabled, moduleOn else { return }
        await runIfReady(reason: "launch")
    }

    /// The switch in Connections turned on: the person asked for it, so access is asked for here if it never was.
    public func turnOn() async {
        enabled = true
        refreshAccess()
        if access == .notDetermined { await requestAccess() } else { await runIfReady(reason: "turned on") }
    }

    public func runIfReady(reason: String) async {
        refreshAccess()
        guard enabled, moduleOn, access == .full else { return }
        startObserving()
        await runNow(reason: reason)
    }

    /// Changes made in Apple Reminders arrive 5 s after the last one.
    public func startObserving() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.storeChanged() }
        }
        #if os(macOS)
        guard hourly == nil else { return }
        // The Mac app stays running in the menu bar; an hourly pass catches anything missed.
        hourly = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in
            Task { @MainActor in await RemindersSync.shared.runIfReady(reason: "hourly") }
        }
        #endif
    }

    /// App-side changes (a task edited here or synced from another device), coalesced.
    public func scheduleRun(after seconds: Double = 5) {
        guard enabled, moduleOn, access == .full else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.runNow(reason: "change")
        }
    }

    private func storeChanged() { scheduleRun() }

    // MARK: run

    public func runNow(reason: String) async {
        guard access == .full, moduleOn, let provider = engineProvider else {
            Self.log.notice("not run (\(reason, privacy: .public)): access \(String(describing: self.access), privacy: .public), module \(self.moduleOn), engine \(self.engineProvider != nil)")
            return
        }
        if running { rerun = true; return }
        running = true
        defer { running = false }
        repeat {
            rerun = false
            let engine = await provider()
            do {
                let summary = try await syncOnce(engine)
                lastSummary = summary
                lastError = nil
                lastRun = Date()
                Self.log.notice("sync (\(reason, privacy: .public)): \(summary, privacy: .public)")
            } catch {
                lastError = error.localizedDescription
                Self.log.error("sync failed: \(error.localizedDescription, privacy: .public)")
            }
        } while rerun
    }

    private func loadState() -> [String: SyncedReminder] {
        guard let d = UserDefaults.standard.data(forKey: Self.stateKey) else { return [:] }
        return (try? JSONDecoder().decode([String: SyncedReminder].self, from: d)) ?? [:]
    }

    private func saveState(_ s: [String: SyncedReminder]) {
        if let d = try? JSONEncoder().encode(s) { UserDefaults.standard.set(d, forKey: Self.stateKey) }
    }

    struct FetchTimedOut: LocalizedError { var errorDescription: String? { "Apple Reminders did not answer in 20 seconds; trying again on the next change." } }

    /// Resumes a continuation once, from whichever comes first: the answer or the time limit.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func run(_ f: () -> Void) {
            lock.lock(); defer { lock.unlock() }
            guard !done else { return }
            done = true
            f()
        }
    }

    /// A fetch that gives up after 20 seconds, so one stuck answer can never hold every later sync.
    private func fetch(_ predicate: NSPredicate) async throws -> [EKReminder] {
        let store = self.store
        return try await withCheckedThrowingContinuation { cont in
            let once = Once()
            let request = store.fetchReminders(matching: predicate) { r in
                nonisolated(unsafe) let r = r
                once.run { cont.resume(returning: r ?? []) }
            }
            nonisolated(unsafe) let req = request
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                once.run { store.cancelFetchRequest(req); cont.resume(throwing: FetchTimedOut()) }
            }
        }
    }

    private func syncOnce(_ engine: SyncEngine) async throws -> String {
        let now = Date()
        let lists = store.calendars(for: .reminder)
        let domainForLists = CalendarSelection.workDomain(facts: engine.facts)?.lowercased()
        self.lists = lists.map { ReminderList(title: $0.title, isWork: Self.isWorkSource($0.source, domain: domainForLists)) }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        self.defaultListTitle = store.defaultCalendarForNewReminders()?.title
        let open = try await fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
        let recent = try await fetch(store.predicateForCompletedReminders(withCompletionDateStarting: now.addingTimeInterval(-RemindersMerge.importDoneWithin), ending: nil, calendars: lists))
        var seenIds = Set<String>()
        let reminders = (open + recent).filter { seenIds.insert($0.calendarItemIdentifier).inserted }
        let domain = CalendarSelection.workDomain(facts: engine.facts)?.lowercased()
        let items = reminders.map { Self.item($0, workDomain: domain) }
        itemCount = items.count

        var state = loadState()
        // Finished long ago on both sides and no longer fetched: forget it rather than read it as deleted.
        let fetched = Set(items.map(\.externalId))
        for (k, v) in state where !fetched.contains(k) && v.fields["done"] == "1" { state[k] = nil }

        let tasks = engine.entities.values.filter { $0.kind == .task }
        let workOff = UserDefaults.standard.bool(forKey: CalendarImporter.workOffKey)
        let plan = RemindersMerge.plan(items: items, tasks: Array(tasks), state: state, presentLists: Set(lists.map(\.calendarIdentifier)),
                                       createsInApple: createsInApple, workOff: workOff, now: now)
        var newState = plan.state

        for p in plan.taskPatches { _ = await engine.apply(p) }

        let byLocal = Dictionary(reminders.map { ($0.calendarItemIdentifier, $0) }, uniquingKeysWith: { a, _ in a })
        for w in plan.appleWrites {
            guard let r = byLocal[w.localId] else { continue }
            let taskId = newState.first { $0.value.localId == w.localId }?.value.taskId
            let full = taskId.flatMap { engine.get($0) }.map { RemindersMerge.fields(of: $0) } ?? [:]
            Self.write(w.fields, full: full, to: r)
            try store.save(r, commit: false)
        }
        for id in plan.appleDeletes {
            if let r = byLocal[id] { try store.remove(r, commit: false) }
            if let k = newState.first(where: { $0.value.localId == id })?.key { newState[k] = nil }
        }
        // Lists are matched by name: their ids differ from device to device.
        let writable = lists.filter(\.allowsContentModifications)
        func list(named title: String?, work: Bool) -> EKCalendar? {
            if let title, let l = writable.first(where: { $0.title == title }) { return l }
            return work ? nil : store.defaultCalendarForNewReminders()
        }
        for m in plan.appleMoves {
            guard let r = byLocal[m.localId], let l = list(named: m.listTitle, work: false), l.title == m.listTitle else { continue }
            r.calendar = l
            try store.save(r, commit: false)
        }
        var created: [(EKReminder, String, [String: String])] = []
        for c in plan.appleCreates {
            guard let l = list(named: c.listTitle, work: c.isWork) else { continue }
            let r = EKReminder(eventStore: store)
            r.calendar = l
            Self.write(c.fields, full: c.fields, to: r)
            try store.save(r, commit: false)
            created.append((r, c.taskId, c.fields))
        }
        try store.commit()

        // Link each new Apple item to its task, so every device matches them from now on.
        for (r, taskId, fields) in created {
            let ext = r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier
            let link: JSONValue = .object(["id": .string(ext), "list": .string(r.calendar.calendarIdentifier), "list_title": .string(r.calendar.title)])
            _ = await engine.apply(Patch(id: taskId, kind: .task, ts: ISO.now(), fields: ["apple": link]))
            newState[ext] = SyncedReminder(taskId: taskId, localId: r.calendarItemIdentifier, fields: fields)
        }
        saveState(newState)
        return "\(items.count) in Reminders; \(plan.taskPatches.count) task changes, \(plan.appleWrites.count + created.count + plan.appleDeletes.count) Reminders changes"
    }

    // MARK: EventKit mapping

    /// A work account: Exchange, or an account named after the work email's domain.
    private static func isWorkSource(_ source: EKSource?, domain: String?) -> Bool {
        source?.sourceType == .exchange || (domain.map { !$0.isEmpty && (source?.title.lowercased().contains($0) ?? false) } ?? false)
    }

    private static func item(_ r: EKReminder, workDomain: String?) -> ReminderItem {
        let cal = Calendar.current
        let due: Date? = r.dueDateComponents.flatMap { c in
            var c = c
            if c.calendar == nil { c.calendar = cal }
            if c.hour == nil { c.hour = 0; c.minute = 0 }
            return c.date
        }
        let alarm: Date? = r.alarms?.lazy.compactMap { a in a.absoluteDate ?? due.map { $0.addingTimeInterval(a.relativeOffset) } }.first
        // Apple puts a timed reminder's time in both the due date and its alarm; read that as a reminder with no
        // separate deadline.
        let deadline = due.flatMap { d in alarm.map { abs($0.timeIntervalSince(d)) < 60 } == true ? nil : d }
        let isWork = isWorkSource(r.calendar.source, domain: workDomain)
        return ReminderItem(externalId: r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier, localId: r.calendarItemIdentifier,
                            listId: r.calendar.calendarIdentifier, listTitle: r.calendar.title, isWork: isWork,
                            title: r.title ?? "", notes: r.notes, due: deadline.map { ISO.string($0) }, remindAt: alarm.map { ISO.string($0) },
                            repeatRule: r.recurrenceRules?.first.flatMap(repeatString), done: r.isCompleted,
                            doneAt: r.completionDate.map { ISO.string($0) }, modified: r.lastModifiedDate)
    }

    /// Writes changed fields onto an Apple item. Dates are written from the task's full state (`full`), since
    /// Apple keeps a timed reminder's time in both the due date and the alarm.
    private static func write(_ changed: [String: String], full: [String: String], to r: EKReminder) {
        if let t = changed["title"] { r.title = t.isEmpty ? "Untitled" : t }
        if let n = changed["notes"] { r.notes = n.isEmpty ? nil : n }
        if changed["due"] != nil || changed["remind_at"] != nil || changed["repeat"] != nil {
            let due = ISO.date(full["due"]) ?? ISO.date(full["remind_at"])
            r.dueDateComponents = due.map(components)
            r.alarms?.forEach { r.removeAlarm($0) }
            if let at = ISO.date(full["remind_at"]) { r.addAlarm(EKAlarm(absoluteDate: at)) }
            let rule = (full["repeat"]).flatMap { $0.isEmpty ? nil : recurrence($0) }
            r.recurrenceRules = (rule != nil && due != nil) ? [rule!] : nil
        }
        if let d = changed["done"] { r.isCompleted = d == "1" }
    }

    /// Local midnight means a date with no time.
    private static func components(_ d: Date) -> DateComponents {
        let cal = Calendar.current
        let c = cal.dateComponents([.hour, .minute], from: d)
        let fields: Set<Calendar.Component> = c.hour == 0 && c.minute == 0 ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute]
        var out = cal.dateComponents(fields, from: d)
        out.calendar = cal
        out.timeZone = fields.contains(.hour) ? cal.timeZone : nil
        return out
    }

    private static let weekdays: [(EKWeekday, String)] = [(.sunday, "sun"), (.monday, "mon"), (.tuesday, "tue"), (.wednesday, "wed"), (.thursday, "thu"), (.friday, "fri"), (.saturday, "sat")]

    private static func repeatString(_ rule: EKRecurrenceRule) -> String? {
        let n = max(1, rule.interval)
        switch rule.frequency {
        case .daily: return "every \(n) days"
        case .weekly:
            let days = (rule.daysOfTheWeek ?? []).compactMap { d in weekdays.first { $0.0 == d.dayOfTheWeek }?.1 }
            return days.isEmpty ? "every \(n) weeks" : "every \(n) weeks on \(days.joined(separator: ","))"
        case .monthly:
            if let day = rule.daysOfTheMonth?.first?.intValue, day > 0 { return "every \(n) months on day\(day)" }
            return "every \(n) months"
        case .yearly: return "every \(n) years"
        @unknown default: return nil
        }
    }

    private static func recurrence(_ s: String) -> EKRecurrenceRule? {
        guard let rule = RepeatRule.parse(s) else { return nil }
        switch rule.unit {
        case .days: return EKRecurrenceRule(recurrenceWith: .daily, interval: rule.n, end: nil)
        case .weeks:
            let days = (rule.on ?? []).compactMap { name in weekdays.first { $0.1 == name }.map { EKRecurrenceDayOfWeek($0.0) } }
            return EKRecurrenceRule(recurrenceWith: .weekly, interval: rule.n, daysOfTheWeek: days.isEmpty ? nil : days, daysOfTheMonth: nil,
                                    monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: nil)
        case .months:
            let day = rule.on.flatMap { on -> Int? in
                if let f = on.first, f.hasPrefix("day"), let v = Int(f.dropFirst(3)) { return v }
                return on.count > 1 ? Int(on[1]) : nil
            }
            return EKRecurrenceRule(recurrenceWith: .monthly, interval: rule.n, daysOfTheWeek: nil, daysOfTheMonth: day.map { [NSNumber(value: $0)] },
                                    monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: nil)
        case .years: return EKRecurrenceRule(recurrenceWith: .yearly, interval: rule.n, end: nil)
        case .minutes, .hours: return nil
        }
    }
}
#endif
