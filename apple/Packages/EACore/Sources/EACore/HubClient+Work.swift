import Foundation

/// The work space switch. Off erases every work event and task on every device and stops new ones.
public struct WorkSpaceStatus: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var events: Int?
    public var tasks: Int?
    public var erased: Int?
}

extension HubClient {
    public func workSpace() async throws -> WorkSpaceStatus { try await get("space/work", as: WorkSpaceStatus.self) }

    /// Turning it off must be confirmed by the caller; the hub erases the work space in the same call.
    public func setWorkSpace(enabled: Bool) async throws -> WorkSpaceStatus {
        struct B: Encodable { var enabled: Bool; var confirm: String? }
        return try await post("space/work", B(enabled: enabled, confirm: enabled ? nil : "erase work"), as: WorkSpaceStatus.self, method: "PUT")
    }
}
