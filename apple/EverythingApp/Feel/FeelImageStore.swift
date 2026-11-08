import SwiftUI
import ImageIO
import UniformTypeIdentifiers
import EACore

/// Uploaded image shapes, decoded once and kept on disk so bursts draw them offline. Missing ones are fetched from
/// the hub with this device's key; ones deleted on the hub are dropped from disk.
@MainActor @Observable
final class FeelImageStore {
    private(set) var cgImages: [String: CGImage] = [:]
    @ObservationIgnored private var fetching: Set<String> = []
    @ObservationIgnored private let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("FeelImages", isDirectory: true)
    }()

    /// The image as SwiftUI draws it, or nil while it has not loaded.
    func image(_ id: String) -> Image? { cgImages[id].map { Image(decorative: $0, scale: 1) } }

    /// Read whatever is already on disk.
    func load(_ list: [FeelImage]) {
        for i in list where cgImages[i.id] == nil {
            if let data = try? Data(contentsOf: file(i.id)), let cg = Self.decode(data) { cgImages[i.id] = cg }
        }
    }

    /// Load from disk, fetch what is missing, forget what the hub no longer has.
    func sync(_ list: [FeelImage], client: HubClient?) {
        load(list)
        let ids = Set(list.map(\.id))
        for id in cgImages.keys where !ids.contains(id) {
            cgImages.removeValue(forKey: id)
            try? FileManager.default.removeItem(at: file(id))
        }
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for n in names where !ids.contains((n as NSString).deletingPathExtension) {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
            }
        }
        guard let client else { return }
        for i in list where cgImages[i.id] == nil && !fetching.contains(i.id) {
            fetching.insert(i.id)
            let id = i.id
            Task { [weak self] in
                let data = try? await client.feelImage(id)
                guard let self else { return }
                self.fetching.remove(id)
                if let data { self.store(data, id: id) }
            }
        }
    }

    /// Keep bytes just uploaded or fetched.
    func store(_ data: Data, id: String) {
        guard FeelID.valid(id), let cg = Self.decode(data) else { return }
        // Complete protection: only the open app draws these.
        DataProtection.folder(dir, .complete)
        try? DataProtection.write(data, to: file(id), .complete)
        cgImages[id] = cg
    }

    private func file(_ id: String) -> URL { dir.appendingPathComponent("\(id).img") }

    private static func decode(_ data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }
}
