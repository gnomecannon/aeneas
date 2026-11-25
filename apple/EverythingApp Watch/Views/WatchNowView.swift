import SwiftUI
import EACore

/// The Watch's Now and next page: the Next line (CONTRACT.md, Planner, The Next line), the same words as the iPhone's
/// Today and the complication. The task you started, with Done and Skip, and under it what is on now or next; else what
/// is on now or next with a time, else the free time. Then the Next tasks, each a tap to start. Until 2026-11-25 this
/// page showed the Now task, the first task in Next when none was started.
struct WatchNowView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                // Read again every half minute: the minutes left count down.
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    line(engine.nextLinePlan(now: ctx.date), at: ctx.date)
                }
                let toStart = Array(engine.upNext.prefix(3))
                if !toStart.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Next tasks").font(.caption2).foregroundStyle(.secondary)
                        ForEach(toStart) { n in
                            // A tap starts it: it is then the task on the line.
                            Button { Task { await engine.startTask(n.id); WKHaptic.click() } } label: {
                                Text(StyleGuard.dashes(n.str("title"))).font(.footnote).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.bordered)
                            .accessibilityHint("Starts it")
                        }
                    }
                }
                // A reminder whose time has passed is not on the line (it waits in Today's Needs you): said here.
                if let up = engine.nextUp(), up.kind == .reminder, let at = up.at, at < Date() {
                    Button { model.page = .today } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "bell")
                            Text("Overdue: " + StyleGuard.dashes(up.title)).lineLimit(1)
                        }
                        .font(.caption2)
                        .foregroundStyle(Color.orange)
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
        .navigationTitle("Now and next")
    }

    @ViewBuilder
    private func line(_ plan: NextLinePlan, at date: Date) -> some View {
        let w = plan.words(at: date)
        VStack(spacing: 6) {
            Text(w.label.rawValue).font(.caption2).foregroundStyle(.secondary)
            Text(StyleGuard.dashes(w.title))
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if !w.detail.isEmpty { Text(w.detail).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center) }
            if let started = engine.startedTask {
                Button { Task { await engine.markDone(started.id); WKHaptic.success() } } label: {
                    Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 44)
                }
                .tint(.green)
                Button { Task { await engine.skip(started.id); WKHaptic.click() } } label: {
                    Label("Skip", systemImage: "forward").frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityHint("Back to the end of Next")
                if let then = plan.then(at: date) {
                    Text(StyleGuard.dashes(then.text)).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
            } else if w.label == .today {
                Text("Ask, capture and hum are one page up.").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
