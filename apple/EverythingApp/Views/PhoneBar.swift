import SwiftUI
import EACore
#if os(iOS)
import UIKit
#endif

// The iPhone's bottom bar (Settings, Theme, Bottom bar chooses what is in it; the rules are EACore `Bar.swift`). The
// first part of this file is for every platform, since the page that edits the bar is on the iPad and Mac too; the
// bar itself and the iPhone's root view are below, for iOS only.

extension AppModel {
    /// The screens the bottom bar can hold on this device now, as groups for the list to choose from: the main ones,
    /// then the Library's areas (a module's screen only while the module is on).
    var barChoices: [LibraryArea] {
        [LibraryArea(title: BarText.main, sections: [.today, .assistant, .capture, .library, .search])] + libraryAreas
    }

    /// The ids of the screens the bar can show on this device now.
    var barScreensOn: Set<String> { Set(barChoices.flatMap(\.sections).map(\.rawValue)) }

    /// The bottom bar as this device draws it now: the setting's places without the screens that are off here.
    func barLayout(_ bar: BarSetting) -> BarLayout {
        let on = barScreensOn
        return bar.layout { on.contains($0) }
    }
}

extension BarLayout {
    /// The tab a screen shows on: its own when it has a place, else its home's (`Section.barHome`), else Library's.
    func tab(for s: Section) -> Section {
        Section(rawValue: tab(for: s.rawValue, home: s.barHome?.rawValue)) ?? .library
    }
}

private struct PhoneBarKey: EnvironmentKey { static let defaultValue: BarLayout? = nil }

/// A press in the bar on the screen that is already showing: that screen goes back to its first page, as a press on
/// the system's tab bar did.
struct BarReselect: Equatable {
    var tab = ""
    var count = 0
}

private struct BarReselectKey: EnvironmentKey { static let defaultValue = BarReselect() }

private struct BarRoomKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }

extension EnvironmentValues {
    /// The room the bottom bar takes at the bottom of the screens in its tabs, in points. 0 where there is no bar
    /// (the iPad and Mac) and while the keyboard is up.
    var barRoom: CGFloat {
        get { self[BarRoomKey.self] }
        set { self[BarRoomKey.self] = newValue }
    }

    /// The bottom bar as the phone layout draws it now. Nil where there is no bar: the iPad and Mac with their sidebar.
    var phoneBar: BarLayout? {
        get { self[PhoneBarKey.self] }
        set { self[PhoneBarKey.self] = newValue }
    }

    var barReselect: BarReselect {
        get { self[BarReselectKey.self] }
        set { self[BarReselectKey.self] = newValue }
    }
}

/// One screen as the bar draws it: its symbol (filled, as the system's tab bar draws every one) over its name, at the
/// size the count gives (`BarSize`). The name follows the text size chosen on the device up to 1.3 times its own size
/// and the symbol up to 1.15 times; past that the bar would not fit five across, and a long press shows the screen
/// large instead (the system's own tab bar does the same). A name too long for its place is tightened, then drawn
/// smaller, down to three quarters.
struct BarItemLabel: View {
    var title: String
    var symbol: String
    var size: BarSize
    /// A count on the symbol's corner (Library: captures to sort).
    var badge = 0
    @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1

