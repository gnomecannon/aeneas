#if os(macOS)
import AppKit
import SwiftUI
import EACore

/// Floating capture panel popped by the global hotkey.
@MainActor
final class QuickCapturePanel {
    static let shared = QuickCapturePanel()
    private var panel: NSPanel?

    func toggle() {
        if let p = panel, p.isVisible { p.orderOut(nil); return }
        show()
    }

    func show() {
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 220), styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
            p.title = "Capture"
            p.titleVisibility = .hidden
            p.titlebarAppearsTransparent = true
            p.level = .floating
            p.isFloatingPanel = true
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.contentView = NSHostingView(rootView: QuickCaptureView(close: { [weak p] in p?.orderOut(nil) })
                .environmentObject(AppModel.shared)
                .environmentObject(AppModel.shared.engine))
            panel = p
        }
        panel?.center()
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
    }
}

struct QuickCaptureView: View {
    @EnvironmentObject var engine: SyncEngine
    var close: () -> Void
    @State private var text = ""
    @State private var message: String?
    /// A capture on its way: a second Return used to send it again.
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let now = engine.nowTask {
                Text("Now: \(StyleGuard.dashes(now.str("title")))").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
            TextField("Capture", text: $text, axis: .vertical)
                .font(.title2)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...5)
                .focused($focused)
                .onSubmit { save() }
            HStack {
                Text(message ?? engine.statusLabel).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
                Button("Save") { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(20)
        .frame(width: 520)
        .task { await AppModel.shared.ensureStarted(); focused = true }
        .onAppear { focused = true }
    }

    /// Every capture is sorted: into the day's diary, then filed by the assistant.
    private func save() {
        let t = text
        guard !saving, !t.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        saving = true
        Task {
            let e = await engine.capture(t)
            saving = false
            guard e != nil else { message = "Nothing saved"; return }
            // Only what was sent is cleared: words typed while it saved used to be wiped too, and the panel stays
            // open for them.
            text = CaptureDraft.remainder(after: t, now: text).text
            message = engine.status == .online ? "Saved" : "Saved offline"
            guard text.isEmpty else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            close()
            message = nil
        }
    }
}
#endif
