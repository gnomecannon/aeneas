import Foundation

// Work calendar import, platform-neutral part (contract section 2, `event`).
// The EventKit adapter lives in CalendarImporter.swift and is compiled for iOS and iPadOS only;
// everything here is pure so it can be unit tested with a fake source on any platform.

/// One occurrence read from the device calendar. It deliberately has no location, notes, URL or
/// attendees: those never leave the Calendar store.
public struct CalendarOccurrence: Equatable, Sendable {
    public var eventIdentifier: String
    public var calendarId: String
    public var title: String
    public var start: Date
    public var end: Date
    public var allDay: Bool
    /// One occurrence of a repeating event.
    public var recurring: Bool

    public init(eventIdentifier: String, calendarId: String, title: String, start: Date, end: Date, allDay: Bool = false, recurring: Bool = false) {
        self.eventIdentifier = eventIdentifier; self.calendarId = calendarId; self.title = title
        self.start = start; self.end = end; self.allDay = allDay; self.recurring = recurring
    }

    /// Contract occurrence key: `eventIdentifier` + "|" + ISO start.
    public var externalId: String { eventIdentifier + "|" + ISO.string(start) }

    /// The only fields an imported event carries.
    public var fields: [String: JSONValue] {
        ["title": .string(title), "start": .string(ISO.string(start)), "end": .string(ISO.string(end)),
         "all_day": .bool(allDay), "source": "eventkit", "external_id": .string(externalId)]
    }
}

/// A calendar the user can mark as work.
public struct CalendarInfo: Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    /// Account name, e.g. the Exchange account's address.
    public var sourceTitle: String
    public var isExchange: Bool
    public init(id: String, title: String, sourceTitle: String, isExchange: Bool) {
        self.id = id; self.title = title; self.sourceTitle = sourceTitle; self.isExchange = isExchange
    }
}

/// Where occurrences come from: EventKit on the phone, a fake in tests.
@MainActor
public protocol CalendarEventSource: AnyObject {
    func calendars() -> [CalendarInfo]
    func occurrences(calendarIds: Set<String>, from: Date, to: Date) -> [CalendarOccurrence]
}

/// Local record of what was imported: external_id to entity id, plus the start and calendar so
/// aged-out and deselected occurrences can be told apart from cancelled ones.
public struct ImportedOccurrence: Codable, Equatable, Sendable {
    public var entity_id: String
    public var start: String
    public var calendar_id: String
    public var event_id: String
}

public enum CalendarDiff {
    public static let daysBack = 7
    public static let daysAhead = 30

    /// 7 days back from the start of today to the end of the 30th day ahead.
    public static func window(now: Date = Date(), calendar: Calendar = .current) -> (from: Date, to: Date) {
        let today = calendar.startOfDay(for: now)
        let from = calendar.date(byAdding: .day, value: -daysBack, to: today) ?? today
        let to = calendar.date(byAdding: .day, value: daysAhead + 1, to: today) ?? today
        return (from, to)
    }

    public struct Plan: Equatable, Sendable {
        public var patches: [Patch] = []
        public var map: [String: ImportedOccurrence] = [:]
        public var inserted = 0
        public var updated = 0
        public var deleted = 0
        public var unchanged = 0
        public var live: Int { map.count }
    }

