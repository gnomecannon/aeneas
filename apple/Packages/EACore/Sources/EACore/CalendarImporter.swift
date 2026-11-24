#if os(iOS) || os(macOS)
import Foundation
import EventKit
#if os(iOS)
import BackgroundTasks
#endif
import os

/// EventKit source: reads only titles, times and the all-day flag of the chosen calendars.
@MainActor
final class EventKitSource: CalendarEventSource {
    let store: EKEventStore
    init(store: EKEventStore) { self.store = store }

    func calendars() -> [CalendarInfo] {
        store.calendars(for: .event).map(\.info).sorted { ($0.sourceTitle, $0.title) < ($1.sourceTitle, $1.title) }
    }

    func occurrences(calendarIds: Set<String>, from: Date, to: Date) -> [CalendarOccurrence] {
        let cals = store.calendars(for: .event).filter { calendarIds.contains($0.calendarIdentifier) }
        guard !cals.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: cals)
        return store.events(matching: predicate).compactMap { ev in
            guard let start = ev.startDate, let end = ev.endDate, ev.status != .canceled else { return nil }
            // Declined meetings are not busy time. Attendees are read here only to check that; they are never stored.
            if ev.attendees?.first(where: { $0.isCurrentUser })?.participantStatus == .declined { return nil }
            // The server's identifier is the same on every device, so the iPhone and the Mac write the same entities.
            // `eventIdentifier` is local to one device and only the fallback.
            let id = ev.calendarItemExternalIdentifier.flatMap { $0.isEmpty ? nil : $0 } ?? ev.eventIdentifier ?? ev.calendarItemIdentifier
            return CalendarOccurrence(eventIdentifier: id, calendarId: ev.calendar.calendarIdentifier, title: ev.title ?? "", start: start, end: end,
                                      allDay: ev.isAllDay, recurring: ev.hasRecurrenceRules, calendarKey: ev.calendar.info.key)
        }
    }
}

extension EKCalendar {
    /// What the app knows of a calendar: its account, whether it is Exchange, and its own color.
    var info: CalendarInfo {
        CalendarInfo(id: calendarIdentifier, title: title, sourceTitle: source?.title ?? "", isExchange: source?.sourceType == .exchange,
                     color: Self.hex(cgColor), kind: SourceKey.kind(sourceType: source.map { $0.sourceType.rawValue } ?? -1, accountTitle: source?.title ?? ""))
    }

    /// A calendar color as `#RRGGBB` in sRGB, as the hub keeps it.
    static func hex(_ color: CGColor?) -> String? {
        guard let color, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let c = color.converted(to: srgb, intent: .defaultIntent, options: nil)?.components, c.count >= 3 else { return nil }
        return FeelTheme.hex(r: Double(c[0]), g: Double(c[1]), b: Double(c[2]))
    }
}

