import SwiftUI
import EACore

struct WatchNowView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let t = engine.nowTask {
                    Text(t.str("status") == "doing" ? "Doing" : "Next").font(.caption2).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(t.str("title")))
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Button { Task { await engine.markDone(t.id); WKHaptic.success() } } label: {
                        Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .tint(.green)
                    Button { Task { await engine.skip(t.id); WKHaptic.click() } } label: {
                        Label("Skip", systemImage: "forward").frame(maxWidth: .infinity, minHeight: 44)
                    }
                } else {
                    Text("Nothing is next").font(.title3).multilineTextAlignment(.center)
                    Text("Ask, capture and hum are one page up.").font(.caption2).foregroundStyle(.secondary)
                }
                let later = Array(engine.upNext.prefix(3))
                if !later.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Up next").font(.caption2).foregroundStyle(.secondary)
                        ForEach(later) { n in
                            // Tapping one makes it the Now task.
                            Button { Task { await engine.makeNow(n.id); WKHaptic.click() } } label: {
                                Text(StyleGuard.dashes(n.str("title"))).font(.footnote).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                if let up = engine.nextUp() {
                    Button { model.page = .today } label: {
                        HStack(spacing: 4) {
                            Image(systemName: up.kind == .event ? "calendar" : "bell")
                            Text(nextLabel(up) + StyleGuard.dashes(up.title)).lineLimit(1)
                        }
                        .font(.caption2)
                        .foregroundStyle(up.kind == .reminder && (up.at ?? .now) < .now ? Color.orange : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
                if model.isOn(.homelab), let g = engine.homelabGlance {
                    HStack(spacing: 4) {
                        Image(systemName: g.allUp ? "checkmark.circle" : "exclamationmark.triangle")
                        Text(g.allUp ? "Homelab all up" : "\(g.down.first ?? "")\(g.down.count > 1 ? " and \(g.down.count - 1) more" : "") down").lineLimit(1)
                    }
                    .font(.caption2)
                    .foregroundStyle(g.allUp ? Color.green : Color.orange)
                }
                OfflineDot()
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Now")
    }

    private func nextLabel(_ up: AgendaItem) -> String {
        guard let at = up.at else { return "" }
        if up.kind == .reminder, at < Date() { return "Overdue: " }
        return at.formatted(date: .omitted, time: .shortened) + " "
    }
}
