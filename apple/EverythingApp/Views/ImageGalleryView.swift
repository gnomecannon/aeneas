import SwiftUI
import PhotosUI
import EACore
#if os(iOS)
import Photos
#endif

/// Every picture in one place: Generated, Saved (attached, uploaded, downloaded) and, with full Photos access on,
/// the iPhone's own library. Tap to zoom; long-press for Delete. Any of them can start a new image.
struct ImageGalleryView: View {
    @EnvironmentObject var engine: SyncEngine
    enum Bin: String, CaseIterable, Identifiable { case generated = "Generated", saved = "Saved", photos = "Photos"; var id: String { rawValue } }
    @AppStorage(PhotosOptions.fullAccessKey) private var fullAccess = false
    @State private var bin: Bin = .generated
    @State private var open: Entity?
    @State private var picks: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var pickingPhotos = false
    @State private var confirmDelete: Entity?
    @State private var composeFrom: String?
    @State private var composing = false

    private var bins: [Bin] {
        #if os(iOS)
        return fullAccess ? Bin.allCases : [.generated, .saved]
        #else
        return [.generated, .saved]
        #endif
    }

    private var items: [Entity] {
        engine.list(.image)
            .filter { bin == .generated ? $0.str("source") == "generated" : $0.str("source") != "generated" }
            .sorted { $0.created_at > $1.created_at }
    }

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 3)]

    var body: some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $bin) { ForEach(bins) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented)
                .padding(.horizontal).padding(.vertical, 8)
            if bin == .photos {
                #if os(iOS)
                PhotosLibraryGrid(onUse: { id in composeFrom = id; composing = true })
                #endif
            } else if items.isEmpty {
                EmptyState(text: bin == .generated ? "Images you create appear here" : "Pictures you attach or add appear here")
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 3) {
                        ForEach(items) { e in
                            Button { open = e } label: { GalleryThumb(imageId: e.str("image_id")) }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button { composeFrom = e.str("image_id"); composing = true } label: { Label("Use as reference", systemImage: "wand.and.stars") }
                                    Button(role: .destructive) { confirmDelete = e } label: { Label("Delete", systemImage: "trash") }
                                }
                        }
                    }
                }
            }
        }
        .navigationTitle("Image Gallery")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { composeFrom = nil; composing = true } label: { Label("Create image", systemImage: "wand.and.stars") }
                    Button { pickingPhotos = true } label: { Label("Add from Photos", systemImage: "photo.badge.plus") }
                } label: { Label("Add", systemImage: "plus") }
            }
        }
        .overlay(alignment: .bottom) { if importing { ProgressView("Adding").padding().background(.regularMaterial, in: Capsule()).padding() } }
        .photosPicker(isPresented: $pickingPhotos, selection: $picks, maxSelectionCount: 10, matching: .images)
        .onChange(of: picks) { _, p in importPicks(p) }
        .confirmationDialog("Delete this image?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) { if let e = confirmDelete { Task { await engine.softDelete(e.id) } }; confirmDelete = nil }
        }
        .onChange(of: fullAccess) { _, on in if !on && bin == .photos { bin = .generated } }
        #if os(iOS)
        .fullScreenCover(item: $open) { e in ImageViewer(entity: e, onUse: { composeFrom = e.str("image_id"); open = nil; composing = true }) }
        #else
        .sheet(item: $open) { e in ImageViewer(entity: e, onUse: { composeFrom = e.str("image_id"); open = nil; composing = true }).frame(minWidth: 700, minHeight: 560) }
        #endif
        .sheet(isPresented: $composing) { ImageComposerView(referenceId: composeFrom) }
        .refreshable { await engine.sync() }
        // The workers' labels, for "Made with" in an image's details.
        .task { await ImageJobsModel.shared.loadWorkers(engine.client) }
    }

    private func importPicks(_ p: [PhotosPickerItem]) {
        guard !p.isEmpty, let c = engine.client else { return }
        importing = true
        Task {
            for item in p {
                if let d = try? await item.loadTransferable(type: Data.self), let jpeg = ImageShrinker.jpegForUpload(d) {
                    if let e = try? await c.uploadImage(jpeg, source: "uploaded") { await engine.absorb(e) }
                }
            }
            picks = []
            importing = false
            bin = .saved
        }
    }
}

