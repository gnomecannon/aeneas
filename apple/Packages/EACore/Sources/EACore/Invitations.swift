import Foundation

/// Invitations (CONTRACT.md section 2, `invitation`, and section 3, Invitations): one list of the invitations waiting
/// for the owner's answer, from an iCloud calendar the hub keeps in step, from mail, or from Apple Calendar on this
/// device. The list rules are packages/shared `invitations.ts` (both tested with `invitation-cases.json`); the hub
/// answers the first two kinds, and Apple Calendar answers the third (EventKit can read an answer, not change one).
public enum Invitations {
    /// Answered ones stay under Answered this long.
    public static let answeredDays = 7.0
    /// Which source is listed when one invitation (one UID) came from several: iCloud, then mail, then Apple Calendar.
    static let order: [String: Int] = ["caldav": 0, "mail": 1, "open_in_calendar": 2]

    /// What the owner can press, in the hub's words.
    public enum Answer: String, CaseIterable, Sendable, Identifiable {
        case accepted, tentative, declined
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .accepted: return Texts.accept
            case .tentative: return Texts.maybe
            case .declined: return Texts.decline
            }
        }
        /// Said on the row for a moment after it was pressed.
        public var done: String {
            switch self {
            case .accepted: return "Accepted."
            case .tentative: return "Maybe."
            case .declined: return "Declined."
            }
        }
    }

    /// The words every client uses (packages/shared `INVITE_TEXTS`).
    public enum Texts {
        public static let title = "Invitations"
        public static let none = "No invitations need an answer."
        public static let answered = "Answered"
        public static let offline = "Connect to your hub to answer."
        public static let inCalendarApp = "Answer this in your calendar app."
        public static let openInCalendar = "Open in Calendar"
        public static let accept = "Accept"
        public static let maybe = "Maybe"
        public static let decline = "Decline"
        public static let undo = "Undo"
        public static let retry = "Try again"
        public static func state(_ answer: String) -> String {
            switch answer {
            case "accepted": return "Accepted"
            case "tentative": return "Maybe"
            case "declined": return "Declined"
            default: return "Not answered"
            }
        }
        /// "1 invitation", "2 invitations": Today's Needs you line.
        public static func count(_ n: Int) -> String { "\(n) invitation\(n == 1 ? "" : "s")" }
    }

    /// A mail answer that is not sent yet: the row stays among the pending ones, with Undo or Try again.
    public static func replyOpen(_ e: Entity) -> Bool {
        let s = e.fields["reply"]?.objectValue?["state"]?.stringValue
        return s == "waiting" || s == "sending" || s == "failed"
    }

    /// The list as every client shows it: one per UID, the pending ones by start (an answer still being sent stays among
    /// them), those answered in the last 7 days newest first, and how many wait for an answer.
    public static func list(_ items: [Entity], now: Date) -> (pending: [Entity], answered: [Entity], count: Int) {
        var best: [String: Entity] = [:]
        for e in items where !e.isDeleted && e.kind == .invitation {
            let uid = e.str("uid").isEmpty ? "id:\(e.id)" : e.str("uid")
            guard let cur = best[uid] else { best[uid] = e; continue }
            let a = order[e.str("answer_by")] ?? 9
            let b = order[cur.str("answer_by")] ?? 9
            if a < b || (a == b && e.updated_at > cur.updated_at) { best[uid] = e }
        }
        var pending: [Entity] = []
        var answered: [Entity] = []
        let since = now.addingTimeInterval(-answeredDays * 86_400)
        for e in best.values {
            let end = e.date("end") ?? e.date("start") ?? .distantPast
            let answer = e.str("answer")
            if replyOpen(e) || (answer == "needs_action" && end > now) { pending.append(e); continue }
            if answer != "needs_action", let at = e.date("answered_at"), at >= since { answered.append(e) }
        }
        // As the web sorts them: by the stored start text (UTC, so it sorts as time), ties by id.
        pending.sort { ($0.str("start"), $0.id) < ($1.str("start"), $1.id) }
        answered.sort { $0.str("answered_at") != $1.str("answered_at") ? $0.str("answered_at") > $1.str("answered_at") : $0.id < $1.id }
        let count = pending.filter { $0.str("answer") == "needs_action" && !replyOpen($0) }.count
        return (pending, answered, count)
    }

    /// Who invited the owner, in words: the organizer's name, else the address, else nothing.
    public static func organizer(_ e: Entity) -> String {
        let o = e.fields["organizer"]?.objectValue
        let name = (o?["name"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? (o?["address"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces) : name
    }

    /// The line a mail answer shows while it is not sent yet, or nil.
    public static func replyLine(_ e: Entity) -> (text: String, undo: Bool, retry: Bool)? {
        guard replyOpen(e), let r = e.fields["reply"]?.objectValue else { return nil }
        if r["state"]?.stringValue == "failed" {
            let why = r["error"]?.stringValue ?? ""
            return ("Not sent: \(why.isEmpty ? "the answer did not go." : why)", true, true)
        }
        let who = organizer(e).isEmpty ? "the organizer" : organizer(e)
        return ("Sending your answer to \(who).", r["state"]?.stringValue == "waiting", false)
    }

    /// The current answer as a button to show chosen, or nil while not answered.
    public static func chosen(_ e: Entity) -> Answer? { Answer(rawValue: e.str("answer")) }

    /// Only the calendar app can answer it (from Apple Calendar on a device).
    public static func inCalendarApp(_ e: Entity) -> Bool { e.str("answer_by") == "open_in_calendar" }

    /// When it is, in words: "Fri, Nov 27, 7:00 PM to 9:00 PM", or the day and "All day". An all-day one's start and end
    /// are UTC midnights, its end the day after.
    public static func when(_ e: Entity, calendar: Calendar = .current) -> String {
        guard let start = e.date("start") else { return "" }
        let end = e.date("end") ?? start
        // "Fri, Nov 27": the day without the year, as Week names days.
        var day = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day()
        day.timeZone = calendar.timeZone
        if e.bool("all_day") == true {
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC")!
            let first = utc.dateComponents([.year, .month, .day], from: start)
            let lastDate = max(end.addingTimeInterval(-86_400), start)
            let last = utc.dateComponents([.year, .month, .day], from: lastDate)
            let f = calendar.date(from: first) ?? start
            let l = calendar.date(from: last) ?? f
            return first == last ? "\(f.formatted(day)), all day" : "\(f.formatted(day)) to \(l.formatted(day)), all day"
        }
        var time = Date.FormatStyle(date: .omitted, time: .shortened)
        time.timeZone = calendar.timeZone
        if end <= start { return "\(start.formatted(day)), \(start.formatted(time))" }
        return calendar.isDate(start, inSameDayAs: end)
            ? "\(start.formatted(day)), \(start.formatted(time)) to \(end.formatted(time))"
            : "\(start.formatted(day)), \(start.formatted(time)) to \(end.formatted(day)), \(end.formatted(time))"
    }

    /// Today's Needs you line: how many wait, and the first one's title, day and organizer; nil with none waiting.
    public static func need(_ items: [Entity], now: Date, calendar: Calendar = .current) -> (count: Int, detail: String)? {
        let l = list(items, now: now)
        guard l.count > 0, let first = l.pending.first(where: { $0.str("answer") == "needs_action" }) ?? l.pending.first else { return nil }
        let who = organizer(first)
        let day = when(first, calendar: calendar).components(separatedBy: ", ").prefix(2).joined(separator: ", ")
        return (l.count, [first.str("title"), day, who.isEmpty ? "" : "from \(who)"].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    // MARK: Apple Calendar on this device

    /// The id an invitation from Apple Calendar has on every device: from its calendar item's external identifier.
    public static func deviceId(_ externalId: String) -> String { StableID.uuid("eventkit-invite:" + externalId) }

    /// What the device reads of one event the current user is invited to (never its notes or the other attendees).
    public struct DeviceInvite: Equatable, Sendable {
        public enum Status: String, Sendable { case pending, accepted, tentative, declined, other }
        /// The calendar item's external identifier, the same on every device (for CalDAV, the iCalendar UID).
        public var externalId: String
        /// EventKit's identifier on this device, to open the event in Calendar.
        public var eventIdentifier: String
        public var title: String
        public var start: Date
        public var end: Date
        public var allDay: Bool
        public var location: String?
        public var organizerName: String?
        public var organizerAddress: String?
        /// The current user's own answer as EventKit has it.
        public var status: Status
        public var organizedByMe: Bool
        public var cancelled: Bool
        public var repeats: Bool
        public var space: Space

        public init(externalId: String, eventIdentifier: String, title: String, start: Date, end: Date, allDay: Bool = false, location: String? = nil,
                    organizerName: String? = nil, organizerAddress: String? = nil, status: Status, organizedByMe: Bool = false, cancelled: Bool = false,
                    repeats: Bool = false, space: Space = .personal) {
            self.externalId = externalId; self.eventIdentifier = eventIdentifier; self.title = title; self.start = start; self.end = end
            self.allDay = allDay; self.location = location; self.organizerName = organizerName; self.organizerAddress = organizerAddress
            self.status = status; self.organizedByMe = organizedByMe; self.cancelled = cancelled; self.repeats = repeats; self.space = space
        }

        /// An invitation waiting for the owner: their answer pending, not theirs, not cancelled, not over.
        public func isPending(now: Date) -> Bool { status == .pending && !organizedByMe && !cancelled && end > now }

        /// The answer EventKit says the owner gave, in the hub's words; nil while pending or not one of the three.
        public var answer: String? {
            switch status {
            case .accepted: return "accepted"
            case .tentative: return "tentative"
            case .declined: return "declined"
            default: return nil
            }
        }

        /// An all-day event's times as the app keeps them: UTC midnights of its first day and of the day after its last.
        func times(calendar: Calendar) -> (start: String, end: String) {
            guard allDay else { return (ISO.string(start), ISO.string(max(end, start))) }
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC")!
            let first = calendar.dateComponents([.year, .month, .day], from: start)
            // EventKit ends an all-day event within its last day.
            let last = calendar.dateComponents([.year, .month, .day], from: max(end.addingTimeInterval(-1), start))
            let s = utc.date(from: first) ?? start
            let l = utc.date(from: last) ?? s
            return (ISO.string(s), ISO.string(l.addingTimeInterval(86_400)))
        }

        func fields(device: String, calendar: Calendar) -> [String: JSONValue] {
            let t = times(calendar: calendar)
            var f: [String: JSONValue] = [
                "title": .string(String(title.prefix(1000))), "start": .string(t.start), "end": .string(t.end), "all_day": .bool(allDay),
                "answer_by": "open_in_calendar", "uid": .string(String(externalId.prefix(1000))),
                "from": .object(["kind": "device", "device": .string(device), "event": .string(String(eventIdentifier.prefix(1000)))]),
            ]
            if let l = location?.trimmingCharacters(in: .whitespacesAndNewlines), !l.isEmpty { f["location"] = .string(String(l.prefix(1000))) }
            var o: [String: JSONValue] = [:]
            if let n = organizerName?.trimmingCharacters(in: .whitespaces), !n.isEmpty { o["name"] = .string(String(n.prefix(200))) }
            if let a = organizerAddress?.trimmingCharacters(in: .whitespaces).lowercased(), a.contains("@"), a.count <= 254 { o["address"] = .string(a) }
            if !o.isEmpty { f["organizer"] = .object(o) }
            if repeats { f["repeats"] = .bool(true) }
            return f
        }
    }

    /// The patches that bring this device's invitations up to date with what Apple Calendar holds: a new one for each
    /// pending event (unless an invitation from iCloud or mail has its UID: then only an answer given elsewhere is
    /// written on that one), its details kept current, the answer the owner gave in Calendar written, and the ones this
    /// device wrote whose event is gone deleted.
    public static func plan(found: [DeviceInvite], existing: [Entity], device: String, now: Date = Date(), calendar: Calendar = .current) -> [Patch] {
        let ts = ISO.string(now)
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let hubByUid = Dictionary(grouping: existing.filter { !$0.isDeleted && $0.kind == .invitation && $0.str("answer_by") != "open_in_calendar" }, by: { $0.str("uid") })
        var patches: [Patch] = []
        var seen = Set<String>()
        for d in found where !d.externalId.isEmpty && !d.organizedByMe && !d.cancelled {
            let id = deviceId(d.externalId)
            guard seen.insert(id).inserted else { continue }
            let cur = byId[id]
            // iCloud or mail has it: listed from there. When Calendar here shows it answered already (in Google Calendar,
            // say) and that copy still waits, the answer is written on it, so it does not wait for an answer given.
            if let hubs = hubByUid[d.externalId] {
                if let a = d.answer {
                    for h in hubs where h.str("answer") == "needs_action" && !replyOpen(h) {
                        patches.append(Patch(id: h.id, kind: .invitation, ts: ts, fields: ["answer": .string(a), "answered_at": .string(ts)]))
                    }
                }
                continue
            }
            let f = d.fields(device: device, calendar: calendar)
            if cur == nil || cur!.isDeleted {
                // Only an invitation that waits is new to the list; one answered before the app saw it is not.
                guard d.isPending(now: now) else { continue }
                var fields = f
                fields["answer"] = "needs_action"
                if cur != nil { fields["deleted_at"] = .null }
                patches.append(Patch(id: id, kind: .invitation, space: cur == nil ? d.space : nil, ts: ts, fields: fields, create: cur == nil ? true : nil))
                continue
            }
            var changed: [String: JSONValue] = [:]
            for (k, v) in f where k != "from" && cur!.fields[k] != v {
                if k == "start" || k == "end", let a = cur!.fields[k]?.stringValue, let b = v.stringValue, ISO.date(a) == ISO.date(b) { continue }
                changed[k] = v
            }
            for k in ["location", "organizer", "repeats"] where f[k] == nil && cur!.fields[k] != nil && cur!.fields[k] != .null { changed[k] = .null }
            let was = cur!.str("answer")
            if let a = d.answer, a != was { changed["answer"] = .string(a); changed["answered_at"] = .string(ts) }
            else if d.status == .pending, was != "needs_action" { changed["answer"] = "needs_action"; changed["answered_at"] = .null }
            if !changed.isEmpty {
                changed["from"] = f["from"]
                patches.append(Patch(id: id, kind: .invitation, ts: ts, fields: changed))
            }
        }
        // Written from this device, and gone from its calendars (deleted, cancelled, or past the window): deleted.
        for e in existing where !e.isDeleted && e.kind == .invitation && e.str("answer_by") == "open_in_calendar" && !seen.contains(e.id) {
            guard e.fields["from"]?.objectValue?["device"]?.stringValue == device else { continue }
            patches.append(Patch(id: e.id, kind: .invitation, ts: ts, fields: ["deleted_at": .string(ts)]))
        }
        return patches
    }

    /// The Calendar app at the event's day on the iPhone and iPad: `calshow:` takes seconds since 2001.
    public static func calshowURL(_ start: Date) -> URL? { URL(string: "calshow:\(Int(start.timeIntervalSinceReferenceDate))") }
}
