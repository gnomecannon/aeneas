import Foundation
import CryptoKit

// Joining with a phone's yes (CONTRACT.md, Devices, since 2026-11-23): a Mac or iPad that is not paired shows a QR code
// with its own Direct link key, its home relay and a secret; a paired phone scans it and asks its hub to hand that device
// a pairing link. The hub proves with the secret that the phone sent it, so the new device knows it reached the hub the
// phone belongs to. The secret goes from screen to camera to the phone's hub and is never kept.

/// `everythingapp://join?node=&relay=&s=&name=&platform=`: what the new device's QR code holds.
public struct JoinLink: Equatable, Sendable, Identifiable {
    public enum Kind: String, CaseIterable, Sendable {
        case mac, ipad, windows, android

        /// What the phone's question calls the new device.
        public var label: String {
            switch self {
            case .mac: return "Mac"
            case .ipad: return "iPad"
            case .windows: return "Windows PC"
            case .android: return "Android tablet"
            }
        }
    }

    /// The new device's Direct link key, 64 lowercase hex characters.
    public var node: String
    /// Its home relay, through which the hub reaches it.
    public var relay: String
    /// 32 random bytes, base64url without padding (43 characters), as the link carries them.
    public var secret: String
    public var name: String
    public var platform: Kind

    public var id: String { node + secret }

    public init(node: String, relay: String, secret: String, name: String, platform: Kind) {
        self.node = node.lowercased(); self.relay = relay; self.secret = secret
        self.name = Self.cleanName(name) ?? platform.label
        self.platform = platform
    }

