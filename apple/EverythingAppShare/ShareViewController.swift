import UIKit
import SwiftUI
import UniformTypeIdentifiers
import EACore

/// The share sheet entry: text, a link or an image from any app goes to EverythingApp's Capture, which files it as a
/// task, note, reminder or log by itself. Without a connection it waits in the app group and the app sends it later.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(items: extensionContext?.inputItems as? [NSExtensionItem] ?? [])
        let host = UIHostingController(rootView: ShareView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

@MainActor
final class ShareModel: ObservableObject {
    @Published var text = ""
    @Published var image: UIImage?
    @Published var status: String?
    @Published var busy = true
    private var jpeg: Data?

    init(items: [NSExtensionItem]) {
        Task { await load(items) }
    }

    private func load(_ items: [NSExtensionItem]) async {
        var parts: [String] = []
        for item in items {
            if let t = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { parts.append(t) }
            for p in item.attachments ?? [] {
                if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    if !parts.contains(u.absoluteString) { parts.append(u.absoluteString) }
                } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let t = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    if !parts.contains(t) { parts.append(t) }
                } else if p.hasItemConformingToTypeIdentifier(UTType.image.identifier), jpeg == nil {
                    let raw = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier)
                    let data: Data? = (raw as? URL).flatMap { try? Data(contentsOf: $0) } ?? (raw as? Data) ?? (raw as? UIImage)?.jpegData(compressionQuality: 0.9)
                    if let d = data, let small = ImageShrinker.jpeg(from: d) {
                        jpeg = small
                        image = UIImage(data: small)
                    }
                }
            }
        }
        text = parts.joined(separator: "\n")
        busy = false
    }

    func save() async -> Bool {
        busy = true
        defer { busy = false }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = jpeg.map { [Attachment(name: "shared.jpg", mime: "image/jpeg", bytes_b64: $0.base64EncodedString())] }
        let req = CaptureRequest(text: body.isEmpty ? "Shared image" : body, source: .iphone, attachments: attachments, auto: true)
        let config = SharedConfig.shared
        if let client = HubClient.make(config: config), (try? await withDeadline(30, { try await client.capture(req) })) != nil {
            status = "Saved"
            return true
        }
        do {
            try PendingShares.add(req)
            status = "Saved here; it goes to the hub when the app next opens"
            return true
        } catch {
            status = "Could not save: \(error.localizedDescription)"
            return false
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    var done: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextEditor(text: $model.text).frame(minHeight: 120)
                    if let img = model.image {
                        Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                } footer: {
                    Text("Goes to Capture, which files it as a task, note, reminder or log by itself.")
                }
                if let s = model.status { Text(s).foregroundStyle(.secondary) }
            }
            .navigationTitle("EverythingApp")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: done) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.save() {
                                try? await Task.sleep(nanoseconds: 600_000_000)
                                done()
                            }
                        }
                    }
                    .disabled(model.busy || (model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.image == nil))
                }
            }
        }
    }
}
