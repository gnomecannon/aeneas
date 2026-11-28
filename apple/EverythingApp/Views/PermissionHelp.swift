import SwiftUI
import EACore

/// The next step wherever a permission or a module stands in the way: a turned down permission says what is off and
/// opens the system's settings (the system asks only once, so a button that asks again would do nothing), a module that
/// needs an account opens where it is set up, and Settings, Review permissions lists them all.

/// A permission turned down: what is off, in a line, and the button to the system's settings for it.
struct PermissionOffNote: View {
    let permission: DevicePermission

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(PermissionOffNote.line(permission))
                .font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Health is changed in the Health part of Settings, which no link opens: the line says the way there.
            if permission != .health {
                Button(systemSettingsName) { DevicePermissions.openSettings(for: permission) }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("permission.openSettings.\(permission.rawValue)")
            }
        }
    }

    /// Where it is switched back on, in the system's own words.
    static func line(_ p: DevicePermission) -> String {
        #if os(macOS)
        if p == .notifications { return "Notifications are off for Aeneas. Turn them on in System Settings, Notifications, Aeneas." }
        return "Aeneas is not allowed to use \(phrase(p)). Turn it on in System Settings, Privacy and Security, \(settingsName(p))."
        #else
        switch p {
        case .notifications: return "Notifications are off for Aeneas. Turn them on in Settings, Aeneas, Notifications."
        case .health: return "Health shares only what you allow, and never says what that is. Change it in Settings, Health, Data Access and Devices, Aeneas."
        default: return "Aeneas is not allowed to use \(phrase(p)). Turn it on in Settings, Aeneas, \(settingsName(p))."
        }
        #endif
    }

    /// It in a sentence.
    private static func phrase(_ p: DevicePermission) -> String {
        switch p {
        case .microphone: return "the microphone"
        case .speech: return "speech recognition"
        case .calendar: return "your calendars"
        case .contacts: return "your contacts"
        case .location: return "your location"
        default: return p.title
        }
    }

    /// The name the system's settings give it.
    private static func settingsName(_ p: DevicePermission) -> String {
        switch p {
        case .speech: return "Speech Recognition"
        #if os(macOS)
        case .location: return "Location Services"
        #endif
        case .music: return "Media and Apple Music"
        default: return p.title
        }
    }
}

// MARK: Set it up now

/// A module just switched on that needs an account or a sign-in the hub does not have yet.
struct ModuleSetupStart: Identifiable, Equatable {
    var module: String
    var title: String
    /// Finishes "It needs ...".
    var need: String
    var place: ModuleSetup.Place
    var id: String { module }
}

/// The page where a module's account or sign-in is set up.
@MainActor @ViewBuilder func moduleSetupPage(_ place: ModuleSetup.Place) -> some View {
    switch place {
    case .addAccount: AddAccountView()
    case .accounts: AccountsSettingsView()
    case .connections: ConnectionsSettingsView()
    }
}

/// After switching on Mail, Receipts and renewals, Calendar accounts, Project wiki, Games or Films here, when the hub
/// has nothing for it yet: what it needs and Set it up now, which opens the page where it is set up (as Machines opens
/// Set up Machines). Later closes it; the module's own screen links there too.
struct ModuleSetupSheet: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    let start: ModuleSetupStart
    @State private var open = false
    /// Checked again on coming back from the setup page.
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    if done {
                        Label("\(start.title) is set up.", systemImage: "checkmark.circle.fill").foregroundStyle(.okText)
                    } else {
                        Text("\(start.title) is on. It needs \(start.need) before it can show anything.")
                        BigButton(title: "Set it up now", symbol: "arrow.right.circle", prominent: true) { open = true }
                            .accessibilityIdentifier("moduleSetup.now")
                    }
                } footer: {
                    if !done { Text("Or later, in Settings, \(start.place.path).") }
                }
                .themedRow()
            }
            .formStyle(.grouped)
            .themedScreen()
            .navigationTitle("Set up \(start.title)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .pageDestination(isPresented: $open) { moduleSetupPage(start.place) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(done ? "Done" : "Later") { model.moduleSetup = nil }
                        .accessibilityIdentifier("moduleSetup.later")
                }
            }
            .onChange(of: open) { _, now in if !now { Task { await check() } } }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }

    private func check() async {
        guard let c = engine.client, let links = try? await withDeadline(15, { try await c.connections() }) else { return }
        done = ModuleSetup.isSetUp(start.module, links)
    }
}

