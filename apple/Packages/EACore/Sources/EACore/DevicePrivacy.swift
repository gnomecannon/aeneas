import Foundation

/// Privacy choices for this device, kept in the app group so the widgets and Live Activity read them too. Every one
/// starts off (release tenets 1 and 2): nothing of the person's data leaves the device or shows outside the app until
/// they turn it on in Settings, Privacy on this device.
extension SharedConfig {
    /// iPhone and iPad: the local copy (the sync store, the chats copy, the app's own files) goes into iCloud Backup.
    /// Off by default: the copy refills from the hub, and iCloud Backup is readable by Apple unless Advanced Data
    /// Protection is on.
    public var includeInICloudBackup: Bool {
        get { privacyDefaults.bool(forKey: "privacy.icloudBackup") }
        set { privacyDefaults.set(newValue, forKey: "privacy.icloudBackup") }
    }
    /// Titles (never note text) go into Spotlight, so system search finds them. Off by default.
    public var showInSpotlight: Bool {
        get { privacyDefaults.bool(forKey: "privacy.spotlight") }
        set { privacyDefaults.set(newValue, forKey: "privacy.spotlight") }
    }
    /// The Now card, the Live Activity and the widgets show titles while the device is locked. Off by default: they are
    /// redacted on the lock screen and in StandBy.
    public var lockScreenTitles: Bool {
        get { privacyDefaults.bool(forKey: "privacy.lockScreenTitles") }
        set { privacyDefaults.set(newValue, forKey: "privacy.lockScreenTitles") }
    }

    var privacyDefaults: UserDefaults { defaults }

    /// The widget and complication snapshot (Now, next up, the running activity): emptied when this device is removed.
    public func clearSnapshot() {
        let d = privacyDefaults
        for k in ["now.id", "now.title", "now.status", "now.blockEnd", "nextUp.title", "nextUp.at", "nextBlock.title", "nextBlock.start",
                  "activity.name", "activity.start", "captures.unprocessed", "snapshot.updated", "modules.cache", "feel.cache", "feel.pending"] {
            d.removeObject(forKey: k)
        }
    }
}

/// Keeps the local copy out of iCloud Backup unless the person chose otherwise. Caches are never backed up by the
/// system; the store in the app group container and the app's Application Support folder are, so both are marked.
/// The Mac is left alone: there the backup is the person's own Time Machine.
public enum BackupExclusion {
    /// The folders that hold a copy of the person's data and would otherwise be backed up.
    public static func folders(config: SharedConfig = .shared) -> [URL] {
        var out = [config.storeURL.deletingLastPathComponent()]
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first { out.append(support) }
        return out
    }

    /// Marks (or unmarks) every folder. Safe to call on each launch and after the setting changes.
    @discardableResult
    public static func apply(config: SharedConfig = .shared) -> Int {
        #if os(iOS) || os(watchOS)
        let exclude = !config.includeInICloudBackup
        var done = 0
        for var url in folders(config: config) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = exclude
            if (try? url.setResourceValues(values)) != nil { done += 1 }
        }
        return done
        #else
        return 0
        #endif
    }
}
