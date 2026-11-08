import SwiftUI
import EACore

struct ProcedureRoute: Hashable, Identifiable { var id: String }

/// Procedures in progress first, finished ones below. Tap one to run it a step at a time.
struct ProceduresView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var creating = false
    @State private var opened: ProcedureRoute?
    @State private var showFinished = false

    private var all: [Entity] { engine.list(.procedure) }
    private var open: [Entity] { all.filter { !Making.progress(Making.procedure($0)).done }.sorted { $0.updated_at > $1.updated_at } }
    private var finished: [Entity] {
        all.filter { Making.progress(Making.procedure($0)).done }
            .sorted { (Making.procedure($0).done_at ?? $0.updated_at) > (Making.procedure($1).done_at ?? $1.updated_at) }
    }

    var body: some View {
        List {
            if !open.isEmpty {
                SwiftUI.Section("In progress") {
                    ForEach(open) { e in
                        NavigationLink { ProcedureRunnerView(procedureId: e.id) } label: { ProcedureRow(procedure: e) }
                            .deleteSwipe(e.id)
                    }
                }
            }
            if !finished.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: $showFinished) {
                        ForEach(finished) { e in
                            NavigationLink { ProcedureRunnerView(procedureId: e.id) } label: { ProcedureRow(procedure: e) }
                                .deleteSwipe(e.id)
                        }
                    } label: {
                        Text("Finished (\(finished.count))").font(.headline)
                    }
                }
            }
        }
        .overlay {
            if all.isEmpty {
                ContentUnavailableView {
                    Label("No procedures yet", systemImage: "list.number")
                } description: {
                    Text("Tap New procedure and paste steps from anywhere. Numbered lines become steps and code blocks become commands you can copy.")
                } actions: {
                    Button("New procedure") { creating = true }.buttonStyle(.borderedProminent)
                }
            } else if open.isEmpty && !showFinished {
                VStack {
                    Spacer()
                    Text("Nothing in progress. Tap + to paste a new one.").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding()
                }
                .allowsHitTesting(false)
            }
        }
        .navigationTitle("Procedures")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New procedure", systemImage: "plus") } }
        }
        .sheet(isPresented: $creating) {
            NewProcedureSheet(projectId: nil) { id in opened = ProcedureRoute(id: id) }
        }
        .navigationDestination(item: $opened) { r in ProcedureRunnerView(procedureId: r.id) }
        .refreshable { await engine.sync() }
    }
}

struct ProcedureRow: View {
    @EnvironmentObject var engine: SyncEngine
    var procedure: Entity

