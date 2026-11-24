#if os(iOS) || os(macOS)
import SwiftUI
#if os(iOS)
import UIKit
#endif
import EACore

/// "From this iPhone" (Settings, Accounts): what comes into Aeneas from the device's own Apple Reminders and Calendar.
/// Every choice here is one for every device, kept by the hub (the sources setting, Sources.swift).

/// The device's own name in a sentence: this iPhone, this iPad, this Mac.
@MainActor private var thisDevice: String {
    #if os(macOS)
    "this Mac"
    #else
    UIDevice.current.userInterfaceIdiom == .pad ? "this iPad" : "this iPhone"
    #endif
}

/// An account as a group's name: its own name, or what kind of account it is.
private func accountLabel(_ account: String, kind: String) -> String {
    if !account.isEmpty { return account }
    switch kind {
    case "icloud": return "iCloud"
    case "exchange": return "Exchange"
    case "local": return "On this device"
    default: return "Other"
    }
}

/// Where the sources setting stands: read from the hub, not known to it (an older hub), or not read yet.
private struct SourcesStateNote: View {
    var loaded: Bool?
    var what: String
    var body: some View {
        if loaded == true {
            Text("Your hub runs an older version. Update it to choose \(what) here.").foregroundStyle(.secondary)
        } else {
            Text("Connect to your hub to choose \(what).").foregroundStyle(.secondary)
        }
    }
}

