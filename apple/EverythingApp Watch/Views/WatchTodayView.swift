import SwiftUI
import EACore

/// The rest of today on the wrist: all-day events, then events and reminders by time. A reminder can be finished
/// or snoozed ten minutes from here; one that asks for a reason takes it dictated.
struct WatchTodayView: View {
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let items = engine.agendaToday(now: ctx.date)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if items.isEmpty {
                        Text("Nothing else today").font(.title3).frame(maxWidth: .infinity)
                        Text("No events or reminders left.").font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                    ForEach(items) { item in row(item, now: ctx.date) }
                    OfflineDot().frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle("Today")
    }

    @ViewBuilder
    private func row(_ item: AgendaItem, now: Date) -> some View {
        let overdue = item.kind == .reminder && (item.at ?? now) < now
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: item.kind == .event ? "calendar" : "bell").font(.caption2)
                Text(when(item)).font(.caption2.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(overdue ? Color.orange : Color.secondary)
            Text(StyleGuard.dashes(item.title)).font(.body).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            if item.work { Text("Work").font(.caption2).foregroundStyle(.secondary) }
            if item.kind == .reminder {
                HStack(spacing: 6) {
                    Button { Task { await engine.ack(item.id); WKHaptic.success() } } label: {
                        Image(systemName: "checkmark").frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .tint(.green)
                    .accessibilityLabel("Done")
                    Button {
                        if item.friction == .none { snooze(item, reason: nil) } else { askReason(item) }
                    } label: {
                        Image(systemName: "zzz").frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .accessibilityLabel("Snooze 10 minutes")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }

    private func when(_ item: AgendaItem) -> String {
        if item.allDay { return "All day" }
        guard let at = item.at else { return "" }
        let t = at.formatted(date: .omitted, time: .shortened)
        if item.kind == .reminder, at < Date(), !Calendar.current.isDateInToday(at) { return "Overdue since " + at.formatted(.dateTime.month(.abbreviated).day()) }
        if let end = item.end, end > at { return "\(t) to \(end.formatted(date: .omitted, time: .shortened))" }
        return t
    }

    private func snooze(_ item: AgendaItem, reason: String?) {
        Task {
            if await engine.snooze(item.id, minutes: 10, reason: reason) { WKHaptic.success() }
        }
    }

    /// The reason is said, through the same dictation as the voice page. This was a sheet with a TextField, the one
    /// keyboard path on the Watch. Nothing said means no snooze.
    private func askReason(_ item: AgendaItem) {
        Task {
            guard let said = await Dictation.listen() else { return }
            snooze(item, reason: said)
        }
    }
}