/// An empty screen's way to where its module is set up ("Link Steam"), opening that page over the screen.
struct ModuleSetupLink: View {
    let title: String
    let place: ModuleSetup.Place

    var body: some View {
        PageLink { moduleSetupPage(place) } label: { Label(title, systemImage: "link") }
            .accessibilityIdentifier("moduleSetup.link")
    }
}

// MARK: Review permissions

/// Settings, Review permissions: each permission the modules that are on need on this device, with where it stands
/// and the one button that moves it on: Allow while never asked, the system's settings once turned down. The permission
/// screen's Not now is not the last word: this is where it comes back.
struct ReviewPermissionsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.scenePhase) private var scenePhase
    @State private var states: [DevicePermission: PermissionState] = [:]
    @State private var asking: DevicePermission?

    private var needs: [PermissionNeed] {
        PermissionPlan.needs(PermissionPlan.withDeviceDefaults(model.modules), platform: model.platform)
            .filter { DevicePermissions.asksFor($0.permission) }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("What the modules that are on need on this \(deviceKind). Switch a module off in Settings, Modules and its permission is no longer needed.")
                    .font(.callout).foregroundStyle(.secondary)
                if needs.isEmpty { Text("No module that is on needs a permission here.").foregroundStyle(.secondary) }
            }
            .themedRow()
            ForEach(needs) { n in
                SwiftUI.Section { row(n) }
                    .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Review permissions")
        .task { await load() }
        // Back from the system's settings: read again, so a permission turned on there shows as allowed.
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
    }

    @ViewBuilder private func row(_ n: PermissionNeed) -> some View {
        let state = states[n.permission]
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: n.permission.symbol).font(.title3).foregroundStyle(.tint).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(n.permission.title).font(.headline)
                    Spacer(minLength: 8)
                    if let state { Text(state.label).font(.caption.weight(.semibold)).foregroundStyle(color(state)) }
                }
                Text(n.forLine).font(.caption).foregroundStyle(.secondary)
                switch state {
                case .notAsked?, .askedBefore?:
                    Button(asking == n.permission ? "Asking" : (state == .askedBefore ? "Turn on" : "Allow")) { allow(n) }
                        .buttonStyle(.themedProminent)
                        .disabled(asking != nil)
                        .accessibilityIdentifier("permissions.review.allow.\(n.permission.rawValue)")
                case .denied?:
                    PermissionOffNote(permission: n.permission)
                case .allowed?:
                    // Health never says which types were allowed: where to change them.
                    if n.permission == .health { PermissionOffNote(permission: .health) }
                case nil:
                    ProgressView()
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func color(_ s: PermissionState) -> AnyShapeStyle {
        switch s {
        case .allowed: return AnyShapeStyle(StatusStyle.okText)
        case .denied: return AnyShapeStyle(StatusStyle.warnText)
        case .notAsked, .askedBefore: return AnyShapeStyle(.secondary)
        }
    }

    private func load() async {
        states = await DevicePermissions.states(needs.map(\.permission))
    }

    /// Allow: the system's question, then each module with all it needs is on here too (as Continue does).
    private func allow(_ n: PermissionNeed) {
        asking = n.permission
        Task {
            await model.grantOffered(PermissionOffer(needs: [n]))
            asking = nil
            await load()
        }
    }
}
