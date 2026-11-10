import Foundation

/// The hub's own software (hub/src/update.ts): Settings, About, Hub software. Check fetches its branch and lists what is
/// new; update runs deploy/update.sh on the hub machine, which restarts the hub and goes back by itself when the new
/// version does not start.
public struct HubUpdateRun: Decodable, Equatable, Sendable {
    /// starting, checking, installing, restarting, rolling_back, done, up_to_date, rolled_back or failed.
    public var state: String
    public var message: String
    public var from: String?
    public var to: String?
    public var at: String
    public var running: Bool { ["starting", "checking", "installing", "restarting", "rolling_back"].contains(state) }
}

public struct HubUpdateInfo: Decodable, Equatable, Sendable {
    public struct Change: Decodable, Equatable, Sendable, Identifiable {
        public var commit: String
        public var title: String
        public var at: String
        public var id: String { commit }
    }
    public var installed_with_git: Bool
    public var commit: String?
    public var committed_at: String?
    public var branch: String
    public var checked_at: String?
    public var latest: String?
    public var behind: Int
    public var changes: [Change]
    public var local_changes: Bool
    public var can_update: Bool
    public var reason: String?
    public var last_run: HubUpdateRun?
    public var running: Bool
}

public struct HubUpdateStarted: Decodable, Equatable, Sendable {
    public var started: Bool
    public var run: HubUpdateRun
}

extension HubClient {
    public func hubUpdate() async throws -> HubUpdateInfo { try await get("hub-update", as: HubUpdateInfo.self) }
    public func checkHubUpdate() async throws -> HubUpdateInfo { try await post("hub-update/check", Empty(), as: HubUpdateInfo.self) }
    public func startHubUpdate() async throws -> HubUpdateStarted { try await post("hub-update", Empty(), as: HubUpdateStarted.self) }
}

private struct Empty: Codable {}
