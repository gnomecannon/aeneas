import Foundation

// Each device has its own key (CONTRACT.md, Devices, since 2026-11-05). A paired device makes a one-time code; the
// new device trades it for its key at `POST /devices/claim`. An install that still holds the hub's shared key
// trades that at `POST /devices/exchange` and keeps its device id. No link or QR code carries a lasting secret.

/// Pairing codes: 8 characters of Crockford base32 (no I, L, O or U), shown as ABCD-EFGH. Typed in any case, with
/// or without the dash, O read as 0 and I or L as 1, as the hub reads them.
public enum PairingCode {
    public static let length = 8
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    public static func normalize(_ raw: String) -> String {
        raw.uppercased()
            .filter { !$0.isWhitespace && $0 != "-" }
            .map { c -> Character in
                switch c {
                case "O": return "0"
                case "I", "L": return "1"
                default: return c
                }
            }
            .reduce(into: "") { $0.append($1) }
    }

    public static func isValid(_ raw: String) -> Bool {
        let n = normalize(raw)
        return n.count == length && n.allSatisfy { alphabet.contains($0) }
    }

    /// "ABCD-EFGH".
    public static func display(_ raw: String) -> String {
        let n = normalize(raw)
        guard n.count == length else { return raw }
        return "\(n.prefix(4))-\(n.suffix(4))"
    }
}

/// `everythingapp://setup?hub=&code=&name=` (and `fp=`), `?link=direct&node=&relay=&code=&name=` for a Direct link hub,
/// or the older `?hub=&token=&name=`.
public struct SetupLink: Equatable, Sendable {
    public enum Credential: Equatable, Sendable {
        /// A one-time pairing code, normalized.
        case code(String)
        /// The hub's shared key from an older link: traded for this device's own key at once, never kept when the hub can trade it.
        case token(String)
    }

    public var hub: String
    public var credential: Credential
    public var name: String?
    /// The hub certificate's SHA-256, kept only for an https hub.
    public var pin: String?

    public init(hub: String, credential: Credential, name: String? = nil, pin: String? = nil) {
        self.hub = hub; self.credential = credential; self.name = name; self.pin = pin
    }

    /// Nil when the link is not a setup link, names no hub address that works, or carries neither a valid code nor a token.
    public static func parse(_ url: URL) -> SetupLink? {
        guard url.scheme?.lowercased() == "everythingapp" else { return nil }
        let host = (url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        guard host == "setup" else { return nil }
        // A "+" in the query is a space (form encoding, as a browser's URLSearchParams writes it); a real plus is %2B.
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let pq = comps?.percentEncodedQuery { comps?.percentEncodedQuery = pq.replacingOccurrences(of: "+", with: "%20") }
        let items = comps?.queryItems ?? []
        func q(_ n: String) -> String { items.first { $0.name == n }?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        // A Direct link hub (link=direct): its key and relay are the address; any `hub` address is ignored.
        var hub = q("hub")
        if q("link") == "direct" {
            guard DirectHub.validKey(q("node").lowercased()), DirectHub.validRelay(q("relay")) else { return nil }
            hub = DirectHub.address(node: q("node"), relay: q("relay"))
        }
        guard !hub.isEmpty, HTTPTransport.hubURL(hub) != nil else { return nil }
        let name = String(q("name").prefix(60))
        let credential: Credential
        if !q("code").isEmpty {
            guard PairingCode.isValid(q("code")) else { return nil }
            credential = .code(PairingCode.normalize(q("code")))
        } else if !q("token").isEmpty {
            credential = .token(q("token"))
        } else {
            return nil
        }
        return SetupLink(hub: hub, credential: credential, name: name.isEmpty ? nil : name, pin: HubPin.forHub(hub, pin: q("fp")))
    }
}

// MARK: Hub routes

public struct ClaimResponse: Codable, Equatable, Sendable {
    public var device_id: String
    public var key: String
    public var name: String?
    public var version: String?
}

public struct ExchangeResponse: Codable, Equatable, Sendable {
    public var device_id: String
    public var key: String
    public var name: String?
}

/// `GET /devices`: one paired device.
public struct PairedDevice: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var platform: String
    public var last_seen: String?
    public var paired_at: String?
    /// False for a device still on the hub's shared key.
    public var own_key: Bool?
    /// The device asking.
    public var current: Bool?

    public init(id: String, name: String, platform: String, last_seen: String? = nil, paired_at: String? = nil, own_key: Bool? = nil, current: Bool? = nil) {
        self.id = id; self.name = name; self.platform = platform; self.last_seen = last_seen; self.paired_at = paired_at; self.own_key = own_key; self.current = current
    }
}

/// A pairing code and the links that carry it (the app's own and the web app's). An older hub answers with the links
/// alone, which carry its shared key instead of a code.
public struct PairingLinks: Decodable, Equatable, Sendable {
    public var hub: String
    public var app: String
    public var web: String
    /// "ABCD-EFGH". Nil from an older hub.
    public var code: String?
    public var expires_at: String?