    var body: some View {
        let nameScale = min(max(textScale, 1), 1.3), symbolScale = min(max(textScale, 1), 1.15)
        VStack(spacing: size.gap) {
            Image(systemName: symbol)
                .symbolVariant(.fill)
                .font(.system(size: size.icon * symbolScale))
                .frame(height: size.box * symbolScale)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 { BarBadge(count: badge).offset(x: 13, y: -2) }
                }
            Text(title)
                .font(.system(size: size.label * nameScale, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .allowsTightening(true)
        }
        .padding(.vertical, size.pad)
        .padding(.horizontal, 2)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// The count on Library's corner, as the system's tab bar drew it: white on red.
private struct BarBadge: View {
    var count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 17, minHeight: 17)
            .background(Color.red, in: Capsule())
            .fixedSize()
            .accessibilityHidden(true)
    }
}

#if os(iOS)

/// The bar itself, drawn as the system's tab bar is from iOS 26 on: one glass panel floating over the bottom of the
/// screen, a capsule with the first row while it is folded. A press and drag up anywhere on the bar stretches the panel
/// upward like a liquid: the middle of its top edge bulges up first, then the whole top rises with the finger, and the
/// second row fades in inside it above the first. Open, it is one taller rounded panel holding both rows, with no gap or
/// seam between them. Pulled further, the glass keeps stretching with growing resistance and springs back with a small
/// bounce when let go. It stays open once it would come to rest more than half open, and folds on a drag down, a tap
/// outside the bar (PhoneRoot) or a choice, shrinking back down the same way. The grabber in the panel's top edge is a
/// button that does the same without a drag, in the accent color while a screen of the second row is the one showing.
/// With Reduce Motion the panel does not stretch: the second row fades in and out.
///
/// From iOS 26 the panel is Liquid Glass that reacts to a touch, and the screen showing sits in a glass capsule of its
/// own that slides to the one chosen. Before iOS 26 the same shape is drawn in the bar material, or in the theme's card
/// color when a theme is chosen.
struct PhoneBar: View {
    var layout: BarLayout
    /// The screen that is showing.
    var current: Section
    /// Captures to sort, shown on Library.
    var badge: Int
    @Binding var open: Bool
    /// The room the device keeps free at the bottom of the screen (for the home indicator), in points.
    var bottomInset: CGFloat
    var choose: (Section) -> Void

