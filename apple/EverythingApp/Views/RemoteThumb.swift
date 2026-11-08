import SwiftUI
import ImageIO
import EACore

/// A game's Steam picture, read through the hub (`GET /games/art/:appid`, with this device's key), so Steam's
/// servers never see this device. Fetched once, kept on disk, decoded at the size it is shown and kept in memory, so
/// a long list scrolls without fetching or decoding full-size images again.
struct SteamArtThumb: View {
    @EnvironmentObject var engine: SyncEngine
    let appid: Int
    /// Display size in points; the image is decoded for this size at the screen's scale.
    let size: CGSize
    @State private var image: CGImage?
    @Environment(\.displayScale) private var scale

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: scale).resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.15)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .task(id: appid) { image = await ThumbCache.shared.steamArt(appid, client: engine.client, maxPixel: max(size.width, size.height) * scale) }
    }
}

/// Memory cache of decoded thumbnails over a disk copy of what the hub sent.
actor ThumbCache {
    static let shared = ThumbCache()
    private let memory = NSCache<NSString, CGImageBox>()
    /// Complete protection: only the open app shows these.
    private let dir: URL = DataProtection.folder(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("steam-art", isDirectory: true), .complete)
    /// App ids the hub had no picture for this launch, so a list does not ask again on every scroll.
    private var missing: Set<Int> = []

    init() { memory.countLimit = 600 }

    func steamArt(_ appid: Int, client: HubClient?, maxPixel: CGFloat) async -> CGImage? {
        let key = "\(appid)@\(Int(maxPixel))" as NSString
        if let hit = memory.object(forKey: key) { return hit.image }
        let file = dir.appendingPathComponent("\(appid).img")
        var data = try? Data(contentsOf: file)
        if data == nil, !missing.contains(appid), let c = client {
            do {
                let d = try await withDeadline(20) { try await c.gameArt(appid: appid) }
                try? DataProtection.write(d, to: file, .complete)
                data = d
            } catch {
                // An older hub without the route, or a game Steam has no picture for: a plain tile.
                missing.insert(appid)
            }
        }
        guard let data, let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                                     kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        memory.setObject(CGImageBox(img), forKey: key)
        return img
    }
}

final class CGImageBox {
    let image: CGImage
    init(_ i: CGImage) { image = i }
}
