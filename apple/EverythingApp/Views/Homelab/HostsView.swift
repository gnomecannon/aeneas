import SwiftUI
import EACore

/// Machines with their fix notes (kind `runbook`), change journal, snippets and monitors. Find a host, or type a new name to start one.
struct HostsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var hubHosts: [HostSummary] = []
    @State private var query = ""
    @State private var openHost: String?
    @State private var asking = false
    @State private var newName = ""

    /// Local counts win (they include edits not pushed yet); the hub adds hosts this device has not synced. Both are
    /// keyed by the lowercased name, as the hub keys them, so one machine is one row however its name was written.
    private var hosts: [HostSummary] {
        var byName: [String: HostSummary] = [:]
        for h in hubHosts { byName[Homelab.hostKey(h.host)] = h }
        for h in Homelab.localHosts(engine) { byName[Homelab.hostKey(h.host)] = h }
        return byName.values.sorted { $0.host.localizedCaseInsensitiveCompare($1.host) == .orderedAscending }
    }

    private var typed: String { Homelab.trimmed(query).lowercased() }
    private var shown: [HostSummary] { typed.isEmpty ? hosts : hosts.filter { $0.host.lowercased().contains(typed) } }

    var body: some View {
        List {
            if typed.isEmpty {
                SwiftUI.Section {
                    Text("Every computer you run. Each keeps fix notes (what broke on it and the exact steps that fixed it), a log of changes and command snippets. The assistant writes the fix notes when you finish a troubleshooting chat, so next time the answer is already here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !typed.isEmpty, !hosts.contains(where: { $0.host.lowercased() == typed }) {
                SwiftUI.Section {
                    Button { openHost = typed } label: { Label("Open \(typed)", systemImage: "plus.circle") }
                }
            }
            ForEach(shown) { h in
                NavigationLink { HostDetailView(host: h.host) } label: { HostRow(summary: h) }
            }
        }
        .searchable(text: $query, prompt: "Find or add a machine")
        .navigationTitle("Machines")
        .navigationDestination(item: $openHost) { HostDetailView(host: $0) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newName = ""; asking = true } label: { Label("Add machine", systemImage: "plus") }
            }
        }
        .alert("Open or add a machine", isPresented: $asking) {
            TextField("Machine name", text: $newName)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            Button("Open") {
                let h = Homelab.trimmed(newName).lowercased()
                if !h.isEmpty { openHost = h }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A machine appears in the list once it has fix notes, a logged change, a snippet or a monitor.")
        }
        .overlay {
            if hosts.isEmpty && typed.isEmpty {
                ContentUnavailableView {
                    Label("No machines yet", systemImage: "desktopcomputer")
                } description: {
                    Text("Tap + and type a machine name to start its fix notes, change log and snippets.")
                } actions: {
                    Button("Add machine") { newName = ""; asking = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .task(id: engine.lastSync) { await loadHub() }
        .refreshable { await engine.sync(); await loadHub() }
    }

    private func loadHub() async {
        guard let c = engine.client, let h = try? await c.hostSummaries() else { return }
        hubHosts = h
    }
}

struct HostRow: View {
    @EnvironmentObject var engine: SyncEngine
    var summary: HostSummary

    var body: some View {
        // A monitor that is switched off says nothing about the machine, so it is left out of the pill.
        let monitors = engine.list(.monitor).filter { Homelab.sameHost($0.str("host"), summary.host) }.map(MonitorStatus.init).filter { $0 != .off }
        let down = monitors.filter { $0 == .down }.count
        let up = monitors.filter { $0 == .up }.count
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.host).font(.body.monospaced().weight(.semibold))
                Text(details).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if down > 0 {
                HomelabPill(text: "\(down) down", symbol: MonitorStatus.down.symbol, color: .red)
            } else if !monitors.isEmpty, up == monitors.count {
                HomelabPill(text: up == 1 ? "Up" : "\(up) up", symbol: MonitorStatus.up.symbol, color: .green)
            } else if !monitors.isEmpty {
                HomelabPill(text: "\(monitors.count - up) unknown", symbol: MonitorStatus.unknown.symbol, color: .gray)
            }
        }
        .padding(.vertical, 2)
    }

    private var details: String {
        let s = summary
        var parts = [
            s.runbooks > 0 ? "fix notes" : "no fix notes",
            "\(s.journal_entries) change\(s.journal_entries == 1 ? "" : "s")",
            "\(s.snippets) snippet\(s.snippets == 1 ? "" : "s")"
        ]
        parts.append(s.last_change.map { "changed \(Homelab.ago($0))" } ?? "no changes logged")
        return parts.joined(separator: ", ")
    }
}

// MARK: Host page

struct HostDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    var host: String

    @State private var newRunbook = false
    @State private var addingEntry = false
    @State private var editingEntry: Entity?
    @State private var newSnippet = false
    @State private var newMonitor = false

    private let journalPreview = 10

    private var runbooks: [Entity] { engine.list(.runbook).filter { Homelab.sameHost($0.str("host"), host) }.sorted { $0.updated_at > $1.updated_at } }
    private var journal: [Entity] { engine.list(.journal).filter { Homelab.sameHost($0.str("host"), host) }.sorted(by: JournalOrder.newestFirst) }
    private var snippets: [Entity] {
        engine.list(.snippet).filter { Homelab.sameHost($0.str("host"), host) }
            .sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending }
    }
    private var monitors: [Entity] {
        engine.list(.monitor).filter { Homelab.sameHost($0.str("host"), host) }
            .sorted { (MonitorStatus($0).rank, $0.str("name")) < (MonitorStatus($1).rank, $1.str("name")) }
    }

    var body: some View {
        List {
            if !monitors.isEmpty {
                SwiftUI.Section("Monitors") {
                    ForEach(monitors) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: { MonitorRow(monitor: m, uptime: nil) }
                            .deleteSwipe(m.id)
                    }
                }
            }

            SwiftUI.Section {
                if runbooks.isEmpty {
                    Text("No fix notes for \(host) yet. They are what broke on this machine and how it was fixed. The assistant writes them when you finish a troubleshooting chat about \(host), or start them yourself.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Start fix notes") { newRunbook = true }
                } else {
                    ForEach(runbooks) { rb in
                        NavigationLink { RunbookDetailView(id: rb.id) } label: { RunbookRow(runbook: rb) }
                            .deleteSwipe(rb.id)
                    }
                }
            } header: {
                Text("Fix notes")
            }

            SwiftUI.Section {
                if journal.isEmpty {
                    Text("Nothing logged for \(host).").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(journal.prefix(journalPreview)) { e in
                    JournalRow(entry: e, showHost: false, onEdit: { editingEntry = e })
                        .deleteSwipe(e.id)
                }
                if journal.count > journalPreview {
                    NavigationLink("All \(journal.count) changes") { HostJournalView(host: host) }
                }
                Button("Log a change") { addingEntry = true }
            } header: {
                Text("Changes")
            }

            SwiftUI.Section {
                if snippets.isEmpty {
                    Text("No snippets for \(host).").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(snippets) { s in
                    NavigationLink { SnippetDetailView(id: s.id) } label: { SnippetRow(snippet: s, showHost: false) }
                        .deleteSwipe(s.id)
                }
                Button("New snippet") { newSnippet = true }
            } header: {
                Text("Snippets")
            }
        }
        .navigationTitle(host)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Change", systemImage: "list.bullet.clipboard") { addingEntry = true }
                    Button("Snippet", systemImage: "chevron.left.forwardslash.chevron.right") { newSnippet = true }
                    Button("Fix notes", systemImage: "book") { newRunbook = true }
                    Button("Monitor", systemImage: "waveform.path.ecg") { newMonitor = true }
                } label: {
                    Label("Add", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $newRunbook) { RunbookEditor(entry: nil, host: host) }
        .sheet(isPresented: $addingEntry) { JournalEditor(entry: nil, fixedHost: host) }
        .sheet(item: $editingEntry) { e in JournalEditor(entry: e) }
        .sheet(isPresented: $newSnippet) { SnippetEditor(entry: nil, host: host) }
        .sheet(isPresented: $newMonitor) { MonitorEditor(monitor: nil, host: host) }
        .refreshable { await engine.sync() }
    }
}

/// Every journal entry for one host.
struct HostJournalView: View {
    @EnvironmentObject var engine: SyncEngine
    var host: String
    @State private var editing: Entity?
    @State private var adding = false

    var body: some View {
        List {
            ForEach(engine.list(.journal).filter { Homelab.sameHost($0.str("host"), host) }.sorted(by: JournalOrder.newestFirst)) { e in
                JournalRow(entry: e, showHost: false, onEdit: { editing = e })
                    .deleteSwipe(e.id)
            }
        }
        .navigationTitle("\(host) changes")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add entry", systemImage: "plus") } } }
        .sheet(item: $editing) { e in JournalEditor(entry: e) }
        .sheet(isPresented: $adding) { JournalEditor(entry: nil, fixedHost: host) }
    }
}

// MARK: Runbooks

struct RunbookRow: View {
    var runbook: Entity

    var body: some View {
        let sections = RunbookText.sections(runbook.str("body")).filter { $0.title != nil }.count
        let commands = runbook.fields["commands"]?.arrayValue?.count ?? 0
        VStack(alignment: .leading, spacing: 3) {
            Text(StyleGuard.dashes(runbook.str("title"))).font(.body.weight(.medium))
            HStack(spacing: 8) {
                Text("\(sections) section\(sections == 1 ? "" : "s")")
                Text("\(commands) command\(commands == 1 ? "" : "s")")
                if let v = runbook.string("last_verified") { Text("verified \(Homelab.ago(v))") }
                else { Text("updated \(Homelab.ago(runbook.updated_at))") }
            }
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

struct RunbookDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var id: String
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var expanded: Set<Int> = []

    var body: some View {
        if let rb = engine.get(id), !rb.isDeleted {
            content(rb)
        } else {
            ContentUnavailableView("Fix notes deleted", systemImage: "trash", description: Text("Go back to the machine."))
        }
    }

    @ViewBuilder
    private func content(_ rb: Entity) -> some View {
        let f = rb.decoded(RunbookFields.self)
        let sections = RunbookText.sections(rb.str("body"))
        List {
            SwiftUI.Section {
                HStack(spacing: 6) {
                    HomelabPill(text: rb.str("host"), symbol: "server.rack")
                    if let v = f?.last_verified {
                        HomelabPill(text: "Verified \(Homelab.ago(v))", symbol: "checkmark.seal", color: .green)
                    } else {
                        HomelabPill(text: "Not verified", symbol: "seal", color: .secondary)
                    }
                }
                Text("Updated \(Homelab.ago(rb.updated_at))").font(.caption).foregroundStyle(.secondary)
            }

            if let cmds = f?.commands, !cmds.isEmpty {
                SwiftUI.Section("Commands") {
                    ForEach(Array(cmds.enumerated()), id: \.offset) { _, c in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(StyleGuard.dashes(c.label.isEmpty ? "Command" : c.label)).font(.subheadline.weight(.medium))
                                Spacer()
                                Text(c.host.isEmpty ? c.user : "\(c.user)@\(c.host)").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            HStack(alignment: .top, spacing: 8) {
                                CommandBlock(text: c.command)
                                HomelabCopyButton(text: c.command).labelStyle(.iconOnly).controlSize(.small)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            if sections.allSatisfy({ RunbookText.isBlank($0) }) {
                SwiftUI.Section {
                    Text("Empty. Tap Edit to write it.").foregroundStyle(.secondary)
                }
            }
            ForEach(sections) { s in
                if let title = s.title {
                    SwiftUI.Section {
                        DisclosureGroup(isExpanded: binding(s.id, default: s.id == sections.last?.id)) {
                            RunbookBlocksView(blocks: s.blocks)
                        } label: {
                            Text(StyleGuard.dashes(title)).font(.headline)
                        }
                    }
                } else if !RunbookText.isBlank(s) {
                    SwiftUI.Section { RunbookBlocksView(blocks: s.blocks) }
                }
            }
        }
        .navigationTitle(StyleGuard.dashes(rb.str("title")))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
            ToolbarItem {
                Menu {
                    Button("Mark verified now", systemImage: "checkmark.seal") {
                        Task { _ = await engine.update(rb.id, fields: ["last_verified": .string(ISO.now())]) }
                    }
                    Divider()
                    Button("Delete fix notes", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Delete these fix notes?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { await engine.softDelete(rb.id) }
                dismiss()
            }
        } message: {
            Text(StyleGuard.dashes(rb.str("title")))
        }
        .sheet(isPresented: $editing) { RunbookEditor(entry: rb, host: rb.str("host")) }
    }

    /// Sections start collapsed except the newest; `expanded` holds the ones the user flipped.
    private func binding(_ id: Int, default open: Bool) -> Binding<Bool> {
        Binding(get: { expanded.contains(id) != open }, set: { now in
            if now != open { expanded.insert(id) } else { expanded.remove(id) }
        })
    }
}

/// Renders a runbook section: sub-headings, paragraphs with inline markdown, and code blocks with Copy.
struct RunbookBlocksView: View {
    var blocks: [RunbookText.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let t):
                    Text(StyleGuard.dashes(t)).font(.subheadline.weight(.semibold)).padding(.top, 4)
                case .text(let t):
                    Text(RunbookText.inline(StyleGuard.dashes(t))).font(.callout).textSelection(.enabled)
                case .code(let t):
                    HStack(alignment: .top, spacing: 8) {
                        CommandBlock(text: t)
                        HomelabCopyButton(text: t).labelStyle(.iconOnly).controlSize(.small)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Splits runbook markdown into `##` sections and simple blocks. Dated sections look like `## 2026-10-28: what happened`.
enum RunbookText {
    enum Block: Equatable { case heading(String), text(String), code(String) }
    struct Section: Identifiable { var id: Int; var title: String?; var blocks: [Block] }

    static func isBlank(_ s: Section) -> Bool { s.title == nil && s.blocks.isEmpty }

    static func sections(_ body: String) -> [Section] {
        var out: [Section] = [Section(id: 0, title: nil, blocks: [])]
        var para: [String] = []
        var code: [String]? = nil

        func flushPara() {
            let t = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out[out.count - 1].blocks.append(.text(t)) }
            para = []
        }

        for raw in body.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let c = code {
                    out[out.count - 1].blocks.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    flushPara()
                    code = []
                }
                continue
            }
            if code != nil { code?.append(line); continue }
            if line.hasPrefix("## ") {
                flushPara()
                out.append(Section(id: out.count, title: String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces), blocks: []))
            } else if line.hasPrefix("#") {
                flushPara()
                let t = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                // The top `# host` line repeats the page title.
                if !(line.hasPrefix("# ") && out.count == 1 && out[0].blocks.isEmpty) && !t.isEmpty {
                    out[out.count - 1].blocks.append(.heading(t))
                }
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flushPara()
            } else {
                para.append(line)
            }
        }
        if let c = code { out[out.count - 1].blocks.append(.code(c.joined(separator: "\n"))) }
        flushPara()
        return out
    }

    /// Inline markdown (bold, code, links) with line breaks kept; list markers become bullets.
    static func inline(_ text: String) -> AttributedString {
        let lines = text.components(separatedBy: "\n").map { line -> String in
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("- ") || t.hasPrefix("* ") { return "• " + t.dropFirst(2) }
            return line
        }
        let joined = lines.joined(separator: "\n")
        return (try? AttributedString(markdown: joined, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(joined)
    }
}

struct RunbookEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var entry: Entity?
    var host: String

    private struct CommandDraft: Identifiable { let id = UUID(); var label = ""; var user = "root"; var host = ""; var command = "" }

    @State private var title = ""
    @State private var bodyText = ""
    @State private var commands: [CommandDraft] = []
    @State private var confirmDelete = false
    /// What the editor opened with, so Save writes only what was edited here and can tell when the notes changed
    /// elsewhere (the assistant appends a section when a troubleshooting chat closes) while the sheet was open.
    @State private var loadedTitle = ""
    @State private var loadedBody = ""
    @State private var loadedCommands: JSONValue = .array([])
    @State private var loadedRawCommands: JSONValue = .null
    @State private var conflict: String?

    var body: some View {
        NavigationStack {
            Form {
                if let conflict {
                    SwiftUI.Section { Text(conflict).font(.subheadline).foregroundStyle(.red) }
                }
                SwiftUI.Section {
                    TextField("Title", text: $title).font(.title3)
                }
                SwiftUI.Section {
                    TextEditor(text: $bodyText)
                        .font(.callout.monospaced())
                        .frame(minHeight: 240)
                    Button("Add a dated section") {
                        let day = Date().formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
                        if !bodyText.isEmpty && !bodyText.hasSuffix("\n") { bodyText += "\n" }
                        bodyText += "\n## \(day): "
                    }
                } header: {
                    Text("Body")
                } footer: {
                    Text("Markdown. Each change gets a section that starts with ## and the date.")
                }
                SwiftUI.Section("Commands") {
                    ForEach($commands) { $c in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                TextField("Label", text: $c.label)
                                Button(role: .destructive) { commands.removeAll { $0.id == c.id } } label: { Image(systemName: "minus.circle.fill") }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.red)
                                    .accessibilityLabel("Remove \(c.label.isEmpty ? "command" : c.label)")
                            }
                            HStack {
                                TextField("User", text: $c.user).font(.callout.monospaced())
                                Text("@").foregroundStyle(.secondary)
                                TextField("Host", text: $c.host).font(.callout.monospaced())
                            }
                            TextField("Command", text: $c.command, axis: .vertical).font(.callout.monospaced()).lineLimit(1...6)
                        }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    }
                    Button("Add command") { commands.append(CommandDraft(host: host)) }
                }
                if entry != nil {
                    SwiftUI.Section { Button("Delete fix notes", role: .destructive) { confirmDelete = true } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(entry == nil ? "New fix notes" : "Edit fix notes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(Homelab.trimmed(title).isEmpty) }
            }
            .confirmationDialog("Delete these fix notes?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = entry { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 640)
        #endif
    }

    private func load() {
        guard let e = entry else {
            title = "Fix notes: \(host)"
            bodyText = "# \(host)\n"
            return
        }
        let f = e.decoded(RunbookFields.self)
        title = e.str("title")
        bodyText = e.str("body")
        commands = (f?.commands ?? []).map { CommandDraft(label: $0.label, user: $0.user, host: $0.host, command: $0.command) }
        loadedTitle = title
        loadedBody = bodyText
        loadedCommands = commandsJSON()
        loadedRawCommands = e.fields["commands"] ?? .null
    }

    private func commandsJSON() -> JSONValue {
        .array(commands.compactMap { c in
            let cmd = Homelab.trimmed(c.command)
            guard !cmd.isEmpty else { return nil }
            return .object([
                "label": .string(Homelab.trimmed(c.label)),
                "user": .string(Homelab.trimmed(c.user)),
                "host": .string(Homelab.trimmed(c.host).isEmpty ? host : Homelab.trimmed(c.host)),
                "command": .string(cmd)
            ])
        })
    }

    /// Saving wrote every field from what the sheet opened with, so a section the assistant appended while it was open
    /// was erased. Now only edited fields are written. When the body was edited and the saved body changed since the
    /// sheet opened: text added at the end (a new dated section) is kept after the edit, and any other change refuses
    /// the save, as do commands edited here and elsewhere at once.
    private func save() {
        guard let e = entry else {
            let f: [String: JSONValue] = [
                "host": .string(host),
                "title": .string(Homelab.trimmed(title)),
                "body": .string(bodyText),
                "commands": commandsJSON()
            ]
            Task { _ = await engine.create(kind: .runbook, fields: f) }
            dismiss()
            return
        }
        let live = engine.get(e.id) ?? e
        var f: [String: JSONValue] = [:]
        if Homelab.trimmed(title) != Homelab.trimmed(loadedTitle) { f["title"] = .string(Homelab.trimmed(title)) }
        if bodyText != loadedBody {
            let now = live.str("body")
            if now == loadedBody {
                f["body"] = .string(bodyText)
            } else if now.hasPrefix(loadedBody) {
                let added = String(now.dropFirst(loadedBody.count))
                var merged = bodyText
                if !merged.isEmpty && !merged.hasSuffix("\n") && !added.hasPrefix("\n") { merged += "\n" }
                merged += added
                f["body"] = .string(merged)
            } else {
                conflict = "These fix notes were changed somewhere else while you had them open. Copy your edit, then Cancel and open them again."
                return
            }
        }
        let cmds = commandsJSON()
        if cmds != loadedCommands {
            if (live.fields["commands"] ?? .null) != loadedRawCommands {
                conflict = "The commands were changed somewhere else while you had them open. Cancel and open the fix notes again."
                return
            }
            f["commands"] = cmds
        }
        if !f.isEmpty { Task { _ = await engine.update(e.id, fields: f) } }
        dismiss()
    }
}
