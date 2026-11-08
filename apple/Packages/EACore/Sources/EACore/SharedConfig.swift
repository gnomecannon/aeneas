import Foundation
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Configuration and a small snapshot shared through the app group so widgets, complications and the Watch
/// extension can read the hub and the Now task. The device's own key is not here: it is in the Keychain
/// (`secrets`), shared with the widgets and intents through the same app group.
public final class SharedConfig: @unchecked Sendable {
    /// The app group the apps, widgets and Watch share: `EAAppGroup` in each target's Info.plist, built from
    /// `EA_BUNDLE_PREFIX` in apple/Signing.xcconfig, so a copy built under someone else's team uses its own group. The
    /// fallback (a target whose Info.plist lacks the key, or package tests) is worked out from the bundle id the same
    /// way: `<prefix>.everythingapp.widgets` belongs to `group.<prefix>.everythingapp`.
    public static let appGroup: String = {
        if let g = Bundle.main.object(forInfoDictionaryKey: "EAAppGroup") as? String, g.hasPrefix("group."), !g.contains("$(") { return g }
        return groupFor(bundleId: Bundle.main.bundleIdentifier)
    }()

    /// `group.<prefix>.everythingapp` for any of the app's bundle ids; a neutral name for anything else (tests).
    static func groupFor(bundleId: String?) -> String {
        guard let id = bundleId, let r = id.range(of: ".everythingapp") else { return "group.everythingapp.local" }
        return "group." + id[..<r.upperBound]
    }

    /// The unified logging subsystem: this target's bundle id, so a copy built under another name logs under its own.
    public static let logSubsystem = Bundle.main.bundleIdentifier ?? "everythingapp"

    public static let shared = SharedConfig()

    /// Keychain accounts: this device's key, and on the iPhone the key it keeps for its Watch.
    public static let deviceKeyAccount = "device-key"
    public static let watchKeyAccount = "watch-key"

    let defaults: UserDefaults
    public let usesAppGroup: Bool
    public let secrets: SecretStore

