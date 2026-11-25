import SwiftUI
import EACore
#if os(iOS)
import UIKit
#endif

/// The app theme as SwiftUI colors. Nil in the environment means Classic: nothing is changed from the system look.
struct ThemeColors: Equatable {
    var spec: AppTheme
    var accent: Color
    var background: Color
    var surface: Color
    var text: Color

    /// Words on the accent (a prominent button, a count on an accent capsule): white where it reads at 4.5:1, else a
    /// dark ink from the theme, as on the web. White on Forest's green or Ocean's cyan read at about 2:1.
    var onAccent: Color

    init(_ t: AppTheme) {
        spec = t
        accent = FeelController.color(t.accent) ?? .accentColor
        background = FeelController.color(t.background) ?? .clear
        surface = FeelController.color(t.surface) ?? .clear
        text = FeelController.color(t.text) ?? .primary
        let ink = FeelColor.mix(t.background, "#000000", t.isDark ? 0.4 : 0.85)
        onAccent = FeelController.color(FeelColor.onFill(t.accent, ink: ink)) ?? .white
    }

    var scheme: ColorScheme { spec.isDark ? .dark : .light }
}

/// Words on the accent color: the theme's choice (`ThemeColors.onAccent`), white in Classic, whose accent is dark
/// enough for it.
struct OnAccentStyle: ShapeStyle {
    func resolve(in environment: EnvironmentValues) -> Color { environment.eaTheme?.onAccent ?? .white }
}

extension ShapeStyle where Self == OnAccentStyle {
    static var onAccent: OnAccentStyle { OnAccentStyle() }
}

/// `.borderedProminent` with its words in the theme's color for words on the accent. The system draws them white on
/// any tint, which on a light accent (Forest, Ocean, Sunset, Neon) left light words on a light fill. Classic is left
/// to the system.
struct ThemedProminentButtonStyle: PrimitiveButtonStyle {
    @Environment(\.eaTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    #if os(macOS)
    /// In a window of an app in the background the Mac draws the button gray with its own gray words; dark ink on that
    /// gray would not read.
    @Environment(\.appearsActive) private var appearsActive
    private var onAccentFill: Bool { appearsActive }
    #else
    private var onAccentFill: Bool { true }
    #endif

    func makeBody(configuration: Configuration) -> some View {
        Button(role: configuration.role, action: configuration.trigger) {
            if let theme, isEnabled, onAccentFill {
                configuration.label.foregroundStyle(theme.onAccent)
            } else {
                configuration.label
            }
        }
        .buttonStyle(.borderedProminent)
    }
}

extension PrimitiveButtonStyle where Self == ThemedProminentButtonStyle {
    /// The prominent button for every screen: see `ThemedProminentButtonStyle`.
    static var themedProminent: ThemedProminentButtonStyle { ThemedProminentButtonStyle() }
}

private struct ThemeKey: EnvironmentKey { static let defaultValue: ThemeColors? = nil }

extension EnvironmentValues {
    var eaTheme: ThemeColors? {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

extension View {
    /// At the root of every window: accent, light or dark, text color, and the theme for screens below.
    func themedRoot() -> some View { modifier(ThemedRoot()) }

    /// On every screen: the theme's background behind lists, forms and scroll views, and its surface on rows; on the
    /// iPhone and iPad also a Done button over the keyboard, so a multi-line field (where Return adds a line) never
    /// leaves the keyboard covering the tab bar.
    func themedScreen() -> some View { modifier(ThemedScreen()) }

    /// On a page opened over a screen (a person, a note, a machine's page): the theme's colors, as `themedScreen()`
    /// gives the screen it was opened from. A page takes nothing from that screen by itself: SwiftUI hands a pushed
    /// page none of what the screen under it set, so under a theme the page stood in the system's colors (its gray
    /// or black behind the theme's cards). `PageLink` and `pageDestination` apply this, so a screen only has to open
    /// its pages through them. Only the colors, without the keyboard bar of `themedScreen()`: the same colors twice
    /// change nothing, so this is safe on a page that themes itself too (the Settings pages).
    func themedPage() -> some View { modifier(ThemedColors()) }

    /// For one list or form row, where a screen draws its own rows.
    func themedRow() -> some View { modifier(ThemedRow()) }

    /// `navigationDestination(item:)` with the app theme on the page it opens (`themedPage()`).
    func pageDestination<Item: Hashable, Page: View>(item: Binding<Item?>, @ViewBuilder page: @escaping (Item) -> Page) -> some View {
        navigationDestination(item: item) { page($0).themedPage() }
    }

    /// `navigationDestination(isPresented:)` with the app theme on the page it opens (`themedPage()`).
    func pageDestination<Page: View>(isPresented: Binding<Bool>, @ViewBuilder page: () -> Page) -> some View {
        navigationDestination(isPresented: isPresented) { page().themedPage() }
    }
}

/// A link that opens a page over the screen it is on, with the app theme on that page (`themedPage()`). Every page
/// is opened through this or `pageDestination`, never through SwiftUI's NavigationLink with a page of its own or
/// its `navigationDestination(item:)` (the test ThemedPagesTests fails on one). A link by value
/// (`NavigationLink(value:)`) is fine: it opens a screen through `sectionView`, which themes it.
struct PageLink<Destination: View, Label: View>: View {
    private let destination: Destination
    private let label: Label

    init(@ViewBuilder destination: () -> Destination, @ViewBuilder label: () -> Label) {
        self.destination = destination()
        self.label = label()
    }

    var body: some View {
        NavigationLink { destination.themedPage() } label: { label }
    }
}

extension PageLink where Label == Text {
    init(_ title: LocalizedStringKey, @ViewBuilder destination: () -> Destination) {
        self.init(destination: destination) { Text(title) }
    }
}

struct ThemedRoot: ViewModifier {
    @ObservedObject private var feel = FeelController.shared

    func body(content: Content) -> some View {
        let theme = feel.appTheme.map(ThemeColors.init)
        content
            .environment(\.eaTheme, theme)
            .tint(theme?.accent)
            .preferredColorScheme(theme?.scheme ?? Self.scheme(feel.settings.appearance))
            .onAppear { ThemeUIKit.apply(theme) }
            .onChange(of: theme) { _, t in ThemeUIKit.apply(t) }
            #if os(iOS)
            // Dragging any list, form or scroll view down lowers the keyboard, sheets included.
            .scrollDismissesKeyboard(.interactively)
            #endif
    }

    static func scheme(_ appearance: String) -> ColorScheme? {
        switch appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

struct ThemedScreen: ViewModifier {
    #if os(iOS)
    @ObservedObject private var keyboard = KeyboardWatcher.shared
    #endif

    func body(content: Content) -> some View {
        content.modifier(ThemedColors())
            #if os(iOS)
            // SwiftUI's keyboard toolbar does not appear inside the tab view, so the bar is drawn here instead.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if keyboard.visible {
                    HStack {
                        Spacer()
                        Button { KeyboardWatcher.dismiss() } label: { Label("Hide keyboard", systemImage: "keyboard.chevron.compact.down") }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 4)
                    .background(.bar)
                }
            }
            #endif
    }
}

/// The theme's colors on one screen or page: its text color, its background behind lists, forms and scroll views,
/// and on the iPhone and iPad the same background in the title bar. Every screen and page has this, so on the iPhone
/// it also gives each one the soft edge where it scrolls under the bottom bar (`barEdge()`).
struct ThemedColors: ViewModifier {
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        #if os(iOS)
        colors(content).barEdge()
        #else
        colors(content)
        #endif
    }

    /// Classic leaves the screen exactly as it was: any foreground style set here would also override the gray
    /// SwiftUI gives section footers and secondary text. Switching between Classic and a theme rebuilds the screen's
    /// own state (scroll position); switching between themes does not.
    @ViewBuilder private func colors(_ content: Content) -> some View {
        if let theme {
            content
                .foregroundStyle(theme.text)
                .scrollContentBackground(.hidden)
                .background { theme.background.ignoresSafeArea() }
                #if os(iOS)
                .toolbarBackground(theme.background, for: .navigationBar)
                #endif
        } else {
            content
        }
    }
}

struct ThemedRow: ViewModifier {
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        content.listRowBackground(theme?.surface)
    }
}

/// What SwiftUI cannot reach: list and form rows are UIKit cells, so their background follows the theme's surface
/// through a hook on the cell's configuration update, and cells already on screen are updated in place. (A sheet
/// keeps the system's own sheet background in the theme's light or dark mode.)
enum ThemeUIKit {
    @MainActor static func apply(_ theme: ThemeColors?) {
        #if os(iOS)
        ThemeCellPainter.surface = theme.map { UIColor($0.surface) }
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for w in ws.windows { ThemeCellPainter.repaint(w) }
        }
        #endif
    }
}

