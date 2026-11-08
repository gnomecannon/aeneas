import Foundation

/// Data protection classes for the files the apps keep (iPhone, iPad, Watch). Each file gets the strongest class
/// that still lets it work:
/// - `untilFirstUnlock` (complete until first user authentication): what widgets, background refresh, the Watch relay
///   or notifications read while the device is locked. Encrypted from a restart until the first unlock.
/// - `complete`: what only the open app reads (image caches, attachments, chat copies, drafts). Unreadable from 10
///   seconds after the device locks until it is unlocked again.
/// - `completeUnlessOpen`: a recording still being written when the device locks; once closed it is unreadable while locked.
/// On the Mac, FileVault encrypts the disk and these calls do nothing.
public enum DataProtection {
    public enum Level: Sendable {
        case untilFirstUnlock, complete, completeUnlessOpen

        #if os(iOS) || os(watchOS)
        var type: FileProtectionType {
            switch self {
            case .untilFirstUnlock: return .completeUntilFirstUserAuthentication
            case .complete: return .complete
            case .completeUnlessOpen: return .completeUnlessOpen
            }
        }

        public var writingOption: Data.WritingOptions {
            switch self {
            case .untilFirstUnlock: return .completeFileProtectionUntilFirstUserAuthentication
            case .complete: return .completeFileProtection
            case .completeUnlessOpen: return .completeFileProtectionUnlessOpen
            }
        }
        #else
        public var writingOption: Data.WritingOptions { [] }
        #endif
    }

    /// Sets the class on a file or folder (a folder's class is what new files in it get). Missing files are skipped.
    public static func protect(_ url: URL, _ level: Level) {
        #if os(iOS) || os(watchOS)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try? FileManager.default.setAttributes([.protectionKey: level.type], ofItemAtPath: url.path)
        #endif
    }

    /// Creates the folder if needed and sets its class, so files made in it start with that class.
    @discardableResult
    public static func folder(_ url: URL, _ level: Level) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        protect(url, level)
        return url
    }

    /// Writes atomically with the class set on the new file.
    public static func write(_ data: Data, to url: URL, _ level: Level) throws {
        try data.write(to: url, options: [.atomic, level.writingOption])
    }

    /// The class a file has now, for tests and the About screen. Nil on the Mac or when it cannot be read.
    public static func current(_ url: URL) -> String? {
        #if os(iOS) || os(watchOS)
        return (try? FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey] as? FileProtectionType)?.rawValue
        #else
        return nil
        #endif
    }
}