/// Tells the hub which Apple Calendar calendars this device brings events from, with their colors
/// (`PUT /prefs/feel/calendars`), so Theme, Calendar colors lists them and every device draws their events in them.
/// The work import and the personal calendar copy each say what they read; the hub hears them together when one is
/// new or changed, else at most once a day.
@MainActor
public final class CalendarColorReporter {
    public static let shared = CalendarColorReporter()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "calendar")
    static let stateKey = "ea.calendarColorReport"

    /// The whole feel setting the hub answers with, for the app to take the calendars from.
    public var onFeel: ((FeelSettings) -> Void)?

    private var plan: CalendarReportPlan {
        get { UserDefaults.standard.data(forKey: Self.stateKey).flatMap { try? JSONDecoder().decode(CalendarReportPlan.self, from: $0) } ?? CalendarReportPlan() }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.stateKey) }
    }

    /// `part` names who found them (`work`, `personal`). Sent only while the hub answers.
    public func found(_ calendars: [CalendarInfo], part: String, engine: SyncEngine) async {
        var p = plan
        let send = p.found(calendars.compactMap(\.report), part: part)
        plan = p
        guard let send, let c = engine.client, engine.hubInReach else { return }
        do {
            let feel = try await c.reportCalendars(send)
            var done = plan
            done.didSend(send)
            plan = done
            onFeel?(feel)
        } catch {
            // A hub from before calendar colors answers 404: it is asked again a day later, not on every run.
            if case HubError.http(404, _) = error {
                var done = plan
                done.didSend(send)
                plan = done
            }
            Self.log.notice("calendar colors not reported: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Imports the calendars the user marks as work into `event` entities in the `work` space.
/// Runs on launch, on foreground, on `EKEventStoreChanged` (debounced 5 s) and in a
/// `BGAppRefreshTask` on iOS, or an hourly timer on the Mac. Patches go through the normal SyncEngine outbox.
/// Which calendars are work is one choice for every device, kept by the hub (the sources setting): each device
/// imports the chosen calendars it has. The first time, a device adds the calendars it had ticked itself to that
/// choice, once; until then, and with a hub from before 1.0.18, its own ticks are used as before.
@MainActor
public final class CalendarImporter: ObservableObject {
    public static let shared = CalendarImporter()
    /// `$(PRODUCT_BUNDLE_IDENTIFIER).calendar`, the id the app's Info.plist permits (BGTaskSchedulerPermittedIdentifiers).
    public static let backgroundTaskId = (Bundle.main.bundleIdentifier ?? "com.gnomecannon.everythingapp") + ".calendar"
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "calendar")

    public enum Access: Equatable, Sendable { case notDetermined, full, writeOnly, denied, restricted }

    @Published public private(set) var access: Access = .notDetermined
    @Published public private(set) var calendars: [CalendarInfo] = []
    @Published public private(set) var lastResult: CalendarImportRunner.Result?
    @Published public private(set) var running = false
    @Published public private(set) var lastError: String?

    /// Supplies a started engine; set by the app. Used by triggers that fire outside a view.
    public var engineProvider: (() async -> SyncEngine)?

    private let store = EKEventStore()
    private lazy var source = EventKitSource(store: store)
    private var observer: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var rerun = false

    /// The sources setting as the engine last took it.
    @Published public private(set) var setting: SourcesSetting?
    private var sourcesObserver: NSObjectProtocol?

    public init() {
        setting = SharedConfig.shared.sources
        refreshAccess()
        // The engine keeps the setting in the app group before it says it changed.
        sourcesObserver = NotificationCenter.default.addObserver(forName: SyncEngine.sourcesDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.sourcesChanged(SharedConfig.shared.sources) }
        }
    }

    public var config: SharedConfig { .shared }

    /// This device's own ticks were added to the hub-wide choice (once).
    public var ticksMoved: Bool { UserDefaults.standard.bool(forKey: AppleLinkRecords.workTicksMoved) }
    /// The work calendars are the hub-wide choice: the hub has the setting, and this device's own ticks are in it.
    public var usesHubChoice: Bool { setting != nil && ticksMoved }
    public var selected: Set<String> {
        if usesHubChoice, let s = setting { return s.workCalendarIds(calendars) }
        return config.workCalendarIds ?? []
    }
    public var hasChosen: Bool { usesHubChoice || config.workCalendarIds != nil }

    private func sourcesChanged(_ s: SourcesSetting?) {
        let before = selected
        setting = s
        // A calendar ticked or unticked on another device: imported or removed here too.
        if selected != before, access == .full, moduleOn { Task { await runNow(reason: "work calendars changed") } }
    }

    public func refreshAccess() {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: access = .full
        case .writeOnly: access = .writeOnly
        case .denied: access = .denied
        case .restricted: access = .restricted
        // A grant from this launch counts even while the system still says "not determined".
        default: if access != .full { access = .notDetermined }
        }
        if access == .full { calendars = source.calendars() }
    }

    /// Ask for full access, then preselect work calendars on first run and import.
    public func requestAccess(facts: [Entity]) async {
        var granted = false
        do {
            granted = try await store.requestFullAccessToEvents()
        } catch {
            lastError = error.localizedDescription
        }
        refreshAccess()
        // Right after the prompt iOS can still report "not determined"; the prompt's own answer is the truth.
        if granted { access = .full; calendars = source.calendars() }
        guard access == .full else { return }
        if !hasChosen {
            config.workCalendarIds = CalendarSelection.preselect(calendars, workDomain: CalendarSelection.workDomain(facts: facts))
        }
        startObserving()
        await runNow(reason: "access granted")
    }

    public func setSelected(_ id: String, _ on: Bool) {
        if usesHubChoice, let c = calendars.first(where: { $0.id == id }) {
            Task { await setWork(key: c.sourceKey, on) }
            return
        }
        var s = selected
        if on { s.insert(id) } else { s.remove(id) }
        config.workCalendarIds = s
        Task { await runNow(reason: "selection changed") }
    }

    /// A calendar marked as work or not, for every device. Shown at once; the hub's answer is the setting.
    public func setWork(key: String, _ on: Bool) async {
        guard let engine = await engineProvider?(), var s = setting else { return }
        lastError = nil
        if let i = s.calendars.firstIndex(where: { $0.key == key }) {
            s.calendars[i].work = on
            setting = s
        }
        do {
            // A calendar the hub has not heard of yet (this device's list was not sent) is sent first.
            if engine.sources?.calendar(key) == nil { await reportCalendars(engine, force: true) }
            try await engine.changeSources(["calendars": .array([.object(["key": .string(key), "work": .bool(on)])])])
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            setting = engine.sources
        }
        await runNow(reason: "selection changed")
    }

    /// Tells the hub which calendars this device has when that changed (or once a day), with the key a renamed one had;
    /// the first time, also the calendars this device had ticked as work itself, which join the hub-wide choice once.
    func reportCalendars(_ engine: SyncEngine, force: Bool = false) async {
        guard engine.sources != nil, engine.hubInReach, access == .full else { return }
        let key = AppleLinkRecords.sourcesCalendars
        var memory = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(SourcesReportMemory.self, from: $0) } ?? SourcesReportMemory()
        let all = source.calendars()
        let seen = all.map { c in
            SeenCalendar(key: c.sourceKey, title: c.title, account: c.sourceTitle, kind: c.kind, color: c.color, was: memory.was(id: c.id, key: c.sourceKey))
        }.sorted { $0.key < $1.key }
        let ticked = ticksMoved ? nil : WorkCalendarMove.ticked(chosen: config.workCalendarIds, calendars: all, workDomain: CalendarSelection.workDomain(facts: engine.facts))
        let print = (try? JSONCoding.string(seen)) ?? ""
        guard force || ticked != nil || memory.due(print) else { return }
        do {
            try await engine.reportSources(SourcesReport(calendars: Array(seen.prefix(200)), ticked: ticked.map { Array($0.prefix(200)) }))
        } catch {
            Self.log.notice("calendars not reported: \(error.localizedDescription, privacy: .public)")
            return
        }
        if ticked != nil { UserDefaults.standard.set(true, forKey: AppleLinkRecords.workTicksMoved) }
        memory.keys = Dictionary(all.map { ($0.id, $0.sourceKey) }, uniquingKeysWith: { a, _ in a })
        memory.print = print
        memory.at = Date()
        if let d = try? JSONEncoder().encode(memory) { UserDefaults.standard.set(d, forKey: key) }
        setting = engine.sources
    }

    /// Watch the Calendar store; changes are imported 5 s after the last one.
    public func startObserving() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.storeChanged() }
        }
    }

    private func storeChanged() {
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if Task.isCancelled { return }
            self?.refreshAccess()
            await self?.runNow(reason: "calendar changed")
        }
    }

    /// The Apple Calendar module (Settings, Modules) is on, and this device's own switch (Settings, Accounts, From this
    /// iPhone, Calendars). Off, no calendar is read and nothing is imported.
    public var moduleOn: Bool { config.appleCalendarOn }

    /// Launch path: preselect work calendars if access exists but nothing was ever chosen, then import. Access is
    /// never asked for here (release rule 2); the permission screen after setup or a module switched on asks, and so
    /// does this device's Calendars switch in Settings, Accounts.
    public func autoStart(facts: [Entity]) async {
        refreshAccess()
        guard moduleOn else { return }
        switch access {
        case .full where !hasChosen:
            config.workCalendarIds = CalendarSelection.preselect(calendars, workDomain: CalendarSelection.workDomain(facts: facts))
            startObserving()
            await runNow(reason: "first run")
        default:
            await runIfReady(reason: "launch")
        }
    }

    /// Import if access is granted and the user has chosen (launch and foreground path).
    public func runIfReady(reason: String) async {
        refreshAccess()
        guard access == .full, hasChosen, moduleOn else { return }
        startObserving()
        await runNow(reason: reason)
    }

    static let workOffKey = "ea.workSpaceOff"

    public func runNow(reason: String) async {
        guard access == .full, moduleOn, let provider = engineProvider else { return }
        if running { rerun = true; return }
        running = true
        defer { running = false }
        repeat {
            rerun = false
            let engine = await provider()
            // Only against a copy that holds the hub's events: on an emptied one (a removal, another hub) the app's own
            // events in a work calendar were taken for meetings and imported a second time.
            guard engine.hasHubCopy else { break }
            // The work space can be turned off (and erased) from any device; the last answer is kept for offline runs.
            if let c = engine.client, let s = try? await c.workSpace() { UserDefaults.standard.set(!s.enabled, forKey: Self.workOffKey) }
            if UserDefaults.standard.bool(forKey: Self.workOffKey) {
                lastError = "The work space is turned off in Settings, so the work calendar is not imported."
                return
            }
            // The hub-wide choice of work calendars: what this device has is told first (and its own ticks, once).
            await reportCalendars(engine)
            let result = await CalendarImportRunner(engine: engine, source: source).run(selected: selected)
            await CalendarColorReporter.shared.found(source.calendars().filter { selected.contains($0.id) }, part: "work", engine: engine)
            lastResult = result
            config.lastCalendarImport = result.at
            config.lastCalendarImportCount = result.live
            lastError = nil
            Self.log.notice("import (\(reason, privacy: .public)): +\(result.inserted) ~\(result.updated) -\(result.deleted) live=\(result.live)")
        } while rerun
        scheduleBackgroundRefresh()
    }

    // MARK: background refresh

    #if os(macOS)
    private var hourly: Timer?

    /// The Mac app keeps running in the menu bar, so an hourly timer stands in for iOS background refresh.
    public func scheduleBackgroundRefresh() {
        guard hourly == nil else { return }
        hourly = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in
            Task { @MainActor in await CalendarImporter.shared.runIfReady(reason: "hourly") }
        }
    }
    #else
    /// Call from `application(_:didFinishLaunchingWithOptions:)`.
    public func registerBackgroundTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.backgroundTaskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            let work = Task { @MainActor in
                let importer = CalendarImporter.shared
                // The hub's changes first: the copies used to run before this device had pulled, so an event made in
                // the app was not here yet and the Mac's copy of it in Apple Calendar came in as a second event.
                if let engine = await importer.engineProvider?() {
                    await engine.refreshing {
                        await importer.runIfReady(reason: "background")
                        await RemindersSync.shared.runIfReady(reason: "background")
                        await EventMirrorSync.shared.runIfReady(reason: "background")
                    }
                }
                refresh.setTaskCompleted(success: true)
            }
            refresh.expirationHandler = { work.cancel() }
            Task { @MainActor in CalendarImporter.shared.scheduleBackgroundRefresh() }
        }
    }

    public func scheduleBackgroundRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: Self.backgroundTaskId)
        req.earliestBeginDate = Date().addingTimeInterval(3600)
        do { try BGTaskScheduler.shared.submit(req) } catch {
            Self.log.notice("background refresh not scheduled: \(error.localizedDescription, privacy: .public)")
        }
    }
    #endif
}
#endif
