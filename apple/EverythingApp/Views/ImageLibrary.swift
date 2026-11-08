import SwiftUI
import ImageIO
import EACore
#if os(iOS)
import Photos
#endif

/// Hub images by id. Ids are content hashes, so a copy on disk never goes stale: fetched once, kept in Caches.
actor HubImageCache {
    static let shared = HubImageCache()
    /// Complete protection: only the open app shows these. A save to Photos that runs while the phone is locked
    /// fetches the picture from the hub again instead.
    private let dir: URL = DataProtection.folder(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("hub-images", isDirectory: true), .complete)
    private var thumbs: [String: CGImage] = [:]

    func data(_ id: String, client: HubClient?) async -> Data? {
        let file = dir.appendingPathComponent(id)
        if let d = try? Data(contentsOf: file) { return d }
        guard let c = client, let d = try? await c.aiImage(id) else { return nil }
        try? DataProtection.write(d, to: file, .complete)
        return d
    }

    /// A small decoded copy for grids (ImageIO downsampling: the full image is never decoded for a thumbnail).
    func thumbnail(_ id: String, client: HubClient?, maxPixel: Int = 360) async -> CGImage? {
        if let t = thumbs[id] { return t }
        guard let d = await data(id, client: client), let src = CGImageSourceCreateWithData(d as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let t = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        if thumbs.count > 400 { thumbs.removeAll() }
        thumbs[id] = t
        return t
    }
}

/// Image generations started from this device, tracked until they finish. The hub files every result in the gallery
/// by itself; this only drives the progress strip in the Assistant.
@MainActor
final class ImageJobsModel: ObservableObject {
    static let shared = ImageJobsModel()
    @Published private(set) var jobs: [ImageJob] = []
    /// The newest finished image, for the "ready" chip.
    @Published var ready: ImageJob?
    /// The image workers one may pick by hand, with their labels (from the hub's capabilities).
    @Published private(set) var workers: [ImageWorker] = []
    private var polling: Task<Void, Never>?

    func loadWorkers(_ client: HubClient?) async {
        guard let c = client, let caps = try? await c.imageCapabilities() else { return }
        workers = caps.hardware ?? []
    }

    var active: [ImageJob] { jobs.filter(\.isActive) }

    func submit(_ body: ImageRequestBody, client: HubClient) async throws {
        let made = try await client.imageSubmit(body)
        jobs.insert(contentsOf: made, at: 0)
        poll(client)
    }

    func cancel(_ job: ImageJob, client: HubClient) async {
        try? await client.imageCancel(job.id)
        if let f = try? await client.imageJob(job.id), let i = jobs.firstIndex(where: { $0.id == f.id }) { jobs[i] = f }
    }

    private func poll(_ client: HubClient) {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while let self, !Task.isCancelled, self.jobs.contains(where: { $0.isActive || ($0.status == "succeeded" && $0.image_id == nil) }) {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                for j in self.jobs where j.isActive || (j.status == "succeeded" && j.image_id == nil) {
                    guard let f = try? await client.imageJob(j.id), let i = self.jobs.firstIndex(where: { $0.id == f.id }) else { continue }
                    self.jobs[i] = f
                    if f.status == "succeeded", f.image_id != nil, j.image_id == nil { self.ready = f; Haptics.success() }
                }
            }
            self?.polling = nil
        }
    }

    func dismissFinished() { jobs.removeAll { !$0.isActive } ; ready = nil }
}

enum Haptics {
    static func success() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }
}

/// The two Photos switches in Settings, and saving generated images to Photos when the first is on.
enum PhotosOptions {
    static let saveKey = "ea.images.saveToPhotos"
    static let saveSinceKey = "ea.images.saveToPhotosSince"
    static let fullAccessKey = "ea.images.fullPhotoAccess"

    static var saveGenerated: Bool { UserDefaults.standard.bool(forKey: saveKey) }
    static var fullAccess: Bool { UserDefaults.standard.bool(forKey: fullAccessKey) }

    #if os(iOS)
    static func requestAdd() async -> Bool {
        await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized
    }

    static func requestFull() async -> Bool {
        let s = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return s == .authorized || s == .limited
    }

    /// Set while a save run is going. Two runs at once (a sync and a new image a moment apart) could both see an
    /// image not yet marked and save it twice. One run at a time now: a call during a run asks it to look once more
    /// when it is done, so an image that came in meanwhile is still saved.
    @MainActor private static var saving = false
    @MainActor private static var again = false

    /// Save generated images made after the switch was turned on and not saved yet. Marks each so it is saved once.
    @MainActor
    static func saveNew(engine: SyncEngine) async {
        guard saveGenerated, PHPhotoLibrary.authorizationStatus(for: .addOnly) == .authorized else { return }
        if saving { again = true; return }
        saving = true
        defer { saving = false }
        repeat {
            again = false
            let since = UserDefaults.standard.string(forKey: saveSinceKey) ?? ""
            let todo = engine.list(.image).filter { $0.str("source") == "generated" && $0.bool("saved_to_photos") != true && $0.created_at >= since }
            for e in todo.prefix(10) {
                guard let d = await HubImageCache.shared.data(e.str("image_id"), client: engine.client) else { continue }
                do {
                    try await PHPhotoLibrary.shared().performChanges { PHAssetCreationRequest.forAsset().addResource(with: .photo, data: d, options: nil) }
                    _ = await engine.update(e.id, fields: ["saved_to_photos": true])
                } catch { again = false; break }
            }
        } while again
    }
    #endif
}

