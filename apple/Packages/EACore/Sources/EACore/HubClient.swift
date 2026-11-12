import Foundation

public enum HubError: Error, LocalizedError, Equatable, Sendable {
    case notConfigured
    case http(status: Int, message: String)
    case transport(String)
    case decoding(String)
    case phoneUnreachable
    /// `POST /planner/schedule` answered 409: the conflicting block, commitment or blackout.
    case conflict(PlannerConflict)
    /// 401 with `device_removed`: this device's own key was removed on the hub (Settings, Devices on any device).
    case deviceRemoved

    public var errorDescription: String? {
        switch self {
        case .notConfigured: return "Hub not configured"
        case .http(let status, let message): return "HTTP \(status): \(message)"
        case .transport(let m): return m
        case .decoding(let m): return "Bad response: \(m)"
        case .phoneUnreachable: return "iPhone not reachable"
        case .conflict(let c): return "Conflicts with \(c.summary)"
        case .deviceRemoved: return "This device was removed from the hub"
        }
    }
    public var isAuth: Bool {
        if case .deviceRemoved = self { return true }
        if case .http(let s, _) = self { return s == 401 }
        return false
    }
    public var isDeviceRemoved: Bool { if case .deviceRemoved = self { return true }; return false }
    /// The hub refused the body as too large (413), or the Watch relay would not carry it.
    public var isTooLarge: Bool {
        if case .http(let s, _) = self { return s == 413 }
        if case .transport(let m) = self { return m.hasPrefix("Request too large for the Watch relay") }
        return false
    }
    public var isConflict: Bool {
        if case .conflict = self { return true }
        if case .http(let s, _) = self { return s == 409 || s == 422 }
        return false
    }
    public var plannerConflict: PlannerConflict? { if case .conflict(let c) = self { return c }; return nil }
}

/// How raw requests reach the hub: HTTP directly, or relayed through the iPhone on the Watch.
public protocol HubTransport: Sendable {
    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data)
}

/// Direct URLSession transport with a bearer key (iPhone, iPad, Mac): the device's own key, or the hub's shared key
/// on an install that has not traded it yet.
public struct HTTPTransport: HubTransport {
    public let baseURL: URL
    public let token: String
    public let session: URLSession

    /// `pin`: the SHA-256 of the hub's certificate; with an https address only that certificate is accepted.
    public init(baseURL: URL, token: String, session: URLSession? = nil, pin: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        if let s = session {
            self.session = s
        } else if baseURL.scheme?.lowercased() == "https", let p = HubPin.normalize(pin) {
            self.session = PinnedSessions.session(pin: p)
        } else {
            self.session = URLSession(configuration: Self.sessionConfiguration())
        }
    }

