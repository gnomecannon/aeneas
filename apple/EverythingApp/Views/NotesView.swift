import SwiftUI
import EACore

/// Notes in nested folders, collapsed until opened (the open ones stay open on this device), with an Ideas group
/// across folders, search and an autosaving editor.
struct NotesView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var creating = false
    @State private var linked: String?
    @State private var allDiary = false
    @AppStorage("notes.open") private var openRaw = ""
    /// Tags and links come from the model, which runs only when asked, so the GPU stays free for games.
    @State private var linking: HubClient.NoteLinking?

    private var filtered: [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return engine.notes }
        return engine.notes.filter { $0.str("title").lowercased().contains(q) || $0.str("body").lowercased().contains(q) || $0.stringArray("tags").contains { $0.lowercased().contains(q) } }
    }

    private var openSet: Set<String> { Set(openRaw.split(separator: "\n").map(String.init)) }

    /// A folder or group is open while searching, or when it was opened on this device.
    private func isOpen(_ key: String) -> Binding<Bool> {
        Binding(
            get: { !query.isEmpty || openSet.contains(key) },
            set: { open in
                guard query.isEmpty else { return }
                var s = openSet
                if open { s.insert(key) } else { s.remove(key) }
                openRaw = s.sorted().joined(separator: "\n")
            }
        )
    }

    var body: some View {
        let tree = NoteFolder.tree(filtered)
        let ideas = NoteFolder.ideas(filtered)
        List {
            if !ideas.isEmpty {
                DisclosureGroup(isExpanded: isOpen("ideas")) {
                    ForEach(ideas, id: \.form) { g in
                        DisclosureGroup(isExpanded: isOpen("ideas/\(g.form)")) {
                            ForEach(g.notes) { n in NoteRow(note: n) }
                        } label: { FolderLabel(name: g.label, count: g.notes.count) }
                    }
                } label: { FolderLabel(name: "Ideas", count: ideas.reduce(0) { $0 + $1.notes.count }, symbol: "lightbulb") }
            }
            ForEach(tree.children) { f in
                FolderSection(folder: f, isOpen: isOpen, searching: !query.isEmpty, allDiary: $allDiary)
            }
            ForEach(tree.notes) { n in NoteRow(note: n) }
        }
        .listStyle(.plain)
        .overlay { if filtered.isEmpty { EmptyState(text: query.isEmpty ? "No notes" : "No matches") } }
        .searchable(text: $query, prompt: "Search notes")
        .navigationTitle("Notes")
        // A note asked for by a link or Spotlight opens straight away.
        .navigationDestination(item: $linked) { id in NoteEditorView(noteId: id) }
        .onAppear { takeFocus() }
        .onChange(of: model.focusItemId) { _, _ in takeFocus() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New", systemImage: "plus") } }
            ToolbarItem(placement: .primaryAction) {
                NavigationLink { NotesGraphView() } label: { Label("Map", systemImage: "point.3.connected.trianglepath.dotted") }
            }
            if let l = linking, l.waiting > 0 || l.running {
                ToolbarItem(placement: .primaryAction) {
                    Button(l.running ? "Tagging \(l.waiting)" : "Tag \(l.waiting)") {
                        Task { if let c = engine.client { linking = try? await c.notesLinkNow() } }
                    }
                    .disabled(l.running)
                    .help("The model reads the changed notes and gives them tags and links; it stops for any chat")
                }
            }
        }
        .task {
            while !Task.isCancelled {
                if let c = engine.client { linking = try? await c.notesLinking() }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        .sheet(isPresented: $creating) { NewNoteSheet() }
        .refreshable { await engine.sync() }
    }

    private func takeFocus() {
        guard let id = model.focusItemId, engine.get(id)?.kind == .note else { return }
        model.focusItemId = nil
        linked = id
    }
}

/// One folder of notes, as Writing, then Comedy inside it, then Sketches: its notes and the folders inside it.
struct NoteFolder: Identifiable {
    let name: String
    let path: String
    var notes: [Entity] = []
    var children: [NoteFolder] = []
    var count = 0
    var id: String { path }

    /// The folder tree of these notes; the root's `notes` are the ones outside any folder.
    static func tree(_ notes: [Entity]) -> NoteFolder {
        var root = NoteFolder(name: "", path: "")
        for n in notes {
            let dir = (n.str("path") as NSString).deletingLastPathComponent
            root.insert(n, parts: dir.isEmpty ? [] : dir.split(separator: "/").map(String.init), prefix: "")
        }
        root.finish()
        return root
    }

    private mutating func insert(_ n: Entity, parts: [String], prefix: String) {
        guard let first = parts.first else { notes.append(n); return }
        let p = prefix.isEmpty ? first : "\(prefix)/\(first)"
        if let i = children.firstIndex(where: { $0.path == p }) {
            children[i].insert(n, parts: Array(parts.dropFirst()), prefix: p)
        } else {
            var c = NoteFolder(name: first, path: p)
            c.insert(n, parts: Array(parts.dropFirst()), prefix: p)
            children.append(c)
        }
    }

    @discardableResult
    private mutating func finish() -> Int {
        children.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        // The diary gains a note a day: newest first. Other folders by title.
        notes = path == "Diary"
            ? notes.sorted { $0.str("path") > $1.str("path") }
            : notes.sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending }
        var total = notes.count
        for i in children.indices { total += children[i].finish() }
        count = total
        return total
    }

    /// Forms an idea can take (its tags besides `idea`), in the order the Ideas group lists them.
    static let ideaForms: [(form: String, label: String)] = [("story", "Stories"), ("film", "Films"), ("book", "Books"), ("sketch", "Sketches"), ("song", "Songs"), ("game", "Games"), ("app", "Apps"), ("invention", "Inventions"), ("business", "Businesses")]

    /// Notes tagged `idea`, by form, newest first, wherever they are filed.
    static func ideas(_ notes: [Entity]) -> [(form: String, label: String, notes: [Entity])] {
        let ideas = notes.filter { $0.stringArray("tags").contains { $0.lowercased() == "idea" } }
        var placed = Set<String>()
        var out: [(form: String, label: String, notes: [Entity])] = []
        for f in ideaForms {
            let items = ideas.filter { !placed.contains($0.id) && $0.stringArray("tags").contains { $0.lowercased() == f.form } }
            items.forEach { placed.insert($0.id) }
            if !items.isEmpty { out.append((f.form, f.label, items)) }
        }
        let rest = ideas.filter { !placed.contains($0.id) }
        if !rest.isEmpty { out.append(("other", "Other", rest)) }
        return out.map { ($0.form, $0.label, $0.notes.sorted { $0.created_at > $1.created_at }) }
    }
}

