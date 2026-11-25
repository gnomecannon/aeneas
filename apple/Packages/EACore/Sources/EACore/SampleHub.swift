import Foundation

/// Sample mode: the app runs on a made-up month (the demo hub's "Alex", hub/scripts/demo-hub.ts) with no hub at all,
/// for anyone trying the app before they set one up, and for App Review. Every answer comes from a recording of the
/// demo hub (SampleHub.json in the app), moved forward so its "today" is the viewer's today, on whatever day it is read.
/// What the recording says had happened by the time it was made has happened by now too (`holdBack`). Nothing leaves
/// the device: there is no network in sample mode. Edits stay on this device until sample mode ends, which wipes them;
/// the device's copy moves on with the days as the recording does (SyncEngine.catchUpSample), edits included.
public final class SampleTransport: HubTransport, @unchecked Sendable {
    public struct Entry: Codable, Sendable { public var status: Int; public var body: String }
    public struct Recording: Codable, Sendable {
        /// The local day the recording was made (YYYY-MM-DD): dates in it move by the days since.
        public var day: String
        public var entries: [String: Entry]
        public init(day: String, entries: [String: Entry] = [:]) { self.day = day; self.entries = entries }
    }

    /// The recording, set by the app at launch from its bundle.
    nonisolated(unsafe) public static var shared: SampleTransport?

    private let recording: Recording
    /// The time now. The day the recording's dates move to, and what has happened yet, are worked out from it on every
    /// answer: a sample left open past midnight moves on to the new day like one opened then.
    private let clock: @Sendable () -> Date
    private let lock = NSLock()
    private var seq: Int
    private var chats: [String: AISession] = [:]

    static let chatReply = "This is sample data, so there is no assistant to answer. With your own hub, the assistant runs on a model on your own computer: it answers questions about your plans, notes and logs, files what you capture, and remembers what you tell it. To set one up, tap Set up my own hub on Today."
    /// A read the recording has no answer for (a search typed on the device, an item made here). Shown as it is, with
    /// no status code (`HubError.errorDescription`).
    public static let noSampleData = "This has no sample data. Connect your own hub to see it."
    /// A write the sample cannot keep anywhere but on this device.
    public static let needsOwnHub = "This is sample data: connect your own hub to save this."

    /// Sample mode's own refusals are sentences for people, so screens show them without an HTTP code.
    public static func speaksPlainly(_ message: String) -> Bool { message == noSampleData || message == needsOwnHub }

    /// The hub's meals tax table (SampleMealsTax.json in the app), for the bill splitter's "Use my location".
    private let mealsTax: MealsTaxTable?

    public init(recording: Recording, now: @escaping @Sendable () -> Date = { Date() }, mealsTax: MealsTaxTable? = nil) {
        self.recording = recording
        self.mealsTax = mealsTax
        self.clock = now
        self.seq = 1_000_000
    }

    /// Read as on one moment that does not move (tests).
    public convenience init(recording: Recording, today: Date, mealsTax: MealsTaxTable? = nil) {
        self.init(recording: recording, now: { today }, mealsTax: mealsTax)
    }

    public convenience init?(data: Data, now: @escaping @Sendable () -> Date = { Date() }, mealsTax: MealsTaxTable? = nil) {
        guard let r = try? JSONDecoder().decode(Recording.self, from: data) else { return nil }
        self.init(recording: r, now: now, mealsTax: mealsTax)
    }

    /// The time now, as this sample reads it.
    public var now: Date { clock() }

