import Foundation
import Security

/// What a Keychain read found. `unavailable` (the device has not been unlocked since it started, or the Keychain
/// refused) is not `missing`: nothing is cleared or replaced because of an unavailable read.
public enum SecretRead: Equatable, Sendable {
    case value(String)
    case missing
    case unavailable(Int32)

    public var value: String? { if case .value(let v) = self { return v }; return nil }
}

/// Where this device's hub key lives. The app uses the Keychain; tests use `InMemorySecretStore`.
public protocol SecretStore: AnyObject, Sendable {
    func read(_ account: String) -> SecretRead
    /// True when the value is stored and reads back the same.
    @discardableResult func write(_ account: String, _ value: String) -> Bool
    func delete(_ account: String)
}

public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()
    /// Set to make every read answer `unavailable`, as a locked device does.
    public var locked = false

    public init() {}

    public func read(_ account: String) -> SecretRead {
        lock.withLock {
            if locked { return .unavailable(errSecInteractionNotAllowed) }
            return values[account].map(SecretRead.value) ?? .missing
        }
    }

    public func write(_ account: String, _ value: String) -> Bool {
        lock.withLock {
            if locked { return false }
            values[account] = value
            return true
        }
    }

    public func delete(_ account: String) { lock.withLock { _ = values.removeValue(forKey: account) } }
}

/// The Keychain, for this device only: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronized to
/// iCloud and never in a backup that restores to another device. After the first unlock the widgets, intents, the
/// share extension and the Watch relay can read it while the phone is locked.
///
/// Shared through the app group used as the keychain access group, which iOS allows with the app group entitlement
/// alone. On the Mac the data protection keychain is used (the same rules as iOS). A build without those
/// entitlements (unsigned simulator and test builds) is refused with errSecMissingEntitlement; it then keeps the key
/// in the app's own access group, and on the Mac, last, in the file keychain.
public final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    /// The Keychain item's service name. It stays fixed on purpose: every paired device keeps its key under this name,
    /// and a copy built under another team stores its items in its own access group, so the name never collides.
    public static let service = "com.gnomecannon.everythingapp.hub"

    enum Mode: CaseIterable { case shared, own, fileKeychain }

    private let service: String
    private let accessGroup: String?
    private let lock = NSLock()
    /// The first mode that was not refused for a missing entitlement, found on first use.
    private var mode: Mode?

    public init(service: String = KeychainSecretStore.service, accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private var candidates: [Mode] {
        var all: [Mode] = accessGroup == nil ? [.own] : [.shared, .own]
        #if os(macOS)
        all.append(.fileKeychain)
        #endif
        return all
    }

    private func query(_ account: String, _ mode: Mode) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if mode == .shared, let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        #if os(macOS)
        if mode != .fileKeychain { q[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return q
    }

    /// Runs `op` in the known mode, or tries each in turn until one is not refused for a missing entitlement.
    private func run(_ op: (Mode) -> OSStatus) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        if let m = mode { return op(m) }
        var last: OSStatus = errSecMissingEntitlement
        for m in candidates {
            last = op(m)
            if last != errSecMissingEntitlement { mode = m; return last }
        }
        return last
    }

    public func read(_ account: String) -> SecretRead {
        var out: SecretRead = .missing
        let status = run { m in
            var q = query(account, m)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let s = SecItemCopyMatching(q as CFDictionary, &item)
            if s == errSecSuccess, let d = item as? Data, let v = String(data: d, encoding: .utf8) { out = .value(v) }
            return s
        }
        switch status {
        case errSecSuccess: return out
        case errSecItemNotFound: return .missing
        default: return .unavailable(status)
        }
    }

    @discardableResult
    public func write(_ account: String, _ value: String) -> Bool {
        let data = Data(value.utf8)
        let status = run { m in
            var attrs: [String: Any] = [kSecValueData as String: data]
            if m != .fileKeychain { attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }
            let q = query(account, m)
            let s = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
            guard s == errSecItemNotFound else { return s }
            return SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil)
        }
        return status == errSecSuccess && read(account) == .value(value)
    }

    /// Removed in every mode, so a copy kept by a fallback goes too.
    public func delete(_ account: String) {
        lock.lock()
        defer { lock.unlock() }
        for m in candidates { SecItemDelete(query(account, m) as CFDictionary) }
    }
}
