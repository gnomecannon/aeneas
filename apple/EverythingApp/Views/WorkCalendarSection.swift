#if os(iOS) || os(macOS)
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif
import EACore

/// Settings section for the work calendar import: access, which calendars count as work,
/// the last import, and Import now.
struct WorkCalendarSection: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var importer = CalendarImporter.shared

    var body: some View {
        SwiftUI.Section {
            LabeledContent("Access", value: accessLabel)
            switch importer.access {
            case .notDetermined:
                Button("Allow calendar access") { Task { await importer.requestAccess(facts: engine.facts) } }
            case .denied, .restricted, .writeOnly:
                Button(systemSettingsName) {
                    openPrivacySettings()
                }
            case .full:
                if importer.calendars.isEmpty {
                    Text(noCalendarsLabel).foregroundStyle(.secondary)
                } else {
                    if importer.selected.isEmpty {
                        Text("Choose which calendars are work").font(.subheadline.weight(.semibold))
                    }
                    ForEach(importer.calendars) { c in
                        Toggle(isOn: Binding(get: { importer.selected.contains(c.id) }, set: { importer.setSelected(c.id, $0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title)
                                Text(c.sourceTitle.isEmpty ? (c.isExchange ? "Exchange" : localCalendarLabel) : c.sourceTitle)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                LabeledContent("Last import", value: lastImportLabel)
                if let r = importer.lastResult, r.inserted + r.updated + r.deleted > 0 {
                    Text("\(r.inserted) added, \(r.updated) changed, \(r.deleted) removed").font(.caption).foregroundStyle(.secondary)
                }
                Button(importer.running ? "Importing" : "Import now") { Task { await importer.runNow(reason: "manual") } }
                    .disabled(importer.running || importer.selected.isEmpty)
            }
            if let e = importer.lastError { Text(e).font(.caption).foregroundStyle(.red) }
        } header: {
            Text("Work meetings to import")
        } footer: {
            Text("Reads only the title and time of meetings in the calendars you choose, 7 days back to 30 days ahead. They show as Work in Today and Week and count as busy time.")
        }
        .id("workCalendar")
        .onAppear { importer.refreshAccess() }
    }

    private var accessLabel: String {
        switch importer.access {
        case .full: return "Allowed"
        case .notDetermined: return "Not asked"
        case .writeOnly: return "Add events only, needs full access"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        }
    }

    private var lastImportLabel: String {
        guard let d = importer.config.lastCalendarImport else { return "Never" }
        let n = importer.config.lastCalendarImportCount
        return "\(d.shortDateTime), \(n) event\(n == 1 ? "" : "s")"
    }
}
#endif

#if os(iOS) || os(macOS)
/// Where events made in the app (by hand or by the assistant) are copied in Apple Calendar: one calendar for personal
/// events, one for work events. The choice is kept in Memory (`calendar:personal`, `calendar:work`), so it is the same
/// on every device and the assistant can change it too.
struct AppEventsCalendarSection: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var importer = CalendarImporter.shared
    @ObservedObject var mirror = EventMirrorSync.shared

    var body: some View {
        SwiftUI.Section {
            if importer.access == .full, !importer.calendars.isEmpty {
                picker("Personal events", space: .personal, none: "Default calendar")
                picker("Work events", space: .work, none: "Do not copy")
                if let s = mirror.lastSummary, let d = mirror.lastRun {
                    Text("Last copy \(d.shortDateTime): \(s)").font(.caption).foregroundStyle(.secondary)
                }
                if let e = mirror.lastError { Text(e).font(.caption).foregroundStyle(.red) }
            } else {
                Text("Allow calendar access below to copy events made in the app into Apple Calendar.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Where app events go")
        } footer: {
            Text("Events you or the assistant add in EverythingApp are copied into these calendars, and changes made in Apple Calendar come back. Events already in the wrong calendar move.")
        }
    }

    /// The value saved for a calendar: its title when no other calendar shares it, else its account.
    private func value(_ c: CalendarInfo) -> String {
        importer.calendars.filter { $0.title.caseInsensitiveCompare(c.title) == .orderedSame }.count == 1 ? c.title : (c.sourceTitle.isEmpty ? c.title : c.sourceTitle)
    }

    private func picker(_ title: String, space: Space, none: String) -> some View {
        let all = Set(importer.calendars.map(\.id))
        let current = EventMirror.named(space, facts: engine.facts) == nil ? "" :
            (EventMirror.calendar(for: space, facts: engine.facts, calendars: importer.calendars, writable: all, defaultId: nil, work: []) ?? "")
        return Picker(title, selection: Binding(get: { current }, set: { choose($0, space: space) })) {
            Text(none).tag("")
            ForEach(importer.calendars) { c in
                Text(c.sourceTitle.isEmpty || c.sourceTitle == c.title ? c.title : "\(c.title) (\(c.sourceTitle))").tag(c.id)
            }
        }
    }

    private func choose(_ id: String, space: Space) {
        let key = EventMirror.factKey(space)
        let existing = engine.facts.first { !$0.isDeleted && $0.str("key").lowercased() == key }
        Task {
            if let c = importer.calendars.first(where: { $0.id == id }) {
                if let f = existing { _ = await engine.update(f.id, fields: ["value": .string(value(c))]) }
                else { _ = await engine.create(kind: .fact, fields: ["category": "preference", "key": .string(key), "value": .string(value(c)), "source": "user"]) }
            } else if let f = existing {
                await engine.softDelete(f.id)
            }
            await EventMirrorSync.shared.runNow(reason: "calendar chosen")
        }
    }
}
#endif

#if os(iOS) || os(macOS)
/// Shown on Today only while work meetings cannot sync: no calendar access yet, access refused,
/// or no calendar marked as work. Without it the Work blackout looks empty with no reason given.
/// Only for someone who turned on the Apple Calendar module: everyone else never asked for calendar sync, and a new
/// person's first Today opened on a warning about a feature they had not chosen.
struct WorkCalendarBanner: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var importer = CalendarImporter.shared

    var body: some View {
        Group {
            if !engine.config.moduleOn(.appleCalendar) { EmptyView() }
            else { switch importer.access {
            case .full:
                if importer.selected.isEmpty {
                    banner("Work meetings are not syncing", "No calendar is marked as work. Pick it in Settings, under Calendar and work.", button: nil)
                }
            case .notDetermined:
                banner("Work meetings are not syncing", "EverythingApp needs to read your calendar titles and times.", button: ("Allow calendar access", { Task { await importer.requestAccess(facts: engine.facts) } }))
            default:
                banner("Work meetings are not syncing", "Calendar access is off. Turn on Full Access for EverythingApp in \(systemSettingsName.replacingOccurrences(of: "Open ", with: "")).", button: (systemSettingsName, {
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
            if let b = button { Button(b.0, action: b.1).buttonStyle(.borderedProminent) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
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