    /// Compute the patches that make the store match `occurrences`.
    /// - Insert: a new occurrence key gets a new `event` entity in `space` (`work` for the work calendars).
    /// - Update: title, end or all_day changed. A non-recurring event whose start moved keeps its
    ///   entity and gets the new `external_id`; recurring occurrences are always keyed separately.
    /// - Delete: soft-delete (`deleted_at`) when a key inside the window is gone, or its calendar
    ///   is no longer selected. Keys that aged out before the window start are forgotten, not
    ///   deleted, so past meetings stay in the record.
    ///   - byExternalId: a live event already holding this key (`external_id`). The other device may have moved a
    ///     meeting this one never saw at its old time: that entity is the meeting, not a new one to make.
    public static func plan(previous: [String: ImportedOccurrence], existing: (String) -> Entity?, occurrences: [CalendarOccurrence],
                            selected: Set<String>, window: (from: Date, to: Date), now: Date = Date(), space: Space = .work,
                            byExternalId: (String) -> Entity? = { _ in nil },
                            newId: (String) -> String = { StableID.uuid("calendar:\($0)") }) -> Plan {
        let ts = ISO.string(now)
        var plan = Plan()
        var current: [String: CalendarOccurrence] = [:]
        for o in occurrences where selected.contains(o.calendarId) { current[o.externalId] = o }

        // Occurrences per event id, old and new, to recognise a moved single event.
        var newByEvent: [String: [String]] = [:]
        for (k, o) in current { newByEvent[o.eventIdentifier, default: []].append(k) }
        var oldByEvent: [String: [String]] = [:]
        for (k, rec) in previous { oldByEvent[rec.event_id, default: []].append(k) }

        var claimed = Set<String>()   // previous keys reused by a moved event

        for key in current.keys.sorted() {
            let o = current[key]!
            var entityId: String?
            var create = false
            if let rec = previous[key] {
                entityId = rec.entity_id
            } else if let olds = oldByEvent[o.eventIdentifier], olds.count == 1, newByEvent[o.eventIdentifier]?.count == 1,
                      current[olds[0]] == nil, !claimed.contains(olds[0]) {
                entityId = previous[olds[0]]!.entity_id
                claimed.insert(olds[0])
            } else if let held = byExternalId(key), !held.isDeleted, !claimed.contains("entity:\(held.id)") {
                entityId = held.id
                claimed.insert("entity:\(held.id)")
            } else {
                // Stable from the occurrence's key: after a reinstall the same meeting lands on the same entity.
                entityId = newId(key)
                create = existing(entityId!) == nil
            }
            let id = entityId!
            plan.map[key] = ImportedOccurrence(entity_id: id, start: ISO.string(o.start), calendar_id: o.calendarId, event_id: o.eventIdentifier)

            if create {
                plan.patches.append(Patch(id: id, kind: .event, space: space, ts: ts, fields: o.fields, create: true))
                plan.inserted += 1
                continue
            }
            guard let e = existing(id) else {
                // Known locally by key but the entity is gone from the cache: write it in full.
                plan.patches.append(Patch(id: id, kind: .event, space: space, ts: ts, fields: o.fields, create: true))
                plan.inserted += 1
                continue
            }
            var changed: [String: JSONValue] = [:]
            for (k, v) in o.fields where !same(e.fields[k], v) { changed[k] = v }
            if e.isDeleted { changed["deleted_at"] = .null }
            if changed.isEmpty { plan.unchanged += 1 } else {
                plan.patches.append(Patch(id: id, kind: .event, space: space, ts: ts, fields: changed))
                plan.updated += 1
            }
        }

        for (key, rec) in previous.sorted(by: { $0.key < $1.key }) where current[key] == nil && !claimed.contains(key) {
            let start = ISO.date(rec.start) ?? .distantPast
            let deselected = !selected.contains(rec.calendar_id)
            let inWindow = start >= window.from && start < window.to
            guard deselected || inWindow else { continue }   // aged out: forget, keep the entity
            if let e = existing(rec.entity_id), e.isDeleted { continue }
            plan.patches.append(Patch(id: rec.entity_id, kind: .event, space: space, ts: ts, fields: ["deleted_at": .string(ts)]))
            plan.deleted += 1
        }
        return plan
    }

    /// Compare stored and new values; dates compare by instant so formatting differences do not churn.
    static func same(_ a: JSONValue?, _ b: JSONValue) -> Bool {
        guard let a = a else { return false }
        if a == b { return true }
        if let sa = a.stringValue, let sb = b.stringValue, let da = ISO.date(sa), let db = ISO.date(sb), sa.count > 10 { return da == db }
        return false
    }
}

