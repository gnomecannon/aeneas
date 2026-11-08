import Foundation

/// Sample mode: the app runs on a made-up month (the demo hub's "Alex", hub/scripts/demo-hub.ts) with no hub at all,
/// for anyone trying the app before they set one up, and for App Review. Every answer comes from a recording of the
/// demo hub (SampleHub.json in the app), moved forward so its "today" is the viewer's today. Nothing leaves the
/// device: there is no network in sample mode. Edits stay on this device until sample mode ends, which wipes them.
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
    private let shiftDays: Int
    /// The viewer's today, the base for dates in requests.
    private let todayDay: String
    private let lock = NSLock()
    private var seq: Int
    private var chats: [String: AISession] = [:]

    static let chatReply = "This is sample data, so there is no assistant to answer. With your own hub, the assistant runs on a model on your own computer: it answers questions about your plans, notes and logs, files what you capture, and remembers what you tell it. To set one up, tap Set up my own hub on Today."

    public init(recording: Recording, today: Date = Date()) {
        self.recording = recording
        self.todayDay = ISO.localDay(today)
        let rec = SampleTransport.dayDate(recording.day) ?? today
        self.shiftDays = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: rec), to: Calendar.current.startOfDay(for: today)).day ?? 0
        self.seq = 1_000_000
    }

    public convenience init?(data: Data, today: Date = Date()) {
        guard let r = try? JSONDecoder().decode(Recording.self, from: data) else { return nil }
        self.init(recording: r, today: today)
    }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let key = Self.key(method: method, path: p, query: query, recordedDay: todayDay)
        if let e = recording.entries[key] {
            return (e.status, Data(Self.shift(e.body, days: shiftDays, around: recording.day).utf8))
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
        case ("DELETE", _) where path.hasPrefix("ai/sessions"):
            lock.withLock { if path == "ai/sessions" { chats = [:] } else { chats[String(path.dropFirst("ai/sessions/".count))] = nil } }
            return (200, Data("{}".utf8))
        case ("GET", _):
            return (404, Data(#"{"error":"not in the sample data"}"#.utf8))
        default:
            return (503, Data(#"{"error":"This is sample data: connect your own hub to save this."}"#.utf8))
        }
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
/// Debug builds: every answer of the real hub saved, to make SampleHub.json from the demo hub (launch argument
/// `-EARecordSample YES`, then copy `sample-record.json` out of the app's Documents folder).
public final class RecordingTransport: HubTransport, @unchecked Sendable {
    private let inner: HubTransport
    private let file: URL
    private let lock = NSLock()
    private var recording: SampleTransport.Recording

    public init(inner: HubTransport, file: URL, day: String = ISO.localDay()) {
        self.inner = inner
        self.file = file
        self.recording = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(SampleTransport.Recording.self, from: $0) } ?? .init(day: day)
    }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let r = try await inner.send(method: method, path: path, query: query, body: body)
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard method == "GET", r.status < 300, let text = String(data: r.data, encoding: .utf8) else { return r }
        // Pages of the first full sync are kept; later polls that brought nothing new are not (sample mode answers
        // those itself).
        if p == "sync/changes", query["since"] != "0", text.contains(#""changes":[]"#) { return r }
        lock.withLock {
            recording.entries[SampleTransport.key(method: method, path: p, query: query, recordedDay: recording.day)] = .init(status: r.status, body: text)
            if let data = try? JSONEncoder().encode(recording) { try? data.write(to: file, options: .atomic) }
        }
        return r
    }
}
#endif
