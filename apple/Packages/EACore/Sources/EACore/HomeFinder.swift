import Foundation

/// Home Wi-Fi only: finds a hub again after the router gave it a new address. The hub announces itself on the home
/// network (Bonjour, `_aeneas._tcp`, hub/src/announce.ts) with its certificate's fingerprint; this looks for the
/// announcement whose fingerprint is the one pinned from the QR code and returns where it is now.
///
/// The announcement only points the way: every request still accepts the hub only when it presents the pinned
/// certificate (Pinning.swift), so a stand-in announcing the same fingerprint gets nowhere.
public enum HomeFinder {
    public static let serviceType = "_aeneas._tcp"

    /// The pinned hub's address as it is now (`https://<address>:<port>`), or nil when it is not announced within
    /// `timeout` seconds (not on the home network, or the hub is off).
    public static func find(pin: String, timeout: TimeInterval = 6) async -> String? {
        #if canImport(Network) && !os(watchOS)
        return await NetworkFinder.find(pin: pin, timeout: timeout)
        #else
        return nil
        #endif
    }

    /// The address to try for a hub announced at `host` and `port`: IPv6 in brackets, with its interface written so a
    /// URL keeps it.
    public static func address(host: String, port: UInt16) -> String {
        if !host.contains(":"), let cut = host.firstIndex(of: "%") { return "https://\(host[..<cut]):\(port)" }
        if host.contains(":") {
            let parts = host.split(separator: "%", maxSplits: 1)
            let zone = parts.count == 2 ? "%25\(parts[1])" : ""
            return "https://[\(parts[0])\(zone)]:\(port)"
        }
        return "https://\(host):\(port)"
    }

    /// A line in the system log (Console, subsystem aeneas.home) about looking for a moved hub.
    public static func note(_ line: String) {
        #if canImport(Network) && !os(watchOS)
        log.info("home network: \(line, privacy: .public)")
        #endif
    }

    /// The same scheme, host and port.
    public static func sameAddress(_ a: String, _ b: String) -> Bool {
        guard let x = URLComponents(string: a), let y = URLComponents(string: b) else { return a == b }
        return x.scheme?.lowercased() == y.scheme?.lowercased() && x.host?.lowercased() == y.host?.lowercased() && x.port == y.port
    }

    /// Whether a failed sync could be a hub that moved: a pinned https hub that did not answer at all (an HTTP answer
    /// means it was reached).
    public static func worthLooking(hubURL: String, pin: String?, error: Error) -> Bool {
        guard HubPin.forHub(hubURL, pin: pin) != nil, !DirectHub.isDirect(hubURL) else { return false }
        if let h = error as? HubError, case .transport = h { return true }
        return error is URLError
    }
}

#if canImport(Network) && !os(watchOS)
import Network
import os

let log = Logger(subsystem: "aeneas.home", category: "finder")

private enum NetworkFinder {
    static func find(pin: String, timeout: TimeInterval) async -> String? {
        guard let pin = HubPin.normalize(pin) else { return nil }
        guard let endpoint = await browse(pin: pin, timeout: timeout) else { return nil }
        // IPv4 first: an IPv4 address in a URL needs nothing special and outlives a change of interface.
        if let a = await resolve(endpoint, v4Only: true, timeout: 4) { return a }
        return await resolve(endpoint, v4Only: false, timeout: 4)
    }

    /// The announcement whose `fp` is the pin.
    private static func browse(pin: String, timeout: TimeInterval) async -> NWEndpoint? {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: HomeFinder.serviceType, domain: nil), using: NWParameters())
        let once = Once<NWEndpoint?>()
        return await withCheckedContinuation { (c: CheckedContinuation<NWEndpoint?, Never>) in
            let finish: @Sendable (NWEndpoint?) -> Void = { e in
                if once.take(e) { browser.cancel(); c.resume(returning: e) }
            }
            browser.browseResultsChangedHandler = { results, _ in
                log.info("home network: \(results.count, privacy: .public) hub announcement(s) seen")
                for r in results {
                    guard case .bonjour(let txt) = r.metadata, let fp = txt["fp"], HubPin.normalize(fp) == pin else { continue }
                    finish(r.endpoint)
                    return
                }
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .failed(let e):
                    log.error("home network: looking for the hub failed: \(e.localizedDescription, privacy: .public)")
                    finish(nil)
                case .waiting(let e):
                    log.error("home network: looking for the hub is waiting: \(e.localizedDescription, privacy: .public)")
                case .cancelled: finish(nil)
                default: break
                }
            }
            browser.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }

    /// Connects to the announced service just long enough to learn its address.
    private static func resolve(_ endpoint: NWEndpoint, v4Only: Bool, timeout: TimeInterval) async -> String? {
        let params = NWParameters.tcp
        if v4Only, let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let conn = NWConnection(to: endpoint, using: params)
        let once = Once<String?>()
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            let finish: @Sendable (String?) -> Void = { a in
                if once.take(a) { conn.cancel(); c.resume(returning: a) }
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard case .hostPort(let host, let port)? = conn.currentPath?.remoteEndpoint else { finish(nil); return }
                    let h: String
                    switch host {
                    // From the bytes: the description can carry the interface ("10.0.0.5%en0"), which no URL takes.
                    case .ipv4(let a): h = a.rawValue.map { String($0) }.joined(separator: ".")
                    case .ipv6(let a): h = "\(a)"
                    case .name(let n, _): h = n
                    @unknown default: h = "\(host)"
                    }
                    finish(HomeFinder.address(host: h, port: port.rawValue))
                case .failed, .cancelled: finish(nil)
                case .waiting: finish(nil)
                default: break
                }
            }
            conn.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }
}

/// Lets the first of several callbacks through.
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func take(_: T) -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}
#endif
