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

extension EnvironmentValues {
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

/// The bar itself, drawn as the system's tab bar is from iOS 26 on: a capsule floating over the bottom of the screen,
/// and the second row in a capsule of its own above it. A press and drag up anywhere on the bar pulls the second row
/// out of the first: the bar grows upward with the finger, the row comes out from behind the first one and parts from
/// it once it is all out. It stays open once it would come to rest more than half out, and folds on a drag down, a tap
/// outside the bar (PhoneRoot) or a choice. The grabber in the first capsule's top edge is a button that does the same
/// without a drag, in the accent color while a screen of the second row is the one showing.
///
/// From iOS 26 the two capsules are Liquid Glass in one container, so they merge and part as the row moves and react
/// to a touch. The screen showing sits in a capsule of its own that slides to the one chosen. Before iOS 26 the same
/// shapes are drawn in the bar material, or in the theme's card color when a theme is chosen.
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
    @Namespace private var space
    /// How far the finger has moved up since it pressed the bar; back to 0 when it lifts.
    @GestureState(resetTransaction: Transaction(animation: PhoneBar.settle)) private var pull: CGFloat = 0
    /// The second capsule's own height, measured once it is laid out.
    @State private var moreHeight: CGFloat = PhoneBar.capsuleHeight(BarSize.of(count: 5))

    static let settle = Animation.snappy(duration: 0.25)
    /// The system's five-tab bar on iOS 26, as drawn on an iPhone: the capsule 21 points in from the screen's sides,
    /// the screens 8 points in from the capsule's ends, 6 points under its top and 7 over its bottom (62 points tall in
    /// all).
    static let side: CGFloat = 21
    static let padH: CGFloat = 8
    static let padTop: CGFloat = 6
    static let padBottom: CGFloat = 7
    /// The band at the top of the first capsule the grabber sits in, while there is a second row.
    static let strip: CGFloat = 8
    /// Between the two capsules while the second row is out.
    static let gap: CGFloat = 8

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
        let hasMore = !second.isEmpty
        // How far the second capsule travels: from inside the first to its own place above it.
        let travel = moreHeight + Self.gap
        let reveal = hasMore ? min(travel, max(0, (open ? travel : 0) + pull)) : 0