public enum CalendarSelection {
    /// The work email domain, from a `fact` in category `identity` keyed `job` (or `identity:job`).
    public static func workDomain(facts: [Entity]) -> String? {
        let jobs = facts.filter { f in
            guard f.kind == .fact, !f.isDeleted, f.str("category") == "identity" else { return false }
            let k = f.str("key").lowercased()
            return k == "job" || k == "identity:job" || k.hasSuffix(":job")
        }
        for f in jobs {
            let v = f.str("value")
            if let r = v.range(of: "[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)+[A-Za-z]{2,}", options: .regularExpression) {
                let email = String(v[r])
                if let at = email.firstIndex(of: "@") { return String(email[email.index(after: at)...]).lowercased() }
            }
        }
        return nil
    }

    /// First run: Exchange calendars, or calendars whose account mentions the work domain.
    public static func preselect(_ calendars: [CalendarInfo], workDomain: String?) -> Set<String> {
        Set(calendars.filter { c in
            if c.isExchange { return true }
            if let d = workDomain, !d.isEmpty, c.sourceTitle.lowercased().contains(d) { return true }
            return false
        }.map(\.id))
    }
}

/// Runs one import against a source and writes through the engine's outbox.
@MainActor
public final class CalendarImportRunner {
    public static let mapKey = "eventkit.map"

    public struct Result: Equatable, Sendable {
        public var inserted = 0, updated = 0, deleted = 0, unchanged = 0, live = 0
        public var at = Date()
    }

    public let engine: SyncEngine
    public let source: CalendarEventSource
    /// `work` for the work calendars; `personal` for the repeating events of the personal calendar.
    public let space: Space
    /// Which occurrences this import takes.
    public let include: (CalendarOccurrence) -> Bool

    public init(engine: SyncEngine, source: CalendarEventSource, space: Space = .work, include: @escaping (CalendarOccurrence) -> Bool = { _ in true }) {
        self.engine = engine
        self.source = source
        self.space = space
        self.include = include
    }

    /// Each space keeps its own record, so one import never deletes the other's events.
    var mapKey: String { space == .work ? Self.mapKey : "\(Self.mapKey).\(space.rawValue)" }

    public func loadMap() async -> [String: ImportedOccurrence] {
        guard let json = try? await engine.store.meta(mapKey) else { return [:] }
        return (try? JSONCoding.decode([String: ImportedOccurrence].self, from: json)) ?? [:]
    }

    @discardableResult
    public func run(selected: Set<String>, now: Date = Date()) async -> Result {
        let window = CalendarDiff.window(now: now)
        let previous = await loadMap()
        // Events the app itself wrote into a work calendar are already in the app; importing them would double them.
        let ownCopies = Set(engine.list(.event).filter(EventMirror.mirrors).compactMap(EventMirror.appleId))
        let occ = (selected.isEmpty ? [] : source.occurrences(calendarIds: selected, from: window.from, to: window.to)).filter { !ownCopies.contains($0.eventIdentifier) && include($0) }
        let engine = self.engine
        var held: [String: Entity] = [:]
        for e in engine.list(.event) where e.space == space && e.str("source") == "eventkit" { let k = e.str("external_id"); if !k.isEmpty { held[k] = e } }
        let plan = CalendarDiff.plan(previous: previous, existing: { engine.get($0) }, occurrences: occ, selected: selected, window: window, now: now, space: space,
                                     byExternalId: { held[$0] })
        if !plan.patches.isEmpty { await engine.applyBatch(plan.patches) }
        if let json = try? JSONCoding.string(plan.map) { try? await engine.store.setMeta(mapKey, json) }
        return Result(inserted: plan.inserted, updated: plan.updated, deleted: plan.deleted, unchanged: plan.unchanged, live: plan.live, at: now)
    }
}
