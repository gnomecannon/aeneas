import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Resize and recompress an image to JPEG under a byte budget. The hub takes request bodies up to 2 MB, and an
/// image is sent as base64 (a third larger), so 1.2 MB of JPEG is the most that still fits.
enum ImageShrinker {
    static func jpeg(from data: Data, maxBytes: Int = 1_200_000, startPixels: Int = 2048, startQuality: Double = 0.8) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        var maxPixels = startPixels
        var quality = startQuality
        for _ in 0..<8 {
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixels,
                kCGImageSourceCreateThumbnailWithTransform: true
            ]
            guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            if out.length <= maxBytes { return out as Data }
            if quality > 0.5 { quality -= 0.15 } else { maxPixels = maxPixels * 3 / 4 }
        }
        return nil
    }

    /// A gallery upload (a reference for image generation): up to 4096 px and 12 MB, so detail survives.
    static func jpegForUpload(_ data: Data) -> Data? { jpeg(from: data, maxBytes: 12_000_000, startPixels: 4096, startQuality: 0.92) }

    /// An image shape: longest side at most `maxPixels`, transparency kept, as PNG under `maxBytes`.
    static func png(from data: Data, maxPixels: Int = 256, maxBytes: Int = 500_000) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        var side = maxPixels
        for _ in 0..<4 {
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: side,
                kCGImageSourceCreateThumbnailWithTransform: true
            ]
            guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, img, nil)
            guard CGImageDestinationFinalize(dest) else { return nil }
            if out.length <= maxBytes { return out as Data }
            side = side * 3 / 4
        }
        return nil
    }
}
