import SwiftUI
import EACore

/// Create an image (or a new one from a reference) on the local GPUs. The common choices are up front; the rest wait
/// under More options. The plan line shows the exact size and where it runs before anything starts. Results land in
/// the Image Gallery by themselves; the Assistant shows progress.
struct ImageComposerView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @StateObject private var jobs = ImageJobsModel.shared
    @State var referenceId: String?
    @State private var prompt = ""
    @State private var aspect = "1:1"
    @State private var setStyle = false
    @State private var realism = 85.0
    @State private var quality = "auto"
    @State private var exactSize = false
    @State private var width = 1024
    @State private var height = 1024
    @State private var hardware = "auto"
    @State private var count = 1
    @State private var seamless = "off"
    @State private var transparent = false
    @State private var seedText = ""
    @State private var exactPrompt = false
    @State private var plan: ImagePlan?
    @State private var planError: String?
    @State private var sending = false
    @State private var error: String?
    @State private var pickingReference = false

    init(referenceId: String? = nil) { _referenceId = State(initialValue: referenceId) }

    private static let aspects = ["1:1", "4:3", "3:2", "16:9", "9:16"]

    private var request: ImageRequestBody {
        var r = ImageRequestBody(prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines))
        if let ref = referenceId { r.references = [ref]; r.operation = "edit" }
        if exactSize { r.width = width; r.height = height } else if referenceId == nil { r.aspect = aspect } else { r.aspect = "match_source" }
        if setStyle { r.realism = .number(realism.rounded()) }
        if quality != "auto" { r.quality = quality }
        if hardware != "auto" { r.hardware = hardware }
        if count > 1 { r.count = count }
        if seamless != "off" { r.seamless = seamless }
        if transparent { r.transparent = true }
        if let s = Int(seedText) { r.seed = s }
        if exactPrompt { r.exact_prompt = true }
        return r
    }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    if let ref = referenceId {
                        HStack(spacing: 12) {
                            GalleryThumb(imageId: ref).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                            Text("Starting from this image").foregroundStyle(.secondary)
                            Spacer()
                            Button { referenceId = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                .buttonStyle(.borderless).accessibilityLabel("Remove reference")
                        }
                    }
                    TextField(referenceId == nil ? "Describe the image" : "Describe the change", text: $prompt, axis: .vertical)
                        .lineLimit(3...8)
                    if referenceId == nil {
                        Button { pickingReference = true } label: { Label("Start from an image", systemImage: "photo.on.rectangle") }
                    }
                }
                SwiftUI.Section {
                    if referenceId == nil && !exactSize {
                        Picker("Shape", selection: $aspect) { ForEach(Self.aspects, id: \.self) { Text($0).tag($0) } }.pickerStyle(.segmented)
                    }
                    Picker("Quality", selection: $quality) { Text("Auto").tag("auto"); Text("Fast").tag("fast"); Text("Best").tag("best") }.pickerStyle(.segmented)
                    Toggle("Set the look", isOn: $setStyle)
                    if setStyle {
                        Slider(value: $realism, in: 0...100, step: 1) { Text("Look") } minimumValueLabel: { Text("Stylized").font(.caption) } maximumValueLabel: { Text("Photo").font(.caption) }
                            .accessibilityValue(realism < 34 ? "Stylized" : realism < 67 ? "Naturalistic" : "Photographic")
                    }
                }
                SwiftUI.Section {
                    DisclosureGroup("More options") {
                        Toggle("Exact size in pixels", isOn: $exactSize)
                        if exactSize {
                            HStack {
                                TextField("Width", value: $width, format: .number).numericKeyboard()
                                Text("x").foregroundStyle(.secondary)
                                TextField("Height", value: $height, format: .number).numericKeyboard()
                                Button { (width, height) = (height, width) } label: { Image(systemName: "arrow.left.arrow.right") }
                                    .buttonStyle(.borderless).accessibilityLabel("Swap width and height")
                            }
                        }
                        Picker("Hardware", selection: $hardware) {
                            Text("Auto (protect gameplay)").tag("auto")
                            ForEach(jobs.workers, id: \.id) { w in Text("\(w.label) only").tag(w.id) }
                        }
                        Stepper("Images: \(count)", value: $count, in: 1...4)
                        Picker("Repeat seamlessly", selection: $seamless) { Text("Off").tag("off"); Text("Horizontal").tag("x"); Text("Vertical").tag("y"); Text("Both").tag("xy") }
                        Toggle("Transparent background", isOn: $transparent)
                        TextField("Seed (blank for random)", text: $seedText).numericKeyboard()
                        Toggle("Use my prompt exactly", isOn: $exactPrompt)
                    }
                }
                SwiftUI.Section {
                    planLine
                    if let e = error { Text(e).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle(referenceId == nil ? "Create image" : "New from image")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Sending" : "Create") { create() }
                        .disabled(sending || plan == nil || planError != nil)
                }
            }
            .task { await jobs.loadWorkers(engine.client) }
            .task(id: request) {
                try? await Task.sleep(nanoseconds: 500_000_000)
                await replan()
            }
            .sheet(isPresented: $pickingReference) { GalleryPicker { referenceId = $0 } }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 560)
        #endif
    }

    @ViewBuilder private var planLine: some View {
        if request.prompt.isEmpty {
            Text("Nothing runs until you tap Create.").font(.caption).foregroundStyle(.secondary)
        } else if let e = planError {
            Label(e, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
        } else if let p = plan {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(p.output.width) x \(p.output.height)  ·  \(jobs.workers.whereLabel(p.eligible_workers ?? []))").font(.callout)
                if let q = p.queue_reason { Text("Waits: \(q)").font(.caption).foregroundStyle(.orange) }
            }
        } else {
            ProgressView()
        }
    }

    private func replan() async {
        guard let c = engine.client, !request.prompt.isEmpty else { plan = nil; planError = nil; return }
        do { plan = try await c.imagePlan(request); planError = nil } catch {
            plan = nil
            planError = (error as? HubError).map { if case .http(_, let m) = $0 { return m }; return $0.localizedDescription } ?? error.localizedDescription
        }
    }

    private func create() {
        guard let c = engine.client else { return }
        sending = true
        let body = request
        Task {
            do { try await jobs.submit(body, client: c); dismiss() } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}

/// Pick a picture from the gallery (both bins).
struct GalleryPicker: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var onPick: (String) -> Void
    private let columns = [GridItem(.adaptive(minimum: 96), spacing: 3)]
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 3) {
                    ForEach(engine.list(.image).sorted { $0.created_at > $1.created_at }) { e in
                        Button { onPick(e.str("image_id")); dismiss() } label: { GalleryThumb(imageId: e.str("image_id")) }.buttonStyle(.plain)
                    }
                }
            }
            .overlay { if engine.list(.image).isEmpty { EmptyState(text: "The gallery is empty") } }
            .navigationTitle("Choose an image")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }
}