    public init() {
        if let d = UserDefaults(suiteName: SharedConfig.appGroup) {
            defaults = d
            usesAppGroup = true
        } else {
            defaults = .standard
            usesAppGroup = false
        }
        // The app group is the keychain access group (no separate keychain entitlement); a build without the group
        // keeps the key in its own access group.
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedConfig.appGroup) != nil ? SharedConfig.appGroup : nil
        secrets = KeychainSecretStore(accessGroup: group)
    }

    /// Isolated config for tests, with an in-memory key store.
    public init(suiteName: String, secrets: SecretStore = InMemorySecretStore()) {
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        usesAppGroup = false
        self.secrets = secrets
    }

    private func str(_ k: String) -> String { defaults.string(forKey: k) ?? "" }
    private func set(_ k: String, _ v: String?) { if let v = v, !v.isEmpty { defaults.set(v, forKey: k) } else { defaults.removeObject(forKey: k) } }

    public var hubURL: String { get { str("hubURL") } set { set("hubURL", newValue) } }

    /// This device's own key (Keychain). Empty when there is none or the Keychain cannot be read yet.
    public var deviceKey: String { secrets.read(Self.deviceKeyAccount).value ?? "" }
    /// Stores the key and checks it reads back; false leaves the old one (or the shared key) in use.
    @discardableResult public func storeDeviceKey(_ key: String) -> Bool { secrets.write(Self.deviceKeyAccount, key) }
    public func clearDeviceKey() { secrets.delete(Self.deviceKeyAccount) }

    /// iPhone: the key the Watch's requests go with (the Watch never holds one; the iPhone relays every call).
    public var watchKey: String { secrets.read(Self.watchKeyAccount).value ?? "" }
    @discardableResult public func storeWatchKey(_ key: String) -> Bool { secrets.write(Self.watchKeyAccount, key) }
    public func clearWatchKey() { secrets.delete(Self.watchKeyAccount) }

    /// The hub's shared key from before devices had their own. Kept only until it is traded for this device's key
    /// (`/devices/exchange`), or while the hub is too old to trade it.
    public var legacyToken: String { get { str("token") } set { set("token", newValue) } }

    /// What requests carry: this device's key, else the shared key while it waits to be traded.
    public var credential: String {
        let k = deviceKey
        return k.isEmpty ? legacyToken : k
    }
    public var hasDeviceKey: Bool { !deviceKey.isEmpty }

    /// SHA-256 of the hub's certificate (lowercase hex), from a pairing link's `fp`; https hubs only.
    public var hubPin: String? {
        get { defaults.string(forKey: "hubPin").flatMap(HubPin.normalize) }
        set { set("hubPin", HubPin.normalize(newValue)) }
    }
    /// The hub answered that this device was removed; Setup says so until it is paired again.
    public var deviceRemoved: Bool { get { defaults.bool(forKey: "deviceRemoved") } set { defaults.set(newValue, forKey: "deviceRemoved") } }
    /// iPhone: the Watch was removed on the hub, so its requests are not relayed until it is paired again.
    public var watchRemoved: Bool { get { defaults.bool(forKey: "watchRemoved") } set { defaults.set(newValue, forKey: "watchRemoved") } }
    /// iPhone: the Watch's device id, as its requests name it.
    public var watchDeviceId: String { get { str("watchDeviceId") } set { set("watchDeviceId", newValue) } }
    /// When to try trading the shared key again after the hub could not do it (offline, or a hub too old).
    public var exchangeRetryAfter: Date? {
        get { defaults.object(forKey: "exchange.retryAfter") as? Date }
        set { defaults.set(newValue, forKey: "exchange.retryAfter") }
    }
    /// Set when this device was just set up: once the modules are known, it offers the permissions they need.
    public var permissionOfferPending: Bool { get { defaults.bool(forKey: "permissions.offerPending") } set { defaults.set(newValue, forKey: "permissions.offerPending") } }

    public var deviceId: String { get { str("deviceId") } set { set("deviceId", newValue) } }
    public var deviceName: String {
        get { let s = str("deviceName"); return s.isEmpty ? SharedConfig.defaultDeviceName : s }
        set { set("deviceName", newValue) }
    }
    public var healthImportEnabled: Bool { get { defaults.bool(forKey: "healthImport") } set { defaults.set(newValue, forKey: "healthImport") } }
    public var lastHealthImport: Date? {
        get { defaults.object(forKey: "lastHealthImport") as? Date }
        set { defaults.set(newValue, forKey: "lastHealthImport") }
    }
    /// Calendars marked as work. nil means the user has not chosen yet (first run preselects).
    public var workCalendarIds: Set<String>? {
        get { (defaults.array(forKey: "workCalendar.ids") as? [String]).map(Set.init) }
        set { if let v = newValue { defaults.set(Array(v).sorted(), forKey: "workCalendar.ids") } else { defaults.removeObject(forKey: "workCalendar.ids") } }
    }
    public var lastCalendarImport: Date? {
        get { defaults.object(forKey: "workCalendar.lastImport") as? Date }
        set { defaults.set(newValue, forKey: "workCalendar.lastImport") }
    }
    /// Occurrences currently imported (live in the window).
    public var lastCalendarImportCount: Int {
        get { defaults.integer(forKey: "workCalendar.lastCount") }
        set { defaults.set(newValue, forKey: "workCalendar.lastCount") }
    }
    public var allowCloud: Bool { get { defaults.bool(forKey: "allowCloud") } set { defaults.set(newValue, forKey: "allowCloud") } }
    public var isConfigured: Bool { sampleMode || (!hubURL.isEmpty && !credential.isEmpty) }
    /// Sample mode (SampleHub.swift): the app shows a made-up month with no hub. Pairing a hub ends it.
    public var sampleMode: Bool { get { defaults.bool(forKey: "sampleMode") } set { defaults.set(newValue, forKey: "sampleMode") } }

    /// The last feel setting from the hub, so taps sound right offline.
    public var feel: FeelSettings? {
        get { defaults.data(forKey: "feel.cache").flatMap { try? JSONCoding.decode(FeelSettings.self, from: $0) } }
        set { if let v = newValue, let d = try? JSONCoding.data(v) { defaults.set(d, forKey: "feel.cache") } else { defaults.removeObject(forKey: "feel.cache") } }
    }
    /// The last module switches from the hub, so the next launch, widgets and the Watch hide the same things before the network answers.
    public var modules: [ModuleInfo]? {
        get { defaults.data(forKey: "modules.cache").flatMap { try? JSONCoding.decode([ModuleInfo].self, from: $0) } }
        set { if let v = newValue, let d = try? JSONCoding.data(v) { defaults.set(d, forKey: "modules.cache") } else { defaults.removeObject(forKey: "modules.cache") } }
    }
    /// Never fetched counts as on: screens do not vanish before the hub first answers.
    public func moduleOn(_ m: AppModule) -> Bool { (modules ?? []).isOn(m) }
    /// For what copies the person's own data into the hub (Calendar, Reminders, Contacts): on only once this hub
    /// said so. Counted as on before the list came, a phone paired to a hub with those modules off copied its
    /// calendar and reminders into it in the first seconds after pairing.
    public func moduleSaidOn(_ m: AppModule) -> Bool { modules?.first { $0.id == m.rawValue }?.on ?? false }
    /// Feel changes made while the hub could not be reached, sent before the next fetch.
    public var feelPending: [String: JSONValue] {
        get { defaults.data(forKey: "feel.pending").flatMap { try? JSONCoding.decode([String: JSONValue].self, from: $0) } ?? [:] }
        set { if !newValue.isEmpty, let d = try? JSONCoding.data(newValue) { defaults.set(d, forKey: "feel.pending") } else { defaults.removeObject(forKey: "feel.pending") } }
    }

    // Snapshot for widgets and complications.
    public var nowTaskId: String? { get { defaults.string(forKey: "now.id") } set { set("now.id", newValue) } }
    public var nowTaskTitle: String? { get { defaults.string(forKey: "now.title") } set { set("now.title", newValue) } }
    public var nowTaskStatus: String? { get { defaults.string(forKey: "now.status") } set { set("now.status", newValue) } }
    public var nowBlockEnd: Date? {
        get { defaults.object(forKey: "now.blockEnd") as? Date }
        set { defaults.set(newValue, forKey: "now.blockEnd") }
    }
    /// The next planned block today after the Now task, for the medium widget.
    public var nextBlockTitle: String? { get { defaults.string(forKey: "nextBlock.title") } set { set("nextBlock.title", newValue) } }
    public var nextBlockStart: Date? {
        get { defaults.object(forKey: "nextBlock.start") as? Date }
        set { defaults.set(newValue, forKey: "nextBlock.start") }
    }
    /// The next timed event or open reminder today, for the Watch complication.
    public var nextUpTitle: String? { get { defaults.string(forKey: "nextUp.title") } set { set("nextUp.title", newValue) } }
    public var nextUpAt: Date? {
        get { defaults.object(forKey: "nextUp.at") as? Date }
        set { defaults.set(newValue, forKey: "nextUp.at") }
    }
    public var unprocessedCount: Int { get { defaults.integer(forKey: "captures.unprocessed") } set { defaults.set(newValue, forKey: "captures.unprocessed") } }
    public var currentActivity: String? { get { defaults.string(forKey: "activity.name") } set { set("activity.name", newValue) } }
    public var currentActivityStart: Date? {
        get { defaults.object(forKey: "activity.start") as? Date }
        set { defaults.set(newValue, forKey: "activity.start") }
    }
    public var snapshotUpdated: Date? {
        get { defaults.object(forKey: "snapshot.updated") as? Date }
        set { defaults.set(newValue, forKey: "snapshot.updated") }
    }

    /// Database location inside the app group container when available.
    public var storeURL: URL {
        let base: URL
        if usesAppGroup, let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedConfig.appGroup) {
            base = c
        } else {
            base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        }
        return base.appendingPathComponent("EverythingApp", isDirectory: true).appendingPathComponent("store.sqlite")
    }

    public static var defaultDeviceName: String {
        #if os(watchOS)
        return "Apple Watch"
        #elseif os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        // Never ProcessInfo.hostName here: it does a blocking reverse DNS lookup on iOS.
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }
}
