import SwiftUI
import EACore

struct ProjectRoute: Hashable, Identifiable { var id: String }

/// Projects grouped Active, Parked, Done. Each row says when it is done, what is next and what parts are missing.
struct ProjectsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var creating = false
    @State private var opened: ProjectRoute?
    @State private var lastClose: [String: String] = [:]
    @State private var deleting: Entity?

    private static let statuses = ["active", "parked", "done"]

    private var projects: [Entity] { engine.list(.project) }

    private func items(_ status: String) -> [Entity] {
        projects.filter { ($0.str("status").isEmpty ? "active" : $0.str("status")) == status }.sorted { $0.updated_at > $1.updated_at }
    }

    var body: some View {
        List {
            ForEach(Self.statuses, id: \.self) { s in
                let list = items(s)
                if !list.isEmpty {
                    SwiftUI.Section {
                        ForEach(list) { p in
                            NavigationLink { ProjectDetailView(projectId: p.id) } label: {
                                ProjectRow(project: p, lastClose: lastClose[p.id])
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) { statusButtons(p) }
                            .contextMenu {
                                statusButtons(p)
                                Divider()
                                Button("Delete", role: .destructive) { deleting = p }
                            }
                        }
                    } header: {
                        Text("\(MakingBadge.project(s).text) \(list.count)")
                    }
                }
            }
            if !projects.isEmpty {
                SwiftUI.Section {
                    NavigationLink { InventoryView() } label: {
                        LabeledContent {
                            Text(Making.plural(engine.list(.inventory).count, "item"))
                        } label: {
                            Label("Inventory", systemImage: "shippingbox")
                        }
                    }
                } footer: {
                    Text("Parts lists on projects are checked against the names here.")
                }
            }
        }
        .overlay {
            if projects.isEmpty {
                ContentUnavailableView {
                    Label("No projects yet", systemImage: "hammer")
                } description: {
                    Text("Tap New project, give it a name and one sentence for when it is done.")
                } actions: {
                    Button("New project") { creating = true }.buttonStyle(.borderedProminent)
                    NavigationLink("Open inventory") { InventoryView() }
                }
            }
        }
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New project", systemImage: "plus") } }
        }
        .sheet(isPresented: $creating) {
            ProjectEditSheet(project: nil) { id in opened = ProjectRoute(id: id) }
        }
        .navigationDestination(item: $opened) { r in ProjectDetailView(projectId: r.id) }
        .confirmationDialog("Delete \(deleting?.str("name") ?? "this project")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let p = deleting { Task { await engine.softDelete(p.id) } }
                deleting = nil
            }
        } message: { Text("Its tasks, notes and procedures stay.") }
        .refreshable { await engine.sync(); await loadSummaries() }
        .task(id: projects.map(\.id).sorted().joined(separator: ",")) { await loadSummaries() }
    }

    @ViewBuilder
    private func statusButtons(_ p: Entity) -> some View {
        let s = p.str("status", "active")
        if s != "active" { Button { setStatus(p, "active") } label: { Label("Make active", systemImage: "play") }.tint(.green) }
        if s != "parked" { Button { setStatus(p, "parked") } label: { Label("Park", systemImage: "pause") }.tint(.orange) }
        if s != "done" { Button { setStatus(p, "done") } label: { Label("Mark done", systemImage: "checkmark") }.tint(.gray) }
    }

    private func setStatus(_ p: Entity, _ s: String) {
        Task { _ = await engine.update(p.id, fields: ["status": .string(s)]) }
    }

    /// The last session close lives only on the hub; everything else on a row is local.
    private func loadSummaries() async {
        guard let c = engine.client else { return }
        for p in projects where lastClose[p.id] == nil {
            if Task.isCancelled { return }
            if let s = try? await c.projectSummary(p.id), let close = s.last_session_close { lastClose[p.id] = close }
        }
    }
}

struct ProjectRow: View {
    @EnvironmentObject var engine: SyncEngine
    var project: Entity
    var lastClose: String?