    @Environment(\.eaTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var space
    /// How far the finger has moved up since it pressed the bar; back to 0 when it lifts, with the panel's spring.
    @GestureState(resetTransaction: Transaction(animation: PhoneBar.liquid)) private var pull: CGFloat = 0
    /// The second row's own height, measured once it is laid out: how far the panel rises to open.
    @State private var moreHeight: CGFloat = PhoneBar.capsuleHeight(BarSize.of(count: 5))
    /// With Reduce Motion: whether the panel is drawn open, and how far the second row has faded in. Folding, the
    /// row fades out before the panel goes back to its folded size.
    @State private var calmOpen = false
    @State private var calmShown: CGFloat = 0

    static let settle = Animation.snappy(duration: 0.25)
    /// The panel growing and shrinking: a spring with a small bounce, as the system's glass menus open and close.
    static let liquid = Animation.spring(duration: 0.45, bounce: 0.3)
    /// The system's five-tab bar on iOS 26, as drawn on an iPhone: the capsule 21 points in from the screen's sides,
    /// the screens 8 points in from the capsule's ends, 6 points under its top and 7 over its bottom (62 points tall in
    /// all).
    static let side: CGFloat = 21
    static let padH: CGFloat = 8
    static let padTop: CGFloat = 6
    static let padBottom: CGFloat = 7
    /// The band at the top of the panel the grabber sits in, while there is a second row.
    static let strip: CGFloat = 8

    #if DEBUG
    /// `-EABarReveal <points>` (DebugHooks): the panel held as if pulled up that far, so each stage can be photographed.
    private static let heldPull: CGFloat? = UserDefaults.standard.string(forKey: "EABarReveal").flatMap(Double.init).map { CGFloat($0) }
    #endif

    /// A capsule's height at the standard text size.
    static func capsuleHeight(_ size: BarSize) -> CGFloat { CGFloat(size.rowHeight) + padTop + padBottom }

    /// The room the device keeps free at the bottom of the screen: 34 points on an iPhone with a home indicator held
    /// upright, 21 on its side, none on one with a home button. The window's own, so the keyboard does not count.
    @MainActor static func homeIndicatorInset() -> CGFloat {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return (windows.first(where: \.isKeyWindow) ?? windows.first)?.safeAreaInsets.bottom ?? 0
    }

    var body: some View {
        let size = BarSize.of(count: layout.count)
        let first = layout.first.compactMap(Section.init(rawValue:))
        let second = layout.second.compactMap(Section.init(rawValue:))
        let rise = second.isEmpty ? 0 : Self.rise(pulled: pulled, full: moreHeight)

        container {
            panel(first: first, second: second, size: size, rise: rise)
        }
        // What the panel has risen is above the bar's own height, so the screens do not move as it opens.
        .padding(.top, -rise)
        .modifier(BarInk())
        .highPriorityGesture(drag(full: moreHeight), including: second.isEmpty ? .subviews : .all)
        // The capsule behind the screen showing slides to the one chosen.
        .animation(Self.settle, value: current)
        .frame(maxWidth: 560)
        .padding(.horizontal, Self.side)
        .padding(.bottom, floatingBottom)
        .frame(maxWidth: .infinity)
        .onAppear { calmOpen = open; calmShown = open ? 1 : 0 }
        .onChange(of: open) { _, now in
            guard reduceMotion else { calmOpen = now; calmShown = now ? 1 : 0; return }
            if now {
                calmOpen = true
                withAnimation(.easeInOut(duration: 0.2)) { calmShown = 1 }
            } else {
                withAnimation(.easeInOut(duration: 0.2)) { calmShown = 0 } completion: { if !open { calmOpen = false } }
            }
        }
    }

    /// How far up the panel is pulled, in points: open or folded, and the finger's pull. With Reduce Motion it does
    /// not follow the finger.
    private var pulled: CGFloat {
        #if DEBUG
        if let held = Self.heldPull { return held }
        #endif
        if reduceMotion { return calmOpen ? moreHeight : 0 }
        return (open ? moreHeight : 0) + pull
    }

    /// How far the panel rises for a pull of `pulled` points. Up to the second row's height it follows the finger; past
    /// it the glass stretches on with growing resistance, as a list does past its end, and a pull down squeezes the
    /// folded capsule a little.
    static func rise(pulled: CGFloat, full: CGFloat) -> CGFloat {
        if pulled > full { return full + resist(pulled - full, limit: full / 2) }
        if pulled < 0 { return -resist(-pulled, limit: 6) }
        return pulled
    }

    private static func resist(_ x: CGFloat, limit: CGFloat) -> CGFloat {
        limit * (1 - 1 / (x * 0.55 / max(limit, 1) + 1))
    }

    /// 0 to 1 along `t` from 0 to 1, slow at both ends.
    static func ease(_ t: CGFloat) -> CGFloat {
        let x = min(max(t, 0), 1)
        return x * x * (3 - 2 * x)
    }

    /// Where the bar's bottom edge sits: 21 points above the screen's, as the system's does, which on an iPhone with a
    /// home indicator is 13 points into the room kept free for it; 8 points up on one with a home button.
    private var floatingBottom: CGFloat {
        if bottomInset >= 30 { return 21 - bottomInset }
        return bottomInset > 0 ? 0 : 8
    }

    /// From iOS 26 the panel and the capsule of the screen showing are glass of one container.
    @ViewBuilder private func container<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer { content() }
        } else {
            content()
        }
    }