    private var held: Date?
    /// Where today's held-back times go (see `holdBack`). The device's copy keeps one moment for the whole day
    /// (SyncEngine.catchUpSample), so a reminder held back reads the same in every answer and in the copy, however often
    /// it is read. Nil, or another day's: 10 minutes before now.
    public var heldAt: Date? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }

    /// Where `holdBack` moves times to at `now`: `held` when it is earlier today, else 10 minutes before now, never
    /// before today began (so an item stays on the day Dashboard shows it on).
    public static func heldMoment(now: Date, held: Date? = nil) -> Date {
        if let held, held <= now, Calendar.current.isDate(held, inSameDayAs: now) { return held }
        return max(Calendar.current.startOfDay(for: now), now.addingTimeInterval(-600))
    }

    /// Whole local days from `day` (YYYY-MM-DD) to the day `now` falls on.
    public static func days(from day: String, to now: Date) -> Int? {
        guard let d = dayDate(day) else { return nil }
        return Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: d), to: Calendar.current.startOfDay(for: now)).day
    }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let now = clock()
        let key = Self.key(method: method, path: p, query: query, recordedDay: ISO.localDay(now))
        if let e = recording.entries[key] {
            let days = Self.days(from: recording.day, to: now) ?? 0
            return (e.status, Data(Self.present(e.body, days: days, around: recording.day, now: now, to: Self.heldMoment(now: now, held: heldAt)).utf8))
        }
        // Changes after the recorded pages: nothing new (the sample does not change on its own).
        if method == "GET", p == "sync/changes", let since = query["since"], since != "0" {
            let s = lock.withLock { seq }
            return (200, Data(#"{"changes":[],"seq":\#(max(s, Int(since) ?? 0)),"more":false}"#.utf8))
        }
        return answer(method: method, path: p, body: body)
    }

    /// Writes and anything not recorded: kept on the device, or a plain word that this is sample data.
    private func answer(method: String, path: String, body: Data?) -> (Int, Data) {
        switch (method, path) {
        case ("POST", "sync/push"):
            let req = body.flatMap { try? JSONDecoder().decode(PushRequest.self, from: $0) }
            let applied: [[String: Any]] = lock.withLock { (req?.patches ?? []).map { seq += 1; return ["id": $0.id, "seq": seq] } }
            let s = lock.withLock { seq }
            return (200, (try? JSONSerialization.data(withJSONObject: ["applied": applied, "rejected": [], "seq": s])) ?? Data("{}".utf8))
        case ("POST", "ai/chat"):
            let req = body.flatMap { try? JSONDecoder().decode(ChatRequest.self, from: $0) }
            let id = req?.session_id ?? UUID().uuidString
            let now = ISO.now()
            // Kept in memory like the hub keeps chats, so the screen can read the conversation back.
            lock.withLock {
                var sess = chats[id] ?? AISession(session_id: id, title: String((req?.message ?? "Chat").prefix(60)), task_type: "auto", created_at: now, last_at: now, messages: [])
                if let m = req?.message { sess.messages.append(AIStoredMessage(role: .user, content: m, at: now)) }
                sess.messages.append(AIStoredMessage(role: .assistant, content: Self.chatReply, at: now))
                sess.last_at = now
                chats[id] = sess
            }
            let out: [String: Any] = ["reply": Self.chatReply, "model": "sample", "backend": "sample", "redactions": 0, "rules_applied": [], "session_id": id]
            return (200, (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8))
        case ("GET", "ai/sessions"):
            let items = lock.withLock { chats.values.sorted { $0.last_at > $1.last_at }.map {
                AISessionItem(session_id: $0.session_id, title: $0.title, task_type: $0.task_type, created_at: $0.created_at, last_at: $0.last_at,
                              message_count: $0.messages.count, preview: String(($0.messages.last?.content ?? "").prefix(120)), working: nil)
            } }
            struct R: Encodable { var sessions: [AISessionItem] }
            return (200, (try? JSONEncoder().encode(R(sessions: items))) ?? Data("{}".utf8))
        case ("GET", _) where path.hasPrefix("ai/sessions/"):
            let id = String(path.dropFirst("ai/sessions/".count))
            if let sess = lock.withLock({ chats[id] }), let d = try? JSONEncoder().encode(sess) { return (200, d) }
            return (404, Data(#"{"error":"not found"}"#.utf8))
        case ("POST", "calc/meals-tax"):
            // Worked out here as the hub would (hub/src/mealstax.ts): the position never leaves the device.
            struct Place: Decodable { var lat: Double; var lon: Double }
            guard let place = body.flatMap({ try? JSONDecoder().decode(Place.self, from: $0) }) else { return (422, Self.errorBody("lat and lon must be numbers")) }
            guard let table = mealsTax else { return (503, Self.errorBody(Self.needsOwnHub)) }
            guard let m = table.answer(latitude: place.lat, longitude: place.lon) else { return (404, Self.errorBody("not in a US state")) }
            let out: [String: Any] = ["state": m.state, "name": m.name, "pct": m.pct, "note": m.note]
            return (200, (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8))
        case ("DELETE", _) where path.hasPrefix("ai/sessions"):
            lock.withLock { if path == "ai/sessions" { chats = [:] } else { chats[String(path.dropFirst("ai/sessions/".count))] = nil } }
            return (200, Data("{}".utf8))
        case ("GET", _):
            return (404, Self.errorBody(Self.noSampleData))
        default:
            return (503, Self.errorBody(Self.needsOwnHub))
        }
    }

    private static func errorBody(_ message: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["error": message])) ?? Data()
    }

    // MARK: keys and dates

    /// The recording's key for a request: dates in the path and query become offsets from the recording day, so a
    /// request for "today" finds the recording's today on any day.
    public static func key(method: String, path: String, query: [String: String], recordedDay: String) -> String {
        // Which device asked does not change the answer, and differs between recording and replay.
        let q = query.keys.filter { $0 != "device_id" }.sorted().map { "\($0)=\(relative(query[$0] ?? "", to: recordedDay))" }.joined(separator: "&")
        return "\(method) \(relative(path, to: recordedDay))\(q.isEmpty ? "" : "?" + q)"
    }

    private static let dayPattern = try! NSRegularExpression(pattern: #"\b(\d{4}-\d{2}-\d{2})\b"#)

    /// YYYY-MM-DD within a year of `day` becomes @D+n (days after it); other text stays.
    static func relative(_ s: String, to day: String) -> String {
        guard let base = dayDate(day) else { return s }
        return replace(dayPattern, in: s) { m in
            guard let d = dayDate(m), abs(d.timeIntervalSince(base)) < 400 * 86400 else { return m }
            let n = Calendar.current.dateComponents([.day], from: base, to: d).day ?? 0
            return "@D\(n >= 0 ? "+" : "")\(n)"
        }
    }

    private static let isoPattern = try! NSRegularExpression(pattern: #"\b(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?"#)

    /// Every date and time within a year of the recording day, moved `days` later. Birthdays and older history stay.
    public static func shift(_ s: String, days: Int, around day: String) -> String {
        guard days != 0, let base = dayDate(day) else { return s }
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in isoPattern.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let whole = ns.substring(with: m.range)
            let datePart = ns.substring(with: m.range(at: 1))
            if let d = dayDate(datePart), abs(d.timeIntervalSince(base)) < 400 * 86400 {
                let timePart = m.range(at: 2).location == NSNotFound ? "" : ns.substring(with: m.range(at: 2))
                if !timePart.isEmpty, let full = ISO.date(whole) {
                    let moved = full.addingTimeInterval(TimeInterval(days) * 86400)
                    out += timePart.hasSuffix("Z") ? ISO.string(moved) : datePart.shiftedDay(days) + timePart
                } else {
                    out += datePart.shiftedDay(days)
                }
            } else {
                out += whole
            }
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    /// A recorded answer as it reads `now`: its dates moved `days` later (`shift`), then held back to now (`holdBack`).
    public static func present(_ body: String, days: Int, around day: String, now: Date, to moment: Date? = nil) -> String {
        holdBack(shift(body, days: days, around: day), now: now, to: moment)
    }

    /// One stored item moved `days` later and held back to now, as `present` moves an answer: the device's copy of the
    /// sample catches up with the day it is read on (SyncEngine.catchUpSample).
    public static func move(_ e: Entity, days: Int, around day: String, now: Date, to moment: Date? = nil) -> Entity {
        guard let text = try? JSONCoding.string(e) else { return e }
        let out = present(text, days: days, around: day, now: now, to: moment)
        return out == text ? e : (try? JSONCoding.decode(Entity.self, from: out)) ?? e
    }

    /// Keys whose time says when something happened (a log's `at`, a check's `last_check`, when an item was written),
    /// never when something is planned (an event's `start`, a `due` date, a pet's `next_due`).
    static let happenedKeys: Set<String> = [
        "at", "created_at", "updated_at", "deleted_at", "done_at", "acknowledged_at", "opened_at", "reported_at", "time",
        "last_at", "last_check", "last_ok", "last_seen", "last_sync", "last_import", "last_change", "last_played",
        "last_session_close", "checked_at", "linked_at",
    ]

    /// What the recording says had happened by the time it was made has happened by now too. A recording made at 10 AM
    /// and read at 12:30 AM had today's 7:30 weigh-in and the reminder that came due at 9:55 still to come: Health and
    /// Memory showed the weigh-in later today, the reminder waited for 9:55, and Today's Next counted down to it. Every
    /// time that says something happened (`happenedKeys`, and every stamp in an item's `field_ts`), and a reminder that
    /// was already due when its item was last written, moves to `moment` when it is later than now (`heldMoment`: by
    /// default 10 minutes before now, never before today began). Plans stay where they are. JSON answers and CSV
    /// exports; anything else as it is.
    public static func holdBack(_ text: String, now: Date, to moment: Date? = nil) -> String {
        guard hasTime(after: now, in: text) else { return text }
        let to = ISO.string(heldMoment(now: now, held: moment))
        let first = text.first { !$0.isWhitespace }
        if first == "{" || first == "[" {
            guard let v = try? JSONCoding.decode(JSONValue.self, from: text) else { return text }
            var changed = false
            let out = holdBack(v, now: now, to: to, changed: &changed)
            return changed ? (try? JSONCoding.string(out)) ?? text : text
        }
        return holdBackCSV(text, now: now, to: to)
    }

    /// Whether any date with a time in `text` is later than `now`: most answers have none, and are passed on unchanged.
    private static func hasTime(after now: Date, in text: String) -> Bool {
        let ns = text as NSString
        for m in isoPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) where m.range(at: 2).location != NSNotFound {
            if let d = ISO.date(ns.substring(with: m.range)), d > now { return true }
        }
        return false
    }

    /// A date with a time (not a day alone) later than `now`.
    private static func isLater(_ v: JSONValue?, than now: Date) -> Bool {
        guard let s = v?.stringValue, s.count > 10, s.contains("T"), let d = ISO.date(s) else { return false }
        return d > now
    }

    /// A reminder time that was not later than when its item was last written: it was due then, so it is due now.
    private static func wasDue(_ v: JSONValue?, written: Date?) -> Bool {
        guard let written, let d = ISO.date(v?.stringValue) else { return false }
        return d <= written
    }

    private static func holdBack(_ v: JSONValue, now: Date, to: String, changed: inout Bool) -> JSONValue {
        switch v {
        case .array(let a):
            return .array(a.map { holdBack($0, now: now, to: to, changed: &changed) })
        case .object(var o):
            // An item (the contract's envelope): its stamps all say when something was written.
            if case .object(var fields)? = o["fields"], case .object(var stamps)? = o["field_ts"], o["kind"]?.stringValue != nil {
                let written = ISO.date(o["updated_at"]?.stringValue)
                for (k, t) in stamps where isLater(t, than: now) { stamps[k] = .string(to); changed = true }
                for (k, f) in fields {
                    if isLater(f, than: now), happenedKeys.contains(k) || (k == "remind_at" && wasDue(f, written: written)) {
                        fields[k] = .string(to)
                        changed = true
                    } else {
                        fields[k] = holdBack(f, now: now, to: to, changed: &changed)
                    }
                }
                o["fields"] = .object(fields)
                o["field_ts"] = .object(stamps)
            }
            for (k, x) in o where k != "fields" && k != "field_ts" {
                if happenedKeys.contains(k), isLater(x, than: now) { o[k] = .string(to); changed = true }
                else if case .object = x { o[k] = holdBack(x, now: now, to: to, changed: &changed) }
                else if case .array = x { o[k] = holdBack(x, now: now, to: to, changed: &changed) }
            }
            return .object(o)
        default:
            return v
        }
    }

    /// The same for a CSV export (the hub's `entitiesCsv`, a sensor's readings): its columns are named by the first row.
    private static func holdBackCSV(_ text: String, now: Date, to: String) -> String {
        // Rows of cells as written (quotes kept), with what ended each row.
        var rows: [[String]] = [], ends: [String] = []
        var row: [String] = [], cell = "", quoted = false
        for ch in text {
            if quoted {
                cell.append(ch)
                if ch == "\"" { quoted = false } // a doubled quote reopens at once, below
            } else if ch == "\"" {
                quoted = true
                cell.append(ch)
            } else if ch == "," {
                row.append(cell)
                cell = ""
            } else if ch == "\n" || ch == "\r\n" {
                row.append(cell)
                rows.append(row)
                ends.append(String(ch))
                row = []
                cell = ""
            } else {
                cell.append(ch)
            }
        }
        if !cell.isEmpty || !row.isEmpty { row.append(cell); rows.append(row); ends.append("") }
        guard let header = rows.first else { return text }
        let happened = header.indices.filter { happenedKeys.contains(header[$0]) }
        let remind = header.firstIndex(of: "remind_at"), updated = header.firstIndex(of: "updated_at")
        var changed = false
        for r in rows.indices.dropFirst() {
            let written = updated.flatMap { rows[r].indices.contains($0) ? ISO.date(rows[r][$0]) : nil }
            for c in happened where rows[r].indices.contains(c) && isLater(.string(rows[r][c]), than: now) {
                rows[r][c] = to
                changed = true
            }
            if let c = remind, rows[r].indices.contains(c), isLater(.string(rows[r][c]), than: now), wasDue(.string(rows[r][c]), written: written) {
                rows[r][c] = to
                changed = true
            }
        }
        return changed ? zip(rows, ends).map { $0.joined(separator: ",") + $1 }.joined() : text
    }

    static func dayDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: s)
    }

    private static func replace(_ re: NSRegularExpression, in s: String, _ f: (String) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += f(ns.substring(with: m.range))
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }
}

