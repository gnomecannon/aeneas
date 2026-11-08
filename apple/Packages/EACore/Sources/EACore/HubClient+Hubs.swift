import Foundation

/// Other people's hubs on the machine this hub runs on (deploy/people.sh, hub/src/hubs.ts): Settings, People on this
/// machine. Only the machine owner's hub offers it.
public struct PersonHub: Decodable, Equatable, Sendable, Identifiable {
    public var name: String
    public var account: String
    public var port: Int
    public var color: String
    public var owner: Bool
    public var address: String?
    public var up: Bool
    public var id: String { account }
    public var identity: HubIdentity { HubIdentity(name: name, color: color) }
}

public struct HubsList: Decodable, Equatable, Sendable {
    public var available: Bool
    /// `linux_only`, `not_set_up` or `not_owner` when not available.
    public var reason: String?
    public var setup_command: String
    public var admin_note: String
    public var hubs: [PersonHub]
    /// Settings shows the row on the owner's hub only (set up or not yet).
    public var offered: Bool { available || reason == "not_set_up" }
}

/// Adding a person, a new code, or stopping a hub, as it goes.
public struct HubRequest: Decodable, Equatable, Sendable {
    public struct Pairing: Decodable, Equatable, Sendable {
        public var hub: String?
        public var app: String?
        public var web: String?
        public var code: String?
        public var expires_at: String?
    }
    /// `queued`, `working`, `done` or `failed`.
    public var state: String
    public var step: String?
    public var error: String?
    public var name: String?
    public var color: String?
    public var address: String?
    public var account: String?
    public var note: String?
    public var pairing: Pairing?
    public var finished: Bool { state == "done" || state == "failed" }
}

public struct HubRequestStarted: Decodable, Equatable, Sendable { public var request_id: String }

extension HubClient {
    public func hubs() async throws -> HubsList { try await get("hubs", as: HubsList.self) }

    public func addHub(name: String) async throws -> HubRequestStarted {
        struct B: Encodable { var name: String }
        return try await post("hubs", B(name: name), as: HubRequestStarted.self)
    }

    public func hubRequest(_ id: String) async throws -> HubRequest { try await get("hubs/requests/\(id)", as: HubRequest.self) }

    public func pairHub(account: String) async throws -> HubRequestStarted {
        struct B: Encodable {}
        return try await post("hubs/\(account)/pair", B(), as: HubRequestStarted.self)
    }

    public func stopHub(account: String) async throws -> HubRequestStarted {
        struct B: Encodable {}
        return try await post("hubs/\(account)/stop", B(), as: HubRequestStarted.self)
    }
}
