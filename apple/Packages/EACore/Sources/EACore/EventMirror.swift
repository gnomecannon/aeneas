import Foundation

/// One event made in EverythingApp as Apple Calendar holds it. Times are ISO strings rounded to the minute.
public struct AppleEvent: Equatable, Sendable {
    /// The calendar server's id, the same on every device.
    public var externalId: String
    /// This device's id for it (EKCalendarItem.calendarItemIdentifier).
    public var localId: String
    public var title: String
    public var start: String
    public var end: String
    public var allDay: Bool
    public var modified: Date?
    public var calendarId: String

    public init(externalId: String, localId: String, title: String, start: String, end: String, allDay: Bool, modified: Date? = nil, calendarId: String = "") {
        self.externalId = externalId; self.localId = localId; self.title = title; self.start = start; self.end = end; self.allDay = allDay; self.modified = modified
        self.calendarId = calendarId
    }
}

/// What both sides agreed on at the last sync, per event, kept on this device.
public struct SyncedEvent: Codable, Equatable, Sendable {
    public var appleId: String
    public var fields: [String: String]
    /// The calendar it was in: an event missing from a calendar this device no longer has (an account signed out or
    /// switched off) was not deleted. Nil in records written before it was kept.
    public var calendarId: String?
    public init(appleId: String, fields: [String: String], calendarId: String? = nil) {
        self.appleId = appleId; self.fields = fields; self.calendarId = calendarId
    }
}

/// The changes one run makes: event patches for the hub and writes to Apple Calendar.
public struct EventMirrorPlan: Equatable, Sendable {
    public struct Create: Equatable, Sendable { public var entityId: String; public var fields: [String: String]; public var calendarId: String }
    /// In the wrong calendar (made before the calendar was chosen, or the choice changed): copied to the right one,
    /// then removed from the old one.
    public struct Move: Equatable, Sendable { public var entityId: String; public var localId: String; public var fields: [String: String]; public var calendarId: String }
    public struct Write: Equatable, Sendable { public var localId: String; public var entityId: String; public var fields: [String: String] }
    public var patches: [Patch] = []
    /// Events deleted in Apple Calendar: soft-delete them in the app.
    public var entityDeletes: [String] = []
    public var creates: [Create] = []
    public var moves: [Move] = []
    public var writes: [Write] = []
    /// Apple local ids of events deleted in the app.
    public var appleDeletes: [String] = []
    public var state: [String: SyncedEvent] = [:]
}

/// Events made in EverythingApp (by hand, by the assistant, on any device) are copied into Apple Calendar, and edits
/// or deletions made there come back. Personal events go to the calendar the owner named for them, work events to the work
/// calendar. Work events imported from Apple Calendar are not copied back. Single events made in the personal calendar
/// come into the app the same way (`adopt`); its repeating events come in as imported occurrences.
public enum EventMirror {
    /// Events that belong in Apple Calendar: made in the app rather than imported from somewhere.
    public static func mirrors(_ e: Entity) -> Bool {
        guard e.kind == .event else { return false }
        let source = e.str("source")
        return source.isEmpty || source == "manual"
    }

    /// Memory keys naming the calendar for each space, by address or calendar name (`calendar:personal` =
    /// `robin.home@example.com`). The owner can change them in Memory or by telling the assistant.
    public static func factKey(_ space: Space) -> String { space == .work ? "calendar:work" : "calendar:personal" }

