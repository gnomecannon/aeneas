import SwiftUI
import WebKit
import EACore
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A mail as sent: the hub's cleaned page in the view MailPageController sets up (nothing of the mail runs or loads;
/// a tapped link opens outside the app). As tall as the mail, measured at one point tall so a mail sized by its view
/// cannot make it grow, and at most `Mail.pageMax`; a longer mail scrolls inside it.
struct MailPageView: View {
    var html: String
    var unfolded: Bool
    @Binding var foldable: Bool
    @State private var rules: WKContentRuleList?
    @State private var failed = false
    @State private var height: Double = 60

    var body: some View {
        Group {
            if let rules {
                MailPageRepresentable(html: html, unfolded: unfolded, rules: rules, height: $height, foldable: $foldable)
                    .frame(height: height)
            } else if failed {
                Text("This mail cannot be shown as sent on this device. Show as text shows its words.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .task {
            if rules == nil {
                rules = await MailPageController.ruleList()
                failed = rules == nil
            }
        }
    }
}

/// Opens a link from a mail outside the app: the browser, or the mail app for mailto.
@MainActor
private func openOutside(_ url: URL) {
    #if os(iOS)
    UIApplication.shared.open(url)
    #else
    NSWorkspace.shared.open(url)
    #endif
}

#if os(iOS)
/// Holds the mail's view: as big as SwiftUI makes it, or one point tall while it is measured.
final class MailPageHost: UIView {
    let controller: MailPageController
    var measuring = false { didSet { setNeedsLayout(); layoutIfNeeded() } }
    private var lastWidth: CGFloat = 0

    init(controller: MailPageController) {
        self.controller = controller
        super.init(frame: .zero)
        clipsToBounds = true
        addSubview(controller.webView)
    }
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        controller.webView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: measuring ? 1 : max(bounds.height, 1))
        // A new width (turning the device, a wider window) reflows the mail: measured again.
        if !measuring, bounds.width > 0, abs(bounds.width - lastWidth) > 0.5 {
            let first = lastWidth == 0
            lastWidth = bounds.width
            if !first { Task { await controller.measure() } }
        }
    }
}

struct MailPageRepresentable: UIViewRepresentable {
    var html: String
    var unfolded: Bool
    var rules: WKContentRuleList
    @Binding var height: Double
    @Binding var foldable: Bool

    func makeUIView(context: Context) -> MailPageHost {
        let heightBinding = $height, foldBinding = $foldable
        let c = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: openOutside,
                                   onHeight: { h in heightBinding.wrappedValue = h }, onFoldable: { f in foldBinding.wrappedValue = f })
        let host = MailPageHost(controller: c)
        c.setMeasuring = { [weak host] on in host?.measuring = on }
        c.setUnfolded(unfolded)
        c.load(html)
        context.coordinator.unfolded = unfolded
        return host
    }

    func updateUIView(_ host: MailPageHost, context: Context) {
        if context.coordinator.unfolded != unfolded {
            context.coordinator.unfolded = unfolded
            host.controller.setUnfolded(unfolded)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var unfolded = false }
}
#else
/// Holds the mail's view: as big as SwiftUI makes it, or one point tall while it is measured.
final class MailPageHost: NSView {
    let controller: MailPageController
    var measuring = false { didSet { needsLayout = true; layoutSubtreeIfNeeded() } }
    private var lastWidth: CGFloat = 0
    override var isFlipped: Bool { true }

    init(controller: MailPageController) {
        self.controller = controller
        super.init(frame: .zero)
        addSubview(controller.webView)
    }
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        controller.webView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: measuring ? 1 : max(bounds.height, 1))
        if !measuring, bounds.width > 0, abs(bounds.width - lastWidth) > 0.5 {
            let first = lastWidth == 0
            lastWidth = bounds.width
            if !first { Task { await controller.measure() } }
        }
    }
}

struct MailPageRepresentable: NSViewRepresentable {
    var html: String
    var unfolded: Bool
    var rules: WKContentRuleList
    @Binding var height: Double
    @Binding var foldable: Bool

    func makeNSView(context: Context) -> MailPageHost {
        let heightBinding = $height, foldBinding = $foldable
        let c = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: openOutside,
                                   onHeight: { h in heightBinding.wrappedValue = h }, onFoldable: { f in foldBinding.wrappedValue = f })
        let host = MailPageHost(controller: c)
        c.setMeasuring = { [weak host] on in host?.measuring = on }
        c.setUnfolded(unfolded)
        c.load(html)
        context.coordinator.unfolded = unfolded
        return host
    }

    func updateNSView(_ host: MailPageHost, context: Context) {
        if context.coordinator.unfolded != unfolded {
            context.coordinator.unfolded = unfolded
            host.controller.setUnfolded(unfolded)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var unfolded = false }
}
#endif

// MARK: - Colors

/// Mail's colors as SwiftUI styles (MailColors in EACore holds the values): a place's fill, which carries white words,
/// and its word shade, made readable on the theme's page and rows as status colors are.
struct MailFill: ShapeStyle {
    var key: MailColors.Key
    func resolve(in environment: EnvironmentValues) -> Color {
        FeelController.color(MailColors.fill(key, dark: environment.colorScheme == .dark)) ?? .gray
    }
}

struct MailWord: ShapeStyle {
    var key: MailColors.Key
    func resolve(in environment: EnvironmentValues) -> Color {
        let dark = environment.colorScheme == .dark
        let hex: String
        if let t = environment.eaTheme?.spec {
            hex = MailColors.word(key, dark: t.isDark, text: t.text, backgrounds: [t.background, t.surface])
        } else {
            hex = MailColors.word(key, dark: dark, text: MailColors.systemText(dark: dark), backgrounds: MailColors.systemBackgrounds(dark: dark))
        }
        return FeelController.color(hex) ?? .primary
    }
}

extension Mail.Bundle {
    /// The bundle's icon (an SF Symbol), the owner's own as a bookmark.
    var symbol: String {
        if custom != nil { return "bookmark" }
        switch id {
        case "purchases": return "arrow.left.arrow.right"
        case "trips": return "airplane"
        case "other": return "flag"
        case "promos": return "tag"
        case "bills": return "doc.text"
        case "pet": return "pawprint"
        default: return "line.3.horizontal"
        }
    }
    var colorKey: MailColors.Key { MailColors.key(self) }
}

extension MailFolderRole {
    /// A folder's icon (an SF Symbol), as the web's: Drafts a pencil, Sent a paper plane, Spam a shield, Trash a bin.
    var symbol: String {
        switch self {
        case .drafts: return "pencil"
        case .sent: return "paperplane"
        case .junk: return "xmark.shield"
        case .trash: return "trash"
        case .own: return "folder"
        }
    }
}