    var body: some View {
        let f = Making.procedure(procedure)
        let p = Making.progress(f)
        let step = (f.steps ?? []).indices.contains(p.current) ? f.steps![p.current] : nil
        VStack(alignment: .leading, spacing: 5) {
            Text(StyleGuard.dashes(f.title ?? "Procedure")).font(.headline)
            HStack(spacing: 8) {
                if p.done {
                    MakingBadge(text: "Finished", symbol: "checkmark.circle.fill", color: .green)
                    if let r = Making.relative(f.done_at) { Text(r).font(.caption).foregroundStyle(.secondary) }
                } else {
                    MakingBadge(text: "Step \(p.current + 1) of \(p.total)", symbol: "play.circle.fill", color: .blue)
                    ProgressView(value: Double(p.current), total: Double(max(1, p.total))).frame(maxWidth: 80)
                }
            }
            HStack(spacing: 8) {
                if !p.done, let h = step?.host, !h.isEmpty { Label(h, systemImage: "server.rack").font(.caption.monospaced()) }
                if let pid = f.project_id, let pr = engine.get(pid), !pr.isDeleted { Label(pr.str("name"), systemImage: "hammer").font(.caption) }
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Paste steps from anywhere. The hub splits them (with a model when it has one); offline the same rules run here.
struct NewProcedureSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var projectId: String?
    var onCreated: (String) -> Void = { _ in }

    @State private var text = ""
    @State private var title = ""
    @State private var host = ""
    @State private var project = ""
    @State private var busy = false
    @State private var error: String?
    /// Waiting for the hub's copy after the request timed out.
    @State private var waiting = false
    /// The hub did not answer in time and its copy has not come; the next Create saves on this device.
    @State private var saveHere = false
    @State private var closed = false

    private var preview: [Making.Step] {
        let h = host.trimmingCharacters(in: .whitespaces)
        return Making.stepsFromText(text, host: h.isEmpty ? nil : h)
    }
    private var projects: [Entity] {
        engine.list(.project).filter { $0.str("status") != "done" }.sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("1. Snapshot first\n```\nzfs snapshot tank/scratch@pre\n```\n2. Verify with `zfs list -r tank/scratch`")
                                .font(.callout.monospaced())
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8).padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $text)
                            .font(.callout.monospaced())
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .frame(minHeight: 180)
                            .scrollContentBackground(.hidden)
                    }
                } header: {
                    Text("Steps")
                } footer: {
                    Text("Paste numbered or bulleted lines. Code blocks and `inline code` become commands.")
                }
                SwiftUI.Section {
                    TextField("Title (first step if empty)", text: $title)
                    TextField("Host (optional)", text: $host)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Picker("Project", selection: $project) {
                        Text("None").tag("")
                        ForEach(projects) { p in Text(p.str("name")).tag(p.id) }
                    }
                }
                if !preview.isEmpty {
                    SwiftUI.Section {
                        ForEach(Array(preview.enumerated()), id: \.offset) { i, s in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(i + 1). \(s.text)")
                                if let c = s.command { Text(c).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3) }
                            }
                        }
                    } header: {
                        Text("\(Making.plural(preview.count, "step")), \(preview.filter { $0.command != nil }.count) with a command")
                    }
                }
                if waiting {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("The hub is still splitting the steps. Waiting for it to sync in.").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if let e = error { MakingErrorLine(text: e) }
            }
            .formStyle(.grouped)
            .navigationTitle("New procedure")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saveHere ? "Save here" : "Create") { Task { await create() } }.disabled(busy || preview.isEmpty)
                }
            }
            .onAppear { if let p = projectId { project = p } }
            .onDisappear { closed = true }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }

    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        error = nil
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = title.trimmingCharacters(in: .whitespaces)
        let h = host.trimmingCharacters(in: .whitespaces)
        if !saveHere, let c = engine.client {
            let wasOnline = engine.status == .online
            let before = Set(engine.list(.procedure).map(\.id))
            do {
                let e = try await c.procedureFromText(text: body, title: t.isEmpty ? nil : t, host: h.isEmpty ? nil : h, projectId: project.isEmpty ? nil : project)
                await engine.absorb(e)
                engine.moment(.create, kind: e.kind)
                finish(e.id)
                return
            } catch {
                if !Making.unreachable(error) { self.error = Making.message(error); return }
                // The request cuts off after 20 s, but a hub that was reachable goes on splitting the steps (a model
                // can take longer) and saves the procedure, so saving it here too made two. The hub's copy is looked
                // for as it syncs in; only when it does not come is saving on this device offered.
                if wasOnline {
                    waiting = true
                    if let id = await hubCopy(notIn: before) { waiting = false; finish(id); return }
                    waiting = false
                    if closed { return }
                    saveHere = true
                    self.error = "The hub did not answer in time and may still add this procedure. Look in Procedures first; tap Save here to keep it on this device anyway."
                    return
                }
            }
        }
        let steps = preview
        var fields: [String: JSONValue] = [
            "title": .string(t.isEmpty ? String((steps.first?.text ?? "Procedure").prefix(80)) : t),
            "steps": (try? JSONCoding.value(steps)) ?? .array([]),
            "current": 0
        ]
        if !project.isEmpty { fields["project_id"] = .string(project) }
        if let e = await engine.create(kind: .procedure, fields: fields) { finish(e.id) } else { error = "Could not save on this device." }
    }

    /// A procedure that synced in since the request was sent, checked every 5 s for up to 2 minutes (the hub gives a
    /// model call that long) or until the sheet is closed.
    private func hubCopy(notIn before: Set<String>) async -> String? {
        for _ in 0..<24 {
            if closed { return nil }
            await engine.sync()
            if let e = engine.list(.procedure).filter({ !before.contains($0.id) }).max(by: { $0.created_at < $1.created_at }) { return e.id }
            // A hub that cannot be reached now cannot send its copy either.
            if engine.status != .online { return nil }
            try? await Task.sleep(for: .seconds(5))
        }
        return nil
    }

    private func finish(_ id: String) {
        guard !closed else { return }
        dismiss()
        onCreated(id)
    }
}