struct GalleryThumb: View {
    @EnvironmentObject var engine: SyncEngine
    var imageId: String
    @State private var img: CGImage?
    var body: some View {
        Color.secondary.opacity(0.12)
            .aspectRatio(1, contentMode: .fit)
            .overlay { if let img { Image(decorative: img, scale: 1).resizable().scaledToFill() } }
            .clipped()
            .task(id: imageId) { img = await HubImageCache.shared.thumbnail(imageId, client: engine.client) }
            .accessibilityLabel("Image")
    }
}

/// One picture, full screen: pinch or double-tap to zoom, drag to pan. Use, share, details and delete in one bar.
struct ImageViewer: View {
    #if os(iOS)
    static let barPlacement = ToolbarItemPlacement.bottomBar
    #else
    static let barPlacement = ToolbarItemPlacement.primaryAction
    #endif
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var entity: Entity
    var onUse: () -> Void
    @State private var data: Data?
    @State private var showInfo = false
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            ZoomableImage(data: data)
                .background(Color.black)
                .ignoresSafeArea(edges: .bottom)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItemGroup(placement: Self.barPlacement) {
                        Button { onUse() } label: { Label("Use as reference", systemImage: "wand.and.stars") }
                        Spacer()
                        if let d = data, let p = PlatformImage(data: d) {
                            let image = Image(platformImage: p)
                            ShareLink(item: image, preview: SharePreview(entity.str("title").isEmpty ? "Image" : entity.str("title"), image: image)) { Label("Share", systemImage: "square.and.arrow.up") }
                        }
                        Spacer()
                        Button { showInfo = true } label: { Label("Details", systemImage: "info.circle") }
                        Spacer()
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                    }
                }
                .confirmationDialog("Delete this image?", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) { Task { await engine.softDelete(entity.id); dismiss() } }
                }
                .sheet(isPresented: $showInfo) { ImageDetails(entity: entity).presentationDetents([.medium, .large]) }
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.visible, for: .bottomBar)
                #endif
        }
        .task { data = await HubImageCache.shared.data(entity.str("image_id"), client: engine.client) }
    }
}

struct ImageDetails: View {
    @ObservedObject private var jobs = ImageJobsModel.shared
    var entity: Entity
    var body: some View {
        NavigationStack {
            Form {
                if let w = entity.number("width"), let h = entity.number("height"), w > 0 { LabeledContent("Size", value: "\(Int(w)) x \(Int(h))") }
                LabeledContent("Added", value: dateLabel(entity.created_at))
                LabeledContent("From", value: Self.sourceLabel(entity.str("source")))
                if !entity.str("prompt").isEmpty { SwiftUI.Section("Prompt") { Text(entity.str("prompt")).textSelection(.enabled) } }
                if !entity.str("caption").isEmpty { SwiftUI.Section("What the model was given") { Text(entity.str("caption")).font(.callout).textSelection(.enabled) } }
                if !entity.str("workflow").isEmpty {
                    SwiftUI.Section("Made with") {
                        Text(entity.str("workflow"))
                        if !entity.str("worker").isEmpty { Text(jobs.workers.label(for: entity.str("worker"))).foregroundStyle(.secondary) }
                        if let s = entity.number("seed") { Text("Seed \(Int(s))").foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("Details")
        }
    }

    static func sourceLabel(_ s: String) -> String {
        switch s {
        case "generated": return "Created here"
        case "attached": return "Attached in a chat"
        case "photos": return "Photos"
        case "downloaded": return "Downloaded"
        default: return "Added"
        }
    }
}

/// Pinch and double-tap zoom with panning, clamped so the picture never leaves the screen.
struct ZoomableImage: View {
    var data: Data?
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            Group {
                if let d = data, let p = PlatformImage(data: d) {
                    Image(platformImage: p).resizable().scaledToFit()
                        .scaleEffect(scale)
                        .offset(offset)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .gesture(MagnifyGesture()
                            .onChanged { v in scale = min(max(base * v.magnification, 1), 8) }
                            .onEnded { _ in base = scale; if scale == 1 { offset = .zero; lastOffset = .zero } })
                        .simultaneousGesture(DragGesture()
                            .onChanged { v in
                                guard scale > 1 else { return }
                                let maxX = geo.size.width * (scale - 1) / 2, maxY = geo.size.height * (scale - 1) / 2
                                offset = CGSize(width: min(max(lastOffset.width + v.translation.width, -maxX), maxX),
                                                height: min(max(lastOffset.height + v.translation.height, -maxY), maxY))
                            }
                            .onEnded { _ in lastOffset = offset })
                        .onTapGesture(count: 2) {
                            withAnimation(.spring(duration: 0.3)) {
                                if scale > 1 { scale = 1; base = 1; offset = .zero; lastOffset = .zero } else { scale = 2.5; base = 2.5 }
                            }
                        }
                        .accessibilityLabel("Image, pinch or double-tap to zoom")
                } else {
                    ProgressView().tint(.white).frame(width: geo.size.width, height: geo.size.height)
                }
            }
        }
    }
}

#if os(iOS)
/// The iPhone's photo library (only with full access on): recent photos to use as references.
struct PhotosLibraryGrid: View {
    @EnvironmentObject var engine: SyncEngine
    var onUse: (String) -> Void
    @State private var assets: [PHAsset] = []
    @State private var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @State private var working = false
    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 3)]