    public static func named(_ space: Space, facts: [Entity]) -> String? {
        let key = factKey(space)
        return facts.first { !$0.isDeleted && $0.str("key").lowercased() == key }.map { $0.str("value").trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The calendar for new events in a space. A name from memory is matched against the calendar's title, then its
    /// account (an account's main calendar is preferred). Without a name, personal events use the default calendar when
    /// it is not a work one, and work events are not copied: guessing would put meetings in the wrong account.
    public static func calendar(for space: Space, facts: [Entity], calendars: [CalendarInfo], writable: Set<String>, defaultId: String?, work: Set<String>) -> String? {
        let usable = calendars.filter { writable.contains($0.id) }
        if let name = named(space, facts: facts)?.lowercased() {
            if let c = usable.first(where: { $0.title.lowercased() == name }) { return c.id }
            let inAccount = usable.filter { $0.sourceTitle.lowercased() == name || $0.sourceTitle.lowercased().contains(name) }
            if let c = inAccount.first(where: { $0.title.lowercased() == "calendar" }) ?? inAccount.first { return c.id }
            if let c = usable.first(where: { $0.title.lowercased().contains(name) }) { return c.id }
        }
        guard space == .personal else { return nil }
        if let d = defaultId, usable.contains(where: { $0.id == d }), !work.contains(d) { return d }
        return usable.first { !work.contains($0.id) && !$0.isExchange }?.id
    }

    public static func appleId(_ e: Entity) -> String? {
        guard case .object(let o)? = e.fields["apple"], let id = o["id"]?.stringValue, !id.isEmpty else { return nil }
        return id
    }

    /// Made in Apple Calendar and brought into the app (`apple.from_apple`): it stays in whichever calendar the owner keeps it.
    public static func fromApple(_ e: Entity) -> Bool {
        guard case .object(let o)? = e.fields["apple"], case .bool(let b)? = o["from_apple"] else { return false }
        return b
    }

    /// The entity an Apple Calendar event becomes, the same on every device so the iPhone and the Mac never make two.
    public static func adoptedId(_ externalId: String) -> String { StableID.uuid("apple-event:\(externalId)") }

    public struct Adoption: Equatable, Sendable {
        public var patch: Patch
        public var state: SyncedEvent
    }

    /// Single events found in the personal calendar that the app has no entity for become personal events linked to
    /// themselves, so from then on edits and deletions travel both ways like an event made in the app.
    /// - Parameters:
    ///   - found: the calendar's single (not repeating) events in the window.
    ///   - events: every event entity on this device, deleted ones included (an event deleted in the app is not brought back).
    ///   - settled: whether this device takes the event now; the iPhone waits until it is two minutes old, so the Mac's
    ///     copy of an event made in the app has its link on the hub first.
    public static func adopt(found: [AppleEvent], calendarTitle: String, events: [Entity], now: Date = Date(),
                             settled: (AppleEvent) -> Bool = { _ in true }) -> [Adoption] {
        let linked = Set(events.compactMap(appleId))
        let ids = Set(events.map(\.id))
        let live = events.filter { !$0.isDeleted && $0.space == .personal && mirrors($0) }.map { fields(of: $0) }
        var out: [Adoption] = []
        for a in found where !linked.contains(a.externalId) && !a.title.isEmpty && settled(a) {
            let id = adoptedId(a.externalId)
            let af = fields(of: a)
            // Already here under its own id, or an app event whose link has not arrived yet (same title and start).
            guard !ids.contains(id), !live.contains(where: { $0["title"] == af["title"] && $0["start"] == af["start"] }),
                  let d = dates(af) else { continue }
            let when = stored(af) ?? (ISO.string(d.start), ISO.string(d.end))
            let f: [String: JSONValue] = [
                "title": .string(a.title), "start": .string(when.start), "end": .string(when.end), "all_day": .bool(a.allDay),
                "apple": .object(["id": .string(a.externalId), "calendar": .string(calendarTitle), "from_apple": .bool(true)]),
            ]
            out.append(Adoption(patch: Patch(id: id, kind: .event, space: .personal, ts: ISO.string(now), fields: f, create: true),
                                state: SyncedEvent(appleId: a.externalId, fields: af, calendarId: a.calendarId)))
        }
        return out
    }

    /// Comparable fields: title, all_day, and start and end to the minute in UTC. An all-day event compares by its
    /// first and last local day instead: the app ends one at the next midnight or 23:59:59, EventKit at 23:59:59.
    public static func fields(of e: Entity) -> [String: String] {
        // A stored all-day event's days are the date parts of what is written, as on the hub and the web. Read as an
        // instant, one stored at UTC midnight fell on the evening before west of UTC and went to Apple Calendar a day early.
        if e.bool("all_day") == true, let first = datePart(e.str("start")) {
            var last = datePart(e.str("end")) ?? first
            // The end is exclusive when written at a midnight (UTC as stored, or local), not at 23:59:59 of the last day.
            let localMidnight = ISO.date(e.str("end")).map { Calendar.current.dateComponents([.hour, .minute], from: $0) }.map { $0.hour == 0 && $0.minute == 0 } ?? false
            if last > first, isMidnight(e.str("end")) || localMidnight,
               let d = LocalPlanner.date(last), let prev = Calendar(identifier: .gregorian).date(byAdding: .day, value: -1, to: d) {
                last = LocalPlanner.dateString(prev)
            }
            return ["title": e.str("title"), "start": first, "end": max(first, last), "all_day": "1"]
        }
        return times(title: e.str("title"), start: e.date("start"), end: e.date("end") ?? e.date("start"), allDay: e.bool("all_day") ?? false)
    }

    static func datePart(_ s: String) -> String? {
        let p = String(s.prefix(10))
        return p.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? p : nil
    }

    /// The end of an all-day event written at a midnight (exclusive), not at 23:59:59 of its last day.
    static func isMidnight(_ s: String) -> Bool {
        s.range(of: #"T00:00(:00(\.0+)?)?(Z|[+-]\d\d:?\d\d)?$"#, options: .regularExpression) != nil
    }

    public static func fields(of a: AppleEvent) -> [String: String] {
        times(title: a.title, start: ISO.date(a.start), end: ISO.date(a.end), allDay: a.allDay)
    }

    static func times(title: String, start: Date?, end: Date?, allDay: Bool) -> [String: String] {
        guard allDay else { return ["title": title, "start": minute(start), "end": minute(end), "all_day": "0"] }
        let last = end.map { max($0.addingTimeInterval(-1), start ?? $0) }
        return ["title": title, "start": day(start), "end": day(last), "all_day": "1"]
    }

    static func minute(_ d: Date?) -> String {
        guard let d else { return "" }
        return ISO.string(Date(timeIntervalSince1970: (d.timeIntervalSince1970 / 60).rounded(.down) * 60))
    }

    static func day(_ d: Date?) -> String {
        guard let d else { return "" }
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Start and end dates from comparable fields: an all-day event runs from its first day's midnight to the
    /// midnight after its last day.
    /// The start and end to store: an all-day event as UTC midnights of its local first day and the day after its last
    /// (the hub's and the web's convention, read back by date part, so it does not move a day east of UTC); a timed one
    /// as instants.
    static func stored(_ f: [String: String]) -> (start: String, end: String)? {
        if f["all_day"] == "1", let first = f["start"], let last = f["end"], let lastDay = LocalPlanner.date(last),
           let after = Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: lastDay) {
            return ("\(first)T00:00:00.000Z", "\(LocalPlanner.dateString(after))T00:00:00.000Z")
        }
        guard let d = dates(f) else { return nil }
        return (ISO.string(d.start), ISO.string(d.end))
    }

    public static func dates(_ f: [String: String]) -> (start: Date, end: Date)? {
        if f["all_day"] == "1" {
            let fmt = DateFormatter()
            fmt.calendar = Calendar(identifier: .gregorian); fmt.locale = Locale(identifier: "en_US_POSIX"); fmt.timeZone = .current
            fmt.dateFormat = "yyyy-MM-dd"
            guard let s = f["start"].flatMap(fmt.date), let l = f["end"].flatMap(fmt.date),
                  let e = Calendar.current.date(byAdding: .day, value: 1, to: l) else { return nil }
            return (s, e)
        }
        guard let s = ISO.date(f["start"]), let e = ISO.date(f["end"]) else { return nil }
        return (s, e)
    }

    /// - Parameters:
    ///   - apple: the Apple events found for the ids the app knows, by external id. A missing id was deleted there.
    ///   - state: this device's record from the last run, by entity id.
    ///   - creates: whether this device adds new events to Apple Calendar for this entity now.
    ///   - target: the calendar this entity belongs in; nil leaves it uncopied (no calendar chosen for its space).
    ///   - present: the calendars this device has now; nil when unknown. An event missing from a calendar not here
    ///     (its account signed out or switched off) is left alone rather than deleted in the app.
    ///   - moveTarget: where an event in another calendar is moved to; nil leaves it. Defaults to `target`; a device
    ///     only moves to a calendar the owner chose, or two devices with different defaults move one back and forth.
    public static func plan(events: [Entity], apple: [String: AppleEvent], state: [String: SyncedEvent], now: Date = Date(),
                            target: (Entity) -> String? = { _ in "" }, present: Set<String>? = nil,
                            moveTarget: ((Entity) -> String?)? = nil, creates: (Entity) -> Bool) -> EventMirrorPlan {
        var p = EventMirrorPlan()
        // Old events are left alone: nobody needs last month's dinner written into the calendar now.
        let horizon = now.addingTimeInterval(-7 * 86400)
        for e in events where mirrors(e) {
            let snap = state[e.id]
            let ef = fields(of: e)
            guard let aid = appleId(e) else {
                if !e.isDeleted, let end = dates(ef)?.end, end >= horizon, !ef["title", default: ""].isEmpty, let cal = target(e), creates(e) {
                    p.creates.append(.init(entityId: e.id, fields: ef, calendarId: cal))
                }
                continue
            }
            let a = apple[aid]
            if e.isDeleted {
                if let a, snap != nil { p.appleDeletes.append(a.localId) }
                continue
            }
            guard let a else {
                // Gone from Apple Calendar. Only a device that saw it there before may conclude it was deleted:
                // a device whose calendar has not caught up with iCloud yet must not delete it.
                if let snap {
                    let cal = snap.calendarId ?? target(e)
                    if let present, let cal, !cal.isEmpty, !present.contains(cal) { continue }
                    p.entityDeletes.append(e.id)
                }
                continue
            }
            let af = fields(of: a)
            // Moves follow the same rule as new copies, so the iPhone and the Mac never both move one.
            if let cal = moveTarget.map({ $0(e) }) ?? target(e), !cal.isEmpty, !a.calendarId.isEmpty, cal != a.calendarId, !fromApple(e), creates(e) {
                // The newer side's details travel with it.
                let appleNewer = snap.map { $0.fields != af && $0.fields == ef } ?? false
                p.moves.append(.init(entityId: e.id, localId: a.localId, fields: appleNewer ? af : ef, calendarId: cal))
                continue
            }
            if ef == af { p.state[e.id] = SyncedEvent(appleId: aid, fields: ef, calendarId: a.calendarId); continue }
            let appChanged = snap.map { $0.fields != ef } ?? true
            let appleChanged = snap.map { $0.fields != af } ?? true
            let appWins: Bool
            if appChanged && !appleChanged { appWins = true }
            else if appleChanged && !appChanged { appWins = false }
            else { appWins = (ISO.date(e.updated_at) ?? .distantPast) >= (a.modified ?? .distantPast) }
            if appWins {
                p.writes.append(.init(localId: a.localId, entityId: e.id, fields: ef))
                p.state[e.id] = SyncedEvent(appleId: aid, fields: ef, calendarId: a.calendarId)
            } else {
                guard let when = stored(af) else { continue }
                var f: [String: JSONValue] = ["title": .string(a.title), "start": .string(when.start), "end": .string(when.end), "all_day": .bool(a.allDay)]
                if a.title.isEmpty { f.removeValue(forKey: "title") }
                p.patches.append(Patch(id: e.id, kind: .event, ts: ISO.now(), fields: f))
                p.state[e.id] = SyncedEvent(appleId: aid, fields: af, calendarId: a.calendarId)
            }
        }
        return p
    }
}
