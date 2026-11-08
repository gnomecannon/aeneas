import SwiftUI
import EACore

/// Settings: a short list of areas, each with a one-line summary, each opening its own screen.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var feel = FeelController.shared
    @ObservedObject private var importer = CalendarImporter.shared
    @State private var notifStatus = "Checking"
    @State private var debugPage: SettingsPage?

    var body: some View {
        List {
            SwiftUI.Section {
                NavigationLink { ThemeSettingsView() } label: {
                    SettingsRow(title: "Theme", symbol: "paintpalette", summary: themeSummary)
                }
                NavigationLink { ConnectionSettingsView() } label: {
                    SettingsRow(title: "Connection", symbol: "network", summary: connectionSummary,
                                warning: !engine.rejectedEdits.isEmpty || engine.lastError != nil)
                }
                NavigationLink { ConnectionsSettingsView() } label: {
                    SettingsRow(title: "Connections", symbol: "link", summary: connectionsSummary)
                }
                NavigationLink { ImportSettingsView() } label: {
                    SettingsRow(title: "Bring your data in", symbol: "tray.and.arrow.down", summary: "ChatGPT, Google Takeout, Obsidian and other notes, text")
                }
                NavigationLink { ModulesSettingsView() } label: {
                    SettingsRow(title: "Modules", symbol: "square.grid.3x3.square", summary: modulesSummary)
                }
                NavigationLink { PrivacySettingsView() } label: {
                    SettingsRow(title: "Privacy on this device", symbol: "hand.raised", summary: PrivacySettingsView.summary)
                }
                NavigationLink { NotificationSettingsView(status: $notifStatus) } label: {
                    SettingsRow(title: "Notifications", symbol: "bell.badge", summary: notifStatus)
                }
                if model.isOn(.contacts) {
                    NavigationLink { PeopleSettingsView() } label: {
                        SettingsRow(title: "People", symbol: "person.2", summary: UserDefaults.standard.bool(forKey: ContactsSync.enabledKey) ? "Syncing Apple Contacts" : "Contacts sync off")
                    }
                }
                if model.isOn(.images) {
                    NavigationLink { ImageSettingsView() } label: {
                        SettingsRow(title: "Images", symbol: "photo.on.rectangle", summary: ImageSettingsView.summary)
                    }
                }
            }
            .themedRow()
            SwiftUI.Section {
                NavigationLink { CalendarWorkSettingsView() } label: {
                    SettingsRow(title: "Calendar and work", symbol: "briefcase", summary: calendarSummary)
                }
                NavigationLink(value: Section.planRules) {
                    SettingsRow(title: "Planner", symbol: "calendar.badge.clock", summary: plannerSummary)
                }
            }
            .themedRow()
            SwiftUI.Section {
                NavigationLink { AboutSettingsView() } label: {
                    SettingsRow(title: "About", symbol: "info.circle", summary: "\(model.platform.rawValue), version \(Self.version)")
                }
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Settings")
        .navigationDestination(item: $debugPage) { $0.view }
        .task { notifStatus = await NotificationSettingsView.statusLabel() }
        .onAppear {
            #if DEBUG
            if let p = SettingsPage.launchArgument("EASettingsPage") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { debugPage = p }
            }
            #endif
        }
    }

    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }

    private var themeSummary: String {
        let s = feel.settings
        return "\(AppTheme.name(s.app_theme, custom: s.app_themes)) colors, \(FeelTheme.name(s.theme, palettes: s.palettes)) taps"
    }

    private var connectionSummary: String {
        let n = engine.rejectedEdits.count
        if n > 0 { return "The hub refused \(n == 1 ? "1 edit" : "\(n) edits")" }
        return engine.statusLabel
    }

    /// The links whose module is on, in the order the Connections screen shows them.
    private var connectionsSummary: String {
        let links: [(AppModule, String)] = [(.games, "Steam"), (.wiki, "Confluence"), (.films, "Letterboxd"), (.health, "Apple Health")]
        let shown = links.filter { model.isOn($0.0) }.map(\.1)
        return shown.isEmpty ? "Gmail and Apple Reminders" : shown.joined(separator: ", ")
    }

    private var modulesSummary: String {
        let list = model.modules
        if list.isEmpty { return "Everything on" }
        let on = list.filter(\.on).count
        return on == list.count ? "All \(on) on" : "\(on) of \(list.count) on"
    }

    private var plannerSummary: String {
        let n = engine.planRules.count
        return n == 0 ? "No plan rules" : "\(n) plan rule\(n == 1 ? "" : "s")"
    }

    private var calendarSummary: String {
        switch importer.access {
        case .full:
            let n = importer.selected.count
            return n == 0 ? "No work calendar chosen" : "\(n) work calendar\(n == 1 ? "" : "s")"
        case .notDetermined: return "Calendar access not asked"
        default: return "Calendar access off"
        }
    }

}