    /// The one panel: the grabber's band, the second row and the first, as tall as the folded bar and what it has
    /// risen. The rest of the second row is above the panel's top edge, out of sight; it comes in with the glass, not
    /// before it: from a third of the way up it fades in, grows to its size and sharpens.
    private func panel(first: [Section], second: [Section], size: BarSize, rise: CGFloat) -> some View {
        let hasMore = !second.isEmpty
        let full = moreHeight
        let shape = LiquidPanel(rise: rise, full: full)
        let shown = reduceMotion ? calmShown : (full > 0 ? Self.ease((rise / full - 0.3) / 0.6) : 0)
        return VStack(spacing: 0) {
            if hasMore {
                row(second, size: size, marks: rise > 0.5)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(BarText.more)
                    .accessibilityAddTraits(.isTabBar)
                    .accessibilityHidden(!open)
                    .allowsHitTesting(open)
                    .padding(.horizontal, Self.padH)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if $0 > 0 { moreHeight = $0 } }
                    .opacity(shown)
                    .scaleEffect(reduceMotion ? 1 : 0.92 + 0.08 * shown, anchor: .bottom)
                    .blur(radius: 5 * (1 - shown))
            }
            row(first, size: size, marks: true)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isTabBar)
                .accessibilityActions {
                    if hasMore {
                        Button(open ? BarText.hideMore : BarText.showMore) { toggle() }
                    }
                }
                .padding(.horizontal, Self.padH)
        }
        .padding(.top, hasMore ? Self.strip : 0)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, hasMore ? rise - full : 0)
        .clipShape(shape)
        .contentShape(shape)
        // Inside the glass's content, or the glass draws over it.
        .overlay(alignment: .top) {
            if hasMore { grabber(lit: second.contains(current)) }
        }
        .modifier(BarGlass(shape: shape))
    }

    /// A row of screens. `marks`: whether the capsule of the screen showing may be drawn in it (the second row's only
    /// while it is out).
    private func row(_ screens: [Section], size: BarSize, marks: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(screens) { s in
                let selected = s == current
                let count = s == .library ? badge : 0
                Button { pick(s) } label: {
                    // The screen's place reaches the panel's edges, so a press anywhere on the bar lands on a screen.
                    BarItemLabel(title: s.title, symbol: s.symbol, size: size, badge: count)
                        .padding(.top, Self.padTop)
                        .padding(.bottom, Self.padBottom)
                        .background {
                            if selected, marks { bubble }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(BarItemStyle())
                .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .accessibilityLabel(s.title)
                .accessibilityValue(count > 0 ? "\(count) to sort" : "")
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityShowsLargeContentViewer { Label(s.title, systemImage: s.symbol) }
            }
        }
    }

    /// The screen showing, as the system's bar marks it: a capsule 4 points in from the bar's edges and 4 points past
    /// the screen's place on each side, a little darker than the bar in light mode and lighter in dark mode. From iOS
    /// 26 it is glass of its own, tinted with the text color until it is as light as the system's (6 and 13 percent),
    /// that reacts to a touch and, by its id, slides to the screen chosen. Before, a plain capsule of 7 and 14 percent.
    @ViewBuilder private var bubble: some View {
        let ink = theme?.text ?? .primary
        let dark = scheme == .dark
        if #available(iOS 26.0, *) {
            Color.clear
                .glassEffect(.regular.tint(ink.opacity(dark ? 0.13 : 0.06)).interactive(), in: .capsule)
                .padding(.horizontal, 4 - Self.padH)
                .padding(.vertical, 4)
                .glassEffectID("bubble", in: space)
        } else {
            Capsule()
                .fill(ink.opacity(dark ? 0.14 : 0.07))
                .padding(.horizontal, 4 - Self.padH)
                .padding(.vertical, 4)
                .matchedGeometryEffect(id: "bubble", in: space)
        }
    }

    /// The grabber: a short pill in the panel's top band, centered over the bar, rising with the top edge. Its box
    /// reaches up past the panel's edge and down to the screens' places, never over them.
    private func grabber(lit: Bool) -> some View {
        let reach: CGFloat = 14
        return Button { toggle() } label: {
            Capsule()
                .fill(lit ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary.opacity(0.7)))
                .frame(width: 36, height: 5)
                .padding(.top, reach + 3)
                .frame(width: 120, height: reach + Self.strip, alignment: .top)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, -reach)
        .accessibilityLabel(BarText.more)
        .accessibilityValue(open ? BarText.opened : BarText.closed)
    }

    private func drag(full: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($pull) { value, pull, _ in pull = -value.translation.height }
            .onEnded { value in
                // Where the panel would come to rest: past half way it stays open. A slow drag rests where it is let
                // go; a flick carries on, so a short quick one opens or folds it too.
                let rest = (open ? full : 0) - value.predictedEndTranslation.height
                set(open: rest > full / 2)
            }
    }

    private func toggle() { set(open: !open) }

    private func pick(_ s: Section) {
        if open { set(open: false) }
        choose(s)
    }

    /// Opens or folds the panel with its spring; with Reduce Motion at once, and the second row fades.
    private func set(open now: Bool) {
        withAnimation(reduceMotion ? nil : Self.liquid) { open = now }
    }
}

