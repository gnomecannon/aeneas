import Foundation

public enum Kind: String, Codable, CaseIterable, Sendable {
    case capture, note, task, reminder, event, log, fact, rule, runbook, ledger, project, device, watch, plan_rule
    case journal, snippet, pet_event, sensor, reading, food_option, inventory, procedure, music_idea, quiz
    case monitor, incident, checklist, application, game, film, image, person
}

public enum Space: String, Codable, CaseIterable, Sendable { case personal, work }

public enum Source: String, Codable, CaseIterable, Sendable {
    case watch, iphone, ipad, mac, windows, web, shortcut, voice, api
}

public enum TaskStatus: String, Codable, CaseIterable, Sendable { case inbox, next, scheduled, doing, done, parked }
public enum Friction: String, Codable, CaseIterable, Sendable {
    case none, reason
    /// "witness" was removed on 2026-10-28; a reminder still carrying it keeps the typed reason.
    public init(from decoder: Decoder) throws {
        let s = try decoder.singleValueContainer().decode(String.self)
        self = Friction(rawValue: s) ?? (s == "witness" ? .reason : .none)
    }
}
public enum LogType: String, Codable, CaseIterable, Sendable { case weight, med, bp, caffeine, sleep, mood, activity, steps, custom }
public enum FactCategory: String, Codable, CaseIterable, Sendable { case identity, constraint, preference, health, relationship, host, project, gear, history }
public enum RuleEnforce: String, Codable, CaseIterable, Sendable { case prompt, filter, both }
public enum ProjectStatus: String, Codable, CaseIterable, Sendable { case active, parked, done }
public enum Platform: String, Codable, CaseIterable, Sendable { case watch, iphone, ipad, mac, windows, web }
/// `auto` lets the hub pick per message (troubleshooting when hosts or failures come up).
public enum TaskType: String, Codable, CaseIterable, Sendable { case auto, general, troubleshoot, draft, classify, plan }
public enum WatchCategory: String, Codable, CaseIterable, Sendable { case cert, subscription, prescription, insurance, rma, warranty, domain, other }
/// `info` rules (custody weeks and the like) only describe the week; a type added later reads as `info`, never as a
/// failure that would hide the rule or drop a whole planner answer.
public enum PlanRuleType: String, Codable, CaseIterable, Sendable {
    case blackout, commitment, preference, info
    public init(from decoder: Decoder) throws {
        self = PlanRuleType(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .info
    }
}
public enum Weekday: String, Codable, CaseIterable, Sendable { case mon, tue, wed, thu, fri, sat, sun }
public enum SuggestedKind: String, Codable, CaseIterable, Sendable { case task, note, reminder, log, fact, none }

/// Section 1 of the contract: the entity envelope. Field names match the JSON exactly.
public struct Entity: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var kind: Kind
    public var space: Space
    public var created_at: String
    public var updated_at: String
    public var deleted_at: String?
    public var fields: [String: JSONValue]
    public var field_ts: [String: String]

    public init(id: String = UUID().uuidString.lowercased(), kind: Kind, space: Space = .personal,
                created_at: String = ISO.now(), updated_at: String? = nil, deleted_at: String? = nil,
                fields: [String: JSONValue] = [:], field_ts: [String: String] = [:]) {
        self.id = id
        self.kind = kind
        self.space = space
        self.created_at = created_at
        self.updated_at = updated_at ?? created_at
        self.deleted_at = deleted_at
        self.fields = fields
        self.field_ts = field_ts
    }