/// The Settings screens that can be opened directly in Debug builds (`-EASettingsPage theme`).
enum SettingsPage: String, Hashable, Identifiable {
    case theme, connection, connections, notifications, calendar, health, about, appColors, tapEffects, noteSounds, modules
    var id: String { rawValue }

    /// A page named by a launch argument, once per launch.
    @MainActor private static var used: Set<String> = []
    @MainActor static func launchArgument(_ key: String) -> SettingsPage? {
        guard !used.contains(key), let p = UserDefaults.standard.string(forKey: key).flatMap(SettingsPage.init(rawValue:)) else { return nil }
        used.insert(key)
        return p
    }

    @MainActor @ViewBuilder var view: some View {
        switch self {
        case .theme: ThemeSettingsView()
        case .connection: ConnectionSettingsView()
        case .notifications: NotificationSettingsView(status: .constant(""))
        case .calendar: CalendarWorkSettingsView()
        case .health, .connections: ConnectionsSettingsView()
        case .about: AboutSettingsView()
        case .appColors: AppColorsView()
        case .tapEffects: TapEffectsView()
        case .noteSounds: NoteSoundsView()
        case .modules: ModulesSettingsView()
        }
    }
}

/// A Settings row: symbol, title, and what is set now.
struct SettingsRow: View {
    var title: String
    var symbol: String
    var summary: String
    var warning = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(summary).font(.caption).foregroundStyle(warning ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary)).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Connection

/// The hub, this device's key and name, pairing another device, every paired device, sync status, and what the hub
/// refused.
struct ConnectionSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var deviceName = ""
    @State private var testResult: String?
    @State private var saved = false
    @State private var confirmReset = false

    var body: some View {
        if model.config.sampleMode {
            // Sample mode has no hub, key or devices: only the way to a real one.
            Form { SwiftUI.Section { SampleBanner() } }
        } else {
            connectionForm
        }
    }

    private var connectionForm: some View {
        Form {
            SwiftUI.Section {
                LabeledContent("Hub", value: model.config.hubURL)
                LabeledContent("Signed in with", value: model.config.hasDeviceKey ? "This device's own key" : "The hub's shared key")
                if model.config.hubPin != nil { LabeledContent("Certificate", value: "Pinned") }
                LabeledContent("Device name") {
                    TextField("Device name", text: $deviceName)
                        .multilineTextAlignment(.trailing)
                        .onSubmit { rename() }
                }
                HStack {
                    Button("Save name") { rename() }
                        .disabled(deviceName.trimmingCharacters(in: .whitespaces).isEmpty || deviceName == model.config.deviceName)
                    Spacer()
                    if saved { Text("Saved").font(.caption).foregroundStyle(.secondary) }
                }
                HStack {
                    Button("Test connection") { test() }
                    Spacer()
                    if let r = testResult { Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            } header: {
                Text("Hub")
            } footer: {
                Text(model.config.hasDeviceKey
                     ? "The key is kept in this device's Keychain and never leaves it. To use another hub, remove this device below and pair again."
                     : "This device still uses the key every device shared. It moves to a key of its own once the hub is updated.")
            }
            .themedRow()
            PairDeviceSection()
            DevicesSection()
            SwiftUI.Section("Sync") {
                LabeledContent("Status", value: engine.statusLabel)
                LabeledContent("Waiting to send", value: engine.outboxCount == 0 ? "Nothing" : "\(engine.outboxCount) changes")
                LabeledContent("Items on this device", value: engine.entities.count.formatted())
                DisclosureGroup("Details") {
                    LabeledContent("Device id", value: model.config.deviceId.isEmpty ? "not registered" : String(model.config.deviceId.prefix(8)))
                    LabeledContent("Sync position", value: String(engine.cursor))
                }
                if let e = engine.lastError { Text(e).font(.caption).foregroundStyle(.red) }
                Button("Sync now") { Task { await engine.sync() } }
            }
            .themedRow()
            if !engine.rejectedEdits.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup("The hub refused \(engine.rejectedEdits.count == 1 ? "1 edit" : "\(engine.rejectedEdits.count) edits")") {
                        ForEach(engine.rejectedEdits.reversed()) { r in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.title.isEmpty ? r.kind : r.title).font(.callout.weight(.semibold))
                                Text(r.reason).font(.caption).foregroundStyle(.secondary)
                                Text(r.fields).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(3)
                            }
                        }
                        Button("Clear") { engine.clearRejected() }
                    }
                    .foregroundStyle(.red)
                } footer: {
                    Text("The hub kept its own copy of these. What you changed is listed so nothing is lost silently.")
                }
                .themedRow()
            }
            SwiftUI.Section {
                Button("Reset local cache", role: .destructive) { confirmReset = true }
            } footer: {
                Text("Clears this device's copy and downloads everything again from the hub.")
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Connection")
        .confirmationDialog("Reset the local cache?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset", role: .destructive) {
                // The engine resets its cursor and memory too, so the next sync pulls from zero; edits not yet sent are kept.
                Task { await engine.resetLocalCache(); await engine.start() }
            }
        } message: {
            if engine.outboxCount > 0 {
                Text("\(engine.outboxCount) edits have not reached the hub yet. They are kept and sent first.")
            }
        }
        .onAppear {
            deviceName = model.config.deviceName
        }
    }

    private func rename() {
        let n = deviceName
        Task { await engine.rename(n); saved = true }
    }

    /// Reads with this device's key, so a key the hub no longer knows shows here too.
    private func test() {
        testResult = "Testing"
        Task {
            guard let c = engine.client else { testResult = "Not connected"; return }
            do {
                let h = try await withDeadline(15) { try await c.health() }
                _ = try await withDeadline(15) { try await c.modules() }
                testResult = "OK, version \(h.version ?? "?")"
            } catch { testResult = (error as? HubError)?.errorDescription ?? error.localizedDescription }
        }
    }
}