    var body: some View {
        let f = Making.project(project)
        let rows = Making.partRows(f.parts ?? [], inventory: engine.list(.inventory))
        let missing = rows.filter { $0.missing > 0 }.count
        let next = engine.tasks.filter { $0.str("project_id") == project.id && ["next", "doing"].contains($0.str("status")) }.count
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(StyleGuard.dashes(f.name ?? "Untitled")).font(.headline)
                Spacer(minLength: 6)
                if f.area == "music" { Image(systemName: "music.note").foregroundStyle(.secondary).accessibilityLabel("Music project") }
                MakingBadge.project(f.status ?? "active")
            }
            if let dod = f.definition_of_done, !dod.isEmpty {
                Text("Done when: \(StyleGuard.dashes(dod))").font(.subheadline).lineLimit(2)
            } else {
                Text("No definition of done yet").font(.subheadline).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                if next > 0 { Label("\(next) next", systemImage: "list.bullet") }
                if !rows.isEmpty {
                    if missing > 0 {
                        Label("\(missing) of \(rows.count) parts missing", systemImage: "exclamationmark.circle").foregroundStyle(.orange)
                    } else {
                        Label("All \(rows.count) parts on hand", systemImage: "checkmark.circle").foregroundStyle(.green)
                    }
                }
                // A feed (Codex, the repo) usually knows about more recent work than the last assistant chat.
                if let at = project.string("activity_at"), at > (lastClose ?? ""), let r = Making.relative(at) { Text("Worked on \(r)") }
                else if let r = Making.relative(lastClose) { Text("Last session \(r)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Create or edit: name, status, definition of done, repo and parts, one per line ("2 x 10k resistor").
struct ProjectEditSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var project: Entity?
    var onCreated: (String) -> Void = { _ in }
    var onDeleted: () -> Void = {}

    @State private var name = ""
    @State private var status = "active"
    @State private var dod = ""
    @State private var repo = ""
    @State private var parts = ""
    @State private var music = false
    @State private var confirmDelete = false
    /// The fields as the sheet opened with them, so Save writes only what was changed here.
    @State private var loaded: [String: String] = [:]
    @State private var loadedMusic = false
    /// Set while saving: two quick taps on Create made two projects.
    @State private var saving = false

    private var parsed: [Making.Part] { Making.parsePartsText(parts) }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Name", text: $name).font(.title3)
                    Picker("Status", selection: $status) {
                        Text("Active").tag("active")
                        Text("Parked").tag("parked")
                        Text("Done").tag("done")
                    }
                    .pickerStyle(.segmented)
                    Toggle("Music project (shows in Music)", isOn: $music)
                }
                SwiftUI.Section {
                    TextField("The project is done when...", text: $dod, axis: .vertical).lineLimit(2...5)
                } header: {
                    Text("Definition of done")
                } footer: {
                    Text("One sentence you can check.")
                }
                SwiftUI.Section("Repo") {
                    TextField("optional", text: $repo)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                SwiftUI.Section {
                    TextEditor(text: $parts)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        .frame(minHeight: 110)
                } header: {
                    Text("Parts")
                } footer: {
                    if parsed.isEmpty {
                        Text("One per line, like 2 x 10k resistor. Checked against the inventory.")
                    } else {
                        Text("\(Making.plural(parsed.count, "part")): \(parsed.map { "\(Making.num($0.qty ?? 1)) x \($0.name)" }.joined(separator: ", "))")
                    }
                }
                if project != nil {
                    SwiftUI.Section {
                        Button("Delete project", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(project == nil ? "New project" : "Edit project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(project == nil ? "Create" : "Save") { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .confirmationDialog("Delete this project?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let p = project { Task { await engine.softDelete(p.id) } }
                    dismiss()
                    onDeleted()
                }
            } message: { Text("Its tasks, notes and procedures stay.") }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 560)
        #endif
    }

    private func load() {
        guard let p = project else { return }
        let f = Making.project(p)
        name = f.name ?? ""
        status = f.status ?? "active"
        dod = f.definition_of_done ?? ""
        repo = f.repo ?? ""
        parts = Making.partsToText(f.parts ?? [])
        music = f.area == "music"
        loaded = ["name": name, "status": status, "definition_of_done": dod, "repo": repo, "parts": parts]
        loadedMusic = music
    }

    /// Writes only the fields changed in the sheet. Every field was written from what the sheet opened with, so an
    /// inline edit made on the project page just before (its status, say) was undone by saving something else.
    private func save() async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        // Keep the hub's have and inventory_id on rows whose name did not change.
        let existing = project.map { Making.parts(of: $0) } ?? []
        let merged: [Making.Part] = parsed.map { p in
            guard var prev = existing.first(where: { $0.name.lowercased() == p.name.lowercased() }) else { return p }
            prev.qty = p.qty
            return prev
        }
        let r = repo.trimmingCharacters(in: .whitespaces)
        var f: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "status": .string(status),
            "definition_of_done": .string(dod.trimmingCharacters(in: .whitespacesAndNewlines)),
            "parts": (try? JSONCoding.value(merged)) ?? .array([])
        ]
        if let p = project {
            f["area"] = music ? .string("music") : .null
            f["repo"] = r.isEmpty ? .null : .string(r)
            let drafts = ["name": name, "status": status, "definition_of_done": dod, "repo": repo, "parts": parts]
            for (k, v) in drafts where loaded[k] == v { f.removeValue(forKey: k) }
            if music == loadedMusic { f.removeValue(forKey: "area") }
            if !f.isEmpty { _ = await engine.update(p.id, fields: f) }
            dismiss()
        } else {
            if !r.isEmpty { f["repo"] = .string(r) }
            if music { f["area"] = .string("music") }
            let e = await engine.create(kind: .project, fields: f)
            dismiss()
            if let e { onCreated(e.id) }
        }
    }
}