/// The panel's outline: a capsule as tall as the folded bar, grown upward by `rise`, its round ends kept as it grows.
/// While it grows the top bulges first: the middle of the top edge leads and the corners trail it, so the glass looks
/// drawn up like a liquid; it flattens as the panel opens and bulges again while it is pulled past open. Below 0 the
/// folded capsule is squeezed a little. The rise is animated, so the bulge also shows when a tap opens or folds it.
struct LiquidPanel: Shape {
    var rise: CGFloat
    /// The second row's height: how far the panel rises to open.
    var full: CGFloat

    var animatableData: CGFloat {
        get { rise }
        set { rise = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let r = max(0, min(w, h, h - rise) / 2)
        let lag = min(Self.lag(rise: rise, full: full), max(0, h - 2 * r))
        let x0 = rect.minX, y0 = rect.minY
        var p = Path()
        p.move(to: CGPoint(x: x0, y: y0 + h - r))
        p.addLine(to: CGPoint(x: x0, y: y0 + lag + r))
        p.addArc(center: CGPoint(x: x0 + r, y: y0 + lag + r), radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        // The top edge, a dome from corner to corner whose middle is the top of the frame.
        let span = w - 2 * r
        p.addCurve(to: CGPoint(x: x0 + w - r, y: y0 + lag),
                   control1: CGPoint(x: x0 + r + span * 0.3, y: y0 - lag / 3),
                   control2: CGPoint(x: x0 + r + span * 0.7, y: y0 - lag / 3))
        p.addArc(center: CGPoint(x: x0 + w - r, y: y0 + lag + r), radius: r, startAngle: .degrees(270), endAngle: .degrees(360), clockwise: false)
        p.addLine(to: CGPoint(x: x0 + w, y: y0 + h - r))
        p.addArc(center: CGPoint(x: x0 + w - r, y: y0 + h - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: x0 + r, y: y0 + h))
        p.addArc(center: CGPoint(x: x0 + r, y: y0 + h - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.closeSubpath()
        return p
    }

    /// How far the top corners trail the middle of the top edge, in points: as far as the panel has risen at first,
    /// none from 70 percent open, and half of what it is pulled past open.
    static func lag(rise: CGFloat, full: CGFloat) -> CGFloat {
        guard rise > 0, full > 0 else { return 0 }
        if rise > full { return (rise - full) / 2 }
        return rise * (1 - PhoneBar.ease(rise / full / 0.7))
    }
}

/// The panel's glass. From iOS 26 Liquid Glass; the panel's own answer to a touch is its stretch under the finger. Glass
/// that also reacts to a touch (`interactive()`) grew its own copy of the outline while pressed, so a pull showed a
/// second, rounder edge inside the panel's at both ends. Before iOS 26, the bar material (the theme's card color under
/// a theme) with a hairline edge and a soft shadow.
private struct BarGlass: ViewModifier {
    var shape: LiquidPanel
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background {
                shape
                    .fill(theme.map { AnyShapeStyle($0.surface) } ?? AnyShapeStyle(.bar))
                    .overlay { shape.stroke((theme?.text ?? .primary).opacity(0.1), lineWidth: 0.5) }
                    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
            }
        }
    }
}

/// The bar's words and symbols in the theme's text color, so the screens that are not showing are drawn in the
/// theme's secondary one. Classic is left to the system.
private struct BarInk: ViewModifier {
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        if let theme { content.foregroundStyle(theme.text) } else { content }
    }
}

/// A screen in the bar while it is pressed: a little fainter, as the system's tab bar shows a press.
private struct BarItemStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

/// iPhone: the bar's screens as tabs, each with a navigation stack of its own, and the bar drawn under them. Screens
/// with no place in the bar open inside Library; Settings opens as a sheet from the gear.
///
/// The tab view has five fixed tabs, slots that hold the bar's screens used most recently (`BarSlots`): the system
/// puts the tabs past the fifth under a "More" list of its own, and the bar can hold ten screens. The system's own
/// bar is hidden; `PhoneBar` is drawn in its place, over the room the screens leave free at the bottom.
///
/// That room is kept by UIKit, not SwiftUI (`BarRoom`). The tab view is a UIKit tab bar controller and each tab's
/// stack a UIKit navigation controller, and both take their safe area from the window, not from SwiftUI: room set
/// with safeAreaInset, safeAreaBar or safeAreaPadding on the tab view, or on a tab around its stack, never reaches
/// the screens, so the end of every long screen stayed under the bar. Room added to the tab bar controller's own
/// safe area reaches every screen of every tab, pushed pages too, and no sheet.
struct PhoneRoot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var feel = FeelController.shared
    @ObservedObject private var keyboard = KeyboardWatcher.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var slots = BarSlots()
    @State private var barOpen = PhoneRoot.opensAtLaunch
    @State private var bottomInset: CGFloat = 0
    /// The bar's own height as it is folded, from its top edge to the room kept for the home indicator.
    @State private var barHeight: CGFloat = 57
    @State private var reselect = BarReselect()

