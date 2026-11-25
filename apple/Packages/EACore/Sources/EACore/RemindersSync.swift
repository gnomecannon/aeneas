#if os(iOS) || os(macOS)
import Foundation
import EventKit
import os

/// Keeps tasks and Apple Reminders the same, both ways, on the iPhone and the Mac. Which lists sync, and in which space,
/// is the sources setting (Sources.swift), one choice for every device: a list that is off is neither read nor
/// written and its tasks are hidden; by default lists from a work account (Exchange, or the work email's domain) go
/// into the work space. New tasks made in the app are added to the list chosen for them (else the default list) by the
/// iPhone only, so the two devices never add the same one twice.
/// The merge rules are in `RemindersMerge`; this class reads and writes EventKit and runs it.
@MainActor
public final class RemindersSync: ObservableObject {
    public static let shared = RemindersSync()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "reminders")
    private static let stateKey = AppleLinkRecords.reminders
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
    /// Only one device adds Apple items for tasks made in the app: the iPhone, never an iPad (AppleItems).
    public var createsInApple: Bool = AppleItems.addsReminders(on: AppleItems.thisDevice)

    /// Replaced once access is granted: a store made before that never answers its first fetch.
    private var store = EKEventStore()
    private var observer: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var rerun = false
    #if os(macOS)
    private var hourly: Timer?
    #endif

    private var sourcesObserver: NSObjectProtocol?
    private var alarmsObserver: NSObjectProtocol?
    /// The list choices the last run went by, so a change made on another device starts a run here.
    private var listPrint = RemindersSync.print(SharedConfig.shared.sources)

    public init() {
        refreshAccess()
        sourcesObserver = NotificationCenter.default.addObserver(forName: SyncEngine.sourcesDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let p = Self.print(SharedConfig.shared.sources)
                guard p != self.listPrint else { return }
                self.listPrint = p
                // A list switched on starts syncing, one switched off stops, and new tasks go where they now should.
                self.scheduleRun(after: 1)
            }
        }
        // Alert from Apple Reminders switched (Settings, Notifications, on any device): alarms come off or come back.
        alarmsObserver = NotificationCenter.default.addObserver(forName: SyncEngine.reminderAlarmsDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.scheduleRun(after: 1) }
        }
    }

    /// What of the setting a run depends on: each list's key, switch and space, and the list for new tasks.
    private static func print(_ s: SourcesSetting?) -> String {
        guard let s else { return "" }
        return s.lists.map { "\($0.key)|\($0.on)|\($0.space.rawValue)" }.sorted().joined(separator: "\n") + "\n" + (s.new_tasks ?? "")
    }

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
            // Only against a copy that holds the hub's tasks: an unpaired or removed device, or one whose copy was
            // emptied (another hub) and not filled again yet, reads as having no tasks, so every Apple item came in
            // again as a new one and the records of what was agreed were dropped.
            guard engine.hasHubCopy else {
                Self.log.notice("not run (\(reason, privacy: .public)): this device does not hold the hub's tasks yet")
                break
            }
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
        // The tasks first, then the setting: the hub saves a choice before it moves a list's tasks, so a setting read
        // after them is at least as new as they are. Not read from the hub (it could not be reached), the choices kept
        // here are used, but nothing is deleted for a move to Work and no list waits on a Personal or Work choice.
        let tasks = Array(engine.entities.values.filter { $0.kind == .task })
        // Offline the copy kept is used at once, with no wait for a hub that cannot answer.
        let read = engine.hubInReach ? await engine.refreshSources() : false
        let lists = store.calendars(for: .reminder)
        let domain = CalendarSelection.workDomain(facts: engine.facts)?.lowercased()
        let reported = read ? await reportLists(lists, tasks: tasks, domain: domain, engine: engine) : false
        let fresh = read || reported
        let setting = engine.sources
        let shows = TaskVisibility(setting)
        let linked = Self.linkedLists(tasks)
        var choices: [String: (key: String, choice: ReminderListChoice, own: Space)] = [:]
        for l in lists {
            let key = Self.key(l)
            let own: Space = Self.isWorkSource(l.source, domain: domain) ? .work : .personal
            let choice = SourcesSetting.choice(setting, key: key, kind: Self.kind(l), accountWork: own == .work, hasTasks: linked.keys.contains(key) || linked.titles.contains(l.title))
            choices[l.calendarIdentifier] = (key, choice, own)
        }
        func synced(_ l: EKCalendar) -> Bool {
            guard let c = choices[l.calendarIdentifier] else { return true }
            return c.choice.on && (fresh || c.choice.space == c.own)
        }
        // The Tasks screen offers only the lists that are on, each in its space.
        self.lists = lists.filter { choices[$0.calendarIdentifier]?.choice.on ?? true }
            .map { ReminderList(title: $0.title, isWork: (choices[$0.calendarIdentifier]?.choice.space ?? .personal) == .work) }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        self.defaultListTitle = store.defaultCalendarForNewReminders()?.title
        let open = try await fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
        let recent = try await fetch(store.predicateForCompletedReminders(withCompletionDateStarting: now.addingTimeInterval(-RemindersMerge.importDoneWithin), ending: nil, calendars: lists))
        var seenIds = Set<String>()
        let reminders = (open + recent).filter { seenIds.insert($0.calendarItemIdentifier).inserted }
        // A hub without the setting keeps no list keys (it drops them), so none is written to it: every run would again.
        let items = reminders.map { r in
            let c = choices[r.calendar.calendarIdentifier]
            return Self.item(r, listKey: setting == nil ? "" : c?.key ?? Self.key(r.calendar), listOn: synced(r.calendar), isWork: (c?.choice.space ?? .personal) == .work)
        }
        itemCount = items.count

        var state = loadState()
        // Finished long ago on both sides and no longer fetched: forget it rather than read it as deleted.
        let fetched = Set(items.map(\.externalId))
        for (k, v) in state where !fetched.contains(k) && v.fields["done"] == "1" { state[k] = nil }

        let workOff = UserDefaults.standard.bool(forKey: CalendarImporter.workOffKey)
        let writableLists = lists.filter(\.allowsContentModifications)
        // New tasks go to the list chosen for them when this device has it and it is on, else the default list.
        let newTasks = setting?.new_tasks.flatMap { key in writableLists.first { choices[$0.calendarIdentifier]?.key == key && synced($0) } }
        let defaultOn = store.defaultCalendarForNewReminders().map(synced) ?? false
        // Alert from Apple Reminders (Settings, Notifications), once every iPhone, iPad and Mac can read items without one.
        let alarms = engine.config.writesReminderAlarms
        let plan = RemindersMerge.plan(items: items, tasks: tasks, state: state, presentLists: Set(lists.map(\.calendarIdentifier)),
                                       createsInApple: createsInApple, workOff: workOff,
                                       writableLists: Set(writableLists.map(\.title)), shows: { shows.shows($0) },
                                       newTasksList: newTasks?.title, defaultListOn: defaultOn, moveDeletes: fresh, alarms: alarms, now: now)
        var newState = plan.state

        for p in plan.taskPatches { _ = await engine.apply(p) }

        let byLocal = Dictionary(reminders.map { ($0.calendarItemIdentifier, $0) }, uniquingKeysWith: { a, _ in a })
        for w in plan.appleWrites {
            guard let r = byLocal[w.localId] else { continue }
            let taskId = newState.first { $0.value.localId == w.localId }?.value.taskId
            let full = taskId.flatMap { engine.get($0) }.map { RemindersMerge.fields(of: $0) } ?? [:]
            guard Self.write(w.fields, full: full, alarms: w.alarms, to: r) else { continue }
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
            // Never into a list that is off: its tasks are hidden.
            guard let l = list(named: c.listTitle, work: c.isWork), synced(l) else { continue }
            let r = EKReminder(eventStore: store)
            r.calendar = l
            Self.write(c.fields, full: c.fields, alarms: alarms ? .move : .none, to: r)
            try store.save(r, commit: false)
            created.append((r, c.taskId, c.fields))
        }
        try store.commit()

        // Link each new Apple item to its task, so every device matches them from now on.
        for (r, taskId, fields) in created {
            let ext = r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier
            var o: [String: JSONValue] = ["id": .string(ext), "list": .string(r.calendar.calendarIdentifier), "list_title": .string(r.calendar.title)]
            if setting != nil { o["list_key"] = .string(choices[r.calendar.calendarIdentifier]?.key ?? Self.key(r.calendar)) }
            let link: JSONValue = .object(o)
            _ = await engine.apply(Patch(id: taskId, kind: .task, ts: ISO.now(), fields: ["apple": link]))
            var agreed = fields
            agreed[RemindersMerge.listKey] = r.calendar.title
            if !alarms { agreed[RemindersMerge.alarmsKey] = "off" }
            newState[ext] = SyncedReminder(taskId: taskId, localId: r.calendarItemIdentifier, fields: agreed)
        }
        saveState(newState)
        return "\(items.count) in Reminders; \(plan.taskPatches.count) task changes, \(plan.appleWrites.count + created.count + plan.appleDeletes.count) Reminders changes"
    }

    // MARK: the sources setting

    /// The lists' keys and names the tasks here are linked to, so a list with tasks starts on.
    private static func linkedLists(_ tasks: [Entity]) -> (keys: Set<String>, titles: Set<String>) {
        var keys = Set<String>(), titles = Set<String>()
        for t in tasks where !t.isDeleted {
            guard let a = t.fields["apple"]?.objectValue, !(a["id"]?.stringValue ?? "").isEmpty else { continue }
            if let k = a["list_key"]?.stringValue, !k.isEmpty { keys.insert(k) }
            if let n = a["list_title"]?.stringValue, !n.isEmpty { titles.insert(n) }
        }
        return (keys, titles)
    }

    private static func kind(_ l: EKCalendar) -> String { SourceKey.kind(sourceType: l.source.map { $0.sourceType.rawValue } ?? -1, accountTitle: l.source?.title ?? "") }
    private static func key(_ l: EKCalendar) -> String { SourceKey.make(kind: kind(l), account: l.source?.title ?? "", title: l.title) }

    /// Tells the hub which lists this device sees when that changed (or once a day), with the key a renamed one had,
    /// so its choices go with it. True when the hub answered.
    private func reportLists(_ lists: [EKCalendar], tasks: [Entity], domain: String?, engine: SyncEngine) async -> Bool {
        // Only to a hub that has the setting (one from before 1.0.18 answers 404, and nothing was read when unreachable).
        guard engine.sources != nil else { return false }
        var memory = UserDefaults.standard.data(forKey: AppleLinkRecords.sourcesLists).flatMap { try? JSONDecoder().decode(SourcesReportMemory.self, from: $0) } ?? SourcesReportMemory()
        let linked = Self.linkedLists(tasks)
        let seen = lists.map { l -> SeenList in
            let key = Self.key(l)
            return SeenList(key: key, title: l.title, account: l.source?.title ?? "", kind: Self.kind(l), work: Self.isWorkSource(l.source, domain: domain),
                            has_tasks: linked.keys.contains(key) || linked.titles.contains(l.title), was: memory.was(id: l.calendarIdentifier, key: key))
        }.sorted { $0.key < $1.key }
        let print = (try? JSONCoding.string(seen)) ?? ""
        guard memory.due(print) else { return false }
        do {
            try await engine.reportSources(SourcesReport(lists: Array(seen.prefix(200))))
        } catch {
            Self.log.notice("lists not reported: \(error.localizedDescription, privacy: .public)")
            return false
        }
        memory.keys = Dictionary(lists.map { ($0.calendarIdentifier, Self.key($0)) }, uniquingKeysWith: { a, _ in a })
        memory.print = print
        memory.at = Date()
        if let d = try? JSONEncoder().encode(memory) { UserDefaults.standard.set(d, forKey: AppleLinkRecords.sourcesLists) }
        return true
    }

    // MARK: EventKit mapping

    /// A work account: Exchange, or an account named after the work email's domain.
    private static func isWorkSource(_ source: EKSource?, domain: String?) -> Bool {
        source?.sourceType == .exchange || (domain.map { !$0.isEmpty && (source?.title.lowercased().contains($0) ?? false) } ?? false)
    }

    private static func item(_ r: EKReminder, listKey: String, listOn: Bool, isWork: Bool) -> ReminderItem {
        // A due date with no time reads as the day alone, the same in every time zone (ReminderDates).
        let alarms = (r.alarms ?? []).map(alarm)
        let dates = ReminderDates.read(due: r.dueDateComponents, alarms: alarms)
        return ReminderItem(externalId: r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier, localId: r.calendarItemIdentifier,
                            listId: r.calendar.calendarIdentifier, listTitle: r.calendar.title, listKey: listKey, listOn: listOn, isWork: isWork,
                            title: r.title ?? "", notes: r.notes, due: dates.due, remindAt: dates.remindAt,
                            repeatRule: r.recurrenceRules?.first.flatMap(repeatString), done: r.isCompleted,
                            doneAt: r.completionDate.map { ISO.string($0) }, modified: r.lastModifiedDate,
                            timedAlarm: alarms.contains { !$0.place }, dueAlone: ReminderDates.read(due: r.dueDateComponents, alarms: []).due ?? "")
    }

    private static func alarm(_ a: EKAlarm) -> ReminderAlarm {
        ReminderAlarm(absolute: a.absoluteDate, offset: a.relativeOffset, place: a.structuredLocation != nil || a.proximity != EKAlarmProximity.none)
    }

    /// Writes changed fields onto an Apple item. Dates are written from the task's full state (`full`), since
    /// Apple keeps a timed reminder's time in both the due date and the alarm. When only the dates moved, Apple's
    /// repeat rule and alarms stay and move with them (ReminderDates.write); the rule is made again from the app's
    /// repeat only when the repeat itself changed. `alarms` other than `move` (Alert from Apple Reminders): the alarms
    /// with a time go, or one comes back at the reminder time, even when no date changed; the due date then stays as
    /// it is. False when nothing about the item changed, so there is nothing to save.
    @discardableResult
    private static func write(_ changed: [String: String], full: [String: String], alarms mode: ReminderDates.TimedAlarms, to r: EKReminder) -> Bool {
        var wrote = false
        if let t = changed["title"] { r.title = t.isEmpty ? "Untitled" : t; wrote = true }
        if let n = changed["notes"] { r.notes = n.isEmpty ? nil : n; wrote = true }
        let current = r.alarms ?? []
        func eventKit(_ writes: [ReminderDates.AlarmWrite]) -> [EKAlarm] {
            writes.compactMap { a -> EKAlarm? in
                guard let i = a.from, i < current.count else { return a.at.map { EKAlarm(absoluteDate: $0) } }
                guard let at = a.at else { return current[i] }
                // A copy keeps the sound and anything else set on it; only its time moves.
                let moved = (current[i].copy() as? EKAlarm) ?? EKAlarm(absoluteDate: at)
                moved.absoluteDate = at
                return moved
            }
        }
        if changed["due"] != nil || changed["remind_at"] != nil || changed["repeat"] != nil {
            let w = ReminderDates.write(full: full, repeatChanged: changed["repeat"] != nil, due: r.dueDateComponents, alarms: current.map(alarm), timed: mode)
            r.dueDateComponents = w.due
            r.alarms = eventKit(w.alarms)
            if !w.keepsRepeat {
                let rule = (full["repeat"]).flatMap { $0.isEmpty ? nil : recurrence($0) }
                r.recurrenceRules = (rule != nil && w.due != nil) ? [rule!] : nil
            }
            wrote = true
        } else if mode != .move {
            // Only the alarms: taken off (nothing to do when none has a time), or one put back.
            let mapped = current.map(alarm)
            if mode == .remake || mapped.contains(where: { !$0.place }) {
                r.alarms = eventKit(ReminderDates.alarms(mode, at: ISO.date(full["remind_at"]), alarms: mapped))
                wrote = true
            }
        }
        if let d = changed["done"] { r.isCompleted = d == "1"; wrote = true }
        return wrote
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