#if os(iOS)
/// Whether the on-screen keyboard is up, for the Hide keyboard bar on every screen.
@MainActor final class KeyboardWatcher: ObservableObject {
    static let shared = KeyboardWatcher()
    @Published private(set) var visible = false

    private init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.visible = true }
        }
        nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.visible = false }
        }
    }

    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Paints grouped list cells with the theme's surface. SwiftUI rebuilds a cell's background configuration as it
/// updates, so the painter hooks the cell's configuration update and sets the color after SwiftUI does.
enum ThemeCellPainter {
    @MainActor static var surface: UIColor? {
        didSet { if surface != nil { install() } }
    }
    @MainActor private static var installed = false
    @MainActor static func install() {
        guard !installed else { return }
        installed = true
        let cls: AnyClass = UICollectionViewListCell.self
        let original = #selector(UICollectionViewListCell.updateConfiguration(using:))
        let replacement = #selector(UICollectionViewListCell.ea_updateConfiguration(using:))
        guard let a = class_getInstanceMethod(cls, original), let b = class_getInstanceMethod(cls, replacement) else { return }
        // The method is inherited from UICollectionViewCell. Add the hook to the list cell class itself, so other
        // cells (menus, pickers) keep the original and never meet the hook's selector.
        if class_addMethod(cls, original, method_getImplementation(b), method_getTypeEncoding(b)) {
            class_replaceMethod(cls, replacement, method_getImplementation(a), method_getTypeEncoding(a))
        } else {
            method_exchangeImplementations(a, b)
        }
    }

    @MainActor static func repaint(_ view: UIView) {
        if let cell = view as? UICollectionViewListCell { cell.setNeedsUpdateConfiguration() }
        for v in view.subviews { repaint(v) }
    }
}

extension UICollectionViewListCell {
    @objc func ea_updateConfiguration(using state: UICellConfigurationState) {
        ea_updateConfiguration(using: state)   // the original, after the exchange
        MainActor.assumeIsolated {
            guard let surface = ThemeCellPainter.surface, var bg = backgroundConfiguration else { return }
            // Only the plain grouped background at rest; a row with its own background view, or one being
            // pressed or selected, keeps what SwiftUI chose.
            guard bg.customView == nil, !state.isSelected, !state.isHighlighted else { return }
            // Section headers and footers are list cells too, with a clear background: leave them clear.
            var alpha: CGFloat = 0
            bg.resolvedBackgroundColor(for: tintColor).getRed(nil, green: nil, blue: nil, alpha: &alpha)
            guard alpha > 0.01 else { return }
            bg.backgroundColor = surface
            backgroundConfiguration = bg
        }
    }
}
#endif