    /// Nil when the link is not a join link, or any part of it is not as the contract says.
    public static func parse(_ url: URL) -> JoinLink? {
        guard url.scheme?.lowercased() == "everythingapp" else { return nil }
        let host = (url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        guard host == "join" else { return nil }
        // A "+" is a space, as in a setup link (SetupLink.parse); a real plus is %2B.
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let pq = comps?.percentEncodedQuery { comps?.percentEncodedQuery = pq.replacingOccurrences(of: "+", with: "%20") }
        let items = comps?.queryItems ?? []
        func q(_ n: String) -> String { items.first { $0.name == n }?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        let node = q("node").lowercased()
        guard DirectHub.validKey(node), DirectHub.validRelay(q("relay")), JoinSecret.decode(q("s")) != nil,
              let platform = Kind(rawValue: q("platform").lowercased()) else { return nil }
        return JoinLink(node: node, relay: q("relay"), secret: q("s"), name: q("name"), platform: platform)
    }

    /// The link for the QR code. Every value is escaped so that the phone reads back exactly what was written.
    public var url: URL? {
        func e(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? s }
        let query = [("node", node), ("relay", relay), ("s", secret), ("name", name), ("platform", platform.rawValue)]
            .map { "\($0.0)=\(e($0.1))" }.joined(separator: "&")
        return URL(string: "everythingapp://join?\(query)")
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func cleanName(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : String(t.prefix(60))
    }
}

/// The secret in a join link: 32 random bytes, written as base64url without padding.
public enum JoinSecret {
    public static let byteCount = 32

    /// A fresh secret from the system's secure random source.
    public static func make() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    public static func encode(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// The bytes of a base64url value without padding, or nil when it is not one.
    public static func decodeAny(_ s: String) -> Data? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard !s.isEmpty, s.allSatisfy({ allowed.contains($0) }), s.count % 4 != 1 else { return nil }
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }

    /// The secret's bytes: exactly 32 of them (43 characters), else nil.
    public static func decode(_ s: String) -> Data? {
        guard s.count == 43, let d = decodeAny(s), d.count == byteCount else { return nil }
        return d
    }
}

/// What the hub sends the new device, and how the new device decides whether to take it.
public enum JoinCheck {
    /// `{ v: 1, link, proof }` from the hub.
    struct Offer: Decodable { var v: Int?; var link: String?; var proof: String? }

    public enum Outcome: Equatable, Sendable {
        /// The hub that connected is the one the link names and it proved it holds the secret: pair with this link.
        case accepted(SetupLink)
        /// Anything else, in a plain sentence for the hub, which passes it to the phone whole. The same sentences as the
    /// Windows and Android apps, so the phone says the same whichever device it was adding.
        case refused(String)
    }

    static let label = "aeneas-join/1"

    /// What the proof is made over: the label, the hub's Direct link key, this device's key and the link, one per line.
    public static func message(hubKey: String, node: String, link: String) -> Data {
        Data("\(label)\n\(hubKey.lowercased())\n\(node.lowercased())\n\(link)".utf8)
    }

    /// The proof the hub sends: HMAC-SHA256 with the secret as the key, base64url without padding.
    public static func proof(secret: Data, hubKey: String, node: String, link: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: message(hubKey: hubKey, node: node, link: link), using: SymmetricKey(data: secret))
        return JoinSecret.encode(Data(mac))
    }

    /// Whether `proof` was made with one of `secrets`; compared in constant time, so a guess learns nothing from how long
    /// the answer took.
    public static func proofHolds(_ proof: String, secrets: [Data], hubKey: String, node: String, link: String) -> Bool {
        guard let given = JoinSecret.decodeAny(proof), given.count == SHA256.byteCount else { return false }
        let m = message(hubKey: hubKey, node: node, link: link)
        var ok = false
        for s in secrets where HMAC<SHA256>.isValidAuthenticationCode(given, authenticating: m, using: SymmetricKey(data: s)) { ok = true }
        return ok
    }

    /// The hub's message checked against the key of the endpoint that connected (`remoteKey`) and this device's own key
    /// (`node`): the link must be a Direct link pairing link with a code for exactly that hub, and the proof must hold for
    /// one of `secrets` (the one on screen, and the one before it for a short while).
    public static func check(_ data: Data, remoteKey: String, node: String, secrets: [Data]) -> Outcome {
        guard let offer = try? JSONDecoder().decode(Offer.self, from: data), offer.v == 1, let raw = offer.link, let proof = offer.proof else {
            return .refused(unreadable)
        }
        guard let url = URL(string: raw), let link = SetupLink.parse(url), case .code = link.credential, let hub = DirectHub.parse(link.hub) else {
            return .refused(unreadable)
        }
        // Only the hub the link names may hand it over: anyone else could send a link to their own hub.
        guard hub.node == remoteKey.lowercased() else {
            return .refused(otherHub)
        }
        guard proofHolds(proof, secrets: secrets, hubKey: hub.node, node: node, link: raw) else {
            return .refused(noMatch)
        }
        return .accepted(link)
    }

    public static let unreadable = "That was not a join this device can read."
    public static let otherHub = "The pairing link names another hub than the one that sent it."
    public static let noMatch = "The hub's proof does not match the code on this device. Scan the code on its screen again."
    public static let alreadyJoined = "This device has already joined a hub."

    /// The device's answer to the hub: `{ ok: true }` or `{ ok: false, error }`.
    public static func answer(ok: Bool, error: String? = nil) -> Data {
        struct A: Encodable { var ok: Bool; var error: String? }
        return (try? JSONEncoder().encode(A(ok: ok, error: ok ? nil : error))) ?? Data(#"{"ok":false}"#.utf8)
    }
}

// MARK: The phone's side

/// What the hub said to `POST /devices/join`.
public enum JoinAnswer: Equatable, Sendable {
    /// 200: the new device claimed its code and is paired.
    case added(name: String)
    /// 202: it took the pairing link but had not claimed its code within a minute; it finishes by itself.
    case sent(name: String)

    /// A refused join in plain words: the hub's own sentence when it gave one.
    public static func failureText(_ error: Error, name: String) -> String {
        guard let h = error as? HubError else { return error.localizedDescription }
        switch h {
        case .http(let status, _) where status == 404:
            return "Your hub is too old to add a computer this way. Update the hub, then try again."
        case .http(_, let message):
            let m = message.trimmingCharacters(in: .whitespacesAndNewlines)
            // A proxy's error page is not a sentence for anyone.
            return m.isEmpty || m.hasPrefix("<") ? "Your hub could not add \(name)." : m
        case .transport(let m):
            return "Could not reach your hub: \(m)"
        default:
            return h.errorDescription ?? "Your hub could not add \(name)."
        }
    }
}

extension HubClient {
    /// `POST /devices/join`: the hub reaches the device in the link over Direct link and hands it a pairing link. It can
    /// take up to about 100 seconds (reaching the device, its answer, then waiting for it to claim its code), which
    /// `HTTPTransport.timeout(path:)` allows for.
    public func join(_ link: JoinLink) async throws -> JoinAnswer {
        struct B: Encodable { var node: String; var relay: String; var s: String; var name: String; var platform: String }
        let body = try JSONCoding.data(B(node: link.node, relay: link.relay, s: link.secret, name: link.name, platform: link.platform.rawValue))
        let (status, data) = try await transport.send(method: "POST", path: "devices/join", query: [:], body: body)
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
        struct R: Decodable { var name: String?; var state: String? }
        let r = (try? JSONCoding.decode(R.self, from: data)) ?? R()
        let name = JoinLink.cleanName(r.name ?? "") ?? link.name
        return status == 202 || r.state == "sent" ? .sent(name: name) : .added(name: name)
    }
}