    public var expires: Date? { ISO.date(expires_at) }
    /// True for an older hub's link, which holds the hub's shared key.
    public var carriesSharedKey: Bool { code == nil }
}

extension HubClient {
    /// `POST /devices/claim`: trade a one-time code for this device's own key. Needs no key of its own.
    public func claim(code: String, name: String, platform: Platform, deviceId: String? = nil) async throws -> ClaimResponse {
        struct B: Encodable { var code: String; var name: String; var platform: String; var device_id: String? }
        return try await post("devices/claim", B(code: PairingCode.normalize(code), name: name, platform: platform.rawValue, device_id: deviceId), as: ClaimResponse.self)
    }

    /// `POST /devices/exchange` with the hub's shared key: this device's own key, keeping its device id. `parentId`
    /// is the iPhone that holds a Watch's key, so removing that iPhone removes the Watch's key too.
    public func exchange(name: String, platform: Platform, deviceId: String?, parentId: String? = nil) async throws -> ExchangeResponse {
        struct B: Encodable { var name: String; var platform: String; var device_id: String?; var parent_id: String? }
        return try await post("devices/exchange", B(name: name, platform: platform.rawValue, device_id: deviceId, parent_id: parentId), as: ExchangeResponse.self)
    }

    public func devices() async throws -> [PairedDevice] {
        struct R: Decodable { var devices: [PairedDevice] }
        return try await get("devices", as: R.self).devices
    }

    /// Ends that device's key at once; it is told it was removed the next time it asks.
    public func removeDevice(_ id: String) async throws {
        _ = try await send("DELETE", "devices/\(id)")
    }

    /// A one-time code for another device (`POST /devices/pairing`). An older hub has only `GET /setup/pair`, whose
    /// link carries its shared key.
    public func pairing(name: String) async throws -> PairingLinks {
        struct B: Encodable { var name: String }
        do {
            return try await post("devices/pairing", B(name: name), as: PairingLinks.self)
        } catch HubError.http(let status, _) where status == 404 {
            return try await get("setup/pair", query: ["name": name], as: PairingLinks.self)
        }
    }
}

/// The hub gave this device its key but the Keychain would not keep it (a build without its entitlements). The
/// code is used up; a new one is needed once the Keychain works.
public struct KeychainRefused: Error, LocalizedError, Equatable, Sendable {
    public init() {}
    public var errorDescription: String? {
        "The hub paired this device, but its key could not be kept in this device's Keychain, so nothing was saved. Make a new code and try again."
    }
}

// MARK: Trading the shared key

/// When an install that holds the hub's shared key trades it for its own, and what to do after each answer.
public enum CredentialMigration {
    public enum Step: Equatable, Sendable {
        case nothing
        case exchange
        /// A key is already stored and the shared key is still there (an exchange cut short): drop it.
        case clearLeftoverToken
    }

    public static func next(hubURL: String, hasKey: Bool, legacyToken: String, retryAfter: Date?, now: Date = Date()) -> Step {
        guard !hubURL.isEmpty, !legacyToken.isEmpty else { return .nothing }
        if hasKey { return .clearLeftoverToken }
        if let r = retryAfter, r > now { return .nothing }
        return .exchange
    }

    public enum Outcome: Equatable, Sendable {
        case traded
        /// Keep using the shared key quietly and try again after this many seconds.
        case keepToken(retryIn: TimeInterval)
        /// The hub refused the shared key itself (401 or 403).
        case refused
    }

    public static func outcome(_ error: Error?) -> Outcome {
        guard let error else { return .traded }
        guard let h = error as? HubError else { return .keepToken(retryIn: 60) }
        switch h {
        case .http(let status, _):
            switch status {
            // A hub from before device keys has no such route.
            case 404, 405: return .keepToken(retryIn: 6 * 3600)
            case 401, 403: return .refused
            case 500...: return .keepToken(retryIn: 600)
            default: return .keepToken(retryIn: 3600)
            }
        case .deviceRemoved: return .refused
        default:
            // Offline, a time limit, a reply that did not decode: next start.
            return .keepToken(retryIn: 60)
        }
    }
}

/// Ends `work` after `seconds` with `HubError.transport`, so no hub call can wait for ever.
public func withDeadline<T: Sendable>(_ seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await work() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw HubError.transport("The hub did not answer within \(Int(seconds)) seconds")
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw HubError.transport("No answer") }
        return first
    }
}
