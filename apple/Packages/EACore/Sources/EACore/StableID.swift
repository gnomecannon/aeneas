import Foundation
import CryptoKit

/// The same stable ids the hub gives synced things (SHA-1 of "everythingapp:" plus a key, in version 5 layout), so
/// importing the same thing again, after a reinstall or on another device, finds the same entity instead of a copy.
public enum StableID {
    public static func uuid(_ key: String) -> String {
        var b = Array(Insecure.SHA1.hash(data: Data("everythingapp:\(key)".utf8)))
        b[6] = (b[6] & 0x0f) | 0x50
        b[8] = (b[8] & 0x3f) | 0x80
        let hex = b.prefix(16).map { String(format: "%02x", $0) }.joined()
        let c = Array(hex)
        return "\(String(c[0..<8]))-\(String(c[8..<12]))-\(String(c[12..<16]))-\(String(c[16..<20]))-\(String(c[20..<32]))"
    }
}
