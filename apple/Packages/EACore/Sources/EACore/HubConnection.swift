import Foundation

/// Why a device cannot sync until it is paired again. Either way Retry alone never helps, so the banners offer Pair
/// again (Setup with the hub's address kept) next to it.
public enum PairingProblem: Equatable, Sendable {
    /// The hub refused this device's key without saying it was removed: a plain 401, or `unknown_key` from a hub that
    /// lost its keys file. The key, the copy and the queued edits stay here.
    case keyRefused
    /// The hub's address answers with another hub's id, so nothing is sent to it.
    case otherHub
}

/// What the offline banner says about how fresh this device's copy is.
public enum SyncFreshness {
    /// Unsaid for the first hour offline: a short gap is normal and the banner already says Offline. After that, hours
    /// until two days, then days, so a device that lost its hub long ago says so.
    public static func lastSynced(_ last: Date?, now: Date = Date()) -> String? {
        guard let last else { return nil }
        let gap = now.timeIntervalSince(last)
        guard gap > 3600 else { return nil }
        let hours = Int(gap / 3600)
        if hours < 48 { return "Last synced \(hours) h ago" }
        let days = hours / 24
        return "Last synced \(days) days ago"
    }

    /// A banner's second line: the reason, then the last sync when it says one, as sentences.
    public static func line(_ reason: String?, lastSync: Date?, now: Date = Date()) -> String? {
        let parts = [reason, lastSynced(lastSync, now: now)].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        return parts.map { $0.hasSuffix(".") ? $0 : $0 + "." }.joined(separator: " ")
    }

    /// Which banner shows Pair again: a problem that pairing fixes, while the hub is not answering.
    public static func offersPairAgain(_ problem: PairingProblem?, status: SyncEngine.Status, platform: Platform) -> Bool {
        problem != nil && status != .online && platform != .watch
    }
}

extension HubError {
    /// The iPhone's answer to a Watch request when it is not paired with a hub (WatchKeys, WatchLink).
    public static let phoneHasNoHub = "iPhone has no hub configured"
}
