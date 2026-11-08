import Foundation

// Section 2 of the contract. Each struct mirrors the kind's field names exactly.
// Optional fields are optional here; required ones have defaults only where the
// contract or the TypeScript schema gives one.

public struct Attachment: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var mime: String
    public var bytes_b64: String
    public init(name: String, mime: String, bytes_b64: String) { self.name = name; self.mime = mime; self.bytes_b64 = bytes_b64 }
}

public struct CaptureFields: Codable, Equatable, Sendable {
    public var text: String
    public var source: Source
    public var transcript_confidence: Double?
    public var attachments: [Attachment]?
    public var processed: Bool?
    public var converted_to: [String]?
    public var suggested_kind: SuggestedKind?
    public init(text: String, source: Source, transcript_confidence: Double? = nil, attachments: [Attachment]? = nil, processed: Bool? = false, converted_to: [String]? = nil, suggested_kind: SuggestedKind? = nil) {
        self.text = text; self.source = source; self.transcript_confidence = transcript_confidence; self.attachments = attachments; self.processed = processed; self.converted_to = converted_to; self.suggested_kind = suggested_kind
    }
}

public struct NoteFields: Codable, Equatable, Sendable {
    public var title: String
    public var body: String?
    public var tags: [String]?
    public var path: String
    public var links: [String]?          // derived by the hub from title mentions; never typed
    public var suggested_tags: [String]? // set by the hub via /notes/:id/suggest
    public var pinned: Bool?
    public init(title: String, body: String? = "", tags: [String]? = [], path: String, links: [String]? = nil, suggested_tags: [String]? = nil, pinned: Bool? = nil) {
        self.title = title; self.body = body; self.tags = tags; self.path = path; self.links = links; self.suggested_tags = suggested_tags; self.pinned = pinned
    }
}

public struct TaskBlock: Codable, Equatable, Sendable {
    public var start: String
    public var end: String
    public init(start: String, end: String) { self.start = start; self.end = end }
}

public struct TaskFields: Codable, Equatable, Sendable {
    public var title: String
    public var notes: String?
    public var status: TaskStatus
    public var order: Double
    public var due: String?
    public var block: TaskBlock?
    public var project_id: String?
    public var done_at: String?
    public var parked_reason: String?
    /// Reminders are tasks (since 2026-10-28): `due` is the optional deadline, `remind_at` the optional notification.
    public var remind_at: String?
    public var `repeat`: String?
    public var friction: Friction?
    public var snoozed_until: String?
    public var snooze_log: [SnoozeEntry]?
    public var fired: [String]?
    public var linked_id: String?
    public var apple: AppleLink?
    public init(title: String, notes: String? = nil, status: TaskStatus = .inbox, order: Double = 0, due: String? = nil, block: TaskBlock? = nil, project_id: String? = nil, done_at: String? = nil, parked_reason: String? = nil,
                remind_at: String? = nil, repeat: String? = nil, friction: Friction? = nil, snoozed_until: String? = nil, linked_id: String? = nil) {
        self.title = title; self.notes = notes; self.status = status; self.order = order; self.due = due; self.block = block; self.project_id = project_id; self.done_at = done_at; self.parked_reason = parked_reason
        self.remind_at = remind_at; self.repeat = `repeat`; self.friction = friction; self.snoozed_until = snoozed_until; self.linked_id = linked_id
    }
}

/// The Apple Reminders item a task mirrors: its calendar item id and list.
public struct AppleLink: Codable, Equatable, Sendable {
    public var id: String
    public var list: String
    public var list_title: String?
    public init(id: String, list: String, list_title: String? = nil) { self.id = id; self.list = list; self.list_title = list_title }
}

public struct SnoozeEntry: Codable, Equatable, Sendable {
    public var at: String
    public var until: String
    public var reason: String
    public init(at: String, until: String, reason: String) { self.at = at; self.until = until; self.reason = reason }
}

public struct ReminderFields: Codable, Equatable, Sendable {
    public var title: String
    public var at: String
    public var `repeat`: String?
    public var friction: Friction
    public var snoozed_until: String?
    public var snooze_log: [SnoozeEntry]?
    public var fired: [String]?
    public var acknowledged_at: String?
    public var linked_id: String?
    public init(title: String, at: String, repeat: String? = nil, friction: Friction = .none, snoozed_until: String? = nil, snooze_log: [SnoozeEntry]? = nil, fired: [String]? = nil, acknowledged_at: String? = nil, linked_id: String? = nil) {
        self.title = title; self.at = at; self.repeat = `repeat`; self.friction = friction; self.snoozed_until = snoozed_until; self.snooze_log = snooze_log; self.fired = fired; self.acknowledged_at = acknowledged_at; self.linked_id = linked_id
    }
}

public struct EventFields: Codable, Equatable, Sendable {
    public enum EventSource: String, Codable, Sendable { case manual, m365, eventkit }
    public var title: String
    public var start: String
    public var end: String
    public var all_day: Bool?
    public var source: EventSource?
    public var external_id: String?
    public var location: String?
}

