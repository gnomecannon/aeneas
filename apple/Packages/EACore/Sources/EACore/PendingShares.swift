import Foundation

/// Captures the share sheet could not send (no connection to the hub) wait here, in the app group, until the app
/// next starts and sends them. Nothing shared is lost and nothing has to be shared again.
public enum PendingShares {
    static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedConfig.appGroup)?.appendingPathComponent("pending-shares", isDirectory: true)
    }

    /// Complete protection: shared text and pictures are written by the share sheet and read by the open app. A
    /// start while the phone is locked (background refresh) cannot read them, and leaves them for the next one.
    public static func add(_ req: CaptureRequest) throws {
        guard let dir = folder else { throw HubError.transport("No shared folder") }
        DataProtection.folder(dir, .complete)
        try DataProtection.write(JSONCoding.data(req), to: dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).json"), .complete)
    }

    /// Oldest first.
    public static func all() -> [(file: URL, request: CaptureRequest)] {
        guard let dir = folder, let names = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return names.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { url in
            guard let data = try? Data(contentsOf: url), let r = try? JSONCoding.decode(CaptureRequest.self, from: data) else { return nil }
            return (url, r)
        }
    }

    public static func remove(_ file: URL) { try? FileManager.default.removeItem(at: file) }
}