    /// `-EABarOpen YES` (DebugHooks): the second row shows at launch, for screenshots.
    private static var opensAtLaunch: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "EABarOpen")
        #else
        return false
        #endif
    }

    var body: some View {
        let layout = model.barLayout(feel.settings.shownBar)
        let current = layout.tab(for: model.section)
        // The slots as they are once `current` shows: worked out here too, so the tab is there in the same pass
        // that selects it, and kept below.
        let shown = slots.showing(current.rawValue, among: layout.tabs)
        let showsBar = !keyboard.visible
        // The room the screens leave free for the bar as it is folded. The second row, when out, covers the screen
        // as a sheet would.
        let room = showsBar ? barHeight : 0

        // Nothing but the app selects a tab (the system's bar is hidden), so what the tab view says back is not taken.
        TabView(selection: Binding(get: { shown.index(of: current.rawValue) ?? 0 }, set: { _ in })) {
            ForEach(0..<BarSlots.limit, id: \.self) { i in
                let root = shown.ids[i].flatMap(Section.init(rawValue:))
                Tab(root?.title ?? "", systemImage: root?.symbol ?? "circle", value: i) {
                    Group {
                        if let root {
                            // A slot handed to another screen starts that screen afresh.
                            BarTabStack(root: root).id(root)
                        } else {
                            Color.clear
                        }
                    }
                    .toolbarVisibility(.hidden, for: .tabBar)
                    .background { BarRoom(height: room) }
                }
            }
        }
        .environment(\.phoneBar, layout)
        .environment(\.barReselect, reselect)
        .environment(\.barRoom, room)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { _ in bottomInset = PhoneBar.homeIndicatorInset() }
        // Over the screen and under the bar while the second row is out: a touch there folds it.
        .overlay {
            if barOpen, !layout.second.isEmpty, showsBar {
                Color.clear
                    .contentShape(Rectangle())
                    .ignoresSafeArea()
                    .gesture(DragGesture(minimumDistance: 0).onChanged { _ in fold() })
                    .accessibilityHidden(true)
            }
        }
        // The bar over the whole screen, so the second row it raises above its own height is still inside the view
        // that takes its touches. It leaves while the keyboard is up: it would ride on top of the keyboard.
        .overlay(alignment: .bottom) {
            if showsBar {
                PhoneBarHost(layout: layout, current: current, open: $barOpen, bottomInset: bottomInset) { choose($0, current: current) }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { barHeight = $0 }
                    .accessibilityAction(.escape) { fold() }
            }
        }
        .onAppear {
            slots = shown
            bottomInset = PhoneBar.homeIndicatorInset()
        }
        .onChange(of: current) { _, c in slots = slots.showing(c.rawValue, among: layout.tabs) }
        .onChange(of: layout.tabs) { _, tabs in slots = slots.showing(current.rawValue, among: tabs) }
        .onChange(of: keyboard.visible) { _, up in if up { barOpen = false } }
        .sheet(isPresented: $model.showingSettings) {
            NavigationStack {
                SettingsView().themedScreen()
                    .navigationDestination(for: Section.self) { sectionView($0) }
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.showingSettings = false } } }
            }
            // A module switched on in Settings, Modules: what it needs is offered over Settings, which is a sheet
            // here (a sheet cannot open under another one).
            .sheet(item: Binding(get: { model.permissionOffer }, set: { if $0 == nil { model.permissionOffer = nil } })) { offer in
                PermissionsOfferView(offer: offer).environmentObject(model)
            }
            // Machines switched on in Settings, Modules: Set up Machines over Settings too, after the permission screen.
            .sheet(isPresented: Binding(get: { model.permissionOffer == nil && model.machinesStart }, set: { if !$0 { model.machinesStart = false } })) {
                MachinesStartSheet().environmentObject(model).environmentObject(engine)
            }
            // Mail, Games and the like switched on in Settings, Modules with nothing linked: Set it up now, over
            // Settings too.
            .sheet(item: Binding(get: { model.permissionOffer == nil && !model.machinesStart ? model.moduleSetup : nil }, set: { if $0 == nil { model.moduleSetup = nil } })) { start in
                ModuleSetupSheet(start: start).environmentObject(model).environmentObject(engine)
            }
            // A join code scanned while Settings is open (Pair another device says to), and pairing links.
            .pairingPrompts(active: true)
        }
        // Anything that asks for Settings by section opens the sheet instead.
        .onChange(of: model.section) { old, s in
            if s == .settings { model.section = old == .settings ? .today : old; model.showingSettings = true }
        }
        // The same for the screen the app starts on (`-EASection settings`), which no change announces.
        .onAppear {
            if model.section == .settings { model.section = .today; model.showingSettings = true }
        }
    }

    /// A screen chosen in the bar. The one already showing goes back to its first page.
    private func choose(_ s: Section, current: Section) {
        if s == current { reselect = BarReselect(tab: s.rawValue, count: reselect.count + 1) }
        model.section = s
    }

    private func fold() {
        if barOpen { withAnimation(reduceMotion ? nil : PhoneBar.liquid) { barOpen = false } }
    }
}

