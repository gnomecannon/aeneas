import SwiftUI
import EACore

/// Settings, Modules: every part beyond the core, switched on or off once for every device. The hub keeps the
/// switches and tells the other devices over /live; this screen only writes them and shows the answer.
struct ModulesSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// Switches flipped here that the hub has not answered yet, so the toggle does not jump back while it waits.
    @State private var pending: [String: Bool] = [:]
    @State private var error: String?
    @State private var loading = false
    /// Areas opened on this screen; all start folded.
    @State private var expanded: Set<String> = []

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("Switch off what you do not use. Off hides it on every device and stops its background work; nothing is erased.")
                    .font(.callout).foregroundStyle(.secondary)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            .themedRow()
            if engine.client == nil {
                Text("Set up the hub connection first.").foregroundStyle(.secondary).themedRow()
            } else if model.modules.isEmpty {
                SwiftUI.Section {
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    else { Button("Try again") { Task { await load() } } }
                }
                .themedRow()
            }
            // Each area folds to one line naming its modules and how many are on (the same as the web picker).
            ForEach(model.modules.grouped) { g in
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: expandedBinding(g.title)) {
                        ForEach(g.modules) { m in
                            Toggle(isOn: binding(m)) { ModuleRow(m: m, on: binding(m).wrappedValue) }
                                .toggleStyle(.switch)
                                .disabled(pending[m.id] != nil)
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(g.title).font(.headline)
                                Spacer()
                                Text("\(g.modules.filter { binding($0).wrappedValue }.count) of \(g.modules.count) on").font(.caption).foregroundStyle(.secondary)
                            }
                            Text(g.modules.map(\.title).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Modules")
        .task { await load() }
        .refreshable { await load() }
    }

    private func expandedBinding(_ group: String) -> Binding<Bool> {
        Binding(get: { expanded.contains(group) }, set: { if $0 { expanded.insert(group) } else { expanded.remove(group) } })
    }

    private func binding(_ m: ModuleInfo) -> Binding<Bool> {
        Binding(
            get: { pending[m.id] ?? model.modules.isOn(m.id) },
            set: { on in flip(m.id, on) }
        )
    }

    private func load() async {
        guard let c = engine.client else { return }
        loading = true
        defer { loading = false }
        do { model.applyModules(try await c.modules()); error = nil }
        catch { self.error = "Could not load the modules: \(Self.message(error))" }
    }

    private func flip(_ id: String, _ on: Bool) {
        pending[id] = on
        error = nil
        Task {
            do { try await model.setModules([id: on]) }
            catch { self.error = "Could not save: \(Self.message(error))" }
            pending[id] = nil
        }
    }

    private static func message(_ e: Error) -> String { (e as? HubError)?.errorDescription ?? e.localizedDescription }
}

/// One module under its switch: a line on what it does. What it reads, the permissions it asks for and any advanced
/// setup show once it is on, and before that under "What it reads" (release rule 2: nothing hidden when it matters).
private struct ModuleRow: View {
    let m: ModuleInfo
    let on: Bool
    @State private var showMore = false

    private static let permissionNames: [String: String] = [
        "microphone": "the microphone", "speech": "speech recognition", "notifications": "notifications", "reminders": "Reminders",
        "calendar": "Calendar", "contacts": "Contacts", "health": "Health", "photos": "Photos", "location": "Location",
    ]

    private var details: [String] {
        var out: [String] = []
        if let r = m.reads, !r.isEmpty { out.append("Reads: \(r)") }
        let asks = (m.permissions ?? []).map { Self.permissionNames[$0] ?? $0 }
        if !asks.isEmpty {
            let list = asks.count == 1 ? asks[0] : asks.dropLast().joined(separator: ", ") + " and " + asks[asks.count - 1]
            out.append("This device asks for \(list) once, and only while this is on.")
        }
        if let s = m.setup { out.append("Advanced setup: \(s.needs), about \(s.minutes) minutes. The rest works without it.") }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(m.title)
            if !m.summary.isEmpty { Text(m.summary).font(.caption).foregroundStyle(.secondary) }
            if let s = m.setup, !on { Text("Advanced setup for part of it, about \(s.minutes) minutes.").font(.caption).foregroundStyle(.secondary) }
            if on || showMore {
                ForEach(details, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
            } else if !details.isEmpty {
                Button("What it reads") { showMore = true }.font(.caption).buttonStyle(.borderless)
            }
        }
    }
}
