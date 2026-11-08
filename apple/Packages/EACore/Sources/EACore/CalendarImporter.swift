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
        store.calendars(for: .event).map {
            CalendarInfo(id: $0.calendarIdentifier, title: $0.title, sourceTitle: $0.source?.title ?? "", isExchange: $0.source?.sourceType == .exchange)
        }.sorted { ($0.sourceTitle, $0.title) < ($1.sourceTitle, $1.title) }
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
                                      allDay: ev.isAllDay, recurring: ev.hasRecurrenceRules)
        }
    }
}

/// Imports the calendars the user marks as work into `event` entities in the `work` space.
/// Runs on launch, on foreground, on `EKEventStoreChanged` (debounced 5 s) and in a
/// `BGAppRefreshTask` on iOS, or an hourly timer on the Mac. Patches go through the normal SyncEngine outbox.
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

    public init() { refreshAccess() }

    public var config: SharedConfig { .shared }
    public var selected: Set<String> { config.workCalendarIds ?? [] }
    public var hasChosen: Bool { config.workCalendarIds != nil }

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
        var s = selected
        if on { s.insert(id) } else { s.remove(id) }
        config.workCalendarIds = s
        Task { await runNow(reason: "selection changed") }
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

    /// The Apple Calendar module (Settings, Modules) is on. Off, no calendar is read and nothing is imported.
    public var moduleOn: Bool { config.moduleSaidOn(.appleCalendar) }

    /// Launch path: preselect work calendars if access exists but nothing was ever chosen, then import. Access is
    /// never asked for here (release rule 2); the permission screen after setup or a module switched on asks, and so
    /// does Allow calendar access in Settings, Calendar and work.
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
            // The work space can be turned off (and erased) from any device; the last answer is kept for offline runs.
            if let c = engine.client, let s = try? await c.workSpace() { UserDefaults.standard.set(!s.enabled, forKey: Self.workOffKey) }
            if UserDefaults.standard.bool(forKey: Self.workOffKey) {
                lastError = "The work space is turned off in Settings, so the work calendar is not imported."
                return
            }
            let result = await CalendarImportRunner(engine: engine, source: source).run(selected: selected)
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
                await importer.runIfReady(reason: "background")
                await RemindersSync.shared.runIfReady(reason: "background")
                await EventMirrorSync.shared.runIfReady(reason: "background")
                if let engine = await importer.engineProvider?() { await engine.sync() }
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
