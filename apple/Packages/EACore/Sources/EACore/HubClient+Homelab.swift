import Foundation

// Module 2 (hosts, snippets) and Module 6 (ops) routes that are not plain synced data.

/// One row of `GET /hosts`, derived by the hub from runbook, journal and snippet entities plus `host:` facts.
public struct HostSummary: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var host: String
    public var runbooks: Int
    public var journal_entries: Int
    public var last_change: String?
    public var snippets: Int
    public var id: String { host }

    public init(host: String, runbooks: Int = 0, journal_entries: Int = 0, last_change: String? = nil, snippets: Int = 0) {
        self.host = host; self.runbooks = runbooks; self.journal_entries = journal_entries; self.last_change = last_change; self.snippets = snippets
    }

    enum CodingKeys: String, CodingKey { case host, runbooks, journal_entries, last_change, snippets }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decode(String.self, forKey: .host)
        runbooks = try c.decodeIfPresent(Int.self, forKey: .runbooks) ?? 0
        journal_entries = try c.decodeIfPresent(Int.self, forKey: .journal_entries) ?? 0
        last_change = try c.decodeIfPresent(String.self, forKey: .last_change)
        snippets = try c.decodeIfPresent(Int.self, forKey: .snippets) ?? 0
    }
}

/// A monitor from `GET /ops`: the entity with its open incident attached.
public struct OpsMonitor: Decodable, Equatable, Identifiable, Sendable {
    public var entity: Entity
    public var incident_open: Entity?
    public var id: String { entity.id }

    enum CodingKeys: String, CodingKey { case incident_open }

    public init(from decoder: Decoder) throws {
        entity = try Entity(from: decoder)
        incident_open = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(Entity.self, forKey: .incident_open)
    }
}

public struct UptimeEntry: Decodable, Equatable, Sendable {
    public var name: String
    public var pct: Double?
}

/// `GET /ops`: the board the Ops screen is built from.
public struct OpsBoard: Decodable, Equatable, Sendable {
    public var monitors: [OpsMonitor]
    public var incidents_open: [Entity]
    public var incidents_7d: Int
    public var uptime_24h: [UptimeEntry]
    public var watches_due_30d: [Entity]
    public var journal_recent: [Entity]
    public var hosts: [HostSummary]

    enum CodingKeys: String, CodingKey { case monitors, incidents_open, incidents_7d, uptime_24h, watches_due_30d, journal_recent, hosts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        monitors = try c.decodeIfPresent([OpsMonitor].self, forKey: .monitors) ?? []
        incidents_open = try c.decodeIfPresent([Entity].self, forKey: .incidents_open) ?? []
        incidents_7d = Int(try c.decodeIfPresent(Double.self, forKey: .incidents_7d) ?? 0)
        uptime_24h = try c.decodeIfPresent([UptimeEntry].self, forKey: .uptime_24h) ?? []
        watches_due_30d = try c.decodeIfPresent([Entity].self, forKey: .watches_due_30d) ?? []
        journal_recent = try c.decodeIfPresent([Entity].self, forKey: .journal_recent) ?? []
        hosts = try c.decodeIfPresent([HostSummary].self, forKey: .hosts) ?? []
    }

    /// 24 h uptime percent by monitor name.
    public var uptimeByName: [String: Double] {
        var out: [String: Double] = [:]
        for u in uptime_24h { if let p = u.pct { out[u.name] = p } }
        return out
    }
}

/// One row of `GET /monitors/:id/history`.
public struct MonitorCheck: Decodable, Equatable, Sendable {
    public var at: String
    public var ok: Bool
    public var latency_ms: Double?
    public var error: String?
}

/// `POST /preflight` as sent: `destructive` and, when true, the rule and its wording.
struct PreflightCheck: Decodable {
    var destructive: Bool
    var name: String?
    var command: String?
    var backup: String?
    var verify: String?
    var rollback: String?
    var block: String?
}

/// A destructive command found by the hub's pre-flight rules (hub/src/preflight.ts), worded as in assistant replies.
public struct PreflightHit: Equatable, Sendable {
    public var name: String
    public var command: String
    /// "Back up: ...", "Verify: ...", "Rollback: ..." with their labels.
    public var backup: String
    public var verify: String
    public var rollback: String
    /// The whole block the assistant inserts: "Pre-flight for `cmd` (name):" and the three lines as a list.
    public var block: String
    /// The rollback without its label, for the journal's rollback field.
    public var rollbackText: String {
        rollback.replacingOccurrences(of: #"^Rollback:\s*"#, with: "", options: .regularExpression)
    }
}

extension HubClient {
    // MARK: Hosts and snippets (Module 2)

    /// `GET /hosts`.
    public func hostSummaries() async throws -> [HostSummary] { try await get("hosts", as: [HostSummary].self) }

    /// `POST /snippets/:id/render`. The hub fills defaults, sets `last_used`, and answers 422 with the missing names.
    public func renderSnippet(id: String, params: [String: String]) async throws -> String {
        struct B: Encodable { var params: [String: String] }
        struct R: Decodable { var text: String }
        return try await post("snippets/\(id)/render", B(params: params), as: R.self).text
    }

    /// `POST /snippets/:id/run`: try a snippet on its host. Read-only snippets run at once; one that changes something
    /// is a 409 (the assistant runs it after approval).
    public func runSnippet(id: String, params: [String: String]) async throws -> SnippetRun {
        struct B: Encodable { var params: [String: String] }
        return try await post("snippets/\(id)/run", B(params: params), as: SnippetRun.self)
    }

    /// `POST /preflight`: the assistant's destructive-command check for a command typed by hand. Nil when harmless.
    public func preflight(text: String) async throws -> PreflightHit? {
        struct B: Encodable { var text: String }
        let r = try await post("preflight", B(text: text), as: PreflightCheck.self)
        guard r.destructive, let name = r.name, let block = r.block else { return nil }
        return PreflightHit(name: name, command: r.command ?? text, backup: r.backup ?? "", verify: r.verify ?? "", rollback: r.rollback ?? "", block: block)
    }

    /// The journal form's check: nil for blank text, harmless text, and whenever the hub cannot be asked, so offline stays quiet.
    public func preflightQuietly(text: String) async -> PreflightHit? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (try? await preflight(text: text)) ?? nil
    }

    // MARK: Ops (Module 6)

    /// `GET /ops`. A 404 means the hub has no monitors module.
    public func opsBoard() async throws -> OpsBoard { try await get("ops", as: OpsBoard.self) }

    /// `POST /monitors/:id/check`: runs the check now and returns the updated monitor.
    public func checkMonitor(id: String) async throws -> Entity {
        try decode(Entity.self, try await send("POST", "monitors/\(id)/check", body: Data("{}".utf8)))
    }

    /// `GET /monitors/:id/history?hours=`.
    public func monitorHistory(id: String, hours: Int = 24) async throws -> [MonitorCheck] {
        try await get("monitors/\(id)/history", query: ["hours": String(hours)], as: [MonitorCheck].self)
    }

    /// `POST /incidents/:id/ack`. With a note the hub also writes a journal entry and links it.
    public func acknowledgeIncident(id: String, note: String?) async throws -> Entity {
        struct B: Encodable { var note: String? }
        let n = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await post("incidents/\(id)/ack", B(note: (n?.isEmpty ?? true) ? nil : n), as: Entity.self)
    }
}

/// What running a snippet on its host printed.
public struct SnippetRun: Decodable, Sendable {
    public var host: String
    public var command: String
    public var exit_code: Int?
    public var output: String
}
