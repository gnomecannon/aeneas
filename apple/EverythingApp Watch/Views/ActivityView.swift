import SwiftUI
import EACore

/// One-tap activity tracker. Tap starts; tapping the current one ends it.
struct ActivityView: View {
    @EnvironmentObject var engine: SyncEngine

    private let defaults = ["Work", "Homelab", "Music", "Game", "Drive", "Rest"]

    private var names: [String] {
        var out = engine.recentValues(type: .activity, limit: 8)
        for d in defaults where !out.contains(where: { $0.caseInsensitiveCompare(d) == .orderedSame }) { out.append(d) }
        return Array(out.prefix(10))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let cur = engine.currentActivity {
                    TimelineView(.periodic(from: .now, by: 30)) { ctx in
                        VStack(spacing: 2) {
                            Text(cur.name).font(.headline)
                            Text(elapsed(since: cur.start, now: ctx.date)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("Nothing running").font(.caption).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(names, id: \.self) { n in
                        let active = engine.currentActivity?.name.caseInsensitiveCompare(n) == .orderedSame
                        Button { Task { await engine.toggleActivity(n) } } label: {
                            Text(active ? "End \(n)" : n)
                                .font(.body.weight(.semibold))
                                .lineLimit(2)
                                .minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity, minHeight: 52)
                        }
                        .tint(active ? .orange : .accentColor)
                    }
                    // Voice only: another activity is said, not typed. This was a TextField, which opened the keyboard.
                    Button {
                        Task {
                            guard let said = await Dictation.listen() else { return }
                            await engine.toggleActivity(said)
                        }
                    } label: {
                        Label("Say one", systemImage: "mic.fill")
                            .font(.body.weight(.semibold))
                            .lineLimit(2)
                            .minimumScaleFactor(0.7)
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .accessibilityLabel("Say another activity")
                }
                OfflineDot()
            }
            .padding(.horizontal, 2)
        }
        .navigationTitle("Activity")
    }

    private func elapsed(since start: Date, now: Date) -> String {
        let s = Int(max(0, now.timeIntervalSince(start)))
        let h = s / 3600, m = (s % 3600) / 60
        return h > 0 ? "\(h) h \(m) min" : "\(m) min"
    }
}
