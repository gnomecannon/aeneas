import Foundation

/// A device permission a module needs (release rule 2: devices ask only for what the chosen modules need, right after
/// setup or when a module is switched on, never at launch).
public enum DevicePermission: String, CaseIterable, Sendable, Identifiable {
    // The order the permission screen lists and asks them in.
    case notifications, microphone, speech, reminders, calendar, contacts, health, photos, location
    /// Apple Music (since 2026-11-25, the Music module): MusicKit's own permission, on the iPhone, iPad and Mac.
    case music

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
        case .music: return "Apple Music"
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
        case .music: return "Reads your Apple Music library, playlists and play counts, so the assistant knows what you like. Nothing in Apple Music is played or changed."
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
        case .music: return "music.note"
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

/// Where a permission stands on this device.
public enum PermissionState: String, Equatable, Sendable {
    /// Never asked here: the system shows its question.
    case notAsked
    case allowed
    /// Turned down (or restricted): the system never asks again, only its Settings can change it.
    case denied
    /// Asked before, and the system does not say what was answered (Health never reports a refusal).
    case askedBefore

    /// What the permission screen and Settings, Review permissions say about it.
    public var label: String {
        switch self {
        case .notAsked: return "Not asked yet"
        case .allowed: return "Allowed"
        case .denied: return "Off in the system's Settings"
        case .askedBefore: return "Asked before"
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

    /// "For Voice and Song ideas."
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
        AppModule.appleMusic.rawValue: [.music],
    ]

    /// The module's own list from the hub, else the fallback. Names this app does not know are left out.
    public static func permissions(of m: ModuleInfo) -> [DevicePermission] {
        if let p = m.permissions { return p.compactMap(DevicePermission.init(rawValue:)) }
        return fallback[m.id] ?? []
    }

    /// What the modules that are on need on this platform, in `DevicePermission` order, each with its modules.
    /// On the Watch the microphone is only for hums (Song ideas): voice there is the system's dictation.
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

    /// Why the permission screen shows.
    public enum OfferReason: Sendable {
        /// Right after pairing: everything the modules that are on need.
        case paired
        /// A module was switched on: what that module needs.
        case switchedOn
    }

    /// What the permission screen lists. After pairing, only what was never asked here (and Health asked before
    /// whose sync is off, so Continue turns it on): a device paired again does not hear again about each "no". A
    /// module switched on lists everything it needs that is not allowed, turned down ones too: switching it on is a
    /// yes, and a permission turned down long ago left the module idle in silence. Those show with the way to the
    /// system's settings, since the system asks only once.
    public static func toOffer(_ needs: [PermissionNeed], reason: OfferReason, state: (DevicePermission) -> PermissionState) -> [PermissionNeed] {
        needs.filter { n in
            switch state(n.permission) {
            case .allowed: return false
            case .notAsked, .askedBefore: return true
            case .denied: return reason == .switchedOn
            }
        }
    }

    /// The modules whose every permission on this platform is allowed now: Continue (or a switch turned on here) turns
    /// on their own part on this device too, so a yes is not left idle behind a second switch. Health counts when asked
    /// before, since it never says what was allowed.
    public static func ready(_ needs: [PermissionNeed], platform: Platform, state: (DevicePermission) -> PermissionState) -> [ModuleInfo] {
        var seen: Set<String> = []
        var out: [ModuleInfo] = []
        for n in needs {
            for m in n.modules where !seen.contains(m.id) {
                seen.insert(m.id)
                let all = permissions(of: m).filter { $0.applies(on: platform) }
                if all.allSatisfy({ [.allowed, .askedBefore].contains(state($0)) }) { out.append(m) }
            }
        }
        return out
    }
}

/// Modules that need an account or a sign-in on the hub before they show anything, and where that is set up. Switching
/// one on offers Set it up now (as Machines opens Set up Machines), and its empty screen links there.
public enum ModuleSetup {
    public enum Place: String, Sendable {
        /// Settings, Accounts, Add account: no account linked yet.
        case addAccount
        /// Settings, Accounts: an account is linked, and what it does is switched there.
        case accounts
        /// Settings, Connections: Steam, Letterboxd, Confluence.
        case connections

        /// Where it is in Settings, for "Or later, in Settings, ...".
        public var path: String {
            switch self {
            case .addAccount, .accounts: return "Accounts"
            case .connections: return "Connections"
            }
        }
    }

    /// What a module needs, in words that finish "It needs ...". Nil for a module that works with nothing linked.
    public static func need(_ module: String) -> String? {
        switch module {
        case AppModule.mailInbox.rawValue: return "a mail account linked to your hub"
        case AppModule.mail.rawValue: return "a mail account to read receipts and renewals from"
        case AppModule.calendars.rawValue: return "an iCloud account with its calendars on"
        case AppModule.wiki.rawValue: return "Confluence linked, for your wiki pages"
        case AppModule.games.rawValue: return "Steam linked, for your games and playtime"
        case AppModule.films.rawValue: return "Letterboxd linked, for the films you watch"
        default: return nil
        }
    }

    /// Where the module is set up: an account's own switches when one is linked (adding a second account is not the
    /// way to turn on the first one's mail), else Add account, or Connections.
    public static func place(_ module: String, _ c: Connections?) -> Place {
        switch module {
        case AppModule.mailInbox.rawValue, AppModule.mail.rawValue, AppModule.calendars.rawValue:
            let linked = c.map { ($0.internet?.count ?? 0) + ($0.icloud?.accounts.count ?? 0) + ($0.google?.accounts.count ?? 0) } ?? 0
            return linked > 0 ? .accounts : .addAccount
        default:
            return .connections
        }
    }

    /// Whether the hub has what the module needs. A hub that does not say (an older one) counts as set up, so nothing
    /// is offered on a guess.
    public static func isSetUp(_ module: String, _ c: Connections) -> Bool {
        let accounts = c.internet
        switch module {
        case AppModule.mailInbox.rawValue:
            if let a = accounts { return a.contains { $0.features.inbox == true } }
            return !((c.icloud?.accounts ?? []) + (c.google?.accounts ?? [])).isEmpty
        case AppModule.mail.rawValue:
            if let a = accounts { return a.contains { $0.features.receipts == true } }
            return !((c.icloud?.accounts ?? []) + (c.google?.accounts ?? [])).isEmpty
        case AppModule.calendars.rawValue:
            return accounts.map { $0.contains { $0.features.calendars == true } } ?? true
        case AppModule.wiki.rawValue: return c.atlassian?.connected ?? true
        case AppModule.games.rawValue: return c.steam.connected
        case AppModule.films.rawValue: return c.letterboxd.connected
        default: return true
        }
    }
}

extension PermissionPlan {

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