/// A folder that opens to its notes and the folders inside it.
private struct FolderSection: View {
    let folder: NoteFolder
    let isOpen: (String) -> Binding<Bool>
    let searching: Bool
    @Binding var allDiary: Bool
    private let diaryShown = 7

    var body: some View {
        DisclosureGroup(isExpanded: isOpen(folder.path)) {
            let capped = folder.path == "Diary" && !allDiary && !searching && folder.notes.count > diaryShown
            ForEach(capped ? Array(folder.notes.prefix(diaryShown)) : folder.notes) { n in NoteRow(note: n) }
            if folder.path == "Diary" && !searching && folder.notes.count > diaryShown {
                Button(allDiary ? "Last 7 days" : "All \(folder.notes.count) days") { allDiary.toggle() }
            }
            ForEach(folder.children) { c in FolderSection(folder: c, isOpen: isOpen, searching: searching, allDiary: $allDiary) }
        } label: { FolderLabel(name: folder.name, count: folder.count, symbol: "folder") }
    }
}

private struct FolderLabel: View {
    let name: String
    let count: Int
    var symbol: String = "folder"
    var body: some View {
        HStack {
            Label(name, systemImage: symbol).font(.headline)
            Spacer()
            Text("\(count)").font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

private struct NoteRow: View {
    let note: Entity
    var body: some View {
        // A destination link, not a value: the iPhone's Library stack only takes screens as values,
        // so a note id pushed as a value was dropped and the row did nothing.
        NavigationLink { NoteEditorView(noteId: note.id) } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(note.str("title"))).font(.title3)
                let tags = note.stringArray("tags")
                if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .deleteSwipe(note.id)
    }
}

struct NewNoteSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var folder = "Inbox"
    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title).font(.title3)
                TextField("Folder", text: $folder)
                Text("Path: \(folder.isEmpty ? "" : folder + "/")\(SyncEngine.safeFileName(title)).md").font(.caption).foregroundStyle(.secondary)
            }
            .navigationTitle("New note")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        let path = (folder.isEmpty ? "" : folder.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "/") + SyncEngine.safeFileName(title) + ".md"
                        Task { _ = await engine.create(kind: .note, fields: ["title": .string(title), "body": "", "tags": [], "path": .string(path)]) }
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 240)
        #endif
    }
}

/// Title, tags, path, markdown body. Autosaves one second after the last edit.
/// Links are derived by the hub from title mentions and the note linker, which also tags notes; Related comes from the hub.
struct NoteEditorView: View {
    @EnvironmentObject var engine: SyncEngine
    var noteId: String
    @State private var title = ""
    @State private var tags = ""
    /// The tags as loaded: they are sent only when the owner changed them here, so tags the note linker added while the
    /// note was open are not taken away by an edit to its text.
    @State private var loadedTags = ""
    // What the editor last took from the synced note: only fields typed here since go back, so a line the hub added
    // (the diary) or a move the note linker made is not undone by the next keystroke.
    @State private var loadedTitle = ""
    @State private var loadedPath = ""
    @State private var loadedBody = ""
    @State private var path = ""
    @State private var body_ = ""
    @State private var loaded = false
    @State private var dirty = false
    @State private var saveTask: Task<Void, Never>?
    @State private var savedAt: Date?
    @State private var related = RelatedResponse()
    @State private var relatedLoaded = false
    @State private var showRelated = true

