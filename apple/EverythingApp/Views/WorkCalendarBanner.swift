#if os(iOS) || os(macOS)
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif
import EACore

/// Shown on Today only while work meetings cannot sync: no calendar access yet, access refused,
/// or no calendar marked as work. Without it the Work blackout looks empty with no reason given.
/// Only for someone who turned on the Apple Calendar module: everyone else never asked for calendar sync, and a new
/// person's first Today opened on a warning about a feature they had not chosen.
struct WorkCalendarBanner: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var importer = CalendarImporter.shared

    var body: some View {
        Group {
            if !engine.config.moduleOn(.appleCalendar) || !engine.config.appleCalendarHere { EmptyView() }
            else { switch importer.access {
            case .full:
                if importer.selected.isEmpty {
                    banner("Work meetings are not syncing", "No calendar is marked as work. Pick it in Settings, Accounts, Calendars.", button: nil)
                }
            case .notDetermined:
                banner("Work meetings are not syncing", "Aeneas needs to read your calendar titles and times.", button: ("Allow calendar access", { Task { await importer.requestAccess(facts: engine.facts) } }))
            default:
                banner("Work meetings are not syncing", "Calendar access is off. Turn on Full Access for Aeneas in \(systemSettingsName.replacingOccurrences(of: "Open ", with: "")).", button: (systemSettingsName, {
                    openPrivacySettings()
                }))
            } }
        }
        .onAppear { importer.refreshAccess() }
    }

    private func banner(_ title: String, _ detail: String, button: (String, () -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: "calendar.badge.exclamationmark").font(.headline)
            Text(detail).font(.subheadline).foregroundStyle(.secondary)
            if let b = button { Button(b.0, action: b.1).buttonStyle(.themedProminent) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.warn.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
    }
}
#endif

#if os(iOS) || os(macOS)
/// The system's privacy settings for this app (iOS Settings, or Calendars privacy on the Mac).
@MainActor func openPrivacySettings(_ pane: String = "Privacy_Calendars") {
    #if os(iOS)
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    #else
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    #endif
}
#endif

#if os(iOS)
let systemSettingsName = "Open iOS Settings"
let noCalendarsLabel = "No calendars on this iPhone"
let localCalendarLabel = "On this iPhone"
#elseif os(macOS)
let systemSettingsName = "Open System Settings"
let noCalendarsLabel = "No calendars on this Mac. The iPhone imports work meetings when it has them."
let localCalendarLabel = "On this Mac"
#endif