/// Generations started from this device: a slim strip above the Assistant's message bar.
struct ImageJobsStrip: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @StateObject private var jobs = ImageJobsModel.shared

    var body: some View {
        let shown = jobs.jobs.filter { $0.isActive || $0.status == "failed" || ($0.status == "succeeded" && $0.image_id != nil) }.prefix(3)
        if !shown.isEmpty {
            VStack(spacing: 6) {
                ForEach(Array(shown)) { j in
                    HStack(spacing: 10) {
                        if let id = j.image_id {
                            GalleryThumb(imageId: id).frame(width: 36, height: 36).clipShape(RoundedRectangle(cornerRadius: 6))
                        } else if j.isActive {
                            ProgressView().frame(width: 36, height: 36)
                        } else {
                            Image(systemName: "exclamationmark.triangle").frame(width: 36, height: 36).foregroundStyle(.orange)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(j.plan.prompt_original ?? "Image").font(.subheadline).lineLimit(1)
                            Text(j.status == "succeeded" ? "Saved to the Image Gallery" : (j.error ?? j.status_label)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if j.isActive, let c = engine.client {
                            Button { Task { await jobs.cancel(j, client: c) } } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless).accessibilityLabel("Cancel")
                        } else if j.status == "succeeded" {
                            Button("Open") { model.section = .images }.buttonStyle(.borderless).font(.caption)
                        }
                    }
                }
                if jobs.active.isEmpty {
                    Button("Clear") { jobs.dismissFinished() }.font(.caption).buttonStyle(.borderless).frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
