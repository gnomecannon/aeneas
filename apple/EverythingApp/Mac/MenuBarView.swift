#if os(macOS)
import SwiftUI
import EACore

/// Menu bar extra: capture field and the Now task.
struct MenuBarView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.openWindow) private var openWindow
    @State private var text = ""
    @State private var message: String?
    /// A capture on its way: a second Return used to send it again.
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let now = engine.nowTask {
                VStack(alignment: .leading, spacing: 6) {
                    Text(now.str("status") == "doing" ? "Doing" : "Next").font(.caption).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(now.str("title"))).font(.title3.weight(.semibold)).lineLimit(3)
                    HStack {
                        Button("Done") { Task { await engine.markDone(now.id) } }
                        Button("Skip") { Task { await engine.skip(now.id) } }
                        if now.str("status") != "doing" { Button("Start 3 h") { Task { await engine.startBlock(now.id) } } }
                    }
                }
            } else {
                Text("Nothing is next").font(.title3).foregroundStyle(.secondary)
            }
            Divider()
            TextField("Capture", text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4).onSubmit { save() }
            HStack {
                Button("Save") { save() }.buttonStyle(.borderedProminent)
                Spacer()
                Text(message ?? engine.statusLabel).font(.caption).foregroundStyle(.secondary)
            }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            Divider()
            HStack {
                Button("Open EverythingApp") { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil) }
                Spacer()
                if let s = UserDefaults.standard.string(forKey: HotKey.settingKey), s != "off" {
                    Text("\(HotKey.label(s)) to capture").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .frame(width: 340)
        .task { await model.ensureStarted() }
    }

    /// Every capture is sorted: into the day's diary, then filed by the assistant.
    private func save() {
        let t = text
        guard !saving, !t.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        saving = true
        Task {
            let e = await engine.capture(t)
            saving = false
            // Only what was sent is cleared: words typed while it saved used to be wiped too.
            if e != nil { text = CaptureDraft.remainder(after: t, now: text).text }
            message = e == nil ? "Nothing saved" : engine.status == .online ? "Saved" : "Saved offline"
        }
    }
}
#endif