    /// 20 s without a byte from the hub ends a request (routes that wait longer set their own, see `timeout(path:)`).
    static func sessionConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return c
    }

    /// The hub address as typed, made into a URL. With no scheme it is https://, as on the web app, so a typed address
    /// never sends the device key unencrypted; only this computer's own address (a hub in development) gets http://.
    /// Nil when it is not one.
    public static func hubURL(_ urlString: String) -> URL? {
        var s = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if let d = DirectHub.parse(s) { return DirectHub.baseURL(node: d.node) }
        if !s.contains("://") {
            let host = s.split(separator: "/").first.map(String.init) ?? s
            let loopback = host.hasPrefix("localhost") || host.hasPrefix("127.") || host.hasPrefix("[::1]")
            s = (loopback ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    /// Build a transport from a user typed URL string. Returns nil when it is not a URL.
    public static func make(urlString: String, token: String, pin: String? = nil) -> HTTPTransport? {
        // A Direct link hub: requests go over iroh, through the session the app installed (none: no transport here).
        if let d = DirectHub.parse(urlString) {
            guard let base = DirectHub.baseURL(node: d.node), let session = DirectLinkBridge.session?(d.node, d.relay) else { return nil }
            return HTTPTransport(baseURL: base, token: token, session: session)
        }
        // A Tailscale hub, with Tailscale signed in inside Aeneas: through that connection.
        if Tailnet.isTailnetHub(urlString), let base = hubURL(urlString), let session = TailnetBridge.session?() {
            return HTTPTransport(baseURL: base, token: token, session: session)
        }
        return hubURL(urlString).map { HTTPTransport(baseURL: $0, token: token, pin: pin) }
    }

    /// This device's hub, key and pin.
    public static func make(config: SharedConfig) -> HTTPTransport? {
        make(urlString: config.hubURL, token: config.credential, pin: config.hubPin)
    }

    public func request(method: String, path: String, query: [String: String] = [:], body: Data? = nil, timeout: TimeInterval? = nil) -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) }
        if !items.isEmpty { comps.queryItems = items }
        var r = URLRequest(url: comps.url!)
        r.httpMethod = method
        if !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            r.httpBody = body
            r.setValue(Self.contentType(path: path), forHTTPHeaderField: "Content-Type")
        }
        if let t = timeout { r.timeoutInterval = t }
        return r
    }

    /// How long a request may wait in silence for the hub. An assistant reply comes back whole, and the hub gives each
    /// model call up to 2 minutes (more with tool rounds), so the session's 20 s cut answers off while the hub was still
    /// writing them: on the iPhone, and on the Watch, whose requests the iPhone relays through this transport.
    public static func timeout(path: String) -> TimeInterval? {
        path == "ai/chat" ? 300 : nil
    }

    /// Request bodies are JSON except a vault note (markdown) and an image shape (PNG).
    public static func contentType(path: String) -> String {
        if path.hasPrefix("vault/file") { return "text/markdown; charset=utf-8" }
        if path.hasPrefix("prefs/feel/images") { return "image/png" }
        if path.hasPrefix("images/library") { return "application/octet-stream" }
        return "application/json"
    }

    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let r = request(method: method, path: path, query: query, body: body, timeout: Self.timeout(path: path))
        let data: Data
        let resp: URLResponse
        do { (data, resp) = try await session.data(for: r) }
        catch { throw HubError.transport(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw HubError.transport("No HTTP response") }
        return (http.statusCode, data)
    }
}

/// Client for every route in section 3 of the contract. Streaming routes need an `HTTPTransport`.
public final class HubClient: Sendable {
    public let transport: HubTransport
    public let http: HTTPTransport?

    public init(transport: HubTransport) {
        self.transport = transport
        self.http = transport as? HTTPTransport
    }

    public convenience init(baseURL: URL, token: String, session: URLSession? = nil) {
        self.init(transport: HTTPTransport(baseURL: baseURL, token: token, session: session))
    }

    /// Build a direct client from a user typed URL string. Returns nil when it is not a URL.
    public static func make(urlString: String, token: String, pin: String? = nil) -> HubClient? {
        HTTPTransport.make(urlString: urlString, token: token, pin: pin).map { HubClient(transport: $0) }
    }