    enum CodingKeys: String, CodingKey { case id, kind, space, created_at, updated_at, deleted_at, fields, field_ts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        space = try c.decodeIfPresent(Space.self, forKey: .space) ?? .personal
        created_at = try c.decodeIfPresent(String.self, forKey: .created_at) ?? ISO.now()
        updated_at = try c.decodeIfPresent(String.self, forKey: .updated_at) ?? created_at
        deleted_at = try c.decodeIfPresent(String.self, forKey: .deleted_at)
        fields = try c.decodeIfPresent([String: JSONValue].self, forKey: .fields) ?? [:]
        field_ts = try c.decodeIfPresent([String: String].self, forKey: .field_ts) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(space, forKey: .space)
        try c.encode(created_at, forKey: .created_at)
        try c.encode(updated_at, forKey: .updated_at)
        try c.encode(deleted_at, forKey: .deleted_at)
        try c.encode(fields, forKey: .fields)
        try c.encode(field_ts, forKey: .field_ts)
    }

    public var isDeleted: Bool { deleted_at != nil && !(deleted_at ?? "").isEmpty }

    // Typed accessors
    public func string(_ key: String) -> String? { fields[key]?.stringValue }
    public func str(_ key: String, _ fallback: String = "") -> String { fields[key]?.stringValue ?? fallback }
    public func number(_ key: String) -> Double? { fields[key]?.doubleValue }
    public func bool(_ key: String) -> Bool? { fields[key]?.boolValue }
    public func stringArray(_ key: String) -> [String] { fields[key]?.arrayValue?.compactMap { $0.stringValue } ?? [] }
    public func date(_ key: String) -> Date? { ISO.date(fields[key]?.stringValue) }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONCoding.typed(type, from: .object(fields)) }
    public func decoded<T: Decodable>(_ type: T.Type) -> T? { try? decode(type) }

    /// Apply a patch using per-field last writer wins (section 3, push semantics).
    /// Returns true when at least one field changed.
    @discardableResult
    public mutating func apply(_ patch: Patch) -> Bool {
        var changed = false
        for (key, value) in patch.fields {
            let existing = field_ts[key]
            if existing == nil || ISO.isAfter(patch.ts, existing!) {
                if key == "deleted_at" {
                    deleted_at = value.stringValue
                } else {
                    fields[key] = value
                }
                field_ts[key] = patch.ts
                changed = true
            }
        }
        if changed, ISO.isAfter(patch.ts, updated_at) { updated_at = patch.ts }
        return changed
    }

    /// Merge a hub copy into this local copy field by field, so pending local edits
    /// with a newer ts are not clobbered by an older hub value.
    public mutating func merge(hub: Entity) {
        for (key, value) in hub.fields {
            let hubTs = hub.field_ts[key] ?? hub.updated_at
            let localTs = field_ts[key]
            if localTs == nil || !ISO.isAfter(localTs!, hubTs) {
                fields[key] = value
                field_ts[key] = hubTs
            }
        }
        if let d = hub.deleted_at, !d.isEmpty {
            let hubTs = hub.field_ts["deleted_at"] ?? hub.updated_at
            let localTs = field_ts["deleted_at"]
            if localTs == nil || !ISO.isAfter(localTs!, hubTs) { deleted_at = d; field_ts["deleted_at"] = hubTs }
        } else if hub.field_ts["deleted_at"] != nil, let localTs = field_ts["deleted_at"], !ISO.isAfter(localTs, hub.field_ts["deleted_at"]!) {
            deleted_at = nil
        }
        if ISO.isAfter(hub.updated_at, updated_at) { updated_at = hub.updated_at }
        created_at = hub.created_at
        space = hub.space
    }
}

/// Section 3: Patch. `ts` is the write time used for last writer wins.
public struct Patch: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var kind: Kind
    public var space: Space?
    public var ts: String
    public var fields: [String: JSONValue]
    public var create: Bool?

    public init(id: String, kind: Kind, space: Space? = nil, ts: String = ISO.now(), fields: [String: JSONValue], create: Bool? = nil) {
        self.id = id
        self.kind = kind
        self.space = space
        self.ts = ts
        self.fields = fields
        self.create = create
    }
}

public struct Change: Codable, Equatable, Sendable {
    public var seq: Int
    public var entity: Entity
    public init(seq: Int, entity: Entity) { self.seq = seq; self.entity = entity }
}
