#if os(macOS)
import SwiftUI
import EACore

/// Menu bar extra: the Next line (the task you started, with its buttons, else what is on now or next, else the free
/// time; CONTRACT.md, Planner, The Next line) and a capture field. It showed the Now task, the first task in Next when
/// none was started, until 2026-11-25.
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
            // Read again every half minute: the minutes left count down.
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                let plan = engine.nextLinePlan(now: ctx.date)
                let line = plan.words(at: ctx.date)
                VStack(alignment: .leading, spacing: 6) {
                    Text(line.label.rawValue).font(.caption).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(line.title)).font(.title3.weight(.semibold)).lineLimit(3)
                    if !line.detail.isEmpty { Text(line.detail).font(.subheadline).foregroundStyle(.secondary) }
                    if let started = engine.startedTask {
                        let blockOn = plan.started.map { ($0.blockStart ?? .distantFuture) <= ctx.date && ($0.blockEnd ?? .distantPast) > ctx.date } == true
                        HStack {
                            Button("Done") { Task { await engine.markDone(started.id) } }
                            Button("Skip") { Task { await engine.skip(started.id) } }.help("Back to the end of Next")
                            if !blockOn { Button("Start 3 h") { Task { await engine.startBlock(started.id) } } }
                        }
                        // Under the task you started: what is on now or next.
                        if let then = plan.then(at: ctx.date) {
                            Text(StyleGuard.dashes(then.text)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
            }
            Divider()
            TextField("Capture", text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4).onSubmit { save() }
            HStack {
                Button("Save") { save() }.buttonStyle(.themedProminent)
                Spacer()
                Text(message ?? engine.statusLabel).font(.caption).foregroundStyle(.secondary)
            }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            Divider()
            HStack {
                Button("Open Aeneas") { MainWindow.open(openWindow) }
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
