import SwiftUI
import EACore

/// Reusable commands with `{{name}}` parameters. Fill the parameters, tap Copy command.
struct SnippetsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var query = ""
    @State private var hostFilter: String?
    @State private var tagFilter: String?
    @State private var creating = false

    private var snippets: [Entity] { engine.list(.snippet) }
    /// One per machine however its snippets spell it ("NAS" and "nas"), as Machines lists them.
    private var hosts: [String] { Homelab.hostKeys(snippets) }
    private var tags: [String] { Array(Set(snippets.flatMap { $0.stringArray("tags") })).sorted() }

    private var shown: [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return snippets.filter { e in
            if let h = hostFilter, !Homelab.sameHost(e.str("host"), h) { return false }
            if let t = tagFilter, !e.stringArray("tags").contains(t) { return false }
            guard !q.isEmpty else { return true }
            return [e.str("title"), e.str("body"), e.str("host")].contains { $0.lowercased().contains(q) }
                || e.stringArray("tags").contains { $0.lowercased().contains(q) }
        }
    }

    private var groups: [(os: String, items: [Entity])] {
        SnippetText.oses.compactMap { os in
            let items = shown.filter { $0.str("os", "any") == os }
                .sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending }
            return items.isEmpty ? nil : (os, items)
        }
    }

    var body: some View {
        List {
            if hostFilter != nil || tagFilter != nil {
                SwiftUI.Section {
                    HStack {
                        Text("Showing \([hostFilter, tagFilter.map { "#\($0)" }].compactMap { $0 }.joined(separator: ", "))").font(.subheadline)
                        Spacer()
                        Button("Show all") { hostFilter = nil; tagFilter = nil }.buttonStyle(.borderless)
                    }
                }
            }
            ForEach(groups, id: \.os) { g in
                SwiftUI.Section(header: Text("\(SnippetText.osLabel(g.os)) (\(g.items.count))").font(.headline)) {
                    ForEach(g.items) { e in
                        NavigationLink { SnippetDetailView(id: e.id) } label: { SnippetRow(snippet: e) }
                            .deleteSwipe(e.id)
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search title, body, host, tag")
        .navigationTitle("Snippets")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .snippet) } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("New snippet", systemImage: "plus") }
            }
            if !hosts.isEmpty || !tags.isEmpty {
                ToolbarItem {
                    Menu {
                        if !hosts.isEmpty {
                            Picker("Host", selection: $hostFilter) {
                                Text("All hosts").tag(String?.none)
                                ForEach(hosts, id: \.self) { Text($0).tag(String?.some($0)) }
                            }
                        }
                        if !tags.isEmpty {
                            Picker("Tag", selection: $tagFilter) {
                                Text("All tags").tag(String?.none)
                                ForEach(tags, id: \.self) { Text("#\($0)").tag(String?.some($0)) }
                            }
                        }
                    } label: {
                        Label("Filter", systemImage: hostFilter == nil && tagFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    }
                }
            }
        }
        .overlay {
            if snippets.isEmpty {
                ContentUnavailableView {
                    Label("No snippets", systemImage: "chevron.left.forwardslash.chevron.right")
                } description: {
                    Text("Save a command once with {{name}} where values change, then fill them in and copy it next time.")
                } actions: {
                    Button("New snippet") { creating = true }.buttonStyle(.borderedProminent)
                }
            } else if shown.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .sheet(isPresented: $creating) { SnippetEditor(entry: nil, host: hostFilter) }
        .refreshable { await engine.sync() }
    }
}

struct SnippetRow: View {
    var snippet: Entity
    var showHost = true

    var body: some View {
        let params = SnippetText.renderRows(snippet).count
        VStack(alignment: .leading, spacing: 3) {
            Text(StyleGuard.dashes(snippet.str("title"))).font(.body.weight(.medium))
            HStack(spacing: 8) {
                Text(snippet.str("language"))
                if showHost, let h = snippet.string("host"), !h.isEmpty { Text(h).monospaced() }
                if params > 0 { Text("\(params) param\(params == 1 ? "" : "s")") }
                if let used = snippet.string("last_used") { Text("Used \(Homelab.ago(used))") }
            }
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            let tags = snippet.stringArray("tags")
            if !tags.isEmpty { Text(tags.map { "#\($0)" }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(.vertical, 2)
    }
}

// MARK: Detail and render

struct SnippetDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String

    @State private var values: [String: String] = [:]
    /// The default each field was prefilled with, so a default changed by an edit replaces the old one unless typed over.
    @State private var prefilled: [String: String] = [:]
    @State private var result: String?
    @State private var ran: SnippetRun?
    @State private var copied = false
    @State private var error: String?
    @State private var busy = false
    @State private var editing = false

    var body: some View {
        if let e = engine.get(id), !e.isDeleted {
            content(e)
        } else {
            ContentUnavailableView("Snippet deleted", systemImage: "trash", description: Text("Go back to the list."))
        }
    }

    @ViewBuilder
    private func content(_ e: Entity) -> some View {
        let rows = SnippetText.renderRows(e)
        Form {
            SwiftUI.Section {
                FlowLayout(spacing: 6) {
                    HomelabPill(text: SnippetText.osLabel(e.str("os", "any")), symbol: "desktopcomputer")
                    HomelabPill(text: e.str("language"), symbol: "chevron.left.forwardslash.chevron.right")
                    if let h = e.string("host"), !h.isEmpty { HomelabPill(text: h, symbol: "server.rack") }
                    ForEach(e.stringArray("tags"), id: \.self) { HomelabPill(text: "#\($0)") }
                }
                if let used = e.string("last_used") {
                    Text("Last used \(Homelab.ago(used))").font(.caption).foregroundStyle(.secondary)
                }
            }
            SwiftUI.Section {
                Text(SnippetText.highlighted(e.str("body")))
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } header: {
                Text("Body")
            } footer: {
                if !rows.isEmpty { Text("Highlighted names are filled in from the values below.") }
            }
            if !rows.isEmpty {
                SwiftUI.Section("Values") {
                    ForEach(rows, id: \.name) { r in
                        LabeledContent {
                            TextField(r.name, text: binding(r.name), prompt: Text(r.description ?? (r.defaultValue.isEmpty ? "value" : r.defaultValue)))
                                .font(.callout.monospaced())
                                .autocorrectionDisabled()
                                #if os(iOS)
                                .textInputAutocapitalization(.never)
                                #endif
                                .onSubmit { Task { await render(e) } }
                        } label: {
                            Text(r.name).font(.callout.monospaced())
                        }
                    }
                }
            }
            SwiftUI.Section {
                Button {
                    Task { await render(e) }
                } label: {
                    HStack {
                        Spacer()
                        if busy { ProgressView().controlSize(.small) }
                        Label(copied ? "Copied" : "Copy command", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(.body.weight(.semibold))
                        Spacer()
                    }
                    .frame(minHeight: 36)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                // Shell snippets can be tried on their host: read-only ones run at once, others go through the assistant.
                if Self.runnable(e) {
                    Button { Task { await run(e) } } label: {
                        Label("Run on \(e.str("host"))", systemImage: "play.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy || engine.client == nil)
                }
                if let error { Text(error).font(.subheadline).foregroundStyle(.red) }
                if let ran {
                    Text("Ran on \(ran.host), exit \(ran.exit_code.map(String.init) ?? "none")").font(.caption).foregroundStyle(.secondary)
                    CommandBlock(text: ran.output.isEmpty ? "(no output)" : ran.output)
                }
                if let result {
                    CommandBlock(text: result)
                    HomelabCopyButton(text: result, title: "Copy again")
                }
            } footer: {
                Text(rows.isEmpty ? "No values to fill. Copies the body as it is." : "Fills in the values, shows the result and copies it.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle(StyleGuard.dashes(e.str("title")))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
        }
        .sheet(isPresented: $editing) { SnippetEditor(entry: e, host: nil) }
        .onAppear { fillDefaults(rows) }
        .onChange(of: e.updated_at) { _, _ in fillDefaults(SnippetText.renderRows(engine.get(id) ?? e)) }
    }

    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { values[name] ?? "" }, set: { values[name] = $0; copied = false })
    }

    /// Prefill defaults without overwriting what was typed. A field still holding the default it was prefilled with
    /// takes the new default after an edit; it used to keep the old one, so Copy filled in a value no longer saved.
    private func fillDefaults(_ rows: [SnippetText.Row]) {
        for r in rows where values[r.name] == nil || values[r.name] == prefilled[r.name] {
            values[r.name] = r.defaultValue
            prefilled[r.name] = r.defaultValue
        }
    }

    private func render(_ e: Entity) async {
        busy = true
        error = nil
        defer { busy = false }
        let rows = SnippetText.renderRows(e)
        var params: [String: String] = [:]
        for r in rows { let v = values[r.name] ?? ""; if !v.isEmpty { params[r.name] = v } }
        let missing = rows.filter { (params[$0.name] ?? $0.defaultValue).isEmpty }.map(\.name)
        if !missing.isEmpty {
            error = "Fill in \(missing.joined(separator: ", "))."
            return
        }
        if let c = engine.client {
            do {
                finish(try await c.renderSnippet(id: e.id, params: params))
                Task { await engine.sync() }
                return
            } catch let h as HubError {
                if case .http = h { error = Homelab.errorText(h); return }
                // Hub not reachable: render here instead.
            } catch {}
        }
        do { finish(try SnippetText.render(e.str("body"), rows: rows, values: params)) }
        catch let err { error = err.localizedDescription }
    }

    static func runnable(_ e: Entity) -> Bool {
        ["bash", "sh", "shell", "zsh", "powershell", "pwsh"].contains(e.str("language").lowercased()) && !e.str("host").isEmpty
    }

    private func run(_ e: Entity) async {
        guard let c = engine.client else { return }
        busy = true
        error = nil
        ran = nil
        defer { busy = false }
        var params: [String: String] = [:]
        for r in SnippetText.renderRows(e) { let v = values[r.name] ?? ""; if !v.isEmpty { params[r.name] = v } }
        do { ran = try await c.runSnippet(id: e.id, params: params); result = nil; Task { await engine.sync() } }
        catch let h as HubError { error = Homelab.errorText(h) }
        catch { self.error = error.localizedDescription }
    }

    private func finish(_ text: String) {
        result = text
        Homelab.copy(text)
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }
}

// MARK: Editor

struct SnippetEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var entry: Entity?
    var host: String?

    private struct ParamDraft: Identifiable { let id = UUID(); var name = ""; var defaultValue = ""; var description = "" }

    @State private var title = ""
    @State private var os = "linux"
    @State private var language = "bash"
    @State private var hostText = ""
    @State private var bodyText = ""
    @State private var params: [ParamDraft] = []
    @State private var tags = ""
    @State private var confirmDelete = false
    /// The fields as loaded, to send only what was changed here.
    @State private var loaded: [String: JSONValue] = [:]

    private var undeclared: [String] {
        SnippetText.paramNames(bodyText).filter { n in !params.contains { Homelab.trimmed($0.name) == n } }
    }
    private var valid: Bool { !Homelab.trimmed(title).isEmpty && !Homelab.trimmed(bodyText).isEmpty && !Homelab.trimmed(language).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Title", text: $title).font(.title3)
                    Picker("OS", selection: $os) { ForEach(SnippetText.oses, id: \.self) { Text(SnippetText.osLabel($0)).tag($0) } }
                    HStack {
                        TextField("Language", text: $language, prompt: Text("Language"))
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                        Menu {
                            ForEach(SnippetText.languages, id: \.self) { l in Button(l) { language = l } }
                        } label: { Image(systemName: "chevron.down.circle") }
                        .menuStyle(.button).buttonStyle(.borderless).fixedSize()
                        .accessibilityLabel("Pick a language")
                    }
                    HostField(host: $hostText, hosts: Homelab.knownHosts(engine), prompt: "Host, optional")
                }
                SwiftUI.Section {
                    TextEditor(text: $bodyText)
                        .font(.callout.monospaced())
                        .frame(minHeight: 160)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("Body")
                } footer: {
                    Text("Write {{name}} where a value changes each time.")
                }
                SwiftUI.Section("Parameters") {
                    ForEach($params) { $p in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                TextField("Name", text: $p.name).font(.callout.monospaced())
                                Button(role: .destructive) { params.removeAll { $0.id == p.id } } label: { Image(systemName: "minus.circle.fill") }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.red)
                                    .accessibilityLabel("Remove \(p.name.isEmpty ? "parameter" : p.name)")
                            }
                            TextField("Default", text: $p.defaultValue, prompt: Text("Default, optional")).font(.callout.monospaced())
                            TextField("Description", text: $p.description, prompt: Text("Description, optional"))
                        }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    }
                    if !undeclared.isEmpty {
                        Button("Add \(undeclared.joined(separator: ", ")) from the body") {
                            params.append(contentsOf: undeclared.map { ParamDraft(name: $0) })
                        }
                    }
                    Button("Add parameter") { params.append(ParamDraft()) }
                }
                SwiftUI.Section("Tags") {
                    TextField("Tags", text: $tags, prompt: Text("Comma separated"))
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                if entry != nil {
                    SwiftUI.Section { Button("Delete snippet", role: .destructive) { confirmDelete = true } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(entry == nil ? "New snippet" : "Edit snippet")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!valid) }
            }
            .confirmationDialog("Delete this snippet?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = entry { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 620)
        #endif
    }

    private func load() {
        guard let e = entry else { hostText = host ?? ""; return }
        title = e.str("title")
        os = e.str("os", "linux")
        language = e.str("language", "bash")
        hostText = e.str("host")
        bodyText = e.str("body")
        params = SnippetText.declared(e).map { ParamDraft(name: $0.name, defaultValue: $0.defaultValue, description: $0.description ?? "") }
        tags = e.stringArray("tags").joined(separator: ", ")
        loaded = fields()
    }

    private func save() {
        let f = fields()
        if let e = entry {
            // Only what was changed here: every field used to go with a new time, undoing an edit made elsewhere meanwhile.
            let changed = f.filter { loaded[$0.key] != $0.value }
            if !changed.isEmpty { Task { _ = await engine.update(e.id, fields: changed) } }
        } else {
            Task { _ = await engine.create(kind: .snippet, fields: f.filter { !$0.value.isNull }) }
        }
        dismiss()
    }

    private func fields() -> [String: JSONValue] {
        let ps: [JSONValue] = params.compactMap { p in
            let n = Homelab.trimmed(p.name)
            guard !n.isEmpty else { return nil }
            var o: [String: JSONValue] = ["name": .string(n)]
            if !p.defaultValue.isEmpty { o["default"] = .string(p.defaultValue) }
            let d = Homelab.trimmed(p.description)
            if !d.isEmpty { o["description"] = .string(d) }
            return .object(o)
        }
        let tagList = tags.split(separator: ",").map { Homelab.trimmed(String($0)).replacingOccurrences(of: "#", with: "") }.filter { !$0.isEmpty }
        var f: [String: JSONValue] = [
            "title": .string(Homelab.trimmed(title)),
            "os": .string(os),
            "language": .string(Homelab.trimmed(language)),
            "body": .string(bodyText),
            "params": .array(ps),
            "tags": .array(tagList.map { .string($0) })
        ]
        let h = Homelab.trimmed(hostText)
        f["host"] = h.isEmpty ? .null : .string(h)
        return f
    }
}

// MARK: Parameter text

/// `{{name}}` parsing, highlighting and the local stand-in for `POST /snippets/:id/render`.
enum SnippetText {
    static let oses = ["linux", "windows", "macos", "any"]
    static let languages = ["bash", "powershell", "python", "sql", "text"]

    static func osLabel(_ os: String) -> String {
        switch os {
        case "linux": return "Linux"
        case "windows": return "Windows"
        case "macos": return "macOS"
        default: return "Any OS"
        }
    }

    // The hub's rule (renderSnippet in hub/src/memory.ts): letters, digits, `_`, `.` and `-`, so `{{.Names}}` in a Docker
    // or Go template is a parameter too. This only took names starting with a letter, so the hub answered "missing
    // params" for `{{.Names}}` and the screen had no field to fill it.
    private static let regex = try! NSRegularExpression(pattern: #"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}"#)

    private static func matches(_ body: String) -> [NSTextCheckingResult] {
        regex.matches(in: body, range: NSRange(body.startIndex..., in: body))
    }

    /// Parameter names in order of first appearance, each once.
    static func paramNames(_ body: String) -> [String] {
        var out: [String] = []
        for m in matches(body) {
            if let r = Range(m.range(at: 1), in: body) {
                let n = String(body[r])
                if !out.contains(n) { out.append(n) }
            }
        }
        return out
    }

    struct Row { var name: String; var defaultValue: String; var description: String? }

    static func declared(_ e: Entity) -> [Row] {
        (e.fields["params"]?.arrayValue ?? []).compactMap { v in
            guard let o = v.objectValue, let n = o["name"]?.stringValue, !n.isEmpty else { return nil }
            return Row(name: n, defaultValue: o["default"]?.displayString ?? "", description: o["description"]?.stringValue)
        }
    }

    /// Every declared param plus any `{{name}}` in the body that is not declared.
    static func renderRows(_ e: Entity) -> [Row] {
        var rows = declared(e)
        for n in paramNames(e.str("body")) where !rows.contains(where: { $0.name == n }) { rows.append(Row(name: n, defaultValue: "")) }
        return rows
    }

    struct Missing: LocalizedError {
        var names: [String]
        var errorDescription: String? { "Fill in \(names.joined(separator: ", "))." }
    }

    static func render(_ body: String, rows: [Row], values: [String: String]) throws -> String {
        var out = ""
        var missing: [String] = []
        var last = body.startIndex
        for m in matches(body) {
            guard let whole = Range(m.range, in: body), let nameRange = Range(m.range(at: 1), in: body) else { continue }
            out += body[last..<whole.lowerBound]
            let name = String(body[nameRange])
            let v = values[name] ?? rows.first { $0.name == name }?.defaultValue ?? ""
            if v.isEmpty { missing.append(name); out += body[whole] } else { out += v }
            last = whole.upperBound
        }
        out += body[last...]
        if !missing.isEmpty { throw Missing(names: missing.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }) }
        return out
    }

    /// The body with each `{{name}}` in bold accent color.
    static func highlighted(_ body: String) -> AttributedString {
        var out = AttributedString()
        var last = body.startIndex
        for m in matches(body) {
            guard let whole = Range(m.range, in: body) else { continue }
            out += AttributedString(String(body[last..<whole.lowerBound]))
            var p = AttributedString(String(body[whole]))
            p.foregroundColor = Color.accentColor
            p.inlinePresentationIntent = .stronglyEmphasized
            out += p
            last = whole.upperBound
        }
        out += AttributedString(String(body[last...]))
        return out
    }
}
