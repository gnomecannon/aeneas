import Foundation

/// A hub reached by Direct link (iroh, hub/src/link.ts): saved as `iroh://<hub key>?relay=<relay URL>`. The key is
/// the hub's public key from the pairing QR code; the app connects to that key and no other, through that relay when no
/// direct path exists. Only the iPhone, iPad and Mac apps carry iroh (the EALink package); elsewhere such a hub has no
/// transport, and the Watch reaches it through the iPhone as it reaches any hub.
public enum DirectHub {
    /// The hub key: 64 hex characters (an ed25519 public key).
    public static func validKey(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit }
    }

    public static func validRelay(_ s: String) -> Bool {
        guard let u = URL(string: s), u.scheme?.lowercased() == "https", let h = u.host, !h.isEmpty else { return false }
        return true
    }

    /// The saved address for a hub key and its relay.
    public static func address(node: String, relay: String) -> String {
        var c = URLComponents()
        c.scheme = "iroh"
        c.host = node.lowercased()
        c.queryItems = [URLQueryItem(name: "relay", value: relay)]
        return c.string ?? "iroh://\(node.lowercased())"
    }

    /// The hub key and relay of a saved Direct link address, or nil for any other address.
    public static func parse(_ s: String) -> (node: String, relay: String)? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.lowercased().hasPrefix("iroh://"), let c = URLComponents(string: t), let node = c.host?.lowercased(), validKey(node),
              let relay = c.queryItems?.first(where: { $0.name == "relay" })?.value, validRelay(relay) else { return nil }
        return (node, relay)
    }

    public static func isDirect(_ s: String) -> Bool { parse(s) != nil }

    /// The base URL requests are made against: `iroh://<hub key>` (the relay is the transport's to know).
    public static func baseURL(node: String) -> URL? { URL(string: "iroh://\(node.lowercased())") }
}

/// Set once at launch by an app that carries iroh (EALink.install()): a URLSession whose requests to `iroh://<key>`
/// go over the Direct link through the given relay. Nil in the Watch, widgets and tests without it.
public enum DirectLinkBridge {
    nonisolated(unsafe) public static var session: (@Sendable (_ node: String, _ relay: String) -> URLSession?)?
}
