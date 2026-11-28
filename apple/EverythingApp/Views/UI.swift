import SwiftUI
import EACore

/// Large, terse, high-contrast controls. One screen shows one thing.
struct BigButton: View {
    /// The theme's accent for a prominent one: on the Mac, Color.accentColor is the system's accent, not the theme's.
    @Environment(\.eaTheme) private var theme
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
        .tint(prominent ? (theme?.accent ?? Color.accentColor) : nil)
        .controlSize(.large)
    }
}

/// Offline, connecting, or unable to sync: what is wrong, how long since the last sync once that is over an hour, and
/// Retry. When only pairing again can fix it (the hub refused this device's key, or its address now leads to another
/// hub), Pair again leads: Retry alone never helped, and the device was left with no way back.
struct StatusBanner: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    var body: some View {
        if engine.status != .online {
            Group {
                if engine.offersPairAgain { pairAgain } else { offline }
            }
            .font(.subheadline)
            .padding(10)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var offline: some View {
        HStack(spacing: 8) {
            Image(systemName: engine.status == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash")
            VStack(alignment: .leading, spacing: 2) {
                Text(engine.statusLabel)
                if engine.status == .offline, let line = detail(engine.lastError) {
                    Text(line).lineLimit(2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Retry") { Task { await engine.sync() } }.buttonStyle(.borderless)
        }
    }

    private var pairAgain: some View {
        let otherHub = engine.pairingProblem == .otherHub
        return VStack(alignment: .leading, spacing: 8) {
            Label(otherHub ? "This address leads to another hub" : SyncEngine.keyRefusedMessage,
                  systemImage: otherHub ? "exclamationmark.triangle" : "key")
                .font(.subheadline.weight(.semibold))
            if let line = detail(otherHub ? "Nothing was sent to it." : "Your hub no longer accepts its key. Changes not sent yet stay here and go once it is paired.") {
                Text(line).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 16) {
                Button("Pair again") { model.pairAgain() }
                    .buttonStyle(.themedProminent)
                    .accessibilityIdentifier("status.pairAgain")
                Button("Retry") { Task { await engine.sync() } }.buttonStyle(.borderless)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The reason, then how long since the last sync once that is over an hour.
    private func detail(_ reason: String?) -> String? {
        SyncFreshness.line(reason, lastSync: engine.lastSync)
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
                .buttonStyle(.themedProminent)
                .disabled(leaving)
                .accessibilityIdentifier("sample.leave")
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
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
            Button("Stop", action: stop).buttonStyle(.themedProminent).tint(.orange)
        }
        .controlSize(.small)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.warn.opacity(0.5)))
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
                .background(selected ? AnyShapeStyle(.tint.opacity(0.25)) : AnyShapeStyle(Color.secondary.opacity(0.15)), in: Capsule())
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
            let size = Self.size(of: s, width: width)
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = bounds.minX, y: CGFloat = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = Self.size(of: s, width: bounds.width)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }

    /// A chip at its own size, but never wider than the row: one wider than that (a button at the largest text
    /// sizes) is given the row's width and its words wrap, where it used to run past the edge of the screen.
    private static func size(of s: LayoutSubview, width: CGFloat) -> CGSize {
        let size = s.sizeThatFits(.unspecified)
        guard size.width > width, width > 0 else { return size }
        return s.sizeThatFits(ProposedViewSize(width: width, height: nil))
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

// MARK: Wide windows

/// How screens use a wide window: a large Mac window, or an iPad on its side.
///
/// A screen is wide from `minWidth` points. Below that every screen is laid out exactly as on the iPhone, so an iPad
/// held upright (1032 points at most, the 13-inch iPad Pro) and a Mac window of 1100 points (about 870 beside the
/// sidebar) do not change.
enum WideLayout {
    /// The width of a screen (the part of the window beside the sidebar) from which it is wide: 1040 points. A Debug
    /// build takes another from `-EAWideFrom <points>`, to look at the wide layouts on a screen too narrow for
    /// them, such as an iPad held upright in the simulator.
    static let minWidth: CGFloat = {
        #if DEBUG
        let asked = UserDefaults.standard.double(forKey: "EAWideFrom")
        if asked > 0 { return asked }
        #endif
        return 1040
    }()
    /// The same for what sits inside a screen's 16 point padding on each side.
    static let minContentWidth: CGFloat = minWidth - 32
    /// The narrowest a card in a grid of cards gets: 3 cards across a screen of 1040 points, 5 across a 1920 window.
    static let cardWidth: CGFloat = 320
    /// The space between two cards, and between two sections side by side.
    static let gap: CGFloat = 12
    #if DEBUG
    /// `-EAWideLayouts NO` (DebugHooksMac): every screen keeps its narrow layout at any width, to see the two side by
    /// side in screenshots.
    static let off = UserDefaults.standard.object(forKey: "EAWideLayouts") != nil && !UserDefaults.standard.bool(forKey: "EAWideLayouts")
    #else
    static let off = false
    #endif
}

private struct WideHintKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// Whether the window's screen area is wide, as last measured by `givesWideHint()`. A hint only: `WideReader`
    /// measures the screen itself and goes by that.
    var wideHint: Bool {
        get { self[WideHintKey.self] }
        set { self[WideHintKey.self] = newValue }
    }
}

private struct WideHint: ViewModifier {
    @State private var wide = false
    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: Bool.self) { $0.size.width >= WideLayout.minWidth } action: { wide = $0 }
            .environment(\.wideHint, wide)
    }
}

extension View {
    /// On the part of a window that shows screens (the split view's detail side, a screen's own window): measures it
    /// once and tells the screens inside whether it is wide, so a screen opened there starts in the right layout.
    func givesWideHint() -> some View { modifier(WideHint()) }
}

/// Tells a screen whether it is wide, so it can show another layout from `WideLayout.minWidth` points.
///
/// The answer is measured on the screen itself: a screen in a sheet or in a small window of its own is narrow even
/// while the main window is wide. Before the first measurement it takes the window's answer (`wideHint`), so a screen
/// opened in a wide window is drawn wide from the start instead of narrow for a moment.
///
/// `macOnly` is for a list whose rows are swiped (delete, archive, park): only a list can be swiped, so on the iPhone
/// and iPad such a screen stays a list at every width. On the Mac the same actions are in each row's right-click
/// menu, which a card keeps.
struct WideReader<Content: View>: View {
    @Environment(\.wideHint) private var hint
    @State private var measured: Bool?
    var macOnly = false
    @ViewBuilder var content: (Bool) -> Content

    private var allowed: Bool {
        if WideLayout.off { return false }
        #if os(macOS)
        return true
        #else
        return !macOnly
        #endif
    }

    var body: some View {
        content(allowed && (measured ?? hint))
            .onGeometryChange(for: Bool.self) { $0.size.width >= WideLayout.minWidth } action: { measured = $0 }
    }
}

/// Sections side by side on a wide screen, one under the other on a narrow one.
///
/// Below `WideLayout.minContentWidth` this is a plain column: each section at the full width, `spacing` apart, as a
/// VStack lays them out. From there the sections go into as many columns as fit at `minWidth` each (2 columns at
/// 1008 points and 3 at 1292 with the default 420), never more than `maxColumns`. The first section goes to the
/// first column, the second to the second and so on, starting over at the first column, and each column stacks its
/// sections from the top. A section's column depends only on its place in the list, never on how tall anything is,
/// so nothing moves to another column when a section grows.
struct AdaptiveColumns: Layout {
    var minWidth: CGFloat = 420
    var maxColumns = 3
    var spacing: CGFloat = 16

    /// Where each section goes: its column, its top and its height, and the height of it all.
    private struct Plan {
        var columnWidth: CGFloat
        var places: [(column: Int, y: CGFloat, height: CGFloat)]
        var height: CGFloat
    }

    private func columns(for width: CGFloat) -> Int {
        guard width >= WideLayout.minContentWidth, !WideLayout.off else { return 1 }
        return max(1, min(maxColumns, Int((width + spacing) / (minWidth + spacing))))
    }

    private func plan(width: CGFloat, subviews: Subviews) -> Plan {
        let n = columns(for: width)
        let columnWidth = (width - CGFloat(n - 1) * spacing) / CGFloat(n)
        var tops = [CGFloat](repeating: 0, count: n)
        var places: [(column: Int, y: CGFloat, height: CGFloat)] = []
        for (i, s) in subviews.enumerated() {
            let column = i % n
            let h = s.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height
            places.append((column, tops[column], h))
            tops[column] += h + spacing
        }
        return Plan(columnWidth: columnWidth, places: places, height: max(0, (tops.max() ?? 0) - spacing))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Asked for its own width (no width proposed): the widest section, as one column.
        guard let width = proposal.width, width.isFinite else {
            let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
            let height = sizes.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, sizes.count - 1))
            return CGSize(width: sizes.map(\.width).max() ?? 0, height: height)
        }
        return CGSize(width: width, height: plan(width: width, subviews: subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let p = plan(width: bounds.width, subviews: subviews)
        for (s, place) in zip(subviews, p.places) {
            let x = bounds.minX + CGFloat(place.column) * (p.columnWidth + spacing)
            s.place(at: CGPoint(x: x, y: bounds.minY + place.y), anchor: .topLeading, proposal: ProposedViewSize(width: p.columnWidth, height: place.height))
        }
    }
}

extension View {
    /// One card in a `CardGrid`: the row's content on the quiet fill the app's cards have, filling its cell, so the
    /// cards of one row are the same height.
    func gridCard() -> some View {
        padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(RoundedRectangle(cornerRadius: 12))
    }

    /// For a row view that is a list row on a narrow screen and a card on a wide one: a card only when `on`.
    @ViewBuilder func gridCard(if on: Bool) -> some View {
        if on { gridCard() } else { self }
    }
}

/// A collection of uniform cards on a wide screen: as many across as fit at `minWidth` each (3 across 1008 points,
/// 5 across the 1658 a 1920 window leaves), in reading order, left to right and then down. Only the cards on screen
/// are built, so a long collection opens as fast as its list does.
struct CardGrid<Content: View>: View {
    var minWidth: CGFloat = WideLayout.cardWidth
    @ViewBuilder var content: Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minWidth), spacing: WideLayout.gap, alignment: .top)], alignment: .leading, spacing: WideLayout.gap) {
            content
        }
    }
}