    var body: some View {
        Group {
            if status != .authorized && status != .limited {
                VStack(spacing: 12) {
                    Text("Aeneas does not have access to your photo library.").foregroundStyle(.secondary)
                    Button("Allow access") { Task { _ = await PhotosOptions.requestFull(); status = PHPhotoLibrary.authorizationStatus(for: .readWrite); load() } }
                }
                .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 3) {
                        ForEach(assets, id: \.localIdentifier) { a in
                            AssetThumb(asset: a)
                                .contextMenu {
                                    Button { use(a) } label: { Label("Use as reference", systemImage: "wand.and.stars") }
                                    Button { add(a) } label: { Label("Add to Saved", systemImage: "tray.and.arrow.down") }
                                }
                                .onTapGesture { use(a) }
                        }
                    }
                }
                .overlay { if working { ProgressView().padding().background(.regularMaterial, in: Capsule()) } }
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard status == .authorized || status == .limited else { return }
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = 600
        let r = PHAsset.fetchAssets(with: .image, options: opts)
        var out: [PHAsset] = []
        r.enumerateObjects { a, _, _ in out.append(a) }
        assets = out
    }

    private func upload(_ a: PHAsset) async -> Entity? {
        guard let c = engine.client else { return nil }
        let data: Data? = await withCheckedContinuation { cont in
            let o = PHImageRequestOptions()
            o.isNetworkAccessAllowed = true
            o.deliveryMode = .highQualityFormat
            PHImageManager.default().requestImageDataAndOrientation(for: a, options: o) { d, _, _, _ in cont.resume(returning: d) }
        }
        guard let d = data, let jpeg = ImageShrinker.jpegForUpload(d) else { return nil }
        let e = try? await c.uploadImage(jpeg, source: "photos")
        if let e { await engine.absorb(e) }
        return e
    }

    private func use(_ a: PHAsset) { working = true; Task { if let e = await upload(a) { onUse(e.str("image_id")) }; working = false } }
    private func add(_ a: PHAsset) { working = true; Task { _ = await upload(a); working = false } }
}

struct AssetThumb: View {
    var asset: PHAsset
    @State private var img: UIImage?
    var body: some View {
        Color.secondary.opacity(0.12)
            .aspectRatio(1, contentMode: .fit)
            .overlay { if let img { Image(uiImage: img).resizable().scaledToFill() } }
            .clipped()
            .task(id: asset.localIdentifier) {
                let o = PHImageRequestOptions()
                o.deliveryMode = .opportunistic
                o.isNetworkAccessAllowed = true
                PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 300, height: 300), contentMode: .aspectFill, options: o) { i, _ in if let i { img = i } }
            }
    }
}
#endif
