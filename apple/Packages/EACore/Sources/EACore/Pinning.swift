import Foundation
import Security
import CryptoKit

/// Optional pinning of the hub's TLS certificate. A pairing link may carry `fp=`, the SHA-256 of the hub's
/// certificate (DER) in lowercase hex. With an https hub address the device then accepts that certificate and no
/// other, whether or not a public authority signed it (a hub on a LAN with its own certificate). Without a pin the
/// system's usual checks apply.
public enum HubPin {
    /// A fingerprint as given (lowercase or uppercase hex, with or without colons or spaces), or nil when it is not
    /// 32 bytes of hex.
    public static func normalize(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.lowercased().filter { $0 != ":" && $0 != " " }
        guard s.count == 64, s.allSatisfy({ $0.isHexDigit }) else { return nil }
        return s
    }

    /// The pin for a hub address: only an https address keeps one.
    public static func forHub(_ hubURL: String, pin: String?) -> String? {
        guard let p = normalize(pin), hubURL.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("https://") else { return nil }
        return p
    }

    public static func fingerprint(_ der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    public enum Decision: Equatable, Sendable {
        /// No pin: the system decides as usual.
        case standard
        case accept
        case reject
    }

    /// What to do with the certificate a hub presented (`leaf`, DER).
    public static func decide(pin: String?, leaf: Data?) -> Decision {
        guard let pin = normalize(pin) else { return .standard }
        guard let leaf else { return .reject }
        return fingerprint(leaf) == pin ? .accept : .reject
    }

    /// The server's own certificate (the first of the chain), DER.
    public static func leafCertificate(_ trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }
}

/// Accepts only the pinned certificate for every request of its session (data requests and the `/live` stream).
final class PinnedSessionDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    let pin: String
    init(pin: String) { self.pin = pin }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        switch HubPin.decide(pin: pin, leaf: HubPin.leafCertificate(trust)) {
        case .accept: return (.useCredential, URLCredential(trust: trust))
        case .reject: return (.cancelAuthenticationChallenge, nil)
        case .standard: return (.performDefaultHandling, nil)
        }
    }
}

/// One session per pin: a session keeps its delegate until it is invalidated, so they are made once and reused.
enum PinnedSessions {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var sessions: [String: URLSession] = [:]

    static func session(pin: String) -> URLSession {
        lock.withLock {
            if let s = sessions[pin] { return s }
            let s = URLSession(configuration: HTTPTransport.sessionConfiguration(), delegate: PinnedSessionDelegate(pin: pin), delegateQueue: nil)
            sessions[pin] = s
            return s
        }
    }
}
