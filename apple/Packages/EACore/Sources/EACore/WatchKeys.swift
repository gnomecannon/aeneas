import Foundation

/// iPhone: the key the Watch's relayed requests go with. The Watch cannot reach the hub and never holds a key; the
/// iPhone keeps one for it in its own Keychain, so the Watch is a device of its own on the hub (Settings, Devices
/// lists it and can remove it) and a request it relays never speaks for the iPhone. With a device key the hub
/// registers only that key's device, so the Watch registering with the iPhone's key would have renamed the iPhone.
///
/// - The Watch's own key, when the iPhone has one.
/// - The hub's shared key, while the iPhone itself still uses it (a hub too old to trade it).
/// - Otherwise a key claimed for the Watch with the iPhone's own: a one-time code made and used at once, keeping the
///   Watch's device id when its requests name one.
public actor WatchKeys {
    public static let shared = WatchKeys(config: .shared)

    public enum Credential: Equatable, Sendable {
        case key(String)
        /// The Watch was removed on the hub; nothing is relayed for it until it is paired again (Settings, Devices).
        case removed
        case unavailable(String)
    }

    let config: SharedConfig
    /// Tests: the client a Watch key is claimed with, given a key (empty for the claim itself).
    var makeClient: (@Sendable (String) -> HubClient?)?
    private var claiming: Task<Credential, Never>?

    public init(config: SharedConfig, makeClient: (@Sendable (String) -> HubClient?)? = nil) {
        self.config = config
        self.makeClient = makeClient
    }

    /// `watchDeviceId`: the id the Watch's request named (its `device_id` query), if any.
    public func credential(watchDeviceId: String?) async -> Credential {
        if let id = watchDeviceId, !id.isEmpty, config.watchDeviceId.isEmpty { config.watchDeviceId = id }
        guard !config.hubURL.isEmpty else { return .unavailable("iPhone has no hub configured") }
        if config.watchRemoved { return .removed }
        let watch = config.watchKey
        if !watch.isEmpty { return .key(watch) }
        let mine = config.deviceKey
        if mine.isEmpty {
            let shared = config.legacyToken
            return shared.isEmpty ? .unavailable("iPhone has no hub configured") : .key(shared)
        }
        if let t = claiming { return await t.value }
        let t = Task { await self.claim(with: mine) }
        claiming = t
        let r = await t.value
        claiming = nil
        return r
    }

    private func client(_ key: String) -> HubClient? {
        makeClient?(key) ?? HubClient.make(urlString: config.hubURL, token: key, pin: config.hubPin)
    }

    private func claim(with phoneKey: String) async -> Credential {
        guard let phone = client(phoneKey), let anon = client("") else { return .unavailable("iPhone has no hub configured") }
        let name = config.deviceName + " Watch"
        let id = config.watchDeviceId.isEmpty ? nil : config.watchDeviceId
        do {
            let links = try await withDeadline(20) { try await phone.pairing(name: name) }
            guard let code = links.code else { return .unavailable("The hub gave no pairing code for the Watch") }
            let r = try await withDeadline(20) { try await anon.claim(code: code, name: name, platform: .watch, deviceId: id) }
            guard config.storeWatchKey(r.key) else { return .unavailable("The iPhone could not keep the Watch's key") }
            config.watchDeviceId = r.device_id
            return .key(r.key)
        } catch {
            return .unavailable("Could not get a key for the Watch: \((error as? HubError)?.errorDescription ?? error.localizedDescription)")
        }
    }

    /// The hub answered a Watch request with `device_removed`: drop the Watch's key and relay nothing more for it.
    public func noteRemoved() {
        config.clearWatchKey()
        config.watchRemoved = true
    }

    /// Settings, Devices, Pair the Watch again: the next request from the Watch claims a new key.
    public func allowAgain() {
        config.watchRemoved = false
    }

    /// The body a removed Watch gets, the same the hub sends.
    public static let removedBody = Data(#"{"error":"unauthorized","device_removed":true}"#.utf8)
}