/// Exactly one step on screen. Done advances, Back steps back without clearing, Start over clears every mark.
struct ProcedureRunnerView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var procedureId: String

    @State private var busy = false
    @State private var error: String?
    @State private var showSteps = false
    @State private var confirmReset = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let e = engine.get(procedureId), !e.isDeleted {
                runner(e)
            } else {
                ContentUnavailableView("Procedure not found", systemImage: "list.number", description: Text("It may have been deleted on another device."))
            }
        }
        .navigationTitle(StyleGuard.dashes(engine.get(procedureId)?.str("title") ?? "Procedure"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { confirmReset = true } label: { Label("Start over", systemImage: "arrow.counterclockwise") }
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .confirmationDialog("Start over from step 1?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Start over", role: .destructive) { Task { await act(.reset) } }
        } message: { Text("Every done mark is cleared.") }
        .confirmationDialog("Delete this procedure?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { await engine.softDelete(procedureId) }
                dismiss()
            }
        }
    }

    @ViewBuilder
    private func runner(_ e: Entity) -> some View {
        let f = Making.procedure(e)
        let steps = f.steps ?? []
        let p = Making.progress(f)
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(f, p)
                if p.done {
                    finishedCard(f, p)
                } else if steps.indices.contains(p.current) {
                    stepCard(steps[p.current], p)
                    if p.current + 1 < steps.count {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Up next").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(StyleGuard.dashes(steps[p.current + 1].text)).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                if let err = error { MakingErrorLine(text: err) }
                if !steps.isEmpty { allSteps(steps, p) }
            }
            .padding()
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func header(_ f: Making.ProcedureData, _ p: Making.Progress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let pid = f.project_id, let pr = engine.get(pid), !pr.isDeleted {
                    Label(pr.str("name"), systemImage: "hammer")
                }
                if let r = Making.relative(f.started_at) { Text("Started \(r)") } else { Text("Not started") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            ProgressView(value: Double(p.done ? p.total : p.current), total: Double(max(1, p.total)))
                .tint(p.done ? .green : .blue)
        }
    }

    private func stepCard(_ step: Making.Step, _ p: Making.Progress) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Step \(p.current + 1) of \(p.total)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.blue)
            Text(StyleGuard.dashes(step.text))
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if (step.host ?? "").isEmpty == false || (step.user ?? "").isEmpty == false {
                Label("\(step.user.map { "\($0)@" } ?? "")\(step.host ?? "")", systemImage: "server.rack")
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let c = step.command, !c.isEmpty { MakingCommandBlock(command: c) }
            Button {
                Task { await act(.done) }
            } label: {
                Label(p.current + 1 >= p.total ? "Done, finish" : "Done", systemImage: "checkmark")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(busy)
            Button {
                Task { await act(.back) }
            } label: {
                Label("Back one step", systemImage: "chevron.left").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(busy || p.current == 0)
        }
        .padding()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }

    private func finishedCard(_ f: Making.ProcedureData, _ p: Making.Progress) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Finished", systemImage: "checkmark.circle.fill")
                .font(.title.weight(.semibold))
                .foregroundStyle(.green)
            Text("\(Making.plural(p.total, "step")) done\(Making.relative(f.done_at).map { ", \($0)" } ?? "").")
                .foregroundStyle(.secondary)
            Button { confirmReset = true } label: {
                Label("Run again from step 1", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }

    private func allSteps(_ steps: [Making.Step], _ p: Making.Progress) -> some View {
        DisclosureGroup(isExpanded: $showSteps) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                    let isDone = !(s.done_at ?? "").isEmpty
                    let isCurrent = !p.done && i == p.current
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: isDone ? "checkmark.circle.fill" : isCurrent ? "arrow.right.circle.fill" : "circle")
                            .foregroundStyle(isDone ? Color.green : isCurrent ? Color.blue : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(i + 1). \(StyleGuard.dashes(s.text))")
                                .fontWeight(isCurrent ? .semibold : .regular)
                                .foregroundStyle(isDone || isCurrent ? .primary : .secondary)
                            if let c = s.command, !c.isEmpty { Text(c).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer(minLength: 0)
                        Text(isDone ? "Done" : isCurrent ? "Now" : "").font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 6)
        } label: {
            Text("All \(Making.plural(steps.count, "step"))").font(.headline)
        }
    }

    private func act(_ a: Making.ProcedureAction) async {
        guard let e = engine.get(procedureId) else { return }
        busy = true
        defer { busy = false }
        error = nil
        // With local edits still queued, the hub's copy is behind; advancing there would skip or repeat a step.
        if let c = engine.client, engine.outboxCount == 0 {
            do {
                let onScreen = Making.procedure(e).current.map { Int($0) } ?? 0
                let out = a == .reset ? try await c.procedureReset(procedureId) : try await c.procedureAdvance(procedureId, back: a == .back, step: onScreen)
                await engine.absorb(out)
                return
            } catch {
                if !Making.unreachable(error) { self.error = Making.message(error); return }
            }
        }
        let fields = Making.advanceFields(Making.procedure(e), action: a)
        if !fields.isEmpty { _ = await engine.update(procedureId, fields: fields) }
    }
}