// MARK: Notifications

struct NotificationSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @Binding var status: String

    var body: some View {
        Form {
            SwiftUI.Section {
                LabeledContent("Permission", value: status)
                Button("Request permission") {
                    Task {
                        _ = await ReminderScheduler.shared.requestPermission()
                        status = await Self.statusLabel()
                        await engine.replanNotifications()
                    }
                }
            } footer: {
                Text("Reminders reach you only when notifications are allowed.")
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Notifications")
        .task { status = await Self.statusLabel() }
    }

    static func statusLabel() async -> String {
        switch await ReminderScheduler.shared.authorizationStatus() {
        case .authorized, .provisional, .ephemeral: return "Allowed"
        case .denied: return "Denied"
        default: return "Not asked"
        }
    }
}

// MARK: Calendar and work

struct CalendarWorkSettingsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Form {
            // Apple Calendar off (Settings, Modules): no calendar is read or written on this device.
            if model.isOn(.appleCalendar) {
                AppEventsCalendarSection().themedRow()
                WorkCalendarSection().themedRow()
            }
            WorkSpaceSection().themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Calendar and work")
    }
}

// MARK: About

struct AboutSettingsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Form {
            SwiftUI.Section {
                LabeledContent("Version", value: "\(SettingsView.version) (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))")
                LabeledContent("Platform", value: model.platform.rawValue)
                LabeledContent("App group", value: model.config.usesAppGroup ? "yes" : "no (using standard defaults)")
                LabeledContent("Store", value: model.config.storeURL.lastPathComponent)
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("About")
    }
}

/// One switch for the sealed work space. Off erases every work event and task on every device and stops the import.
struct WorkSpaceSection: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var status: WorkSpaceStatus?
    @State private var confirmOff = false
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        SwiftUI.Section("Work space") {
            if let s = status {
                Toggle("Keep work calendar and tasks", isOn: Binding(get: { s.enabled }, set: { on in on ? set(true) : (confirmOff = true) }))
                    .disabled(busy)
                Text(s.enabled ? "\(s.events ?? 0) work events and \(s.tasks ?? 0) work tasks. Titles and times only; never sent to cloud AI." : "Off. Nothing from work is kept or imported.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(engine.client == nil ? "Hub not configured." : "Loading").foregroundStyle(.secondary)
            }
            if let m = message { Text(m).font(.caption).foregroundStyle(.secondary) }
        }
        .task { await load() }
        .confirmationDialog("Turn off and erase the work space?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Erase work data", role: .destructive) { set(false) }
        } message: {
            Text("Every work event and work task is erased from the hub and every device, and the work calendar stops importing. Turning it back on starts empty.")
        }
    }

    private func load() async {
        guard let c = engine.client else { return }
        do { status = try await c.workSpace() } catch { message = (error as? HubError)?.errorDescription ?? error.localizedDescription }
    }

    private func set(_ on: Bool) {
        guard let c = engine.client else { return }
        busy = true
        Task {
            do {
                let r = try await c.setWorkSpace(enabled: on)
                message = on ? "Work space on." : "Erased \(r.erased ?? 0) work items."
                await engine.sync()
                await load()
                if on { await CalendarImporter.shared.runIfReady(reason: "work space on") }
            } catch { message = (error as? HubError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}
