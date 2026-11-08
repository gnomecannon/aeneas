import SwiftUI
import EACore
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Settings, Privacy on this device: what may leave the app on this device or show outside it. Everything starts off
/// (tenets 1 and 2); each switch says what turning it on does.
struct PrivacySettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var backup = SharedConfig.shared.includeInICloudBackup
    @State private var spotlight = SharedConfig.shared.showInSpotlight
    @State private var lockTitles = SharedConfig.shared.lockScreenTitles
    #if os(macOS)
    @State private var shortcut = UserDefaults.standard.string(forKey: HotKey.settingKey) ?? HotKey.defaultChoice
    @State private var shortcutTaken = false
    #endif

    static var summary: String {
        let c = SharedConfig.shared
        let on = [c.showInSpotlight ? "Spotlight" : nil, c.lockScreenTitles ? "lock screen titles" : nil, c.includeInICloudBackup ? "iCloud Backup" : nil].compactMap { $0 }
        return on.isEmpty ? "Nothing leaves the app" : "On: " + on.joined(separator: ", ")
    }

    var body: some View {
        Form {
            #if os(iOS)
            SwiftUI.Section {
                Toggle("Include in iCloud Backup", isOn: $backup)
                    .onChange(of: backup) { _, v in
                        SharedConfig.shared.includeInICloudBackup = v
                        BackupExclusion.apply(config: engine.config)
                    }
            } footer: {
                Text("Off: this device's copy of your data stays out of iCloud Backup and comes back from your hub after a restore. On: it is in your iCloud Backup, which Apple can read unless Advanced Data Protection is on.")
            }
            #endif
            SwiftUI.Section {
                Toggle("Show in Spotlight", isOn: $spotlight)
                    .onChange(of: spotlight) { _, v in
                        SharedConfig.shared.showInSpotlight = v
                        Task {
                            if v { SpotlightIndexer.shared.enabled(); await SpotlightIndexer.shared.update(engine) }
                            else { await SpotlightIndexer.shared.clear() }
                        }
                    }
            } footer: {
                Text("On: system search finds the titles of your notes, tasks, projects, lists and other items (never a note's text, never work items). Off removes everything EverythingApp put there.")
            }
            #if os(iOS)
            SwiftUI.Section {
                Toggle("Show titles on the lock screen", isOn: $lockTitles)
                    .onChange(of: lockTitles) { _, v in
                        SharedConfig.shared.lockScreenTitles = v
                        WidgetCenter.shared.reloadAllTimelines()
                    }
            } footer: {
                Text("Off: widgets and the Live Activity hide what you are working on while the phone is locked, on the lock screen and in StandBy. On: they show it.")
            }
            #endif
            #if os(macOS)
            SwiftUI.Section {
                Picker("Capture from anywhere", selection: $shortcut) {
                    ForEach(HotKey.choices) { Text($0.label).tag($0.id) }
                    Text("Off").tag("off")
                }
                .onChange(of: shortcut) { _, v in
                    UserDefaults.standard.set(v, forKey: HotKey.settingKey)
                    shortcutTaken = !AppDelegate.applyShortcut(v)
                }
                if shortcutTaken { Text("Another app already uses that shortcut. Pick another.").foregroundStyle(.red) }
            } footer: {
                Text("Opens the quick capture panel from any app. The Windows app offers the same choices.")
            }
            #endif
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Privacy on this device")
    }
}