    /// A client for this device's hub with its own key (or the shared key until it is traded).
    public static func make(config: SharedConfig) -> HubClient? {
        // Sample mode has no hub and no network: every answer comes from the app's recording.
        if config.sampleMode { return SampleTransport.shared.map { HubClient(transport: $0) } }
        #if DEBUG
        // `-EARecordSample YES` (simulator, against the demo hub): every answer is kept to make SampleHub.json.
        if UserDefaults.standard.bool(forKey: "EARecordSample"), let t = HTTPTransport.make(config: config),
           let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            return HubClient(transport: RecordingTransport(inner: t, file: docs.appendingPathComponent("sample-record.json")))
        }
        #endif
        return HTTPTransport.make(config: config).map { HubClient(transport: $0) }
    }

    /// `/live` and `/ai/chat/stream` are only available over HTTP, not through the Watch relay.
    public var supportsStreaming: Bool { http != nil }

    // MARK: request plumbing

    /// Internal (not private) so area extensions in their own files (HubClient+Ops.swift and so on) can use it.
    func send(_ method: String, _ path: String, query: [String: String?] = [:], body: Data? = nil) async throws -> Data {
        var q: [String: String] = [:]
        for (k, v) in query { if let v = v { q[k] = v } }
        let (status, data) = try await transport.send(method: method, path: path, query: q, body: body)
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
        return data
    }

    /// The error for a refused request. A 401 that says `device_removed` means this device's key is gone for good.
    static func error(status: Int, data: Data) -> HubError {
        struct Removed: Decodable { var device_removed: Bool? }
        if status == 401, (try? JSONCoding.decode(Removed.self, from: data))?.device_removed == true { return .deviceRemoved }
        let msg = (try? JSONCoding.decode(APIError.self, from: data).error) ?? String(decoding: data.prefix(200), as: UTF8.self)
        return .http(status: status, message: msg)
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONCoding.decode(T.self, from: data) } catch { throw HubError.decoding(String(describing: error)) }
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as: T.Type) async throws -> T {
        try decode(T.self, try await send("GET", path, query: query))
    }

    func post<B: Encodable, T: Decodable>(_ path: String, _ body: B, as: T.Type, method: String = "POST", query: [String: String?] = [:]) async throws -> T {
        try decode(T.self, try await send(method, path, query: query, body: try JSONCoding.data(body)))
    }

    // MARK: Health
    public func health() async throws -> HealthResponse { try await get("health", as: HealthResponse.self) }

    // MARK: Sync
    /// `deviceId` marks this device as seen, so a device that only reads still shows when it last synced.
    public func changes(since: Int, kinds: [Kind]? = nil, space: Space? = nil, deviceId: String? = nil) async throws -> ChangesResponse {
        try await get("sync/changes", query: [
            "since": String(since),
            "device_id": deviceId.flatMap { $0.isEmpty ? nil : $0 },
            "kinds": kinds.map { $0.map(\.rawValue).joined(separator: ",") },
            "space": space?.rawValue
        ], as: ChangesResponse.self)
    }

    public func push(deviceId: String, patches: [Patch]) async throws -> PushResponse {
        try await post("sync/push", PushRequest(device_id: deviceId, patches: patches), as: PushResponse.self)
    }

    // MARK: Live
    /// Opens `GET /live` and yields events until the connection drops or the task is cancelled.
    public func live(deviceId: String? = nil) -> AsyncThrowingStream<LiveEvent, Error> {
        guard let http = http else { return unsupportedStream() }
        let query = deviceId.flatMap { $0.isEmpty ? nil : ["device_id": $0] } ?? [:]
        return sse(http.request(method: "GET", path: "live", query: query, timeout: 3600), session: http.session) { Self.liveEvent($0) }
    }

    /// One `/live` message as an event. Separate from the stream so the decoding can be tested.
    static func liveEvent(_ msg: SSEMessage) -> LiveEvent {
        let d = Data(msg.data.utf8)
        switch msg.event {
        case "change":
            struct C: Decodable { var seq: Int; var id: String; var kind: Kind }
            if let c = try? JSONCoding.decode(C.self, from: d) { return .change(seq: c.seq, id: c.id, kind: c.kind) }
            return .unknown(name: msg.event, data: msg.data)
        case "notify":
            struct N: Decodable { var id: String?; var kind: String?; var title: String?; var at: String?; var friction: Friction?; var log_id: String? }
            if let n = try? JSONCoding.decode(N.self, from: d) {
                return .notify(NotifyEvent(kind: n.kind ?? "reminder", id: n.id, title: n.title ?? "", at: n.at, friction: n.friction, log_id: n.log_id))
            }
            return .unknown(name: msg.event, data: msg.data)
        case "modules":
            if let m = try? JSONCoding.decode(ModulesResponse.self, from: d) { return .modules(m.modules) }
            return .unknown(name: msg.event, data: msg.data)
        case "ping": return .ping
        default: return .unknown(name: msg.event, data: msg.data)
        }
    }

    private func unsupportedStream<T: Sendable>() -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { c in c.finish(throwing: HubError.transport("Streaming is not available on this device")) }
    }

    private func sse<T: Sendable>(_ r: URLRequest, session: URLSession, map: @escaping @Sendable (SSEMessage) -> T?) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = r
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse else { throw HubError.transport("No HTTP response") }
                    guard (200..<300).contains(http.statusCode) else { throw HubError.http(status: http.statusCode, message: "stream refused") }
                    var parser = SSEParser()
                    var lines = SSELineBuffer()
                    // Byte by byte, not `bytes.lines`: that sequence drops the blank lines that end SSE events.
                    for try await byte in bytes {
                        guard let line = lines.append(byte) else { continue }
                        if Task.isCancelled { break }
                        if let msg = parser.feed(line: line), let v = map(msg) { continuation.yield(v) }
                    }
                    if let rest = lines.flush(), let msg = parser.feed(line: rest), let v = map(msg) { continuation.yield(v) }
                    if let msg = parser.feed(line: ""), let v = map(msg) { continuation.yield(v) }
                    continuation.finish()
                } catch {
                    if error is CancellationError { continuation.finish() } else { continuation.finish(throwing: HubError.transport(error.localizedDescription)) }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Entities
    public func entity(_ id: String) async throws -> Entity { try await get("entities/\(id)", as: Entity.self) }

    public func entities(kind: Kind? = nil, status: String? = nil, space: Space? = nil, limit: Int? = nil) async throws -> [Entity] {
        try await get("entities", query: ["kind": kind?.rawValue, "status": status, "space": space?.rawValue, "limit": limit.map(String.init)], as: [Entity].self)
    }

    public func createEntity(kind: Kind, space: Space? = nil, fields: [String: JSONValue]) async throws -> Entity {
        struct B: Encodable { var kind: Kind; var space: Space?; var fields: [String: JSONValue] }
        return try await post("entities", B(kind: kind, space: space, fields: fields), as: Entity.self)
    }

    public func patchEntity(_ id: String, fields: [String: JSONValue]) async throws -> Entity {
        struct B: Encodable { var fields: [String: JSONValue] }
        return try await post("entities/\(id)", B(fields: fields), as: Entity.self, method: "PATCH")
    }

    public func deleteEntity(_ id: String) async throws { _ = try await send("DELETE", "entities/\(id)") }

    // MARK: Capture
    public func capture(_ req: CaptureRequest) async throws -> CaptureResponse { try await post("capture", req, as: CaptureResponse.self) }

    /// Ask the hub to load the start every chat shares into the model's cache, so the first reply does not wait for it.
    /// The hub answers at once and skips it when the cache is already warm.
    public func warmAssistant() async throws {
        _ = try await post("ai/warm", [String: String](), as: WarmAck.self)
    }

    /// Have the assistant file one capture now; answers with the capture when it is done.
    public func fileCapture(_ id: String) async throws -> Entity {
        try await post("capture/\(id)/file", [String: String](), as: Entity.self)
    }

    public func convertCapture(_ id: String, to kind: Kind, fields: [String: JSONValue]? = nil) async throws -> Entity {
        try await post("capture/\(id)/convert", ConvertRequest(kind: kind, fields: fields), as: Entity.self)
    }

    // MARK: Reminders
    public func snooze(_ id: String, until: String, reason: String?) async throws {
        _ = try await send("POST", "reminders/\(id)/snooze", body: try JSONCoding.data(SnoozeRequest(until: until, reason: reason)))
    }

    public func ack(_ id: String) async throws { _ = try await send("POST", "reminders/\(id)/ack") }


    // MARK: Search
    public func search(_ q: String, kinds: [Kind]? = nil, limit: Int = 50) async throws -> [SearchHit] {
        try await get("search", query: ["q": q, "kinds": kinds.map { $0.map(\.rawValue).joined(separator: ",") }, "limit": String(limit)], as: SearchResponse.self).hits
    }

    // MARK: Notes (knowledge map)
    public func related(noteId: String) async throws -> RelatedResponse { try await get("notes/\(noteId)/related", as: RelatedResponse.self) }
    public func related(itemId: String) async throws -> [RelatedItem] { try await get("entities/\(itemId)/related", as: RelatedItemsResponse.self).items }

    public func suggest(noteId: String, ai: Bool) async throws -> SuggestResponse {
        try decode(SuggestResponse.self, try await send("POST", "notes/\(noteId)/suggest", query: ["ai": ai ? "true" : "false"]))
    }

    public func accept(noteId: String, tags: [String]? = nil) async throws -> Entity {
        struct B: Encodable { var tags: [String]? }
        return try await post("notes/\(noteId)/accept", B(tags: tags), as: Entity.self)
    }

    public func graph() async throws -> NoteGraph { try await get("notes/graph", as: NoteGraph.self) }

    // MARK: Vault (markdown export surface)
    /// `mtime` is the ISO time the hub sends (a number never decoded).
    public struct VaultEntry: Codable, Sendable { public var path: String; public var hash: String?; public var mtime: String?; public var size: Int? }
    public func vaultIndex() async throws -> [VaultEntry] { try await get("vault/index", as: [VaultEntry].self) }
    public func vaultFile(path: String) async throws -> String {
        String(decoding: try await send("GET", "vault/file", query: ["path": path]), as: UTF8.self)
    }
    public func putVaultFile(path: String, mtime: String?, markdown: String) async throws {
        _ = try await send("PUT", "vault/file", query: ["path": path, "mtime": mtime], body: Data(markdown.utf8))
    }
    public func deleteVaultFile(path: String) async throws { _ = try await send("DELETE", "vault/file", query: ["path": path]) }

    // MARK: Logs and dashboard
    public func log(_ req: LogRequest) async throws -> Entity { try await post("log", req, as: Entity.self) }
    public func dashboard() async throws -> Dashboard { try await get("dashboard", as: Dashboard.self) }

    // MARK: AI
    public func chat(_ req: ChatRequest) async throws -> ChatResponse { try await post("ai/chat", req, as: ChatResponse.self) }

    // MARK: Chats kept on the hub
    public func aiSessions(limit: Int = 100) async throws -> [AISessionItem] {
        struct R: Decodable { var sessions: [AISessionItem] }
        return try await get("ai/sessions", query: ["limit": String(limit)], as: R.self).sessions
    }
    public func aiSession(_ id: String) async throws -> AISession { try await get("ai/sessions/\(id)", as: AISession.self) }
    public func deleteAISession(_ id: String) async throws { _ = try await send("DELETE", "ai/sessions/\(id)") }
    /// Erase every chat on the hub (images, command output and ledgers included).
    public func wipeAISessions() async throws { _ = try await send("DELETE", "ai/sessions", body: Data(#"{"confirm":"wipe all chats"}"#.utf8)) }
    public func cancelAction(_ id: String) async throws { _ = try await send("POST", "ai/actions/\(id)/cancel", body: Data("{}".utf8)) }
    /// Raw bytes of an image stored with a chat.
    public func aiImage(_ id: String) async throws -> Data { try await send("GET", "ai/images/\(id)") }

    /// Streaming chat: `token` events then one `done` event carrying the full ChatResponse.
    public func chatStream(_ req: ChatRequest) throws -> AsyncThrowingStream<ChatStreamEvent, Error> {
        guard let http = http else { return unsupportedStream() }
        let r = http.request(method: "POST", path: "ai/chat/stream", body: try JSONCoding.data(req), timeout: 600)
        return sse(r, session: http.session) { msg in
            switch msg.event {
            case "token":
                struct T: Decodable { var token: String?; var text: String? }
                if let t = try? JSONCoding.decode(T.self, from: Data(msg.data.utf8)) { return .token(t.token ?? t.text ?? "") }
                if let s = try? JSONCoding.decode(String.self, from: Data(msg.data.utf8)) { return .token(s) }
                return .token(msg.data)
            case "done":
                if let d = try? JSONCoding.decode(ChatResponse.self, from: Data(msg.data.utf8)) { return .done(d) }
                return nil
            case "tool":
                if let a = try? JSONCoding.decode(ToolAction.self, from: Data(msg.data.utf8)) { return .tool(a) }
                return nil
            case "approval":
                struct A: Decodable { var action: PendingAction }
                if let a = try? JSONCoding.decode(A.self, from: Data(msg.data.utf8)) { return .approval(a.action) }
                return nil
            case "status":
                struct S: Decodable { var text: String }
                if let st = try? JSONCoding.decode(S.self, from: Data(msg.data.utf8)) { return .status(st.text) }
                return nil
            case "photos_request":
                if let r = try? JSONCoding.decode(PhotosRequest.self, from: Data(msg.data.utf8)) { return .photosRequest(r) }
                return nil
            case "error":
                struct E: Decodable { var error: String? }
                let text = (try? JSONCoding.decode(E.self, from: Data(msg.data.utf8)))?.error
                return .failed(text?.isEmpty == false ? text! : "The assistant could not get a reply.")
            default: return nil
            }
        }
    }

    public func classify(_ text: String) async throws -> ClassifyResponse {
        struct B: Encodable { var text: String }
        return try await post("ai/classify", B(text: text), as: ClassifyResponse.self)
    }

    public func resumeCard(projectId: String, sessionId: String) async throws {
        struct B: Encodable { var project_id: String; var session_id: String }
        _ = try await send("POST", "ai/resume-card", body: try JSONCoding.data(B(project_id: projectId, session_id: sessionId)))
    }

    public func memory() async throws -> MemoryResponse { try await get("ai/memory", as: MemoryResponse.self) }

    // MARK: Planner (Module 1: days and tasks)
    /// `GET /planner/week?start=YYYY-MM-DD&min_hours=3`. `start` defaults to the current week's Monday on the hub.
    public func plannerWeek(start: String? = nil, minHours: Double? = nil) async throws -> PlannerWeek {
        var w = try await get("planner/week", query: ["start": start, "min_hours": minHours.map { JSONValue.number($0).displayString }], as: PlannerWeek.self)
        for i in w.days.indices { w.days[i].commitments = w.days[i].commitments.folding(w.days[i].preferences); w.days[i].preferences = nil }
        return w
    }

    /// `POST /planner/schedule`. A 409 is surfaced as `HubError.conflict` carrying the conflicting item.
    public func plannerSchedule(taskId: String, start: String, hours: Double? = nil, force: Bool? = nil) async throws -> Entity {
        let body = try JSONCoding.data(ScheduleRequest(task_id: taskId, start: start, hours: hours, force: force == true ? true : nil))
        let (status, data) = try await transport.send(method: "POST", path: "planner/schedule", query: [:], body: body)
        if status == 409 {
            throw HubError.conflict(PlannerConflict.from(body: data) ?? PlannerConflict(kind: nil, title: (try? JSONCoding.decode(APIError.self, from: data).error)))
        }
        guard (200..<300).contains(status) else {
            let msg = (try? JSONCoding.decode(APIError.self, from: data).error) ?? String(decoding: data.prefix(200), as: UTF8.self)
            throw HubError.http(status: status, message: msg)
        }
        return try decode(Entity.self, data)
    }

    /// `POST /planner/unschedule`: clears `block`; status becomes `next`.
    public func plannerUnschedule(taskId: String) async throws -> Entity {
        struct B: Encodable { var task_id: String }
        return try await post("planner/unschedule", B(task_id: taskId), as: Entity.self)
    }

    /// Preference and info rules folded into `commitments`: online, focus windows and a custody week went missing.
    public func plannerToday() async throws -> PlannerToday {
        var t = try await get("planner/today", as: PlannerToday.self)
        t.commitments = t.commitments.folding(t.preferences); t.preferences = nil
        return t
    }

    // MARK: Watches (renewals and expiries)
    /// `POST /watches/:id/renewed`. Returns the watch when the hub echoes it, else nil.
    @discardableResult
    public func watchRenewed(id: String) async throws -> Entity? {
        let data = try await send("POST", "watches/\(id)/renewed")
        return try? JSONCoding.decode(Entity.self, from: data)
    }

    // MARK: Devices
    public func register(name: String, platform: Platform, pushToken: String? = nil) async throws -> String {
        try await post("devices/register", RegisterRequest(name: name, platform: platform, push_token: pushToken), as: RegisterResponse.self).device_id
    }
}

private struct WarmAck: Decodable { let started: Bool? }
