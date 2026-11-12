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
        WindowGroup {
            root
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.start(); await FeelController.shared.refresh() } }
        }
        .defaultSize(width: 900, height: 640)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Quick Capture") { QuickCapturePanel.shared.toggle() }
                    .keyboardShortcut(" ", modifiers: [.control, .option])
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { model.section = .settings }
                    .keyboardShortcut(",")
            }
        }

        // One screen in a window of its own, for a second monitor: right-click a sidebar row, or the toolbar button.
        WindowGroup("Screen", id: "screen", for: Section.self) { $section in
            if let section {
                NavigationStack {
                    sectionView(section).navigationDestination(for: Section.self) { sectionView($0) }
                }
                .navigationTitle(section.title)
                .overlay { FeelOverlay() }
                .themedRoot()
                .environmentObject(model)
                .environmentObject(model.engine)
            }
        }
        .defaultSize(width: 560, height: 720)

        MenuBarExtra {
            MenuBarView()
                .environmentObject(model)
                .environmentObject(model.engine)
        } label: {
            Image(systemName: "circle.inset.filled")
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
