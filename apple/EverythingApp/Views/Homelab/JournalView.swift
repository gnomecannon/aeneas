import SwiftUI
import EACore

/// Change journal: what was done to which host, how risky it was, and how to undo it.
struct JournalView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var hostFilter: String?
    @State private var riskFilter: JournalRisk?
    @State private var editing: Entity?
    @State private var creating = false

    private var entries: [Entity] { engine.list(.journal).sorted(by: JournalOrder.newestFirst) }

    private var shown: [Entity] {
        entries.filter { e in
            (hostFilter.map { Homelab.sameHost(e.str("host"), $0) } ?? true) && (riskFilter == nil || e.str("risk") == riskFilter?.rawValue)
        }
    }

    private struct Day: Identifiable { var id: Date; var items: [Entity] }

    private var days: [Day] {
        let cal = Calendar.current
        var out: [Day] = []
        for e in shown {
            let d = cal.startOfDay(for: e.date("at") ?? ISO.date(e.created_at) ?? Date())
            if out.last?.id == d { out[out.count - 1].items.append(e) } else { out.append(Day(id: d, items: [e])) }
        }
        return out
    }

    /// One per machine however its entries spell it ("NAS" and "nas"), as Machines lists them.
    private var hosts: [String] { Homelab.hostKeys(entries) }

    var body: some View {
        List {
            if hostFilter != nil || riskFilter != nil {
                SwiftUI.Section {
                    HStack {
                        Text(filterSummary).font(.subheadline)
                        Spacer()
                        Button("Show all") { hostFilter = nil; riskFilter = nil }.buttonStyle(.borderless)
                    }
                }
            }
            ForEach(days) { day in
                SwiftUI.Section(header: Text(dayTitle(day.id)).font(.headline)) {
                    ForEach(day.items) { e in
                        JournalRow(entry: e, showHost: hostFilter == nil, onEdit: { editing = e })
                    }
                }
            }
        }
        .navigationTitle("Change journal")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .journal) } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("Add entry", systemImage: "plus") }
            }
            if !entries.isEmpty {
                ToolbarItem {
                    Menu {
                        Picker("Host", selection: $hostFilter) {
                            Text("All hosts").tag(String?.none)
                            ForEach(hosts, id: \.self) { Text($0).tag(String?.some($0)) }
                        }
                        Picker("Risk", selection: $riskFilter) {
                            Text("Any risk").tag(JournalRisk?.none)
                            ForEach(JournalRisk.allCases) { Text($0.label).tag(JournalRisk?.some($0)) }
                        }
                    } label: {
                        Label("Filter", systemImage: hostFilter == nil && riskFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    }
                }
            }
        }
        .overlay {
            if entries.isEmpty {
                ContentUnavailableView {
                    Label("No changes logged", systemImage: "list.bullet.clipboard")
                } description: {
                    Text("The assistant logs changes it helps you make. Tap Add entry to log one yourself.")
                } actions: {
                    Button("Add entry") { creating = true }.buttonStyle(.borderedProminent)
                }
            } else if shown.isEmpty {
                ContentUnavailableView {
                    Label("Nothing matches", systemImage: "line.3.horizontal.decrease.circle")
                } actions: {
                    Button("Show all") { hostFilter = nil; riskFilter = nil }
                }
            }
        }
        .sheet(item: $editing) { e in JournalEditor(entry: e) }
        .sheet(isPresented: $creating) { JournalEditor(entry: nil, fixedHost: hostFilter) }
        .refreshable { await engine.sync() }
    }

    private var filterSummary: String {
        var parts: [String] = []
        if let h = hostFilter { parts.append(h) }
        if let r = riskFilter { parts.append(r.label.lowercased()) }
        return "Showing \(parts.joined(separator: ", ")), \(shown.count) of \(entries.count)"
    }

    private func dayTitle(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(date: .abbreviated, time: .omitted)
    }
}

enum JournalOrder {
    static func newestFirst(_ a: Entity, _ b: Entity) -> Bool { a.str("at", a.created_at) > b.str("at", b.created_at) }
}

/// One journal entry: risk and outcome, what changed, the command with Copy, and the rollback.
struct JournalRow: View {
    @EnvironmentObject var engine: SyncEngine
    var entry: Entity
    var showHost = true
    var onEdit: () -> Void
    @State private var confirmDelete = false

    var body: some View {
        let risk = JournalRisk(rawValue: entry.str("risk")) ?? .low
        let outcome = JournalOutcome(rawValue: entry.str("outcome")) ?? .done
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                HomelabPill(text: risk.label, symbol: risk.symbol, color: risk.color)
                HomelabPill(text: outcome.label, symbol: outcome.symbol, color: outcome.color)
                if showHost { Text(entry.str("host")).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                Spacer(minLength: 0)
                Text(dateLabel(entry.string("at"))).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(StyleGuard.dashes(entry.str("what"))).font(.body.weight(.medium))
            if let cmd = entry.string("command"), !cmd.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    CommandBlock(text: cmd)
                    HomelabCopyButton(text: cmd).labelStyle(.iconOnly).controlSize(.small)
                }
            }
            if let rb = entry.string("rollback"), !rb.isEmpty {
                Text("\(Text("Rollback: ").foregroundStyle(.secondary))\(StyleGuard.dashes(rb))").font(.subheadline)
            }
            if entry.string("session_id") != nil {
                Text("Logged by the assistant").font(.caption).foregroundStyle(.secondary)
            }
            if outcome == .planned {
                HStack(spacing: 8) {
                    Button("Mark done") { Task { _ = await engine.update(entry.id, fields: ["outcome": "done"]) } }
                        .buttonStyle(.borderedProminent)
                    Button("Mark reverted") { Task { _ = await engine.update(entry.id, fields: ["outcome": "reverted"]) } }
                        .buttonStyle(.bordered)
                }
                .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", role: .destructive) { confirmDelete = true }
        }
        .contextMenu {
            Button("Edit") { onEdit() }
            if let cmd = entry.string("command"), !cmd.isEmpty { Button("Copy command") { Homelab.copy(cmd) } }
            Divider()
            Button("Delete", role: .destructive) { confirmDelete = true }
        }
        .confirmationDialog("Delete this entry?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await engine.softDelete(entry.id) } }
        } message: {
            Text(StyleGuard.dashes(entry.str("what")))
        }
    }
}

