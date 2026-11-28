import SwiftUI
import CoreSpotlight
import EACore
import EALink
import EATailnet

@main
struct EverythingAppApp: App {
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Direct link (iroh): hubs saved as iroh://<key> are reached through it.
        EALink.install()
        // Tailscale signed in inside Aeneas (off until the person does it): Tailscale hubs are reached through it.
        EATailnet.install()
    }
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #elseif os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif

    private var root: some View {
        RootView()
            .overlay { FeelOverlay() }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
            .task {
                FeelController.shared.attach(model.engine)
                await model.start()
                await FeelController.shared.refresh()
                #if DEBUG
                // Simulator screenshots and UI tests: `-EASetupLink everythingapp://setup?...` pairs with no taps.
                // Debug builds only: a shipped app takes setup links from the person alone.
                if let s = UserDefaults.standard.string(forKey: "EASetupLink"), let u = URL(string: s), !model.isConfigured { model.handle(url: u) }
                #endif
            }
            .onOpenURL { model.handle(url: $0) }
            // A Spotlight result: its identifier is the entity id.
            .onContinueUserActivity(CSSearchableItemActionType) { activity in
                if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String { model.open(itemId: id) }
            }
    }

    var body: some Scene {
        #if os(macOS)
        // The main window. Open Aeneas in the menu bar and Settings… front it, or open it again after it was closed
        // (they used to front a window that no longer existed); the Dock icon and links open one as before.
        WindowGroup(id: MainWindow.id) {
            root
                // A link (a widget, a shortcut, Spotlight, another app) goes to the main window that is open. Without
                // this, macOS opened one more main window for every link, and the screens in all of them changed.
                .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
        }
        // With no main window open, a link opens one here.
        .handlesExternalEvents(matching: ["*"])
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.start(); await FeelController.shared.refresh() } }
        }
        .defaultSize(width: 900, height: 640)
        .commands {
            CommandGroup(after: .newItem) { QuickCaptureCommand() }
            CommandGroup(replacing: .appSettings) { SettingsCommand() }
            // The Window menu names the main window, also after it was closed, as Mac apps do.
            CommandGroup(before: .windowArrangement) { MainWindowCommand() }
            // macOS said help was not available for Aeneas.
            CommandGroup(replacing: .help) { Link("Aeneas Help", destination: MainWindow.helpURL) }
        }

        // One screen in a window of its own, for a second monitor: right-click a sidebar row, or the toolbar button.
        // Only those open it (the File menu's item for it opened an empty window); a restored one with no screen shows
        // Today.
        WindowGroup("Screen", id: "screen", for: Section.self) { $section in
            let shown = section ?? .today
            NavigationStack {
                sectionView(shown).navigationDestination(for: Section.self) { sectionView($0) }
            }
            .givesWideHint()
            .navigationTitle(shown.title)
            .overlay { FeelOverlay() }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        }
        .defaultSize(width: 560, height: 720)
        .commandsRemoved()
        // A link never opens one of these: they open from the sidebar or the toolbar only.
        .handlesExternalEvents(matching: [])

        // The menu bar shows the symbol; the title is what VoiceOver says for it.
        MenuBarExtra("Aeneas", systemImage: "circle.inset.filled") {
            MenuBarView()
                .environmentObject(model)
                .environmentObject(model.engine)
        }
        .menuBarExtraStyle(.window)
        #else
        WindowGroup {
            root
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.start(); await FeelController.shared.refresh() } }
            #if os(iOS)
            if phase == .background { CalendarImporter.shared.scheduleBackgroundRefresh() }
            #endif
        }
        #endif
    }
}

#if os(macOS)
/// The Mac's main window.
enum MainWindow {
    static let id = "main"
    /// Aeneas Help in the Help menu: the guide on GitHub.
    static let helpURL = SetupView.hubGuideURL

    /// Fronts the main window, or opens it again if it was closed, on `section` when one is given.
    @MainActor static func open(_ openWindow: OpenWindowAction, section: Section? = nil) {
        if let section { AppModel.shared.section = section }
        NSApp.activate()
        if let w = NSApp.windows.first(where: isMain) {
            if w.isMiniaturized { w.deminiaturize(nil) }
            w.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: id)
        }
    }

    /// A main window that is open or in the Dock. SwiftUI names the scene's windows after its id (`main-AppWindow-1`);
    /// a closed one can stay in the window list, not visible.
    @MainActor static func isMain(_ w: NSWindow) -> Bool {
        guard let name = w.identifier?.rawValue, name == id || name.hasPrefix(id + "-") else { return false }
        return w.isVisible || w.isMiniaturized
    }
}

/// Settings… in the app menu (Command comma): the main window on Settings.
private struct SettingsCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Settings…") { MainWindow.open(openWindow, section: .settings) }
            .keyboardShortcut(",")
    }
}

/// Aeneas in the Window menu (Command 0): the main window, fronted or opened again.
private struct MainWindowCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Aeneas") { MainWindow.open(openWindow) }
            .keyboardShortcut("0")
    }
}

/// Quick Capture in the File menu, showing the shortcut chosen in Settings (it showed Control Option Space whatever
/// was chosen).
private struct QuickCaptureCommand: View {
    @AppStorage(HotKey.settingKey) private var chosen = HotKey.defaultChoice

    var body: some View {
        Button("Quick Capture") { QuickCapturePanel.shared.toggle() }
            .keyboardShortcut(Self.shortcut(chosen))
    }

    /// The menu's form of a HotKey choice; none for Off.
    static func shortcut(_ id: String) -> KeyboardShortcut? {
        switch id {
        case "Control+Shift+Space": return KeyboardShortcut(.space, modifiers: [.control, .shift])
        case "Control+Shift+K": return KeyboardShortcut("k", modifiers: [.control, .shift])
        case "Alt+Shift+Space": return KeyboardShortcut(.space, modifiers: [.option, .shift])
        case "Control+Option+Space": return KeyboardShortcut(.space, modifiers: [.control, .option])
        default: return nil
        }
    }
}
#endif
