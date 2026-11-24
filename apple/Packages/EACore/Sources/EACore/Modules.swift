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
    /// For a module whose work also needs setting up on the hub: whether it is set up and working there (since
    /// 2026-11-18, only `calendars`: the hub keeps at least one calendar in step). Nil when the hub does not say.
    public var active: Bool?
    /// Where its switch is when not in Settings, Modules: "connections", for Apple Reminders, from hubs of 1.0.17 only,
    /// which kept its switch on the iCloud account in Settings, Connections (gnomecannon/aeneas#10). Since 2026-11-24
    /// every switch is in Settings, Modules again, and each device's own Reminders switch is in Settings, Accounts.
    public var switch_in: String?
    /// The module it is shown under in Settings, Modules, as a sub-option with its own switch (since 2026-11-24:
    /// Receipts and renewals under Mail). Only where it is shown: each works with the other off. Nil for every other
    /// module, and from older hubs.
    public var under: String?

    public struct AdvancedSetup: Codable, Equatable, Hashable, Sendable {
        public var minutes: String
        public var needs: String
    }

    public init(id: String, title: String, summary: String = "", group: String = "", on: Bool, reads: String? = nil, permissions: [String]? = nil, setup: AdvancedSetup? = nil, active: Bool? = nil, under: String? = nil) {
        self.id = id; self.title = title; self.summary = summary; self.group = group; self.on = on
        self.reads = reads; self.permissions = permissions; self.setup = setup; self.active = active; self.under = under
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
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        switch_in = try? c.decodeIfPresent(String.self, forKey: .switch_in)
        under = try? c.decodeIfPresent(String.self, forKey: .under)
    }
}

/// One kind of alert the hub announces, switched on or off on its own, once for every device (`alerts` in
/// `GET /modules`, since 2026-11-20). `id` stays a string so a kind a newer hub adds decodes and shows in Settings.
public struct AlertInfo: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var summary: String
    /// The id of the module the alert belongs to: Settings leaves the alert out while that module is off. Nil for an
    /// alert of no module (activity check-ins, the hub's disk).
    public var module: String?
    public var on: Bool

    public init(id: String, title: String, summary: String = "", module: String? = nil, on: Bool = true) {
        self.id = id; self.title = title; self.summary = summary; self.module = module; self.on = on
    }

    // Only the id is needed to switch a kind; the rest falls back so a thinner answer still decodes. A kind with no
    // `on` is on, as every kind is until it is switched off.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        on = (try? c.decodeIfPresent(Bool.self, forKey: .on)) ?? true
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        module = try? c.decodeIfPresent(String.self, forKey: .module)
    }
}

/// The kinds of alert the hub lists today (`ALERT_KINDS` in the hub's alerts.ts). This device plans or shows some of
/// them with no event from the hub (a reminder's notification, the check-in three hours into an activity), so it
/// has to obey their switches itself; the hub holds back the rest before they reach a device.
public enum AlertKind: String, CaseIterable, Sendable {
    case reminder, digest, activity, mail, monitor, sensor, disk, quiz
}

/// `GET /modules`, `PUT /modules` and the `modules` event on `/live`.
public struct ModulesResponse: Codable, Equatable, Sendable {
    public var modules: [ModuleInfo]
    /// The alert switches (since 2026-11-20). Nil from an older hub: every kind is on and Settings lists none.
    public var alerts: [AlertInfo]?
    public init(modules: [ModuleInfo], alerts: [AlertInfo]? = nil) { self.modules = modules; self.alerts = alerts }

    // Alerts that do not read as a list are left out, as from an older hub, instead of losing the module switches.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        modules = try c.decode([ModuleInfo].self, forKey: .modules)
        alerts = try? c.decodeIfPresent([AlertInfo].self, forKey: .alerts)
    }
}

/// `PUT /modules/alerts`: the whole list as it is now.
public struct AlertsResponse: Codable, Equatable, Sendable {
    public var alerts: [AlertInfo]
    public init(alerts: [AlertInfo]) { self.alerts = alerts }
}