private extension String {
    /// YYYY-MM-DD moved by whole local days.
    func shiftedDay(_ days: Int) -> String {
        guard let d = SampleTransport.dayDate(self), let m = Calendar.current.date(byAdding: .day, value: days, to: d) else { return self }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: m)
    }
}

#if DEBUG
/// Debug builds: every answer of the real hub saved, to make SampleHub.json from the demo hub. SampleHub.json itself
/// is made by the recorder test, which asks every screen's reads (SampleRecorderTests.swift in EACoreTests says how to
/// run it). The app can record too, for a look at one screen: launch argument `-EARecordSample YES`, then copy
/// `sample-record.json` out of the app's Documents folder.
public final class RecordingTransport: HubTransport, @unchecked Sendable {
    private let inner: HubTransport
    /// Written after every answer; nil keeps the recording in memory only (`recording`).
    private let file: URL?
    private let lock = NSLock()
    private var kept: SampleTransport.Recording

    public init(inner: HubTransport, file: URL?, day: String = ISO.localDay()) {
        self.inner = inner
        self.file = file
        self.kept = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(SampleTransport.Recording.self, from: $0) } ?? .init(day: day)
    }

    /// What has been recorded so far.
    public var recording: SampleTransport.Recording { lock.withLock { kept } }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let r = try await inner.send(method: method, path: path, query: query, body: body)
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard method == "GET", r.status < 300, let text = String(data: r.data, encoding: .utf8) else { return r }
        // Pages of the first full sync are kept; later polls that brought nothing new are not (sample mode answers
        // those itself).
        if p == "sync/changes", query["since"] != "0", text.contains(#""changes":[]"#) { return r }
        // Chats are kept on the device in sample mode: a recorded list would hide the ones made there.
        if p == "ai/sessions" || p.hasPrefix("ai/sessions/") { return r }
        // Mail is never written down on a device, a recording included.
        if p == "mail" || p.hasPrefix("mail/") { return r }
        lock.withLock {
            kept.entries[SampleTransport.key(method: method, path: p, query: query, recordedDay: kept.day)] = .init(status: r.status, body: text)
            if let file, let data = try? JSONEncoder().encode(kept) { try? data.write(to: file, options: .atomic) }
        }
        return r
    }
}
#endif