/// The bar's room at the bottom of the screens, added to the safe area of the tab bar controller the tab view is,
/// so UIKit hands it to every tab, every navigation stack in it and every page pushed on one, as it hands down the
/// system's own tab bar. Each tab carries one, behind its content; they all set the same room.
private struct BarRoom: UIViewControllerRepresentable {
    var height: CGFloat

    func makeUIViewController(context: Context) -> Holder { Holder() }

    func updateUIViewController(_ holder: Holder, context: Context) {
        holder.height = height
        holder.apply()
    }

    final class Holder: UIViewController {
        var height: CGFloat = 0

        override func loadView() {
            view = UIView()
            view.isHidden = true
            view.isUserInteractionEnabled = false
        }

        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            apply()
        }

        func apply() {
            guard let tabs = tabBarController, tabs.additionalSafeAreaInsets.bottom != height else { return }
            tabs.additionalSafeAreaInsets.bottom = height
        }
    }
}

extension View {
    /// From iOS 26, a screen in one of the bar's tabs fades and blurs where it scrolls under the bar, as one does
    /// under the system's tab bar. `ThemedColors` puts this on every screen and page, so it reaches pages at any
    /// depth; it does nothing where there is no bar, while the keyboard is up, or in a sheet.
    func barEdge() -> some View { modifier(BarEdgeSpot()) }
}

/// The spot under the bar, from the screen's bottom edge (the top of the bar's room) to the bottom of the display.
private struct BarEdgeSpot: ViewModifier {
    @Environment(\.barRoom) private var room

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if #available(iOS 26.0, *), room > 0 {
                let height = room + PhoneBar.homeIndicatorInset()
                BarEdgeShape()
                    .frame(maxWidth: .infinity)
                    .frame(height: height)
                    // Hung from the screen's bottom edge, which is the top of the room, down to the display's.
                    .padding(.bottom, -height)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// The scroll edge effect needs UIKit: a view over the scroll view's edge, holding the shapes that edge lies under,
/// with an interaction that names the scroll view. The bar is drawn in another view controller than the screen, so
/// this view stands in for it, on the screen's own page: a glass panel too faint to see, the size of the room.
@available(iOS 26.0, *)
private struct BarEdgeShape: UIViewRepresentable {
    func makeUIView(context: Context) -> BarEdgeView { BarEdgeView() }
    func updateUIView(_ view: BarEdgeView, context: Context) { view.find() }
}

@available(iOS 26.0, *)
private final class BarEdgeView: UIView {
    private let glass = UIVisualEffectView(effect: UIGlassEffect())
    private let edge = UIScrollEdgeElementContainerInteraction()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        glass.alpha = 0.02
        glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(glass)
        edge.edge = .bottom
        addInteraction(edge)
    }