/// The module ids this app has screens or parts for. Anything else from the hub is only listed in Settings.
public enum AppModule: String, CaseIterable, Sendable {
    case renewals, dashboard, homelab, projects, music, wiki, images, quiz, health, pet, food, sensors, games, films, calc, jobs, web
    // Device features with no screen of their own (group "On your devices"), and newer areas.
    case voice, notifications, layouts, mail, contacts
    /// Offline reference: Wikipedia and other open references kept on the hub (since 2026-11-16).
    case reference
    case appleReminders = "apple_reminders"
    case appleCalendar = "apple_calendar"
    /// Calendar accounts: the hub keeps iCloud calendars in step with the app, both ways (since 2026-11-18).
    case calendars
    /// Mail: the Inbox of each linked mailbox (iCloud Mail, Gmail or another mail server) with bundles, Pin, Done and
    /// Snooze (since 2026-11-19). Off on a new hub, so the app shows it only while the hub lists it as on
    /// (`isOnListed`), never while the switches are not known.
    case mailInbox = "mail_inbox"

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
    /// On only when the hub lists it and it is on: for a module that is off on a new hub (Mail), so an older hub that
    /// has no such module, or switches not loaded yet, never show a screen the hub cannot answer.
    public func isOnListed(_ m: AppModule) -> Bool { first { $0.id == m.rawValue }?.on ?? false }

    /// The modules Settings, Modules switches: not one whose switch is elsewhere (`switch_in`), so one setting is never in
    /// two places.
    public var listedInModules: [ModuleInfo] { filter { $0.switch_in == nil } }

    /// Grouped for Settings, groups and modules in the hub's order (a module switched elsewhere left out), but for a
    /// module shown under another (`under`), which comes right after that one (ModuleGroup.nesting).
    public var grouped: [ModuleGroup] {
        var order: [String] = []
        var by: [String: [ModuleInfo]] = [:]
        for m in listedInModules {
            if by[m.group] == nil { order.append(m.group) }
            by[m.group, default: []].append(m)
        }
        return order.map { ModuleGroup.nesting(title: $0, modules: by[$0] ?? []) }
    }
}

extension Array where Element == AlertInfo {
    /// A kind the hub does not list, or a list that never came (an older hub sends none), means on: no alert goes
    /// missing because this device knows less than the hub.
    public func isOn(_ id: String) -> Bool { first { $0.id == id }?.on ?? true }
    public func isOn(_ k: AlertKind) -> Bool { isOn(k.rawValue) }

    /// For Settings, in the hub's order: an alert whose module is off is left out, since nothing would send it.
    public func shown(with modules: [ModuleInfo]) -> [AlertInfo] {
        filter { a in a.module.map { modules.isOn($0) } ?? true }
    }
}

/// Modules that share a Library area, for the Settings list.
public struct ModuleGroup: Equatable, Sendable, Identifiable {
    public var title: String
    /// In the order they show: a sub-option right after the module it sits under.
    public var modules: [ModuleInfo]
    /// The modules shown as a sub-option of the module above them, drawn indented (`under`, since 2026-11-24).
    public var nested: Set<String> = []
    public var id: String { title }

    /// Whether a module is shown indented, as a sub-option of the module above it.
    public func isNested(_ m: ModuleInfo) -> Bool { nested.contains(m.id) }

    /// One area's modules with each one that has `under` moved right after the module it sits under, and marked nested.
    /// It keeps its own switch, so it shows whether that module is on or off. One level only: a module whose parent is
    /// not in the area (an older hub, another area, a switch kept elsewhere), or whose parent sits under another
    /// itself, stays a normal row where the hub put it (the web's nestedOrder, kept the same).
    static func nesting(title: String, modules: [ModuleInfo]) -> ModuleGroup {
        var byId: [String: ModuleInfo] = [:]
        for m in modules where byId[m.id] == nil { byId[m.id] = m }
        func parent(_ m: ModuleInfo) -> String? {
            guard let p = m.under, p != m.id, let pm = byId[p] else { return nil }
            if let pp = pm.under, byId[pp] != nil { return nil }
            return p
        }
        var out: [ModuleInfo] = []
        var nested: Set<String> = []
        for m in modules where parent(m) == nil {
            out.append(m)
            for s in modules where parent(s) == m.id {
                out.append(s)
                nested.insert(s.id)
            }
        }
        return ModuleGroup(title: title, modules: out, nested: nested)
    }
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

    /// The module switches with the alert switches beside them, in one read.
    public func modulesAndAlerts() async throws -> ModulesResponse {
        try await get("modules", as: ModulesResponse.self)
    }

    /// Switch kinds of alert on or off (`{ "<kind>": true | false }`, one or several); answers with the whole list
    /// as it is now. The hub refuses a kind it does not list (422).
    public func setAlerts(_ changes: [String: Bool]) async throws -> [AlertInfo] {
        try await post("modules/alerts", changes, as: AlertsResponse.self, method: "PUT").alerts
    }
}
