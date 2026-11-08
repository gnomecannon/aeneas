import SwiftUI
import EACore

/// The job application board: active stages with counts, the next follow-up on top, closed ones tucked away.
struct CareerView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var creating = false
    @State private var openId: String?
    @State private var showClosed = false
    @State private var deleting: Entity?

    /// An application asked for by a link or Spotlight opens straight away.
    private func takeFocus() {
        guard let id = model.focusItemId, engine.get(id)?.kind == .application else { return }
        model.focusItemId = nil
        openId = id
    }

    private var apps: [Entity] { engine.list(.application) }

    var body: some View {
        let apps = self.apps
        let closed = AdminStage.closed.flatMap { AdminBoard.column(apps, $0) }
        List {
            if let f = AdminBoard.followUps(apps).first {
                SwiftUI.Section("Next follow-up") {
                    NavigationLink { AdminApplicationDetail(id: f.id) } label: { followUpRow(f) }
                }
            }
            ForEach(AdminStage.active) { stage in
                let items = AdminBoard.column(apps, stage)
                if !items.isEmpty {
                    SwiftUI.Section {
                        ForEach(items) { a in row(a) }
                    } header: {
                        HStack {
                            Label(stage.title, systemImage: stage.symbol).foregroundStyle(stage.color)
                            Spacer()
                            Text("\(items.count)").monospacedDigit().foregroundStyle(.secondary)
                        }
                        .font(.headline)
                        .textCase(nil)
                    }
                }
            }
            if !closed.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: $showClosed) {
                        ForEach(closed) { a in row(a) }
                    } label: {
                        Text("Closed: " + AdminStage.closed.compactMap { s in
                            let n = AdminBoard.column(apps, s).count
                            return n > 0 ? "\(s.rawValue) \(n)" : nil
                        }.joined(separator: ", "))
                    }
                }
            }
        }
        .overlay {
            if apps.isEmpty {
                ContentUnavailableView {
                    Label("No applications yet", systemImage: "briefcase")
                } description: {
                    Text("Tap + and type the company and the role, or tell the assistant.")
                } actions: {
                    Button("Add application") { creating = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Job applications")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .application) } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("New application", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $creating) { AdminNewApplication { id in openId = id } }
        .navigationDestination(item: $openId) { id in AdminApplicationDetail(id: id) }
        .onAppear { takeFocus() }
        .onChange(of: model.focusItemId) { _, _ in takeFocus() }
        .confirmationDialog("Delete \(deleting?.str("company") ?? "application")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let d = deleting { Task { await engine.softDelete(d.id) } }
                deleting = nil
            }
        } message: {
            Text("Its notes and follow-up reminder go with it.")
        }
        .refreshable { await engine.sync() }
    }

    private func followUpRow(_ a: Entity) -> some View {
        let at = a.date("next_at")
        let overdue = (at ?? .distantFuture) < Date()
        return HStack(spacing: 12) {
            Image(systemName: overdue ? "exclamationmark.circle.fill" : "calendar").font(.title2).foregroundStyle(overdue ? Color.red : Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(StyleGuard.dashes(a.str("company"))).font(.body.weight(.semibold))
                Text(StyleGuard.dashes(a.string("next_step") ?? "Next step")).font(.subheadline)
                if let d = at { Text(overdue ? "Overdue, \(d.shortDateTime)" : d.shortDateTime).font(.caption).foregroundStyle(overdue ? Color.red : Color.secondary) }
            }
        }
    }

    private func row(_ a: Entity) -> some View {
        let stage = AdminStage.of(a)
        return NavigationLink { AdminApplicationDetail(id: a.id) } label: { AdminApplicationRow(app: a) }
            .swipeActions(edge: .leading) {
                if let n = stage.next {
                    Button { setStage(a, n) } label: { Label(n.title, systemImage: n.symbol) }.tint(n.color)
                }
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { deleting = a } label: { Label("Delete", systemImage: "trash") }
                if stage.isActive {
                    Button { setStage(a, .rejected) } label: { Label("Rejected", systemImage: AdminStage.rejected.symbol) }.tint(.red)
                }
            }
            .contextMenu {
                Menu("Move to") {
                    ForEach(AdminStage.allCases) { s in
                        Button { setStage(a, s) } label: { Label(s.title, systemImage: s.symbol) }.disabled(s == stage)
                    }
                }
                Button(role: .destructive) { deleting = a } label: { Label("Delete", systemImage: "trash") }
            }
    }

    private func setStage(_ a: Entity, _ s: AdminStage) {
        var f: [String: JSONValue] = ["stage": .string(s.rawValue)]
        if s == .applied, a.string("applied_at") == nil { f["applied_at"] = .string(ISO.string(AdminApplicationDetail.noon(Date()))) }
        Task { _ = await engine.update(a.id, fields: f) }
    }
}

struct AdminApplicationRow: View {
    var app: Entity

    var body: some View {
        let stage = AdminStage.of(app)
        let at = app.date("next_at")
        let overdue = stage.isActive && (at ?? .distantFuture) < Date()
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(StyleGuard.dashes(app.str("company"))).font(.body.weight(.semibold))
                Spacer()
                if let r = app.string("remote"), !r.isEmpty { Text(r.capitalized).font(.caption).foregroundStyle(.secondary) }
                AdminPill(text: stage.title, symbol: stage.symbol, color: stage.color)
            }
            Text(StyleGuard.dashes(app.str("role"))).font(.subheadline).foregroundStyle(.secondary)
            if app.string("next_step") != nil || at != nil {
                HStack(spacing: 4) {
                    if overdue { Image(systemName: "exclamationmark.circle") }
                    Text([app.string("next_step").map(StyleGuard.dashes), at.map { (overdue ? "overdue, " : "") + $0.shortDateTime }].compactMap { $0 }.joined(separator: ", "))
                }
                .font(.caption)
                .foregroundStyle(overdue ? Color.red : Color.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Company and role are all it takes; everything else is on the detail screen.
struct AdminNewApplication: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var onCreated: (String) -> Void
    @State private var company = ""
    @State private var role = ""
    @State private var stage: AdminStage = .saved
    @State private var url = ""
    /// Set while the new application is being written: two quick taps on Add made two applications.
    @State private var saving = false

    private var ready: Bool { !company.trimmingCharacters(in: .whitespaces).isEmpty && !role.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Company", text: $company).font(.title3)
                TextField("Role", text: $role)
                Picker("Stage", selection: $stage) {
                    ForEach(AdminStage.active) { s in Text(s.title).tag(s) }
                }
                TextField("Posting URL (optional)", text: $url).autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never).keyboardType(.URL)
                    #endif
            }
            .formStyle(.grouped)
            .navigationTitle("New application")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") { save() }.disabled(!ready || saving) }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 300)
        #endif
    }

    private func save() {
        guard !saving else { return }
        saving = true
        var f: [String: JSONValue] = [
            "company": .string(company.trimmingCharacters(in: .whitespaces)),
            "role": .string(role.trimmingCharacters(in: .whitespaces)),
            "stage": .string(stage.rawValue),
        ]
        let u = url.trimmingCharacters(in: .whitespaces)
        if !u.isEmpty { f["url"] = .string(u) }
        if stage != .saved { f["applied_at"] = .string(ISO.string(AdminApplicationDetail.noon(Date()))) }
        Task {
            let e = await engine.create(kind: .application, fields: f)
            dismiss()
            if let id = e?.id { onCreated(id) }
        }
    }
}

/// One application: stage, details saved as you type, and the cover letter drafted through the hub.
struct AdminApplicationDetail: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var id: String

    @State private var loaded = false
    @State private var company = ""
    @State private var role = ""
    @State private var salary = ""
    @State private var nextStep = ""
    @State private var url = ""
    @State private var notes = ""
    @State private var remote = ""
    @State private var hasApplied = false
    @State private var applied = Date()
    @State private var hasNext = false
    @State private var nextAt = Calendar.current.date(byAdding: .day, value: 3, to: AdminApplicationDetail.noon(Date())) ?? Date()
    @State private var saveTask: Task<Void, Never>?
    @State private var confirmDelete = false

    @State private var job = ""
    @State private var tone = "plain"
    @State private var drafting = false
    @State private var letterMsg: (tone: AdminMessage.Tone, text: String)?

    static func noon(_ d: Date) -> Date { Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: d) ?? d }

    var body: some View {
        Group {
            if let e = engine.get(id), !e.isDeleted {
                form(e)
            } else {
                ContentUnavailableView("Application not found", systemImage: "briefcase", description: Text("It may have been deleted on another device."))
            }
        }
        .onAppear(perform: load)
        .onDisappear { saveNow() }
    }

    @ViewBuilder
    private func form(_ e: Entity) -> some View {
        let stage = AdminStage.of(e)
        Form {
            SwiftUI.Section {
                HStack {
                    Picker("Stage", selection: Binding(get: { stage }, set: { setStage(e, $0) })) {
                        ForEach(AdminStage.allCases) { s in Label(s.title, systemImage: s.symbol).tag(s) }
                    }
                    .pickerStyle(.menu)
                    Spacer()
                    AdminPill(text: stage.title, symbol: stage.symbol, color: stage.color)
                }
                if let n = stage.next {
                    Button { setStage(e, n) } label: {
                        Label("Move to \(n.title)", systemImage: n.symbol).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(n.color)
                }
            }

            SwiftUI.Section("Details") {
                TextField("Company", text: $company)
                TextField("Role", text: $role)
                Toggle("Applied", isOn: $hasApplied)
                if hasApplied { DatePicker("Applied on", selection: $applied, displayedComponents: .date) }
                TextField("Salary", text: $salary)
                Picker("Where", selection: $remote) {
                    Text("Not set").tag("")
                    Text("Remote").tag("remote")
                    Text("Hybrid").tag("hybrid")
                    Text("Onsite").tag("onsite")
                }
                TextField("Posting URL", text: $url).autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never).keyboardType(.URL)
                    #endif
                if let link = URL(string: url.trimmingCharacters(in: .whitespaces)), link.scheme?.hasPrefix("http") == true {
                    Link(destination: link) { Label("Open the posting", systemImage: "safari") }
                }
            }

            SwiftUI.Section {
                TextField("Next step, like Call with recruiter", text: $nextStep)
                Toggle("Date", isOn: $hasNext)
                if hasNext { DatePicker("When", selection: $nextAt) }
            } header: {
                Text("Next step")
            } footer: {
                Text("The hub keeps a reminder at this date.")
            }

            SwiftUI.Section("Notes") {
                TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...12)
            }

            coverLetter(e)

            SwiftUI.Section {
                Button("Delete application", role: .destructive) { confirmDelete = true }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(StyleGuard.dashes(e.str("company")))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onChange(of: company) { _, _ in scheduleSave() }
        .onChange(of: role) { _, _ in scheduleSave() }
        .onChange(of: salary) { _, _ in scheduleSave() }
        .onChange(of: nextStep) { _, _ in scheduleSave() }
        .onChange(of: url) { _, _ in scheduleSave() }
        .onChange(of: notes) { _, _ in scheduleSave() }
        .onChange(of: remote) { _, _ in scheduleSave() }
        .onChange(of: hasApplied) { _, _ in scheduleSave() }
        .onChange(of: applied) { _, _ in scheduleSave() }
        .onChange(of: hasNext) { _, _ in scheduleSave() }
        .onChange(of: nextAt) { _, _ in scheduleSave() }
        .confirmationDialog("Delete \(e.str("company"))?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                saveTask?.cancel()
                Task { await engine.softDelete(e.id) }
                dismiss()
            }
        } message: {
            Text("Its notes and follow-up reminder go with it. A drafted cover letter note stays.")
        }
    }

    @ViewBuilder
    private func coverLetter(_ e: Entity) -> some View {
        SwiftUI.Section {
            TextField("Paste the job text (optional)", text: $job, axis: .vertical).lineLimit(4...12)
            Picker("Tone", selection: $tone) {
                Text("Plain").tag("plain")
                Text("Warm").tag("warm")
                Text("Direct").tag("direct")
            }
            .pickerStyle(.segmented)
            Button {
                draft(e)
            } label: {
                HStack {
                    if drafting { ProgressView().controlSize(.small) }
                    Text(drafting ? "Drafting" : "Draft cover letter")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(drafting)
            if let m = letterMsg { AdminMessage(tone: m.tone, text: m.text) }
            if let noteId = e.string("letter_note_id"), !noteId.isEmpty {
                if engine.get(noteId) != nil {
                    NavigationLink { NoteEditorView(noteId: noteId) } label: { Label("Open the saved letter", systemImage: "doc.text") }
                } else {
                    Text("The letter is saved as a note. It shows here after the next sync.").font(.callout).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Cover letter")
        } footer: {
            Text("Uses only your identity and history facts and the job text.")
        }
    }

    private func setStage(_ e: Entity, _ s: AdminStage) {
        var f: [String: JSONValue] = ["stage": .string(s.rawValue)]
        if s == .applied, e.string("applied_at") == nil, !hasApplied {
            let d = Self.noon(Date())
            f["applied_at"] = .string(ISO.string(d))
            hasApplied = true
            applied = d
        }
        Task { _ = await engine.update(e.id, fields: f) }
    }

    private func load() {
        guard !loaded, let e = engine.get(id) else { return }
        company = e.str("company")
        role = e.str("role")
        salary = e.str("salary")
        nextStep = e.str("next_step")
        url = e.str("url")
        notes = e.str("notes")
        remote = e.str("remote")
        if let d = e.date("applied_at") { hasApplied = true; applied = d }
        if let d = e.date("next_at") { hasNext = true; nextAt = d }
        loaded = true
    }

    private func scheduleSave() {
        guard loaded else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 700_000_000)
            if Task.isCancelled { return }
            saveNow()
        }
    }

    /// Writes only the fields that differ from the stored entity, so opening and closing the screen writes nothing.
    private func saveNow() {
        guard loaded, let e = engine.get(id), !e.isDeleted else { return }
        var f: [String: JSONValue] = [:]
        func text(_ key: String, _ v: String, required: Bool = false) {
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if required && t.isEmpty { return }
            if t != e.str(key) { f[key] = t.isEmpty ? .null : .string(t) }
        }
        text("company", company, required: true)
        text("role", role, required: true)
        text("salary", salary)
        text("next_step", nextStep)
        text("url", url)
        text("notes", notes)
        if remote != e.str("remote") { f["remote"] = remote.isEmpty ? .null : .string(remote) }
        let oldApplied = e.date("applied_at")
        if hasApplied {
            if oldApplied.map({ !Calendar.current.isDate($0, inSameDayAs: applied) }) ?? true { f["applied_at"] = .string(ISO.string(Self.noon(applied))) }
        } else if oldApplied != nil { f["applied_at"] = .null }
        let oldNext = e.date("next_at")
        if hasNext {
            if oldNext.map({ abs($0.timeIntervalSince(nextAt)) >= 1 }) ?? true { f["next_at"] = .string(ISO.string(nextAt)) }
        } else if oldNext != nil { f["next_at"] = .null }
        guard !f.isEmpty else { return }
        Task { _ = await engine.update(e.id, fields: f) }
    }

    private func draft(_ e: Entity) {
        guard let c = engine.client else {
            letterMsg = (.error, "Drafting needs the hub. Set it up in Settings.")
            return
        }
        saveNow()
        drafting = true
        letterMsg = nil
        Task {
            do {
                let r = try await c.coverLetter(e.id, jobText: job, tone: tone)
                await engine.absorb(r.note)
                letterMsg = (.ok, "Drafted with \(r.backend). Saved as a note.")
                // The hub set letter_note_id on the application; pull it.
                Task { await engine.sync() }
            } catch let err as CoverLetterError {
                if case .hub(.transport) = err {
                    letterMsg = (.error, "Hub unreachable. Drafting needs the hub.")
                } else if case .noModel = err {
                    letterMsg = (.note, err.localizedDescription)
                } else {
                    letterMsg = (.error, err.localizedDescription)
                }
            } catch {
                letterMsg = (.error, error.localizedDescription)
            }
            drafting = false
        }
    }
}
