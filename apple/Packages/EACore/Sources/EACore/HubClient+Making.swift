import Foundation

/// One row of a project's parts list checked against the inventory (`GET /projects/:id/summary`).
public struct ProjectPartRow: Codable, Hashable, Sendable {
    public var name: String
    public var qty: Double
    public var have: Double
    public var missing: Double
    public var inventory_id: String?

    public init(name: String, qty: Double, have: Double, missing: Double, inventory_id: String? = nil) {
        self.name = name; self.qty = qty; self.have = have; self.missing = missing; self.inventory_id = inventory_id
    }

    enum CodingKeys: String, CodingKey { case name, qty, have, missing, inventory_id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        qty = try c.decodeIfPresent(Double.self, forKey: .qty) ?? 1
        have = try c.decodeIfPresent(Double.self, forKey: .have) ?? 0
        missing = try c.decodeIfPresent(Double.self, forKey: .missing) ?? max(0, qty - have)
        inventory_id = try c.decodeIfPresent(String.self, forKey: .inventory_id)
    }
}

/// `GET /projects/:id/summary`. Everything but the plan note and the last session close is also in the local store.
public struct ProjectSummary: Decodable, Sendable {
    public struct Tasks: Decodable, Sendable {
        public var next: [Entity]?
        public var doing: [Entity]?
        public var done_7d: [Entity]?
    }
    public var project: Entity?
    public var tasks: Tasks?
    public var notes: [Entity]?
    public var plan_note: Entity?
    public var procedures: [Entity]?
    public var music: [Entity]?
    public var parts: [ProjectPartRow]?
    public var last_session_close: String?
}

/// The `creative` block of `GET /status`; the rest of that response is not needed here.
public struct CreativeStatus: Decodable, Sendable {
    public struct Creative: Decodable, Sendable {
        public var projects_active: Int?
        public var procedures_open: Int?
        public var music_ideas: Int?
        public var quiz_streak_days: Int?
    }
    public var creative: Creative?
}

public enum QuizResult: String, Codable, CaseIterable, Sendable { case right, wrong, revealed }

/// Module 5 routes: projects, procedures, music and the recall quiz.
extension HubClient {
    public func projectSummary(_ id: String) async throws -> ProjectSummary {
        try await get("projects/\(id)/summary", as: ProjectSummary.self)
    }

    /// Upserts `Projects/<name>/Plan.md`. Sections left nil keep what the note has; the log line is dated and appended.
    public func projectPlan(_ id: String, goal: String? = nil, current: String? = nil, next: String? = nil, parts: String? = nil, logLine: String? = nil) async throws -> Entity {
        struct S: Encodable { var goal: String?; var current: String?; var next: String?; var parts: String?; var log_line: String? }
        struct B: Encodable { var sections: S }
        return try await post("projects/\(id)/plan", B(sections: S(goal: goal, current: current, next: next, parts: parts, log_line: logLine)), as: Entity.self)
    }

    public func procedureFromText(text: String, title: String? = nil, host: String? = nil, projectId: String? = nil) async throws -> Entity {
        struct B: Encodable { var text: String; var title: String?; var host: String?; var project_id: String? }
        return try await post("procedures/from-text", B(text: text, title: title, host: host, project_id: projectId), as: Entity.self)
    }

    /// Marks the current step done and moves on, or with `back` steps back without clearing anything. `step` is the
    /// step on screen: a request sent again after a lost reply then changes nothing, instead of passing a step unseen.
    public func procedureAdvance(_ id: String, back: Bool = false, step: Int? = nil) async throws -> Entity {
        struct B: Encodable { var done: Bool?; var back: Bool?; var step: Int? }
        return try await post("procedures/\(id)/advance", back ? B(done: nil, back: true, step: step) : B(done: true, back: nil, step: step), as: Entity.self)
    }

    public func procedureReset(_ id: String) async throws -> Entity {
        struct B: Encodable {}
        return try await post("procedures/\(id)/reset", B(), as: Entity.self)
    }

    /// One line such as `Am F C G 6/8 112bpm drop D` becomes a `music_idea`.
    public func musicQuick(_ text: String) async throws -> Entity {
        struct B: Encodable { var text: String }
        return try await post("music/quick", B(text: text), as: Entity.self)
    }

    /// Today's quiz, or nil when none was built.
    public func quizToday() async throws -> Entity? {
        try await get("quiz/today", as: Entity?.self)
    }

    /// `POST /quiz/build`: make today's quiz from today's chats now (the model runs only when asked). Nil when there is nothing to ask.
    public func quizBuild() async throws -> Entity? {
        try await post("quiz/build", [String: String](), as: Entity?.self)
    }

    /// Notes waiting for tags and links from the model, and whether they are being read now.
    public struct NoteLinking: Decodable, Equatable, Sendable { public var waiting: Int; public var running: Bool }
    public func notesLinking() async throws -> NoteLinking { try await get("notes/link", as: NoteLinking.self) }
    public func notesLinkNow() async throws -> NoteLinking { try await post("notes/link", [String: String](), as: NoteLinking.self) }

    public func quizAnswer(_ id: String, index: Int, result: QuizResult) async throws -> Entity {
        struct B: Encodable { var index: Int; var result: QuizResult }
        return try await post("quiz/\(id)/answer", B(index: index, result: result), as: Entity.self)
    }

    public func creativeStatus() async throws -> CreativeStatus {
        try await get("status", as: CreativeStatus.self)
    }
}

extension HubError {
    /// True when the hub could not be reached at all, so a local fallback is right. False when it answered with a refusal.
    public var isUnreachable: Bool {
        switch self {
        case .notConfigured, .transport, .phoneUnreachable: return true
        case .http, .decoding, .conflict, .deviceRemoved: return false
        }
    }
}