/// A screen that is one list of sections on a narrow screen and two lists side by side on a wide one.
///
/// Below `WideLayout.minWidth` it is the one list it always was: the first sections, then the second ones. From
/// there the first sections are a list on the left and the second ones a list on the right, each scrolling by itself,
/// so nothing a list row does (a swipe, a link, a field) changes. The right list is `secondWidth` points wide when
/// given, else the two share the width evenly.
struct SplitList<First: View, Second: View>: View {
    var secondWidth: CGFloat? = nil
    @ViewBuilder var first: First
    @ViewBuilder var second: Second

    var body: some View {
        WideReader { wide in
            if wide {
                HStack(alignment: .top, spacing: 0) {
                    List { first }
                    Divider()
                    if let secondWidth { List { second }.frame(width: secondWidth) } else { List { second } }
                }
                .environment(\.listsSideBySide, true)
            } else {
                List {
                    first
                    second
                }
            }
        }
    }
}

private struct ListsSideBySideKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// True inside a `SplitList` while its two lists are side by side, for words that say where something is
    /// ("above" on a narrow screen is "beside" on a wide one).
    var listsSideBySide: Bool {
        get { self[ListsSideBySideKey.self] }
        set { self[ListsSideBySideKey.self] = newValue }
    }
}

/// A wide screen's scrolling page: sections one under the other with the screen's usual 16 point padding.
struct WidePage<Content: View>: View {
    var spacing: CGFloat = 22
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
    }
}

/// One titled section of a wide page: what a list's section header and rows are on a narrow one.
struct WideSection<Header: View, Content: View>: View {
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header.font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension WideSection where Header == Text {
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.init(header: { Text(title) }, content: content)
    }
}
