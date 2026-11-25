import SwiftUI
import EACore

/// Settings, Notifications: one switch for each kind of alert, under the hub's own title and line for it. The hub
/// keeps the switches, holds back a kind that is off and tells the other devices over /live; this section only
/// writes them and shows the answer. The notifications this device plans itself (a reminder at its time, the
/// check-in three hours into an activity) follow from the engine's copy of the same list.
struct AlertSwitchesSection: View {
    @EnvironmentObject var engine: SyncEngine
    /// The alerts to list, in the hub's order, those of switched off modules already left out.
    let alerts: [AlertInfo]
    /// Switches flipped here that the hub has not answered yet, so the toggle does not jump back while it waits.
    @State private var pending: [String: Bool] = [:]
    /// A switch that did not change, and why.
    @State private var refused: (id: String, text: String)?

    var body: some View {
        SwiftUI.Section {
            ForEach(alerts) { a in
                Toggle(isOn: binding(a)) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(a.title)
                        if !a.summary.isEmpty { Text(a.summary).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .toggleStyle(.switch)
                .disabled(pending[a.id] != nil)
                // Under the switch that did not change, where the eye already is.
                if let refused, refused.id == a.id {
                    Text(refused.text).font(.caption).foregroundStyle(.warnText)
                }
            }
        } header: {
            Text("Every device")
        }
        .themedRow()
    }

    private func binding(_ a: AlertInfo) -> Binding<Bool> {
        Binding(
            get: { pending[a.id] ?? a.on },
            set: { on in flip(a.id, on) }
        )
    }

    private func flip(_ id: String, _ on: Bool) {
        pending[id] = on
        refused = nil
        Task {
            do { try await engine.setAlerts([id: on]) }
            catch { refused = (id, "Could not save: \((error as? HubError)?.errorDescription ?? error.localizedDescription)") }
            pending[id] = nil
        }
    }
}

/// Settings, Notifications: tasks that are also in Apple Reminders alert from Aeneas and from Apple's Reminders app
/// (the alarm on the item). Each is switched once for every device. Shown while the Apple Reminders sync is on and the
/// hub has the switches (1.0.19 and later).
struct AppleReminderAlertsSection: View {
    @EnvironmentObject var engine: SyncEngine
    let setting: AppleReminderAlerts
    /// Switches flipped here that the hub has not answered yet.
    @State private var pending: [String: Bool] = [:]
    @State private var refused: (id: String, text: String)?

    var body: some View {
        SwiftUI.Section {
            row("aeneas", title: "Alert from Aeneas", line: "Aeneas alerts you at the reminder time, on every device.", on: setting.aeneas)
            row("apple", title: "Alert from Apple Reminders", line: "Apple Reminders alerts you too. Off, the items keep their date and time but have no alert.", on: setting.apple)
            if let waits = setting.waitingLine {
                Text(waits).font(.caption).foregroundStyle(.warnText)
            }
        } header: {
            Text("Reminders also in Apple Reminders")
        } footer: {
            Text(Self.systemSwitch)
        }
        .themedRow()
    }

    /// Where Apple Reminders' own notifications are switched on this kind of device.
    static var systemSwitch: String {
        #if os(macOS)
        "The system's own switch for Apple Reminders is in System Settings, Notifications, Reminders."
        #else
        "The system's own switch for Apple Reminders is in iOS Settings, Notifications, Reminders."
        #endif
    }

    @ViewBuilder private func row(_ id: String, title: String, line: String, on: Bool) -> some View {
        Toggle(isOn: Binding(get: { pending[id] ?? on }, set: { flip(id, $0) })) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(line).font(.caption).foregroundStyle(.secondary)
            }
        }
        .toggleStyle(.switch)
        .disabled(pending[id] != nil)
        if let refused, refused.id == id {
            Text(refused.text).font(.caption).foregroundStyle(.warnText)
        }
    }

    private func flip(_ id: String, _ on: Bool) {
        pending[id] = on
        refused = nil
        Task {
            do { try await engine.setAppleReminderAlerts([id: on]) }
            catch { refused = (id, "Could not save: \((error as? HubError)?.errorDescription ?? error.localizedDescription)") }
            pending[id] = nil
        }
    }
}
