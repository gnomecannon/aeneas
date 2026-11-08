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

    init(_ t: AppTheme) {
        spec = t
        accent = FeelController.color(t.accent) ?? .accentColor
        background = FeelController.color(t.background) ?? .clear
        surface = FeelController.color(t.surface) ?? .clear
        text = FeelController.color(t.text) ?? .primary
    }

    var scheme: ColorScheme { spec.isDark ? .dark : .light }
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

    /// For one list or form row, where a screen draws its own rows.
    func themedRow() -> some View { modifier(ThemedRow()) }
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
    @Environment(\.eaTheme) private var theme

    /// Classic leaves the screen exactly as it was: any foreground style set here would also override the gray
    /// SwiftUI gives section footers and secondary text. Switching between Classic and a theme rebuilds the screen's
    /// own state (scroll position); switching between themes does not.
    #if os(iOS)
    @ObservedObject private var keyboard = KeyboardWatcher.shared
    #endif

    func body(content: Content) -> some View {
        themed(content)
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

    @ViewBuilder private func themed(_ content: Content) -> some View {
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
