import Foundation

/// One part of the app beyond the core that the owner switches on or off, once for every device (`GET /modules`).
/// `id` stays a string so a module added by a newer hub decodes and shows in Settings like any other.
public struct ModuleInfo: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var summary: String
    /// The Library area it sits in, or "Assistant" for something the assistant does with no screen.
    public var group: String
    public var on: Bool
    /// The personal data it reads and where from, in one sentence (since 2026-11-05).
    public var reads: String?
    /// What a device asks for while it is on: `microphone`, `speech`, `notifications`, `reminders`, `calendar`,
    /// `contacts`, `health`, `photos`. Kept as strings so a permission a newer hub names still decodes.
    public var permissions: [String]?
    /// Set when part of it needs the person's own key or app.
    public var setup: AdvancedSetup?

    public struct AdvancedSetup: Codable, Equatable, Hashable, Sendable {
        public var minutes: String
        public var needs: String
    }

    public init(id: String, title: String, summary: String = "", group: String = "", on: Bool, reads: String? = nil, permissions: [String]? = nil, setup: AdvancedSetup? = nil) {
        self.id = id; self.title = title; self.summary = summary; self.group = group; self.on = on
        self.reads = reads; self.permissions = permissions; self.setup = setup
    }

    // Only id and on are needed to hide things; the rest falls back so a thinner answer still decodes.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? true
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        group = try c.decodeIfPresent(String.self, forKey: .group) ?? ""
        reads = try? c.decodeIfPresent(String.self, forKey: .reads)
        permissions = try? c.decodeIfPresent([String].self, forKey: .permissions)
        setup = try? c.decodeIfPresent(AdvancedSetup.self, forKey: .setup)
    }
}

/// `GET /modules`, `PUT /modules` and the `modules` event on `/live`.
public struct ModulesResponse: Codable, Equatable, Sendable {
    public var modules: [ModuleInfo]
    public init(modules: [ModuleInfo]) { self.modules = modules }
}

/// The module ids this app has screens or parts for. Anything else from the hub is only listed in Settings.
public enum AppModule: String, CaseIterable, Sendable {
    case renewals, dashboard, homelab, projects, music, wiki, images, quiz, health, pet, food, sensors, games, films, calc, jobs, web
    // Device features with no screen of their own (group "On your devices"), and newer areas.
    case voice, notifications, layouts, mail, contacts
    case appleReminders = "apple_reminders"
    case appleCalendar = "apple_calendar"

    /// The module an entity kind belongs to, nil for the core. Mirrors the hub's `kinds` in modules.ts.
    public static func of(kind: Kind) -> AppModule? {
        switch kind {
        case .watch: return .renewals
        case .runbook, .journal, .snippet, .monitor, .incident: return .homelab
        case .project, .procedure, .inventory: return .projects
        case .music_idea: return .music
        case .image: return .images
        case .quiz: return .quiz
        case .pet_event: return .pet
        case .food_option: return .food
        case .sensor, .reading: return .sensors
        case .game: return .games
        case .film: return .films
        case .application: return .jobs
        default: return nil
        }
    }
}

extension Array where Element == ModuleInfo {
    /// Unknown or not loaded yet means on, so nothing disappears offline or before the hub first answers.
    public func isOn(_ id: String) -> Bool { first { $0.id == id }?.on ?? true }
    public func isOn(_ m: AppModule) -> Bool { isOn(m.rawValue) }

    /// Grouped for Settings, groups and modules in the hub's order.
    public var grouped: [ModuleGroup] {
        var order: [String] = []
        var by: [String: [ModuleInfo]] = [:]
        for m in self {
            if by[m.group] == nil { order.append(m.group) }
            by[m.group, default: []].append(m)
        }
        return order.map { ModuleGroup(title: $0, modules: by[$0] ?? []) }
    }
}

/// Modules that share a Library area, for the Settings list.
public struct ModuleGroup: Equatable, Sendable, Identifiable {
    public var title: String
    public var modules: [ModuleInfo]
    public var id: String { title }
}

/// `GET /feeds`: keys that open one door each, for a calendar subscription and sensor boards (never the hub token).
public struct FeedKeys: Codable, Equatable, Sendable {
    public struct Door: Codable, Equatable, Sendable { public var key: String; public var path: String }
    public var calendar: Door
    public var sensors: Door
}

extension HubClient {
    public func feedKeys() async throws -> FeedKeys { try await get("feeds", as: FeedKeys.self) }

    /// A new key for "calendar" or "sensors"; the old one stops working.
    public func rotateFeedKey(_ kind: String) async throws -> FeedKeys {
        try await post("feeds/\(kind)/rotate", [String: String](), as: FeedKeys.self)
    }

    public func modules() async throws -> [ModuleInfo] {
        try await get("modules", as: ModulesResponse.self).modules
    }

    /// Switch modules on or off; answers with the whole list as it is now.
    public func setModules(_ changes: [String: Bool]) async throws -> [ModuleInfo] {
        try await post("modules", changes, as: ModulesResponse.self, method: "PUT").modules
    }
}