/// Which Reminders lists come in, each Personal or Work, and where tasks made in Aeneas go.
struct DeviceRemindersView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var loaded: Bool?
    @State private var error: String?
    @State private var busy = false

    private var setting: SourcesSetting? { engine.sources }

    /// Accounts by name, each with its lists by name.
    private var groups: [(account: String, lists: [SourcesSetting.ReminderList])] {
        let lists = setting?.lists ?? []
        var order: [String] = []
        for l in lists where !order.contains(accountLabel(l.account, kind: l.kind)) { order.append(accountLabel(l.account, kind: l.kind)) }
        return order.sorted { $0.localizedStandardCompare($1) == .orderedAscending }.map { a in
            (a, lists.filter { accountLabel($0.account, kind: $0.kind) == a }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending })
        }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("Choose which Apple Reminders lists come into Aeneas. The choice is the same on every device. A list that is off stays out of Tasks and Today, and stays as it is in Apple Reminders.")
                    .font(.footnote).foregroundStyle(.secondary)
                if setting == nil { SourcesStateNote(loaded: loaded, what: "lists") }
                else if setting?.lists.isEmpty == true {
                    Text("No lists yet. They appear once an iPhone, iPad or Mac syncs Apple Reminders.").foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.dangerText) }
            }
            .themedRow()
            ForEach(groups, id: \.account) { g in
                SwiftUI.Section {
                    ForEach(g.lists) { l in row(l) }
                } header: {
                    Text(g.account)
                }
                .themedRow()
            }
            if let s = setting, !s.lists.isEmpty {
                SwiftUI.Section {
                    Picker("New tasks go to", selection: Binding(get: { s.new_tasks ?? "" }, set: { k in change(["new_tasks": k.isEmpty ? .null : .string(k)]) })) {
                        Text("Default list").tag("")
                        ForEach(s.lists.filter { $0.on && ($0.wants ?? $0.space) == .personal }) { l in
                            Text(s.lists.filter { $0.title == l.title }.count > 1 ? "\(l.title) (\(accountLabel(l.account, kind: l.kind)))" : l.title).tag(l.key)
                        }
                    }
                } footer: {
                    Text("Tasks you or the assistant make in Aeneas are added to this list in Apple Reminders. The default list is the one each device uses for new reminders.")
                }
                .themedRow()
            }
            if let s = setting, s.lists.contains(where: { $0.wants != nil }) {
                SwiftUI.Section {
                    Text("Personal or Work takes effect once every iPhone, iPad and Mac runs Aeneas \(s.needs) or later. Until then the tasks stay where their account puts them. Update these:")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(s.waiting) { d in
                        LabeledContent(d.name.isEmpty ? "A device" : d.name, value: d.version.map { "runs \($0)" } ?? "version not known")
                    }
                } header: {
                    Text("Waiting for an update")
                }
                .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Reminders")
        .disabled(busy)
        .task { loaded = await engine.refreshSources() }
    }

    private func row(_ l: SourcesSetting.ReminderList) -> some View {
        let here = l.devices.contains(engine.config.deviceId)
        let wanted = l.wants ?? l.space
        return VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { l.on }, set: { on in change(["lists": .array([.object(["key": .string(l.key), "on": .bool(on)])])]) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(l.title)
                    if !here { Text("Not on \(thisDevice)").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if l.on {
                Picker("Space", selection: Binding(get: { wanted }, set: { s in change(["lists": .array([.object(["key": .string(l.key), "space": .string(s.rawValue)])])]) })) {
                    Text("Personal").tag(Space.personal)
                    Text("Work").tag(Space.work)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Space for \(l.title)")
                if let w = l.wants {
                    Text("\(w == .work ? "Work" : "Personal") once every device is updated").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func change(_ body: [String: JSONValue]) {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do { try await engine.changeSources(body) }
            catch { self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
        }
    }
}

/// Your calendar (where events made in Aeneas go), the work calendars (one choice for every device) and where work
/// events made in Aeneas go: everything Settings, Calendar and work had, which is gone since 2026-11-24. Where the
/// hub's own new events go is on the iCloud account's page instead; the two never both apply.
struct DeviceCalendarsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @ObservedObject private var importer = CalendarImporter.shared
    @ObservedObject private var mirror = EventMirrorSync.shared
    @State private var loaded: Bool?
    @State private var error: String?

    private var setting: SourcesSetting? { engine.sources }

    var body: some View {
        Form {
            SwiftUI.Section {
                if importer.access != .full {
                    Text("Allow calendar access to choose calendars on \(thisDevice).").foregroundStyle(.secondary)
                    if importer.access == .notDetermined {
                        Button("Allow calendar access") { Task { await importer.requestAccess(facts: engine.facts) } }
                    } else {
                        Button(systemSettingsName) { openPrivacySettings() }
                    }
                } else if SharedConfig.hubKeepsCalendars(model.modules) {
                    Text("Your hub keeps your iCloud calendars in step, so it adds the events you make to the calendar chosen there (Settings, Accounts, your iCloud account).")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    picker("Events you make go to", space: .personal, none: "Default calendar")
                }
                if importer.access == .full, let s = mirror.lastSummary, let d = mirror.lastRun {
                    Text("Last copy \(d.shortDateTime): \(s)").font(.caption).foregroundStyle(.secondary)
                }
                if let e = mirror.lastError { Text(e).font(.caption).foregroundStyle(.dangerText) }
            } header: {
                Text("Your calendar")
            } footer: {
                Text("Events you or the assistant add in Aeneas are copied into this calendar, and changes made in Apple Calendar come back.")
            }
            .themedRow()

            SwiftUI.Section {
                if let s = setting {
                    if s.calendars.isEmpty {
                        Text("No calendars yet. They appear once an iPhone, iPad or Mac with calendar access syncs.").foregroundStyle(.secondary)
                    }
                    ForEach(s.calendars) { c in workRow(c) }
                } else {
                    SourcesStateNote(loaded: loaded, what: "work calendars")
                }
                if let e = error ?? importer.lastError { Text(e).font(.footnote).foregroundStyle(.dangerText) }
            } header: {
                Text("Work calendars")
            } footer: {
                Text("Meetings in these calendars come in as Work, titles and times only, on every device that has the calendar. A calendar your hub keeps in step cannot be work: its events would come in twice.")
            }
            .themedRow()

            if importer.access == .full {
                SwiftUI.Section {
                    picker("Work events you make go to", space: .work, none: "Do not copy")
                    LabeledContent("Last import", value: lastImport)
                    if let r = importer.lastResult, r.inserted + r.updated + r.deleted > 0 {
                        Text("\(r.inserted) added, \(r.updated) changed, \(r.deleted) removed").font(.caption).foregroundStyle(.secondary)
                    }
                    Button(importer.running ? "Importing" : "Import now") { Task { await importer.runNow(reason: "manual") } }
                        .disabled(importer.running || importer.selected.isEmpty)
                } footer: {
                    Text("Work events you or the assistant add in Aeneas are copied into this calendar. Work meetings are read 7 days back to 30 days ahead.")
                }
                .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Calendars")
        .task {
            importer.refreshAccess()
            loaded = await engine.refreshSources()
        }
    }

    private var lastImport: String {
        guard let d = importer.config.lastCalendarImport else { return "Never" }
        let n = importer.config.lastCalendarImportCount
        return "\(d.shortDateTime), \(n) event\(n == 1 ? "" : "s")"
    }

    private func workRow(_ c: SourcesSetting.WorkCalendar) -> some View {
        let here = c.devices.contains(engine.config.deviceId)
        return Toggle(isOn: Binding(get: { c.work }, set: { on in
            error = nil
            Task { await importer.setWork(key: c.key, on) }
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.title)
                Text(c.hub_kept ? "Kept in step by your hub" : here ? accountLabel(c.account, kind: c.kind) : "\(accountLabel(c.account, kind: c.kind)), not on \(thisDevice)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .disabled(c.hub_kept)
    }

    /// The value kept for a calendar: its title when no other calendar shares it, else its account.
    private func value(_ c: CalendarInfo) -> String {
        importer.calendars.filter { $0.title.caseInsensitiveCompare(c.title) == .orderedSame }.count == 1 ? c.title : (c.sourceTitle.isEmpty ? c.title : c.sourceTitle)
    }

    /// The calendar a fact (`calendar:personal`, `calendar:work`) names, one choice for every device.
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
