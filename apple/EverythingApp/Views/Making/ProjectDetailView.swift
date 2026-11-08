import SwiftUI
import EACore

/// One project: where I left off, the definition of done, tasks, the living plan, parts against the inventory,
/// and the procedures, music and notes linked to it.
struct ProjectDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var projectId: String

    @State private var summary: ProjectSummary?
    @State private var hubNote: String?
    @State private var dodDraft: String?
    @State private var quick = ""
    @State private var editing = false
    @State private var planOpen = false
    @State private var newProcedure = false
    @State private var openedProcedure: ProcedureRoute?
    @State private var editingTask: Entity?
    @State private var partsMessage: String?
    @State private var busy = false
    @FocusState private var dodFocused: Bool

    private static let week: TimeInterval = 7 * 86400

    var body: some View {
        Group {
            if let p = engine.get(projectId), !p.isDeleted {
                content(p)
            } else {
                ContentUnavailableView("Project not found", systemImage: "hammer", description: Text("It may have been deleted on another device."))
            }
        }
        .navigationTitle(StyleGuard.dashes(engine.get(projectId)?.str("name") ?? "Project"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true }.disabled(engine.get(projectId) == nil) }
        }
        .sheet(isPresented: $editing) {
            ProjectEditSheet(project: engine.get(projectId), onDeleted: { dismiss() })
        }
        .sheet(isPresented: $planOpen) {
            PlanUpdateSheet(projectId: projectId) { await loadSummary() }
        }
        .sheet(isPresented: $newProcedure) {
            NewProcedureSheet(projectId: projectId) { id in openedProcedure = ProcedureRoute(id: id) }
        }
        .sheet(item: $editingTask) { t in TaskEditView(task: t) }
        .navigationDestination(item: $openedProcedure) { r in ProcedureRunnerView(procedureId: r.id) }
        .task { await loadSummary() }
        .refreshable { await engine.sync(); await loadSummary() }
    }

    // MARK: content

    private func content(_ p: Entity) -> some View {
        let f = Making.project(p)
        let name = f.name ?? ""
        // The hub's folder for the project: characters a vault path cannot carry become spaces (projects.ts
        // projectFolder), so "Fan: v2" lives in "Projects/Fan v2".
        let cleaned = name.replacingOccurrences(of: "[\\\\/:*?\"<>|]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let folder = "Projects/" + (cleaned.isEmpty ? "project" : cleaned)
        let tasks = engine.tasks.filter { $0.str("project_id") == projectId }
        let notes = engine.notes.filter { $0.str("path").hasPrefix("\(folder)/") }
        let plan = notes.first { $0.str("path") == "\(folder)/Plan.md" } ?? summary?.plan_note.flatMap { engine.get($0.id) ?? $0 }
        let rows = Making.partRows(f.parts ?? [], inventory: engine.list(.inventory))
        let procedures = engine.list(.procedure).filter { $0.str("project_id") == projectId }.sorted { $0.updated_at > $1.updated_at }
        let music = engine.list(.music_idea).filter { $0.str("project_id") == projectId }.sorted { $0.updated_at > $1.updated_at }

        return List {
            SwiftUI.Section {
                Picker("Status", selection: Binding(get: { f.status ?? "active" }, set: { s in Task { _ = await engine.update(projectId, fields: ["status": .string(s)]) } })) {
                    Text("Active").tag("active")
                    Text("Parked").tag("parked")
                    Text("Done").tag("done")
                }
                .pickerStyle(.segmented)
                if let repo = f.repo, !repo.isEmpty {
                    LabeledContent("Repo") { Text(repo).font(.callout.monospaced()).textSelection(.enabled) }
                }
            }

            resumeSection(f)
            if let a = p.fields["activity"]?.objectValue { activitySection(a, at: p.string("activity_at")) }
            dodSection(f)
            tasksSection(tasks)
            planSection(plan, name: name)
            partsSection(rows, tasks: tasks)
            proceduresSection(procedures)

            if !music.isEmpty {
                SwiftUI.Section("Music") {
                    ForEach(music) { m in MusicLink(idea: m) }
                }
            }

            let others = notes.filter { $0.id != plan?.id }
            if !others.isEmpty {
                SwiftUI.Section {
                    ForEach(others) { n in
                        NavigationLink { NoteEditorView(noteId: n.id) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(StyleGuard.dashes(n.str("title")))
                                Text(ISO.date(n.updated_at)?.shortDateTime ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Notes")
                } footer: {
                    Text("Projects/\(name)/")
                }
            }
        }
    }

    private func resumeSection(_ f: Making.ProjectData) -> some View {
        SwiftUI.Section {
            if let card = f.resume_card, !card.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MakingMarkdown(text: card)
            } else {
                Text("No resume card yet. Close an assistant chat with this project picked and one is written here.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Where I left off")
        } footer: {
            if let r = Making.relative(engine.get(projectId)?.field_ts["resume_card"]) { Text("Updated \(r)") }
            else if let r = Making.relative(summary?.last_session_close) { Text("Session closed \(r)") }
            else if let n = hubNote { Text(n) }
            else if summary != nil { Text("No session closed yet") }
        }
    }

    /// What Codex and the repo last did on this project, from the project feed.
    private func activitySection(_ a: [String: JSONValue], at: String?) -> some View {
        let threads = a["threads"]?.arrayValue?.compactMap { $0.objectValue } ?? []
        let repo = a["repo"]?.objectValue ?? [:]
        return SwiftUI.Section {
            ForEach(Array(threads.enumerated()), id: \.offset) { _, t in
                DisclosureGroup {
                    if let m = t["last_message"]?.stringValue, !m.isEmpty { MakingMarkdown(text: m) }
                } label: {
                    HStack {
                        Text(t["title"]?.stringValue ?? "Thread")
                        Spacer()
                        Text(Making.relative(t["updated_at"]?.stringValue) ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let last = repo["last_commit_at"]?.stringValue, let d = ISO.date(last) {
                let pending = repo["uncommitted"]?.doubleValue.map { Int($0) } ?? 0
                Text(pending > 0 ? "\(pending) files changed since the last commit on \(d.formatted(date: .abbreviated, time: .omitted))" : "Last commit \(d.formatted(date: .abbreviated, time: .omitted))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Activity")
        } footer: {
            if let r = Making.relative(at) { Text("Latest \(r)\(a["source"]?.stringValue.map { ", from \($0)" } ?? "")") }
        }
    }

    private func dodSection(_ f: Making.ProjectData) -> some View {
        let current = f.definition_of_done ?? ""
        let changed = dodDraft != nil && dodDraft != current
        return SwiftUI.Section {
            TextField("The project is done when...", text: Binding(get: { dodDraft ?? current }, set: { dodDraft = $0 }), axis: .vertical)
                .lineLimit(1...5)
                .focused($dodFocused)
                .onSubmit { saveDod(current) }
            if changed {
                Button("Save") { saveDod(current) }.buttonStyle(.borderedProminent)
            }
        } header: {
            Text("Definition of done")
        }
        .onChange(of: dodFocused) { _, focused in if !focused { saveDod(current) } }
    }

    private func saveDod(_ current: String) {
        guard let d = dodDraft?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        dodDraft = nil
        guard d != current else { return }
        Task { _ = await engine.update(projectId, fields: ["definition_of_done": .string(d)]) }
    }

    private func tasksSection(_ tasks: [Entity]) -> some View {
        let doing = tasks.filter { $0.str("status") == "doing" }
        let next = tasks.filter { $0.str("status") == "next" }.sorted { ($0.number("order") ?? 0) < ($1.number("order") ?? 0) }
        let cutoff = Date().addingTimeInterval(-Self.week)
        let done = tasks.filter { $0.str("status") == "done" && (ISO.date($0.string("done_at") ?? $0.updated_at) ?? .distantPast) > cutoff }
            .sorted { ($0.string("done_at") ?? $0.updated_at) > ($1.string("done_at") ?? $1.updated_at) }
        let other = tasks.filter { ["inbox", "scheduled", "parked"].contains($0.str("status")) }
        return SwiftUI.Section {
            HStack {
                TextField("Add a next task", text: $quick)
                    .onSubmit { addTask() }
                    .submitLabel(.done)
                Button("Add") { addTask() }
                    .buttonStyle(.bordered)
                    .disabled(quick.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            ForEach(doing) { t in taskRow(t, label: "Doing", color: .blue) }
            ForEach(next) { t in taskRow(t, label: "Next", color: .green) }
            ForEach(other) { t in taskRow(t, label: t.str("status").capitalized, color: .secondary) }
            ForEach(done) { t in taskRow(t, label: "Done", color: .secondary) }
            if tasks.isEmpty { Text("No tasks yet. Add the next physical step above.").foregroundStyle(.secondary) }
        } header: {
            Text("Tasks")
        } footer: {
            if !done.isEmpty { Text("Done tasks show for 7 days.") }
        }
    }

    private func taskRow(_ t: Entity, label: String, color: Color) -> some View {
        let isDone = t.str("status") == "done"
        return HStack(spacing: 10) {
            Button {
                Task { await engine.markDone(t.id) }
            } label: {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(isDone ? Color.green : Color.secondary)
            }
            .buttonStyle(.borderless)
            .disabled(isDone)
            .accessibilityLabel(isDone ? "Done" : "Mark done")
            Text(StyleGuard.dashes(t.str("title")))
                .foregroundStyle(isDone ? .secondary : .primary)
                .strikethrough(isDone)
            Spacer(minLength: 6)
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(color)
        }
        .contentShape(Rectangle())
        .onTapGesture { editingTask = t }
    }

    private func addTask() {
        let t = quick.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        quick = ""
        let order = (engine.tasks.map { $0.number("order") ?? 0 }.max() ?? 0) + 1
        Task {
            _ = await engine.create(kind: .task, fields: ["title": .string(t), "status": "next", "order": .number(order), "project_id": .string(projectId)])
        }
    }

    private func planSection(_ plan: Entity?, name: String) -> some View {
        SwiftUI.Section {
            if let n = plan {
                let body = n.str("body")
                if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("The plan note is empty.").foregroundStyle(.secondary)
                } else {
                    MakingMarkdown(text: body)
                }
                if engine.get(n.id) != nil {
                    NavigationLink { NoteEditorView(noteId: n.id) } label: { Label("Open the plan note", systemImage: "doc.text") }
                }
            } else {
                Text("No plan yet. Update plan writes Projects/\(name)/Plan.md with Goal, Definition of done, Current state, Next, Parts and Log.")
                    .foregroundStyle(.secondary)
            }
            Button { planOpen = true } label: { Label("Update plan", systemImage: "square.and.pencil") }
        } header: {
            Text("Plan")
        }
    }

    private func partsSection(_ rows: [ProjectPartRow], tasks: [Entity]) -> some View {
        let missingTitles = Making.missingPartTasks(rows)
        let open = Set(tasks.filter { $0.str("status") != "done" }.map { $0.str("title").lowercased() })
        let toAdd = missingTitles.filter { !open.contains($0.lowercased()) }
        let short = rows.filter { $0.missing > 0 }.count
        return SwiftUI.Section {
            if rows.isEmpty {
                Text("No parts listed. Tap Edit parts and add one per line.").foregroundStyle(.secondary)
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(StyleGuard.dashes(r.name))
                        Text("Need \(Making.num(r.qty)), have \(Making.num(r.have))").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    if r.missing > 0 {
                        MakingBadge(text: "\(Making.num(r.missing)) missing", symbol: "exclamationmark.circle.fill", color: .orange)
                    } else {
                        MakingBadge(text: "On hand", symbol: "checkmark.circle.fill", color: .green)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if !toAdd.isEmpty {
                Button { Task { await addMissing(toAdd) } } label: {
                    Label("Add \(Making.plural(toAdd.count, "missing part")) to tasks", systemImage: "cart.badge.plus")
                }
                .disabled(busy)
            }
            if let m = partsMessage { Label(m, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout) }
            Button { editing = true } label: { Label("Edit parts", systemImage: "pencil") }
            NavigationLink { InventoryView() } label: { Label("Inventory", systemImage: "shippingbox") }
        } header: {
            Text("Parts")
        } footer: {
            if !rows.isEmpty { Text("\(rows.count - short) on hand, \(short) missing") }
        }
    }

    private func addMissing(_ titles: [String]) async {
        busy = true
        defer { busy = false }
        let base = (engine.tasks.map { $0.number("order") ?? 0 }.max() ?? 0) + 1
        for (i, t) in titles.enumerated() {
            _ = await engine.create(kind: .task, fields: ["title": .string(t), "status": "inbox", "order": .number(base + Double(i)), "project_id": .string(projectId)])
        }
        partsMessage = "\(Making.plural(titles.count, "task")) added to the inbox."
    }

    private func proceduresSection(_ procedures: [Entity]) -> some View {
        SwiftUI.Section {
            ForEach(procedures) { e in
                NavigationLink { ProcedureRunnerView(procedureId: e.id) } label: { ProcedureRow(procedure: e) }
            }
            Button { newProcedure = true } label: { Label("New procedure for this project", systemImage: "plus") }
        } header: {
            Text("Procedures")
        }
    }

    // MARK: hub

    /// The plan note and the last session close come from the hub; the rest of the page is local and live.
    private func loadSummary() async {
        guard let c = engine.client else {
            hubNote = "The plan history needs the hub."
            return
        }
        do {
            let s = try await c.projectSummary(projectId)
            if let n = s.plan_note { await engine.absorb(n) }
            summary = s
            hubNote = nil
        } catch {
            hubNote = Making.unreachable(error) ? "Hub out of reach, showing what is on this device." : Making.message(error)
        }
    }
}

/// Goal, current state, next and a log line for `POST /projects/:id/plan`. Empty fields keep what the note has.
struct PlanUpdateSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var projectId: String
    var onSaved: () async -> Void

    @State private var goal = ""
    @State private var current = ""
    @State private var next = ""
    @State private var log = ""
    @State private var busy = false
    @State private var error: String?

    private var any: Bool { ![goal, current, next, log].allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Goal", text: $goal, axis: .vertical).lineLimit(1...3)
                    TextField("Current state", text: $current, axis: .vertical).lineLimit(2...6)
                    TextField("Next", text: $next, axis: .vertical).lineLimit(2...6)
                } footer: {
                    Text("Empty fields keep what the plan already says.")
                }
                SwiftUI.Section {
                    TextField("What happened today", text: $log, axis: .vertical).lineLimit(1...3)
                } header: {
                    Text("Log line")
                } footer: {
                    Text("Dated and added to the end of the log.")
                }
                if engine.client == nil { MakingErrorLine(text: "Updating the plan needs the hub.") }
                if let e = error { MakingErrorLine(text: e) }
            }
            .formStyle(.grouped)
            .navigationTitle("Update plan")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save plan") { Task { await save() } }.disabled(busy || !any || engine.client == nil)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 440)
        #endif
    }

    private func save() async {
        guard let c = engine.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        func v(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        do {
            let note = try await c.projectPlan(projectId, goal: v(goal), current: v(current), next: v(next), logLine: v(log))
            await engine.absorb(note)
            await onSaved()
            dismiss()
        } catch {
            self.error = Making.unreachable(error) ? "The hub is out of reach. Try again when it answers." : Making.message(error)
        }
    }
}