/// Share or save a hub image (the share sheet has Save Image).
struct ImageShareButton: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    @State private var data: Data?
    var body: some View {
        Group {
            if let d = data, let img = PlatformImage(data: d) {
                let image = Image(platformImage: img)
                ShareLink(item: image, preview: SharePreview("Image", image: image)) { Label("Share", systemImage: "square.and.arrow.up") }
            }
        }
        .task(id: id) { data = await HubImageCache.shared.data(id, client: engine.client) }
    }
}

#if os(macOS)
typealias PlatformImage = NSImage
extension Image { init(platformImage: NSImage) { self.init(nsImage: platformImage) } }
#else
typealias PlatformImage = UIImage
extension Image { init(platformImage: UIImage) { self.init(uiImage: platformImage) } }
#endif

/// Settings, Images: where created images go, and whether the app may browse the photo library.
struct ImageSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @AppStorage(PhotosOptions.saveKey) private var saveToPhotos = false
    @AppStorage(PhotosOptions.fullAccessKey) private var fullAccess = false
    @State private var note: String?

    static var summary: String {
        #if os(iOS)
        PhotosOptions.saveGenerated ? "Saving to Photos" : "Image Gallery only"
        #else
        "Image Gallery"
        #endif
    }

    var body: some View {
        Form {
            #if os(iOS)
            SwiftUI.Section {
                Toggle("Save created images to Photos", isOn: $saveToPhotos)
                    .onChange(of: saveToPhotos) { _, on in
                        guard on else { return }
                        Task {
                            if await PhotosOptions.requestAdd() {
                                // Only images made from now on; the gallery keeps the rest.
                                UserDefaults.standard.set(ISO.now(), forKey: PhotosOptions.saveSinceKey)
                                note = nil
                            } else { saveToPhotos = false; note = "Photos access was not allowed. Turn it on in the iPhone's Settings, Aeneas, Photos." }
                        }
                    }
            } footer: { Text("Images you create also go to the camera roll, from now on. They always stay in the Image Gallery.") }
            SwiftUI.Section {
                Toggle("Full photo library access", isOn: $fullAccess)
                    .onChange(of: fullAccess) { _, on in
                        guard on else { return }
                        Task {
                            if await PhotosOptions.requestFull() { note = nil } else { fullAccess = false; note = "Photo library access was not allowed. Turn it on in the iPhone's Settings, Aeneas, Photos." }
                        }
                    }
            } footer: { Text("Shows your photo library in the Image Gallery, so any photo can be a reference for a new image. It also lets the assistant look at your newest photos when you ask about them. A photo leaves the phone only when you use or add it, or ask the assistant about it.") }
            if let n = note { SwiftUI.Section { Text(n).font(.callout).foregroundStyle(.orange) } }
            #else
            SwiftUI.Section { Text("Created images are kept in the Image Gallery. Saving to Photos and photo library access are iPhone settings.").foregroundStyle(.secondary) }
            #endif
        }
        .navigationTitle("Images")
    }
}

#if os(iOS)
/// The iPhone's photo library for the assistant (only with full access on): the newest photos, 1024 px JPEG.
enum PhoneLibrary {
    static var available: Bool {
        guard PhotosOptions.fullAccess else { return false }
        let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return s == .authorized || s == .limited
    }

    static func newest(count: Int, sinceDays: Double?) async -> [DevicePhoto] {
        guard available else { return [] }
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = min(max(count, 1), 6)
        if let d = sinceDays { opts.predicate = NSPredicate(format: "creationDate >= %@", Date().addingTimeInterval(-d * 86400) as NSDate) }
        var assets: [PHAsset] = []
        PHAsset.fetchAssets(with: .image, options: opts).enumerateObjects { a, _, _ in assets.append(a) }
        var out: [DevicePhoto] = []
        for a in assets {
            let img: UIImage? = await withCheckedContinuation { cont in
                let o = PHImageRequestOptions()
                o.deliveryMode = .highQualityFormat
                o.isNetworkAccessAllowed = true
                o.resizeMode = .exact
                // Photos may call back first with a blurry preview; answer only with the full-quality result.
                PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: 1024, height: 1024), contentMode: .aspectFit, options: o) { i, info in
                    if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                    cont.resume(returning: i)
                }
            }
            guard let img, let jpeg = img.jpegData(compressionQuality: 0.75) else { continue }
            out.append(DevicePhoto(b64: jpeg.base64EncodedString(), taken_at: a.creationDate.map { ISO.string($0) },
                                   width: Int(img.size.width * img.scale), height: Int(img.size.height * img.scale)))
        }
        return out
    }
}
#endif
