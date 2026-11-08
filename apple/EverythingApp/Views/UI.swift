import SwiftUI
import EACore

/// Large, terse, high-contrast controls. One screen shows one thing.
struct BigButton: View {
    var title: String
    var symbol: String? = nil
    var role: ButtonRole? = nil
    var prominent: Bool = false
    var action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: 10) {
                if let s = symbol { Image(systemName: s) }
                Text(title)
            }
            .font(.title3.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .tint(prominent ? Color.accentColor : nil)
        .controlSize(.large)
    }
}

struct StatusBanner: View {
    @EnvironmentObject var engine: SyncEngine
    var body: some View {
        if engine.status != .online {
            HStack(spacing: 8) {
                Image(systemName: engine.status == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash")
                Text(engine.statusLabel)
                if let e = engine.lastError, engine.status == .offline {
                    Text(e).lineLimit(1).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Retry") { Task { await engine.sync() } }.buttonStyle(.borderless)
            }
            .font(.subheadline)
            .padding(10)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

/// Sample mode (Setup, Try it with sample data): says plainly that this is a made-up month, and offers the way out.
struct SampleBanner: View {
    @EnvironmentObject var model: AppModel
    @State private var leaving = false
    var body: some View {
        if model.config.sampleMode {
            VStack(alignment: .leading, spacing: 8) {
                Label("Sample data", systemImage: "sparkles").font(.headline)
                Text("A made-up month, so you can look around. Nothing here is yours, nothing leaves this device, and what you change is wiped when you set up your own hub. The assistant needs your hub to answer.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button(leaving ? "Leaving" : "Set up my own hub") {
                    leaving = true
                    Task { await model.endSample(); leaving = false }
                }
                .buttonStyle(.borderedProminent)
                .disabled(leaving)
                .accessibilityIdentifier("sample.leave")
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

/// Non-blocking activity check-in: "On <value> for <h> h", Still on it, Stop.
struct CheckinBanner: View {
    var checkin: ActivityCheckin
    var still: () -> Void
    var stop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "figure.walk.motion").font(.title3)
            Text(StyleGuard.dashes(checkin.title)).font(.body.weight(.semibold)).lineLimit(2)
            Spacer(minLength: 4)
            Button("Still on it", action: still).buttonStyle(.bordered)
            Button("Stop", action: stop).buttonStyle(.borderedProminent).tint(.orange)
        }
        .controlSize(.small)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.orange.opacity(0.5)))
        .shadow(radius: 6, y: 2)
        .accessibilityElement(children: .contain)
    }
}

struct EmptyState: View {
    var text: String
    var body: some View {
        VStack {
            Spacer()
            Text(text).font(.title2).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding()
    }
}

/// Small label marking an entity's space, e.g. "Work" on events imported from the work calendar.
struct SpaceChip: View {
    var text: String
    var compact = false
    var body: some View {
        Text(text)
            .font((compact ? Font.caption2 : Font.caption).weight(.semibold))
            .padding(.horizontal, compact ? 4 : 6)
            .padding(.vertical, compact ? 1 : 2)
            .background(Color.indigo.opacity(0.18), in: Capsule())
            .foregroundStyle(Color.indigo)
    }
}

struct Chip: View {
    var text: String
    var selected: Bool = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.body.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(selected ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.15), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = bounds.minX, y: CGFloat = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }
}

extension Date {
    var shortTime: String { formatted(date: .omitted, time: .shortened) }
    var shortDateTime: String { formatted(date: .abbreviated, time: .shortened) }
}

func dateLabel(_ iso: String?) -> String {
    guard let d = ISO.date(iso) else { return "" }
    if Calendar.current.isDateInToday(d) { return d.shortTime }
    return d.shortDateTime
}

func elapsedLabel(since start: Date, now: Date = Date()) -> String {
    let s = Int(max(0, now.timeIntervalSince(start)))
    let h = s / 3600, m = (s % 3600) / 60
    if h > 0 { return "\(h) h \(m) min" }
    return "\(m) min"
}

#if os(iOS)
extension View {
    func numericKeyboard() -> some View { keyboardType(.decimalPad) }
}
#else
extension View {
    func numericKeyboard() -> some View { self }
}
#endif

/// Swipe left on a row (or right-click it on the Mac) to delete the item. Deleting is a soft delete: the hub keeps it
/// for undo and every device drops it on the next sync.
struct DeleteSwipe: ViewModifier {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    var label: String
    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) { Task { await engine.softDelete(id) } } label: { Label(label, systemImage: "trash") }
            }
            .contextMenu {
                Button(role: .destructive) { Task { await engine.softDelete(id) } } label: { Label(label, systemImage: "trash") }
            }
    }
}

extension View {
    func deleteSwipe(_ id: String, label: String = "Delete") -> some View { modifier(DeleteSwipe(id: id, label: label)) }
}