    required init?(coder: NSCoder) { nil }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        find()
        // A screen that shows its list only once it has loaded: look again a little later.
        Task { @MainActor [weak self] in
            for wait in [0.3, 1.0, 3.0] {
                try? await Task.sleep(for: .seconds(wait))
                self?.find()
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        find()
    }

    /// The page this view is on, its scroll view, and whether the page is in one of the bar's tabs. A sheet opened
    /// from a tab takes the tab's room setting along but is not in the tab bar controller: nothing there.
    func find() {
        let page = sequence(first: self as UIResponder, next: \.next).first { $0 is UIViewController } as? UIViewController
        guard let page, page.tabBarController != nil else {
            glass.isHidden = true
            edge.scrollView = nil
            return
        }
        glass.isHidden = false
        let scroll = page.contentScrollView(for: .bottom) ?? page.contentScrollView(for: .top) ?? Self.largest(in: page.view)
        if edge.scrollView !== scroll { edge.scrollView = scroll }
    }

    /// The page's tallest scroll view, when it names none itself.
    private static func largest(in view: UIView) -> UIScrollView? {
        var best: UIScrollView?
        func walk(_ v: UIView) {
            if let s = v as? UIScrollView, !s.isHidden, s.bounds.height > (best?.bounds.height ?? view.bounds.height / 2) { best = s }
            v.subviews.forEach(walk)
        }
        walk(view)
        return best
    }
}

/// The bar with Library's count on it. Apart from PhoneRoot, so a change on the hub redraws the bar and not the tabs.
private struct PhoneBarHost: View {
    @EnvironmentObject var engine: SyncEngine
    var layout: BarLayout
    var current: Section
    @Binding var open: Bool
    var bottomInset: CGFloat
    var choose: (Section) -> Void

    var body: some View {
        PhoneBar(layout: layout, current: current, badge: engine.unprocessedCaptures.count, open: $open, bottomInset: bottomInset, choose: choose)
    }
}

/// One of the bar's screens with its own navigation stack. A screen asked for (a press in the bar, a link, a
/// notification, Spotlight) that has no place of its own is pushed over the screen it opens on: Week over
/// Today, Memory over the Assistant, a machine's page, the change journal and snippets over the Overview, everything
/// else over Library. Asking for the tab's own screen goes back to it.
struct BarTabStack: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.phoneBar) private var bar
    @Environment(\.barReselect) private var reselect
    var root: Section
    @State private var path: [Section] = []

    /// The pages over this tab's own screen for a screen asked for; nil when that screen opens on another tab, or is
    /// Settings, which PhoneRoot opens as a sheet.
    private func target(for s: Section) -> [Section]? {
        if s == root { return [] }
        guard s != .settings, let bar, bar.tab(for: s) == root else { return nil }
        return [s]
    }

    var body: some View {
        NavigationStack(path: $path) {
            first.navigationDestination(for: Section.self) { sectionView($0) }
        }
        .onChange(of: model.section) { _, s in if let t = target(for: s) { path = t } }
        .onAppear { if let t = target(for: model.section) { path = t } }
        .onChange(of: reselect) { _, r in if r.tab == root.rawValue { path = [] } }
        // A module switched off (here or on another device) takes its open screen with it.
        .onChange(of: model.modules) { _, _ in if let i = path.firstIndex(where: { !model.shows($0) }) { path.removeSubrange(i...) } }
    }

    /// The tab's own screen. Today and Library carry the gear that opens Settings, as they always did.
    @ViewBuilder private var first: some View {
        if root == .today || root == .library {
            sectionView(root).settingsGear()
        } else {
            sectionView(root)
        }
    }
}

#endif
