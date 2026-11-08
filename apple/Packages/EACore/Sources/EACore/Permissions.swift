import Foundation

/// A device permission a module needs (release rule 2: devices ask only for what the chosen modules need, right after
/// setup or when a module is switched on, never at launch).
public enum DevicePermission: String, CaseIterable, Sendable, Identifiable {
    // The order the permission screen lists and asks them in.
    case notifications, microphone, speech, reminders, calendar, contacts, health, photos, location

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .notifications: return "Notifications"
        case .microphone: return "Microphone"
        case .speech: return "Speech recognition"
        case .reminders: return "Reminders"
        case .calendar: return "Calendars"
        case .contacts: return "Contacts"
        case .health: return "Health"
        case .photos: return "Photos"
        case .location: return "Location"
        }
    }

    /// What it is for, in plain words.
    public var purpose: String {
        switch self {
        case .notifications: return "Shows your reminders and the morning summary at their time, even with no network."
        case .microphone: return "Hears you only from when you tap the mic until you tap it again, or while you record a hum."
        case .speech: return "Turns what you say into text, on this device when it can. A device that cannot uses Apple's speech service while the mic is on, and says so first."
        case .reminders: return "Keeps your tasks and Apple Reminders the same, both ways."
        case .calendar: return "Reads the titles and times of the calendars you pick, and adds your plan to Calendar."
        case .contacts: return "Keeps People and your contacts the same."
        case .health: return "Reads and writes the Health types you allow, such as weight and sleep."
        case .photos: return "Adds pictures you make to your photo library. It does not read your photos."
        case .location: return "Fills in your state's meals tax in the bill splitter. Only an approximate position, sent to your own hub and nowhere else."
        }
    }

    public var symbol: String {
        switch self {
        case .notifications: return "bell.badge"
        case .microphone: return "mic"
        case .speech: return "waveform"
        case .reminders: return "checklist"
        case .calendar: return "calendar"
        case .contacts: return "person.crop.circle"
        case .health: return "heart"
        case .photos: return "photo"
        case .location: return "location"
        }
    }

    /// Whether this platform asks for it at all. The Mac has no Health and saves no pictures to Photos; the Watch only
    /// shows alerts and records hums (its dictation is the system's own and needs no permission).
    public func applies(on platform: Platform) -> Bool {
        switch platform {
        case .iphone, .ipad: return true
        case .mac: return ![.health, .photos].contains(self)
        case .watch: return self == .notifications || self == .microphone
        case .windows, .web: return false
        }
    }
}

/// One permission the modules that are on need, with the modules it is for.
public struct PermissionNeed: Equatable, Identifiable, Sendable {
    public var permission: DevicePermission
    public var modules: [ModuleInfo]
    public var id: String { permission.rawValue }

    public init(permission: DevicePermission, modules: [ModuleInfo]) {
        self.permission = permission
        self.modules = modules
    }

    /// "For Voice and Music."
    public var forLine: String {
        let names = modules.map(\.title)
        guard let last = names.last else { return "" }
        let list = names.count == 1 ? last : names.dropLast().joined(separator: ", ") + " and " + last
        return "For \(list)."
    }
}

public enum PermissionPlan {
    /// What each module asks for when the hub does not say (a hub from before 2026-11-05); the same as modules.ts.
    public static let fallback: [String: [DevicePermission]] = [
        AppModule.voice.rawValue: [.microphone, .speech],
        AppModule.notifications.rawValue: [.notifications],
        AppModule.appleReminders.rawValue: [.reminders],
        AppModule.appleCalendar.rawValue: [.calendar],
        AppModule.contacts.rawValue: [.contacts],
        AppModule.music.rawValue: [.microphone],
        AppModule.images.rawValue: [.photos],
        AppModule.health.rawValue: [.health],
    ]

    /// The module's own list from the hub, else the fallback. Names this app does not know are left out.
    public static func permissions(of m: ModuleInfo) -> [DevicePermission] {
        if let p = m.permissions { return p.compactMap(DevicePermission.init(rawValue:)) }
        return fallback[m.id] ?? []
    }

    /// What the modules that are on need on this platform, in `DevicePermission` order, each with its modules.
    /// On the Watch the microphone is only for hums (Music): voice there is the system's dictation.
    public static func needs(_ modules: [ModuleInfo], platform: Platform) -> [PermissionNeed] {
        var by: [DevicePermission: [ModuleInfo]] = [:]
        for m in modules where m.on {
            for p in permissions(of: m) where p.applies(on: platform) {
                if platform == .watch, p == .microphone, m.id != AppModule.music.rawValue { continue }
                if by[p]?.contains(where: { $0.id == m.id }) != true { by[p, default: []].append(m) }
            }
        }
        return DevicePermission.allCases.compactMap { p in by[p].map { PermissionNeed(permission: p, modules: $0) } }
    }

    /// Only the ones not asked yet. A permission already allowed or turned down is never asked again from here; the
    /// feature's own screen offers it when the person taps something that needs it.
    public static func toAsk(_ needs: [PermissionNeed], undecided: (DevicePermission) -> Bool) -> [PermissionNeed] {
        needs.filter { undecided($0.permission) }
    }

    /// A hub from before 2026-11-05 lists no device modules; Voice and Reminder alerts were always on there, so the
    /// offer after setup still covers them. A list that names them is left as it is.
    public static func withDeviceDefaults(_ list: [ModuleInfo]) -> [ModuleInfo] {
        var out = list
        let known = Set(list.map(\.id))
        if !known.contains(AppModule.voice.rawValue) {
            out.append(ModuleInfo(id: AppModule.voice.rawValue, title: "Voice", group: "On your devices", on: true))
        }
        if !known.contains(AppModule.notifications.rawValue) {
            out.append(ModuleInfo(id: AppModule.notifications.rawValue, title: "Reminder alerts", group: "On your devices", on: true))
        }
        return out
    }

    /// Modules switched on between two lists: off in `before` (said so, not just missing) and on in `after`. A module
    /// a newer hub adds counts as already on, so an update to the hub asks for nothing.
    public static func switchedOn(before: [ModuleInfo], after: [ModuleInfo]) -> [ModuleInfo] {
        let wasOff = Set(before.filter { !$0.on }.map(\.id))
        return after.filter { $0.on && wasOff.contains($0.id) }
    }
}