/// `value` is a number or a string in the contract.
public struct LogFields: Codable, Equatable, Sendable {
    public var type: LogType
    public var value: JSONValue
    public var unit: String?
    public var at: String
    public var note: String?
    public var checkins: [String]?   // hub-managed: when the hub asked whether a long activity is still on purpose
    public var source: Source?
    public init(type: LogType, value: JSONValue, unit: String? = nil, at: String = ISO.now(), note: String? = nil, checkins: [String]? = nil, source: Source? = nil) {
        self.type = type; self.value = value; self.unit = unit; self.at = at; self.note = note; self.checkins = checkins; self.source = source
    }
}

public struct FactFields: Codable, Equatable, Sendable {
    public var category: FactCategory
    public var key: String
    public var value: String
    public var source: String?
    public var confidence: Double?
    public var `private`: Bool?
    public init(category: FactCategory, key: String, value: String, source: String? = nil, confidence: Double? = nil, private: Bool? = nil) {
        self.category = category; self.key = key; self.value = value; self.source = source; self.confidence = confidence; self.private = `private`
    }
}

public struct RuleFields: Codable, Equatable, Sendable {
    public var text: String
    public var enforce: RuleEnforce
    public var pattern: String?
    public var flags: String?
    public var replacement: String?
    public var active: Bool?
    public init(text: String, enforce: RuleEnforce = .both, pattern: String? = nil, flags: String? = nil, replacement: String? = nil, active: Bool? = true) {
        self.text = text; self.enforce = enforce; self.pattern = pattern; self.flags = flags; self.replacement = replacement; self.active = active
    }
}

public struct RunbookCommand: Codable, Equatable, Sendable {
    public var label: String
    public var host: String
    public var user: String
    public var command: String
}

public struct RunbookFields: Codable, Equatable, Sendable {
    public var host: String
    public var title: String
    public var body: String?
    public var commands: [RunbookCommand]?
    public var last_verified: String?
}

public struct LedgerTried: Codable, Equatable, Sendable {
    public var at: String
    public var what: String
    public var result: String
}

public struct LedgerFields: Codable, Equatable, Sendable {
    public var session_id: String
    public var topic: String
    public var tried: [LedgerTried]?
    public var ruled_out: [String]?
    public var confirmed: [String]?
    public var open: Bool?
}

public struct ProjectFields: Codable, Equatable, Sendable {
    public var name: String
    public var status: ProjectStatus
    public var definition_of_done: String
    public var resume_card: String?
    public var plan_doc_path: String?
    public var repo: String?
}

public struct DeviceFields: Codable, Equatable, Sendable {
    public var name: String
    public var platform: Platform
    public var last_seen: String?
    public var push_token: String?
}

/// A renewal or expiry to stay ahead of (section 2, `watch`).
public struct WatchFields: Codable, Equatable, Sendable {
    public var title: String
    public var category: WatchCategory
    public var due: String
    public var lead_days: Int?
    public var `repeat`: String?
    public var probe_url: String?
    public var cost: Double?
    public var url: String?
    public var notes: String?
    public var reminder_id: String?      // hub-managed
    public var last_probe: String?       // hub-managed
    public var last_probe_error: String? // hub-managed
    public var renewed_at: String?
    /// It renews and pays by itself: the hub gives it no reminder and moves `due` on once it passes.
    public var autopay: Bool?
    public init(title: String, category: WatchCategory, due: String, lead_days: Int? = 7, repeat: String? = nil, probe_url: String? = nil, cost: Double? = nil, url: String? = nil, notes: String? = nil, reminder_id: String? = nil, last_probe: String? = nil, last_probe_error: String? = nil, renewed_at: String? = nil) {
        self.title = title; self.category = category; self.due = due; self.lead_days = lead_days; self.repeat = `repeat`; self.probe_url = probe_url; self.cost = cost; self.url = url; self.notes = notes; self.reminder_id = reminder_id; self.last_probe = last_probe; self.last_probe_error = last_probe_error; self.renewed_at = renewed_at
    }
}

/// A standing constraint for the block planner (section 2, `plan_rule`).
public struct PlanRuleFields: Codable, Equatable, Sendable {
    public var title: String
    public var type: PlanRuleType
    public var days: [Weekday]
    public var start: String             // HH:MM local
    public var end: String               // HH:MM local, 24:00 allowed
    public var alternating_anchor: String?
    public var note: String?
    public var active: Bool?
    public init(title: String, type: PlanRuleType, days: [Weekday], start: String, end: String, alternating_anchor: String? = nil, note: String? = nil, active: Bool? = true) {
        self.title = title; self.type = type; self.days = days; self.start = start; self.end = end; self.alternating_anchor = alternating_anchor; self.note = note; self.active = active
    }
}