        container {
            VStack(spacing: 0) {
                // The second capsule's place. It is above the bar's own height (the padding below takes it back), so
                // the screens do not move as the row comes out.
                Color.clear.frame(height: hasMore ? travel : 0)
                ZStack(alignment: .top) {
                    if hasMore { secondCapsule(second, size: size, reveal: reveal) }
                    firstCapsule(first, size: size, hasMore: hasMore, lit: second.contains(current))
                }
            }
        }
        .padding(.top, hasMore ? -travel : 0)
        .modifier(BarInk())
        .highPriorityGesture(drag(travel: travel), including: hasMore ? .all : .subviews)
        // The capsule behind the screen showing slides to the one chosen.
        .animation(Self.settle, value: current)
        .frame(maxWidth: 560)
        .padding(.horizontal, Self.side)
        .padding(.bottom, floatingBottom)
        .frame(maxWidth: .infinity)
    }

    /// Where the bar's bottom edge sits: 21 points above the screen's, as the system's does, which on an iPhone with a
    /// home indicator is 13 points into the room kept free for it; 8 points up on one with a home button.
    private var floatingBottom: CGFloat {
        if bottomInset >= 30 { return 21 - bottomInset }
        return bottomInset > 0 ? 0 : 8
    }

    /// From iOS 26 the capsules are glass shapes of one container, which merge where they meet.
    @ViewBuilder private func container<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: Self.gap) { content() }
        } else {
            content()
        }
    }

    /// The first row and, while there is a second one, the grabber above it.
    private func firstCapsule(_ screens: [Section], size: BarSize, hasMore: Bool, lit: Bool) -> some View {
        row(screens, size: size)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isTabBar)
            .accessibilityActions {
                if hasMore {
                    Button(open ? BarText.hideMore : BarText.showMore) { toggle() }
                }
            }
            .padding(.top, hasMore ? Self.strip : 0)
            .padding(.horizontal, Self.padH)
            .overlay(alignment: .top) {
                if hasMore { grabber(lit: lit) }
            }
            .modifier(BarCapsule(id: "first", space: space))
    }

    /// The second row. Folded, it lies inside the first capsule; it rises with what is revealed, and only the part
    /// above the first capsule shows its screens.
    private func secondCapsule(_ screens: [Section], size: BarSize, reveal: CGFloat) -> some View {
        let out = min(moreHeight, reveal)
        return row(screens, size: size)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(BarText.more)
            .accessibilityAddTraits(.isTabBar)
            .accessibilityHidden(!open)
            .padding(.horizontal, Self.padH)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if $0 > 0 { moreHeight = $0 } }
            .mask(alignment: .top) { Rectangle().frame(height: out) }
            .modifier(BarCapsule(id: "second", space: space, grows: true, shows: out < moreHeight ? out : nil))
            .offset(y: -reveal)
            .allowsHitTesting(open)
    }

    private func row(_ screens: [Section], size: BarSize) -> some View {
        HStack(spacing: 0) {
            ForEach(screens) { s in
                let selected = s == current
                let count = s == .library ? badge : 0
                Button { pick(s) } label: {
                    // The screen's place reaches the capsule's top and bottom edges, so a press anywhere on the bar
                    // lands on a screen.
                    BarItemLabel(title: s.title, symbol: s.symbol, size: size, badge: count)
                        .padding(.top, Self.padTop)
                        .padding(.bottom, Self.padBottom)
                        .background {
                            if selected { bubble }
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

    /// The grabber: a short pill in the first capsule's top band, centered over the bar. Its box reaches up past the
    /// capsule's edge (into the gap while the second row is out) and down to the screens' places, never over them.
    private func grabber(lit: Bool) -> some View {
        let reach: CGFloat = open ? Self.gap : 14
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

    private func drag(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($pull) { value, pull, _ in pull = -value.translation.height }
            .onEnded { value in
                // Where the row would come to rest: past half way it stays open. A slow drag rests where it is let
                // go; a flick carries on, so a short quick one opens or folds it too.
                let rest = (open ? travel : 0) - value.predictedEndTranslation.height
                withAnimation(Self.settle) { open = rest > travel / 2 }
            }
    }

    private func toggle() {
        withAnimation(Self.settle) { open.toggle() }
    }

    private func pick(_ s: Section) {
        if open { withAnimation(Self.settle) { open = false } }
        choose(s)
    }
}

/// One of the bar's capsules. From iOS 26 it is glass that reacts to a touch, with an id so the two capsules morph
/// into each other; the second one `grows` out of the first when the second row first gets a screen. Before iOS 26 it
/// is the bar material (the theme's card color under a theme) with a soft shadow, and while the second capsule comes
/// out from behind the first only the part that `shows` above it is drawn.
private struct BarCapsule: ViewModifier {
    var id: String
    var space: Namespace.ID
    var grows = false
    /// How much of the capsule shows, from its top; nil when all of it does.
    var shows: CGFloat?
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let glass = content
                .glassEffect(.regular.interactive(), in: .capsule)
                .glassEffectID(id, in: space)
            if grows { glass.glassEffectTransition(.matchedGeometry) } else { glass }
        } else {
            let drawn = content.background {
                Capsule()
                    .fill(theme.map { AnyShapeStyle($0.surface) } ?? AnyShapeStyle(.bar))
                    .overlay { Capsule().strokeBorder((theme?.text ?? .primary).opacity(0.1), lineWidth: 0.5) }
                    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
            }
            if let shows {
                drawn.mask(alignment: .top) { Rectangle().frame(height: shows) }
            } else {
                drawn
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
struct PhoneRoot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var feel = FeelController.shared
    @ObservedObject private var keyboard = KeyboardWatcher.shared
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
                }
            }
        }
        .environment(\.phoneBar, layout)
        .environment(\.barReselect, reselect)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { _ in bottomInset = PhoneBar.homeIndicatorInset() }
        // The room the screens leave free for the bar as it is folded.
        .bottomRoom(showsBar ? barHeight : 0)
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
        if barOpen { withAnimation(PhoneBar.settle) { barOpen = false } }
    }
}

extension View {
    /// Room at the bottom of the screens for the bar, which PhoneRoot draws over them. From iOS 26 the room is a bar
    /// of the system's kind, so a screen scrolled under it fades at its edge as it does under the system's tab bar.
    @ViewBuilder fileprivate func bottomRoom(_ height: CGFloat) -> some View {
        let room = Color.clear.frame(height: height).allowsHitTesting(false).accessibilityHidden(true)
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0) { room }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) { room }
        }
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
/// notification, Spotlight) that has no place of its own is pushed over the screen it opens on: Now and Week over
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