    var body: some View {
        VStack(spacing: 8) {
            TextField("Title", text: $title).font(.title.bold()).textFieldStyle(.plain)
            HStack {
                TextField("tags, comma separated", text: $tags).textFieldStyle(.plain).font(.subheadline)
                Spacer()
                Text(savedAt.map { "Saved \($0.shortTime)" } ?? (dirty ? "Editing" : "")).font(.caption).foregroundStyle(.secondary)
            }
            TextField("Path", text: $path).textFieldStyle(.plain).font(.caption.monospaced()).foregroundStyle(.secondary)
            Divider()
            TextEditor(text: $body_)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
            relatedSection
        }
        .padding()
        .navigationTitle("Note")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear(perform: load)
        .task { await loadRelated() }
        .onChange(of: title) { _, _ in scheduleSave() }
        .onChange(of: tags) { _, _ in scheduleSave() }
        .onChange(of: path) { _, _ in scheduleSave() }
        .onChange(of: body_) { _, _ in scheduleSave() }
        .onChange(of: engine.get(noteId)?.updated_at) { _, _ in refreshFromHub() }
        .onDisappear { saveNow() }
    }

    @ViewBuilder
    private var relatedSection: some View {
        if relatedLoaded, !related.isEmpty {
            DisclosureGroup(isExpanded: $showRelated) {
                VStack(alignment: .leading, spacing: 4) {
                    relatedGroup("Links", related.links)
                    relatedGroup("Backlinks", related.backlinks)
                    relatedGroup("Similar", related.similar)
                }
                .padding(.top, 4)
            } label: {
                Text("Related (\(related.links.count + related.backlinks.count + related.similar.count))").font(.headline).foregroundStyle(.secondary)
            }
            .frame(maxHeight: 220)
        } else if relatedLoaded {
            Text("No related notes").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func relatedGroup(_ name: String, _ items: [RelatedNote]) -> some View {
        if !items.isEmpty {
            Text(name).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(items) { r in
                NavigationLink { NoteEditorView(noteId: r.id) } label: {
                    HStack {
                        Text(StyleGuard.dashes(r.title)).lineLimit(1)
                        Spacer()
                        if let w = r.why, !w.isEmpty { Text(w).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    .padding(.vertical, 3)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func loadRelated() async {
        guard let c = engine.client else { relatedLoaded = true; return }
        if let r = try? await c.related(noteId: noteId) { related = r }
        relatedLoaded = true
    }

    private func load() {
        guard !loaded, let n = engine.get(noteId), let f = n.decoded(NoteFields.self) else { return }
        title = f.title
        tags = (f.tags ?? []).joined(separator: ", ")
        loadedTags = tags
        path = f.path
        body_ = f.body ?? ""
        loadedTitle = title
        loadedPath = path
        loadedBody = body_
        loaded = true
    }

    /// The note changed elsewhere (a diary line added on the hub, the linker moved it): shown here when nothing is
    /// waiting to be saved.
    private func refreshFromHub() {
        guard loaded, !dirty, let n = engine.get(noteId), let f = n.decoded(NoteFields.self) else { return }
        let newTags = (f.tags ?? []).joined(separator: ", ")
        loadedTitle = f.title; loadedPath = f.path; loadedBody = f.body ?? ""; loadedTags = newTags
        if title != f.title { title = f.title }
        if path != f.path { path = f.path }
        if body_ != loadedBody { body_ = loadedBody }
        if tags != newTags { tags = newTags }
    }

    private func scheduleSave() {
        guard loaded else { return }
        dirty = true
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            await MainActor.run { saveNow() }
        }
    }

    private func saveNow() {
        guard loaded, dirty, let n = engine.get(noteId) else { return }
        var p = path.trimmingCharacters(in: .whitespaces)
        if !p.hasSuffix(".md") { p += ".md" }
        let tagList = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#")) }.filter { !$0.isEmpty }
        var fields: [String: JSONValue] = [:]
        if title != loadedTitle && title != n.str("title") { fields["title"] = .string(title) }
        if body_ != loadedBody {
            // Lines the hub added at the end meanwhile (a capture going into today's diary) stay after the typing.
            let synced = n.str("body")
            if synced != loadedBody, synced.hasPrefix(loadedBody) { body_ += String(synced.dropFirst(loadedBody.count)) }
            if body_ != synced { fields["body"] = .string(body_) }
        }
        if p != loadedPath && p != n.str("path") { fields["path"] = .string(p) }
        if tags != loadedTags && tagList != n.stringArray("tags") { fields["tags"] = .array(tagList.map { .string($0) }) }
        loadedTags = tags
        loadedTitle = title
        loadedPath = p
        loadedBody = body_
        dirty = false
        guard !fields.isEmpty else { return }
        Task { _ = await engine.update(noteId, fields: fields) }
        savedAt = Date()
    }
}
