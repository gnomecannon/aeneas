#if os(iOS) || os(macOS)
import Foundation
import EventKit
import os

/// Copies events made in EverythingApp into Apple Calendar and brings back edits and deletions made there. Personal
/// events go to the calendar memory names under `calendar:personal` (else the default calendar), work events to the one
/// under `calendar:work` (else they are not copied). The Mac adds new events at once (it runs all day); the iPhone adds an event only
/// after two minutes untouched, so the Mac's copy, if there is one, is found instead of making a second.
/// Single events made in that personal calendar come into the app linked the same way; its repeating events come in
/// as imported occurrences (`source: eventkit`, never written back).
/// The rules are in `EventMirror`; this class reads and writes EventKit. It needs full Calendar access, the same
/// permission the work calendar import asks for.
@MainActor
public final class EventMirrorSync: ObservableObject {
    public static let shared = EventMirrorSync()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "calendar-mirror")
    private static let stateKey = "ea.eventMirror.state"

    @Published public private(set) var lastRun: Date?
    @Published public private(set) var lastSummary: String?
    @Published public private(set) var lastError: String?

    public var engineProvider: (() async -> SyncEngine)?
    private var store = EKEventStore()
    private var observer: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var running = false
    private var rerun = false

    public init() {}

    /// Full Calendar access, and the Apple Calendar module (Settings, Modules) on: off, nothing is copied either way.
    private var hasAccess: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess && SharedConfig.shared.moduleSaidOn(.appleCalendar) }

    private var state: [String: SyncedEvent] {
        get { (UserDefaults.standard.data(forKey: Self.stateKey)).flatMap { try? JSONDecoder().decode([String: SyncedEvent].self, from: $0) } ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.stateKey) }
    }

    /// A store made before access was granted never answers its first fetch; it is replaced once, the first time
    /// a run finds access.
    private var storeReady = false

    public func runIfReady(reason: String) async {
        guard hasAccess else { return }
        if !storeReady {
            storeReady = true
            if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
            store = EKEventStore()
        }
        startObserving()
        await runNow(reason: reason)
    }

    /// An event changed in the app or synced from another device: copy it over a few seconds later.
    public func scheduleRun(after seconds: Double = 3) {
        guard hasAccess, storeReady else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.runNow(reason: "change")
        }
    }

    private func startObserving() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.scheduleRun(after: 5) }
        }
    }

    public func runNow(reason: String) async {
        guard hasAccess, let provider = engineProvider else { return }
        if running { rerun = true; return }
        running = true
        defer { running = false }
        repeat {
            rerun = false
            let engine = await provider()
            await runOnce(engine: engine, reason: reason)
        } while rerun
    }

    private func runOnce(engine: SyncEngine, reason: String) async {
        // Deleted events are not in the engine's lists; the local store keeps them, and a deletion has to reach
        // Apple Calendar too.
        let deleted = ((try? await engine.store.all(kind: .event, includeDeleted: true)) ?? []).filter { $0.isDeleted }
        var seen = Set<String>()
        // With the work space turned off, work items are being erased; nothing is copied for them.
        let workOff = UserDefaults.standard.bool(forKey: CalendarImporter.workOffKey)
        let all = (engine.list(.event) + deleted).filter { seen.insert($0.id).inserted && EventMirror.mirrors($0) && !(workOff && $0.space == .work) }
        // Look up only the Apple events the app already knows about.
        var apple: [String: AppleEvent] = [:]
        var ekById: [String: EKEvent] = [:]
        for e in all {
            guard let aid = EventMirror.appleId(e) else { continue }
            if let ev = (store.calendarItems(withExternalIdentifier: aid) as? [EKEvent])?.first ?? store.calendarItem(withIdentifier: aid) as? EKEvent {
                apple[aid] = Self.appleEvent(ev, externalId: aid)
                ekById[ev.calendarItemIdentifier] = ev
            }
        }
        let now = Date()
        #if os(macOS)
        let creates: (Entity) -> Bool = { _ in true }
        #else
        // Untouched for two minutes: the Mac, when there is one, has had its turn.
        let creates: (Entity) -> Bool = { e in (ISO.date(e.updated_at) ?? now) < now.addingTimeInterval(-120) }
        #endif
        let cals = store.calendars(for: .event)
        let infos = cals.map { CalendarInfo(id: $0.calendarIdentifier, title: $0.title, sourceTitle: $0.source?.title ?? "", isExchange: $0.source?.sourceType == .exchange) }
        let writable = Set(cals.filter { $0.allowsContentModifications && $0.type != .birthday && $0.type != .subscription }.map(\.calendarIdentifier))
        let work = SharedConfig.shared.workCalendarIds ?? []
        let personalCal = EventMirror.calendar(for: .personal, facts: engine.facts, calendars: infos, writable: writable, defaultId: store.defaultCalendarForNewEvents?.calendarIdentifier, work: work)
        let workCal = EventMirror.calendar(for: .work, facts: engine.facts, calendars: infos, writable: writable, defaultId: nil, work: work)
        // Moves only go to a calendar the owner chose: with each device's own default, two devices move an event
        // back and forth for good.
        let personalChosen = EventMirror.named(.personal, facts: engine.facts) != nil
        let plan = EventMirror.plan(events: all, apple: apple, state: state, now: now, target: { $0.space == .work ? workCal : personalCal },
                                    present: Set(cals.map(\.calendarIdentifier)),
                                    moveTarget: { $0.space == .work ? workCal : (personalChosen ? personalCal : nil) }, creates: creates)
        var newState = state
        for (k, v) in plan.state { newState[k] = v }
        var made = 0, written = 0, removed = 0, moved = 0
        lastError = nil
        // A write or delete that fails keeps the record from before it, so the next run tries it again instead of
        // taking Apple's old values as agreed.
        var failed = Set<String>()
        var notRemoved = Set<String>()
        for w in plan.writes {
            guard let ev = ekById[w.localId] ?? store.calendarItem(withIdentifier: w.localId) as? EKEvent else { failed.insert(w.entityId); continue }
            Self.apply(w.fields, to: ev)
            do { try store.save(ev, span: .thisEvent, commit: false); written += 1 }
            catch { failed.insert(w.entityId); note(error) }
        }
        for localId in plan.appleDeletes {
            guard let ev = store.calendarItem(withIdentifier: localId) as? EKEvent else { continue }
            do { try store.remove(ev, span: .thisEvent, commit: false); removed += 1 }
            catch { notRemoved.insert(localId); note(error) }
        }
        do { try store.commit() } catch {
            note(error)
            store.reset()
            for w in plan.writes { failed.insert(w.entityId) }
            notRemoved.formUnion(plan.appleDeletes)
            written = 0; removed = 0
        }
        for id in failed { newState[id] = state[id] }
        for c in plan.creates {
            guard let cal = store.calendar(withIdentifier: c.calendarId) else { continue }
            if await place(c.fields, entityId: c.entityId, in: cal, engine: engine, state: &newState) == true { made += 1 }
        }
        for m in plan.moves {
            guard let cal = store.calendar(withIdentifier: m.calendarId) else { continue }
            // The old copy goes only once the new one is saved; otherwise the link would point at nothing and the
            // next run would delete the event in the app too.
            guard await place(m.fields, entityId: m.entityId, in: cal, engine: engine, state: &newState) != nil else { continue }
            if let old = store.calendarItem(withIdentifier: m.localId) as? EKEvent, old.calendar?.calendarIdentifier != cal.calendarIdentifier {
                do { try store.remove(old, span: .thisEvent, commit: true) } catch { note(error) }
            }
            moved += 1
        }
        for p in plan.patches { _ = await engine.apply(p) }
        // Many events gone from Apple Calendar at once is an account that went away (signed out, switched off, being
        // set up again), not the owner deleting them one by one: nothing is deleted in the app then.
        let linked = all.filter { !$0.isDeleted && EventMirror.appleId($0) != nil }.count
        if plan.entityDeletes.count >= 3 && plan.entityDeletes.count * 3 > linked {
            lastError = "\(plan.entityDeletes.count) events are missing from Apple Calendar at once; they were kept in the app (is an account signed out?)"
            Self.log.error("mirror: \(plan.entityDeletes.count) of \(linked) linked events missing at once; not deleting")
        } else {
            for id in plan.entityDeletes { await engine.softDelete(id); newState.removeValue(forKey: id) }
        }
        for e in all where e.isDeleted {
            // A deletion that did not reach Apple Calendar keeps its record, so the next run removes it there.
            if let aid = EventMirror.appleId(e), let a = apple[aid], notRemoved.contains(a.localId) { continue }
            newState.removeValue(forKey: e.id)
        }
        // Events made in the personal calendar come into the app. Read after the writes above, so the links just
        // recorded keep the app's own copies from coming back as new events.
        var adopted = 0, repeating = 0
        if let cal = personalCal, !work.contains(cal), let ekCal = store.calendar(withIdentifier: cal) {
            let events = engine.list(.event) + ((try? await engine.store.all(kind: .event, includeDeleted: true)) ?? []).filter { $0.isDeleted }
            #if os(macOS)
            let settled: (AppleEvent) -> Bool = { _ in true }
            #else
            let settled: (AppleEvent) -> Bool = { ($0.modified ?? .distantPast) < now.addingTimeInterval(-120) }
            #endif
            let found = singleEvents(in: ekCal, now: now)
            for a in EventMirror.adopt(found: found, calendarTitle: ekCal.title, events: events, now: now, settled: settled) {
                _ = await engine.apply(a.patch)
                newState[a.patch.id] = a.state
                adopted += 1
            }
            let r = await CalendarImportRunner(engine: engine, source: EventKitSource(store: store), space: .personal, include: \.recurring).run(selected: [cal], now: now)
            repeating = r.inserted + r.updated + r.deleted
        }
        state = newState
        lastRun = Date()
        lastSummary = "\(made) added, \(written) updated, \(moved) moved, \(removed) removed in Calendar; \(plan.patches.count) updated, \(plan.entityDeletes.count) removed, \(adopted) brought in, \(repeating) repeating changes here"
        if made + written + moved + removed + plan.patches.count + plan.entityDeletes.count + adopted + repeating > 0 || lastError != nil {
            Self.log.notice("mirror (\(reason, privacy: .public)): \(self.lastSummary ?? "", privacy: .public)\(self.lastError.map { "; error: " + $0 } ?? "", privacy: .public)")
        }
    }

    /// The personal calendar's single events from 30 days back to a year ahead. Repeating ones are left to the
    /// occurrence import, which keys each occurrence on its own.
    private func singleEvents(in cal: EKCalendar, now: Date) -> [AppleEvent] {
        let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-30 * 86400), end: now.addingTimeInterval(365 * 86400), calendars: [cal])
        return store.events(matching: pred).compactMap { ev in
            guard !ev.hasRecurrenceRules, ev.status != .canceled else { return nil }
            let aid = ev.calendarItemExternalIdentifier.flatMap { $0.isEmpty ? nil : $0 } ?? ev.calendarItemIdentifier
            return Self.appleEvent(ev, externalId: aid)
        }
    }

    /// Put an event in a calendar (or adopt the copy already there) and record the link on the entity.
    /// True when a new Apple event was made.
    /// Puts the event in `cal`: true when a copy was made, false when it was there already, nil when saving failed.
    private func place(_ f: [String: String], entityId: String, in cal: EKCalendar, engine: SyncEngine, state: inout [String: SyncedEvent]) async -> Bool? {
        var made = false
        let ev = existing(f, in: cal) ?? EKEvent(eventStore: store)
        if ev.calendar == nil {
            ev.calendar = cal
            Self.apply(f, to: ev)
            do { try store.save(ev, span: .thisEvent, commit: true); made = true } catch { lastError = error.localizedDescription; return nil }
        }
        let aid = ev.calendarItemExternalIdentifier.flatMap { $0.isEmpty ? nil : $0 } ?? ev.calendarItemIdentifier
        _ = await engine.update(entityId, fields: ["apple": .object(["id": .string(aid), "calendar": .string(cal.title)])])
        state[entityId] = SyncedEvent(appleId: aid, fields: f, calendarId: cal.calendarIdentifier)
        return made
    }

    private func note(_ error: Error) {
        lastError = error.localizedDescription
        Self.log.error("mirror failed: \(error.localizedDescription, privacy: .public)")
    }

    /// The same event already in the calendar (made by the other device, or by an earlier run that stopped short).
    private func existing(_ f: [String: String], in cal: EKCalendar) -> EKEvent? {
        guard let start = EventMirror.dates(f)?.start else { return nil }
        let pred = store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: start.addingTimeInterval(120), calendars: [cal])
        return store.events(matching: pred).first { $0.title == f["title"] && abs($0.startDate.timeIntervalSince(start)) < 60 }
    }

    private static func apply(_ f: [String: String], to ev: EKEvent) {
        ev.title = f["title"]
        let allDay = f["all_day"] == "1"
        ev.isAllDay = allDay
        guard let d = EventMirror.dates(f) else { return }
        ev.startDate = d.start
        // EventKit ends an all-day event within its last day.
        ev.endDate = allDay ? max(d.end.addingTimeInterval(-1), d.start) : d.end
    }

    private static func appleEvent(_ ev: EKEvent, externalId: String) -> AppleEvent {
        AppleEvent(externalId: externalId, localId: ev.calendarItemIdentifier, title: ev.title ?? "", start: ISO.string(ev.startDate),
                   end: ISO.string(ev.endDate ?? ev.startDate), allDay: ev.isAllDay, modified: ev.lastModifiedDate, calendarId: ev.calendar?.calendarIdentifier ?? "")
    }
}
#endif
