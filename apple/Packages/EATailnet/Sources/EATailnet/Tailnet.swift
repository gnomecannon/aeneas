import Foundation
import EACore
import TailscaleKit

/// Tailscale inside Aeneas. Someone whose hub is on Tailscale signs in to Tailscale here, in Tailscale's own sign-in
/// page, instead of installing the Tailscale app. This device then joins their Tailscale network as one more device
/// (named "aeneas-" and the device's name) and the app's requests to the hub go through that connection. Nothing else
/// on the device uses it: it is not a VPN, and other apps do not see it.
///
/// What Tailscale sees is the same as with the Tailscale app: the account, this device's name and when it is online.
/// Off until the person signs in; signing out removes this device's Tailscale key from the device.
public enum EATailnet {
    /// Called once at launch, before the hub connection is made.
    @MainActor public static func install() {
        TailnetBridge.session = { TailnetSessions.current }
        if TailnetSignIn.shared.isOn { TailnetSignIn.shared.resume() }
    }
}

/// The session requests to a Tailscale hub use while Tailscale runs inside Aeneas.
enum TailnetSessions {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var session: URLSession?
    static var current: URLSession? { lock.withLock { session } }
    static func set(_ s: URLSession?) {
        lock.withLock {
            session?.invalidateAndCancel()
            session = s
        }
    }
}

/// Signing in and the connection's state, for Settings and the setup screen.
@MainActor
public final class TailnetSignIn: ObservableObject {
    public static let shared = TailnetSignIn()

    public enum State: Equatable, Sendable {
        case off
        case starting
        /// Tailscale's sign-in page, to open for the person.
        case signIn(URL)
        /// Connected; the Tailscale network's name when Tailscale says it.
        case connected(network: String?)
        case failed(String)
    }

    @Published public private(set) var state: State = .off
    /// Called when requests to the hub start or stop going through Tailscale here (the app rebuilds its connection).
    public var onChange: (() -> Void)?

    private static let onKey = "tailnet.inApp"
    public var isOn: Bool { UserDefaults.standard.bool(forKey: Self.onKey) }

    private var runner: TailnetRunner?

    /// Starts Tailscale here for the first time: Tailscale's sign-in page follows (`state` becomes `.signIn`).
    public func start(deviceName: String) {
        UserDefaults.standard.set(true, forKey: Self.onKey)
        UserDefaults.standard.set(Self.hostName(deviceName), forKey: "tailnet.hostName")
        resume()
    }

    /// Starts Tailscale with the key kept from an earlier sign-in (at launch).
    public func resume() {
        guard runner == nil else { return }
        state = .starting
        let host = UserDefaults.standard.string(forKey: "tailnet.hostName") ?? Self.hostName("device")
        var made: TailnetRunner?
        let r = TailnetRunner(hostName: host, dir: Self.stateDir) { [weak self] update in
            Task { @MainActor in
                // Only the runner in use reports; one cancelled or signed out stays quiet.
                guard let self, let made, self.runner === made else { return }
                self.apply(update)
            }
        }
        made = r
        runner = r
        Task { await r.run() }
    }

    /// Signs this device out of Tailscale, closes the connection and removes its Tailscale key from the device.
    public func signOut() async {
        UserDefaults.standard.set(false, forKey: Self.onKey)
        let r = runner
        runner = nil
        TailnetSessions.set(nil)
        state = .off
        onChange?()
        // Tailscale is told and closed behind the screen, for 10 seconds at most (a sign-in still waiting may not
        // answer); the key on the device goes either way.
        let dir = Self.stateDir
        Task.detached {
            await withTaskGroup(of: Void.self) { g in
                g.addTask { await r?.signOut() }
                g.addTask { try? await Task.sleep(nanoseconds: 10_000_000_000) }
                await g.next()
                g.cancelAll()
            }
            try? FileManager.default.removeItem(at: dir)
        }
    }

    private func apply(_ u: TailnetRunner.Update) {
        switch u {
        case .signIn(let url): state = .signIn(url)
        case .connected(let network, let session):
            TailnetSessions.set(session)
            state = .connected(network: network)
            onChange?()
        case .failed(let m):
            runner = nil
            state = .failed(m)
        }
    }

    /// "aeneas-" and the device's name, in the letters a Tailscale device name takes.
    nonisolated static func hostName(_ device: String) -> String {
        let cleaned = device.lowercased().map { $0.isLetter && $0.isASCII || $0.isNumber ? $0 : "-" }
        let name = String(cleaned).split(separator: "-").joined(separator: "-")
        return "aeneas-" + String((name.isEmpty ? "device" : name).prefix(40))
    }

    /// Tailscale's state for this device (its key), kept out of backups.
    nonisolated static var stateDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent("tailscale", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var v = URLResourceValues()
        v.isExcludedFromBackup = true
        try? dir.setResourceValues(v)
        return dir
    }
}

/// Runs the Tailscale node: watches for the sign-in page, waits until it is connected, then hands over a session.
actor TailnetRunner {
    enum Update: @unchecked Sendable {
        case signIn(URL)
        case connected(network: String?, session: URLSession)
        case failed(String)
    }

    let hostName: String
    let dir: URL
    let report: @Sendable (Update) -> Void
    private var node: TailscaleNode?
    private var api: LocalAPIClient?
    private var processor: MessageProcessor?
    private var watcher: BusWatcher?

    init(hostName: String, dir: URL, report: @escaping @Sendable (Update) -> Void) {
        self.hostName = hostName
        self.dir = dir
        self.report = report
    }

    func run() async {
        do {
            let config = Configuration(hostName: hostName, path: dir.path, authKey: nil, controlURL: kDefaultControlURL, ephemeral: false)
            let node = try TailscaleNode(config: config, logger: QuietLog())
            self.node = node
            let api = LocalAPIClient(localNode: node, logger: QuietLog())
            self.api = api
            let watcher = BusWatcher(report: report)
            self.watcher = watcher
            processor = try await api.watchIPNBus(mask: [.initialState, .noPrivateKeys], consumer: watcher)
            // Tailscale's sign-in page comes from the bus; ask for it once more if it has not come in a few seconds.
            Task { [api] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if await watcher.needsLogin, await !watcher.sawURL { try? await api.startLoginInteractive() }
            }
            // Returns once signed in and connected (at once when a key was kept from before).
            try await node.up()
            let (config2, _) = try await URLSessionConfiguration.tailscaleSession(node)
            config2.timeoutIntervalForRequest = 20
            config2.waitsForConnectivity = false
            let network = try? await api.backendStatus().CurrentTailnet?.Name
            report(.connected(network: network, session: URLSession(configuration: config2)))
        } catch {
            report(.failed("Tailscale did not start (\(error.localizedDescription))"))
        }
    }

    func signOut() async {
        try? await api?.resetAuth()
        processor?.cancel()
        try? await node?.close()
        node = nil
    }
}

actor BusWatcher: MessageConsumer {
    let report: @Sendable (TailnetRunner.Update) -> Void
    private(set) var needsLogin = false
    private(set) var sawURL = false

    init(report: @escaping @Sendable (TailnetRunner.Update) -> Void) { self.report = report }

    func notify(_ n: Ipn.Notify) {
        if let s = n.State { needsLogin = s == .NeedsLogin }
        if let raw = n.BrowseToURL, let url = URL(string: raw), url.scheme == "https" {
            sawURL = true
            report(.signIn(url))
        }
    }

    func error(_ error: Error) {}
}

/// Tailscale's own log stays out of the app's log: it names devices and addresses.
struct QuietLog: LogSink {
    var logFileHandle: Int32? = nil
    func log(_ message: String) {}
}