/// Add or edit a journal entry. `fixedHost` prefills the host (from a host page or a filter).
struct JournalEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var entry: Entity?
    var fixedHost: String? = nil

    @State private var host = ""
    @State private var what = ""
    @State private var command = ""
    @State private var risk: JournalRisk = .low
    @State private var outcome: JournalOutcome = .done
    @State private var rollback = ""
    @State private var at = Date()
    @State private var confirmDelete = false
    @State private var preflight: PreflightHit?
    /// The fields as loaded, to send only what was changed here.
    @State private var loaded: [String: JSONValue] = [:]

    private var valid: Bool { !Homelab.trimmed(host).isEmpty && !Homelab.trimmed(what).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    HostField(host: $host, hosts: Homelab.knownHosts(engine))
                    TextField("What was done", text: $what, prompt: Text("What was done, one line"))
                }
                SwiftUI.Section("Command or UI action") {
                    TextField("Optional", text: $command, axis: .vertical)
                        .font(.callout.monospaced())
                        .lineLimit(1...8)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                if let p = preflight {
                    SwiftUI.Section {
                        PreflightNote(hit: p)
                        if risk != .high || Homelab.trimmed(rollback).isEmpty {
                            Button(Homelab.trimmed(rollback).isEmpty ? "Mark high risk and use this rollback" : "Mark high risk") {
                                risk = .high
                                if Homelab.trimmed(rollback).isEmpty { rollback = p.rollbackText }
                            }
                        }
                    }
                }
                SwiftUI.Section {
                    Picker("Risk", selection: $risk) { ForEach(JournalRisk.allCases) { Text($0.rawValue.capitalized).tag($0) } }
                    Picker("Outcome", selection: $outcome) { ForEach(JournalOutcome.allCases) { Text($0.label).tag($0) } }
                    TextField("Rollback", text: $rollback, prompt: Text("How to undo it"), axis: .vertical).lineLimit(1...4)
                    DatePicker("When", selection: $at)
                } footer: {
                    Text("High risk means destructive or hard to undo.")
                }
                if entry != nil {
                    SwiftUI.Section {
                        Button("Delete entry", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(entry == nil ? "New entry" : "Edit entry")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!valid) }
            }
            .confirmationDialog("Delete this entry?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = entry { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
            .task(id: command) {
                // Ask the hub a moment after typing stops; offline or an older hub shows nothing.
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                let hit = await engine.client?.preflightQuietly(text: command)
                if !Task.isCancelled { withAnimation { preflight = hit } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }

    private func load() {
        guard let e = entry else { host = fixedHost ?? ""; return }
        host = e.str("host")
        what = e.str("what")
        command = e.str("command")
        risk = JournalRisk(rawValue: e.str("risk")) ?? .low
        outcome = JournalOutcome(rawValue: e.str("outcome")) ?? .done
        rollback = e.str("rollback")
        at = e.date("at") ?? at
        loaded = fields()
    }

    private func fields() -> [String: JSONValue] {
        var f: [String: JSONValue] = [
            "host": .string(Homelab.trimmed(host)),
            "what": .string(Homelab.trimmed(what)),
            "risk": .string(risk.rawValue),
            "outcome": .string(outcome.rawValue),
            "at": .string(ISO.string(at))
        ]
        let cmd = Homelab.trimmed(command), rb = Homelab.trimmed(rollback)
        f["command"] = cmd.isEmpty ? .null : .string(cmd)
        f["rollback"] = rb.isEmpty ? .null : .string(rb)
        return f
    }

    private func save() {
        let f = fields()
        if let e = entry {
            // Only what was changed here: every field used to go with a new time, undoing an edit made elsewhere
            // meanwhile (Mark done on another device).
            let changed = f.filter { loaded[$0.key] != $0.value }
            if !changed.isEmpty { Task { _ = await engine.update(e.id, fields: changed) } }
        } else {
            Task { _ = await engine.create(kind: .journal, fields: f.filter { !$0.value.isNull }) }
        }
        dismiss()
    }
}

/// The hub's pre-flight for a destructive command, in the assistant's words: what it is, what to back up, how to check the
/// target, and the rollback. Backticks in the rule text show as code.
struct PreflightNote: View {
    var hit: PreflightHit

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label {
                Text(LocalizedStringKey("Pre-flight for `" + StyleGuard.dashes(String(hit.command.prefix(120))) + "` (" + hit.name + ")")).font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            ForEach([hit.backup, hit.verify, hit.rollback], id: \.self) { line in
                Text(LocalizedStringKey(StyleGuard.dashes(line))).font(.callout)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
