import SwiftUI
import EACore

/// Hum a melody or tap a rhythm and the hub writes it as MIDI; or one line in, one idea out. Music projects (projects
/// with area music), then ideas grouped by type with a status filter. Cheat sheets and checklists are notes in Music/Reference.
struct MusicView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var recorder = HumRecorder()
    @State private var humMode: HumMidi.Mode = .melody
    @State private var humTempo = ""
    @State private var humSending = false
    @State private var humError: String?
    /// Takes the hub did not get, kept on disk until sent or discarded. One take was held in memory, so it was lost on
    /// leaving Music, and a second failed take replaced the first.
    @State private var unsent: [UnsentHum] = []
    @State private var opened: String?
    @State private var newProject = ""
    @State private var naming = false
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var saved: String?
    @State private var filter = ""
    @FocusState private var focused: Bool

    private var all: [Entity] { engine.list(.music_idea) }
    private var musicProjects: [Entity] {
        engine.list(.project).filter { $0.str("area") == "music" && $0.str("status") != "done" }.sorted { $0.updated_at > $1.updated_at }
    }
    private var groups: [(type: String, items: [Entity])] {
        Making.musicTypes.compactMap { t in
            let items = all.filter { $0.str("type") == t && (filter.isEmpty || $0.str("status", "idea") == filter) }.sorted { $0.updated_at > $1.updated_at }
            return items.isEmpty ? nil : (t, items)
        }
    }
    private var preview: Making.MusicQuick? {
        text.trimmingCharacters(in: .whitespaces).isEmpty ? nil : Making.parseMusicQuick(text)
    }

    var body: some View {
        List {
            if model.isOn(.music) { hum }

            SwiftUI.Section {
                HStack(spacing: 8) {
                    TextField("Am F C G 6/8 112bpm drop D", text: $text)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .focused($focused)
                        .onSubmit { Task { await save() } }
                        .submitLabel(.done)
                    Button("Save") { Task { await save() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let p = preview {
                    let meta = Making.musicMeta(key: p.key, bpm: p.bpm, time: p.time_sig, tuning: p.tuning)
                    Text("\(p.type.capitalized): \(p.title)\(meta.isEmpty ? "" : ", " + meta.joined(separator: ", "))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let s = saved { Label("Saved \(s)", systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green) }
                if let e = error { MakingErrorLine(text: e) }
            } header: {
                Text("Quick capture")
            } footer: {
                Text("Chords, time signature, bpm and tuning are picked out. The rest is the title. Cheat sheets and checklists are notes, in Notes under Music, Reference.")
            }

            SwiftUI.Section("Projects") {
                ForEach(musicProjects) { p in
                    NavigationLink { ProjectDetailView(projectId: p.id) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(StyleGuard.dashes(p.str("name"))).font(.headline)
                                Spacer(minLength: 6)
                                MakingBadge.project(p.str("status", "active"))
                            }
                            let n = all.filter { $0.str("project_id") == p.id }.count
                            Text(Making.plural(n, "idea")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Button { naming = true } label: { Label("New music project", systemImage: "plus") }
            }
            .alert("New music project", isPresented: $naming) {
                TextField("An album, an EP, a song", text: $newProject)
                Button("Start") {
                    let name = newProject.trimmingCharacters(in: .whitespaces)
                    newProject = ""
                    guard !name.isEmpty else { return }
                    Task { _ = await engine.create(kind: .project, fields: ["name": .string(name), "status": "active", "definition_of_done": "", "area": "music"]) }
                }
                Button("Cancel", role: .cancel) { newProject = "" }
            }

            if !all.isEmpty {
                SwiftUI.Section {
                    Picker("Status", selection: $filter) {
                        Text("All").tag("")
                        Text("Idea").tag("idea")
                        Text("In progress").tag("wip")
                        Text("Done").tag("done")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                if groups.isEmpty {
                    Text("Nothing with that status.").foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.type) { g in
                    SwiftUI.Section {
                        ForEach(g.items) { e in MusicLink(idea: e).deleteSwipe(e.id) }
                    } header: {
                        Text("\(g.type.capitalized) \(g.items.count)")
                    }
                }
            } else {
                SwiftUI.Section {
                    Text("No ideas yet. Type a line above, for example Am F C G 6/8 112bpm, and press Save.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Music")
        .refreshable { await engine.sync() }
        .navigationDestination(item: $opened) { MusicIdeaView(ideaId: $0) }
        .onChange(of: recorder.finished) { _, take in
            guard let take else { return }
            recorder.finished = nil
            Task { await sendHum(take) }
        }
        .onAppear {
            for t in UnsentHum.load() where !unsent.contains(where: { $0.id == t.id }) { unsent.append(t) }
        }
        .onDisappear { recorder.cancel() }
    }

    /// Melody or rhythm, an optional tempo, and Record. After Stop the take goes to the hub and its idea opens.
    private var hum: some View {
        SwiftUI.Section {
            HumModePicker(mode: $humMode)
            LabeledContent("Tempo") {
                TextField("found by the hub", text: $humTempo)
                    .multilineTextAlignment(.trailing)
                    .font(.body.monospaced())
                    .numericKeyboard()
            }
            if recorder.recording {
                HumRecordingPanel(recorder: recorder)
            } else if humSending {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Sending the recording").foregroundStyle(.secondary)
                }
            } else {
                Button { Task { await recorder.start() } } label: { Label("Record", systemImage: "record.circle") }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
            }
            if let e = humError ?? recorder.error { MakingErrorLine(text: e) }
            if !recorder.recording, !humSending {
                ForEach(unsent) { take in
                    HStack {
                        Text(take.label).font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Button("Send again") { Task { await sendHum(url: take.url, clientId: take.id) } }.buttonStyle(.bordered)
                        Button("Discard", role: .destructive) {
                            try? FileManager.default.removeItem(at: take.url)
                            unsent.removeAll { $0.id == take.id }
                            if unsent.isEmpty { humError = nil }
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        } header: {
            Text("Hum")
        } footer: {
            Text(humMode == .melody
                 ? "Hum or sing one note at a time, up to 2 minutes. The hub writes the notes as MIDI for your DAW."
                 : "Tap, clap or beatbox, up to 2 minutes. Low hits become kick, sharp ones snare, hissy ones hat.")
        }
    }

    /// A new take: its client id is the one Hum.send gives a take, kept with the file so a resend is the same take.
    private func sendHum(_ take: HumTake) async {
        await sendHum(url: take.url, clientId: "app-\(take.id.uuidString.lowercased())")
    }

    private func sendHum(url: URL, clientId: String) async {
        humSending = true
        humError = nil
        defer { humSending = false }
        do {
            guard let c = engine.client else { throw HubError.notConfigured }
            let e = try await c.uploadHum(fileURL: url, mode: humMode, bpm: Hum.tempo(humTempo), fromCapture: false, clientId: clientId)
            await engine.absorb(e)
            engine.moment(.create, kind: .music_idea)
            try? FileManager.default.removeItem(at: url)
            unsent.removeAll { $0.id == clientId }
            opened = e.id
        } catch {
            if let kept = UnsentHum.keep(url, clientId: clientId), !unsent.contains(where: { $0.id == clientId }) { unsent.append(kept) }
            humError = "The hum was not sent. \(Making.message(error))"
        }
    }

    private func save() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        error = nil
        var made: Entity?
        if let c = engine.client {
            do {
                let e = try await c.musicQuick(t)
                await engine.absorb(e)
                engine.moment(.create, kind: e.kind)
                made = e
            } catch {
                if !Making.unreachable(error) { self.error = Making.message(error); return }
            }
        }
        if made == nil {
            let q = Making.parseMusicQuick(t)
            var f: [String: JSONValue] = ["title": .string(q.title), "type": .string(q.type), "body": .string(q.body), "status": "idea", "tags": []]
            if let k = q.key { f["key"] = .string(k) }
            if let b = q.bpm { f["bpm"] = .number(b) }
            if let s = q.time_sig { f["time_sig"] = .string(s) }
            if let s = q.tuning { f["tuning"] = .string(s) }
            made = await engine.create(kind: .music_idea, fields: f)
        }
        guard let e = made else { error = "Could not save on this device."; return }
        text = ""
        saved = StyleGuard.dashes(e.str("title"))
        focused = true
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if saved == StyleGuard.dashes(e.str("title")) { saved = nil }
        }
    }
}

struct MusicLink: View {
    var idea: Entity
    var body: some View {
        NavigationLink { MusicIdeaView(ideaId: idea.id) } label: { MusicRow(idea: idea) }
    }
}

struct MusicRow: View {
    var idea: Entity

    var body: some View {
        let meta = Making.musicMeta(idea)
        let tags = idea.stringArray("tags")
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(StyleGuard.dashes(idea.str("title", "Untitled"))).font(.headline).lineLimit(2)
                Spacer(minLength: 6)
                // Only the state is read here, not the notes, so a long list stays quick.
                if idea.fields["midi"]?.objectValue?["state"]?.stringValue == "listening" {
                    Label("Listening", systemImage: "waveform").font(.caption).foregroundStyle(.secondary)
                }
                MakingBadge.music(idea.str("status", "idea"))
            }
            if !meta.isEmpty || !tags.isEmpty {
                HStack(spacing: 8) {
                    if !meta.isEmpty { Text(meta.joined(separator: "  ")).font(.caption.monospaced()) }
                    if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")).font(.caption) }
                }
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Edit one idea. Status is one tap; everything else saves a second after the last change.
struct MusicIdeaView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var ideaId: String

    private struct Draft {
        var title = "", type = "riff", body = "", key = "", bpm = "", time_sig = "", tuning = "", tags = "", project_id = "", audio_ref = ""
    }

    @State private var d = Draft()
    @State private var loaded = false
    @State private var pending: Set<String> = []
    @State private var saveTask: Task<Void, Never>?
    @State private var savedAt: Date?
    @State private var confirmDelete = false
    @StateObject private var humPlayer = HumPlayer()

    private var projects: [Entity] {
        // Music ideas belong to music projects; the current one stays listed even if it is not one.
        engine.list(.project).filter { ($0.str("status") != "done" && $0.str("area") == "music") || $0.id == d.project_id }
            .sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        Group {
            if let e = engine.get(ideaId), !e.isDeleted {
                form(e)
            } else {
                ContentUnavailableView("Idea not found", systemImage: "music.note", description: Text("It may have been deleted on another device."))
            }
        }
        .navigationTitle(d.title.isEmpty ? "Idea" : StyleGuard.dashes(d.title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear(perform: load)
        .onChange(of: engine.get(ideaId)?.field_ts["midi"]) { _, _ in heardByHub() }
        .onDisappear { humPlayer.stop(); saveTask?.cancel(); Task { await flush() } }
        .confirmationDialog("Delete this idea?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                saveTask?.cancel()
                pending = []
                Task { await engine.softDelete(ideaId) }
                dismiss()
            }
        }
    }

    private func form(_ e: Entity) -> some View {
        Form {
            SwiftUI.Section {
                TextField("Title", text: bind(\.title, "title")).font(.title3.weight(.semibold))
                Picker("Status", selection: Binding(get: { e.str("status", "idea") }, set: { s in Task { _ = await engine.update(ideaId, fields: ["status": .string(s)]) } })) {
                    Text("Idea").tag("idea")
                    Text("In progress").tag("wip")
                    Text("Done").tag("done")
                }
                .pickerStyle(.segmented)
            }
            if model.isOn(.music), let midi = e.humMidi {
                HumIdeaSections(idea: e, midi: midi, player: humPlayer)
            }
            SwiftUI.Section {
                TextEditor(text: bind(\.body, "body"))
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    .frame(minHeight: 200)
            } header: {
                Text("Chords, tab, lyrics, settings")
            }
            SwiftUI.Section("Details") {
                Picker("Type", selection: bind(\.type, "type")) {
                    ForEach(Making.musicTypes, id: \.self) { Text($0.capitalized).tag($0) }
                }
                LabeledContent("Key") { TextField("Am", text: bind(\.key, "key")).multilineTextAlignment(.trailing).font(.body.monospaced()) }
                LabeledContent("BPM") { TextField("120", text: bind(\.bpm, "bpm")).multilineTextAlignment(.trailing).font(.body.monospaced()).numericKeyboard() }
                LabeledContent("Time") { TextField("4/4", text: bind(\.time_sig, "time_sig")).multilineTextAlignment(.trailing).font(.body.monospaced()) }
                LabeledContent("Tuning") { TextField("standard", text: bind(\.tuning, "tuning")).multilineTextAlignment(.trailing) }
                LabeledContent("Tags") { TextField("comma separated", text: bind(\.tags, "tags")).multilineTextAlignment(.trailing) }
                Picker("Project", selection: bind(\.project_id, "project_id")) {
                    Text("None").tag("")
                    ForEach(projects) { p in Text(p.str("name")).tag(p.id) }
                }
                LabeledContent("Audio") { TextField("file name or URL", text: bind(\.audio_ref, "audio_ref")).multilineTextAlignment(.trailing).font(.body.monospaced()).autocorrectionDisabled() }
            }
            SwiftUI.Section {
                Text(pending.isEmpty ? (savedAt.map { "Saved \($0.shortTime)" } ?? "Saved") : "Saving after you stop typing")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Delete idea", role: .destructive) { confirmDelete = true }
            }
        }
        .formStyle(.grouped)
    }

    private func bind(_ kp: WritableKeyPath<Draft, String>, _ key: String) -> Binding<String> {
        Binding(get: { d[keyPath: kp] }, set: { v in
            guard d[keyPath: kp] != v else { return }
            d[keyPath: kp] = v
            edited(key)
        })
    }

    private func load() {
        guard !loaded, let e = engine.get(ideaId) else { return }
        loaded = true
        d = Draft(title: e.str("title"), type: e.str("type", "riff"), body: e.str("body"), key: e.str("key"),
                  bpm: e.number("bpm").map { Making.num($0) } ?? "", time_sig: e.str("time_sig"), tuning: e.str("tuning"),
                  tags: e.stringArray("tags").joined(separator: ", "), project_id: e.str("project_id"), audio_ref: e.str("audio_ref"))
    }

    /// The hub names a hum, finds its tempo and key and tags its mode once it has heard it; show those unless
    /// they are being typed over right now.
    private func heardByHub() {
        guard loaded, let e = engine.get(ideaId) else { return }
        if !pending.contains("title") { d.title = e.str("title") }
        if !pending.contains("key") { d.key = e.str("key") }
        if !pending.contains("bpm") { d.bpm = e.number("bpm").map { Making.num($0) } ?? "" }
        if !pending.contains("tags") { d.tags = e.stringArray("tags").joined(separator: ", ") }
    }

    private func edited(_ key: String) {
        pending.insert(key)
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            await flush()
        }
    }

    private func flush() async {
        guard !pending.isEmpty, let e = engine.get(ideaId), !e.isDeleted else { return }
        let keys = pending
        pending = []
        func opt(_ s: String) -> JSONValue {
            let t = s.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? .null : .string(t)
        }
        var f: [String: JSONValue] = [:]
        for k in keys {
            switch k {
            case "title":
                let t = d.title.trimmingCharacters(in: .whitespaces)
                f["title"] = .string(t.isEmpty ? e.str("title", "Untitled") : t)
            case "type": f["type"] = .string(d.type)
            case "body": f["body"] = .string(d.body)
            case "bpm": f["bpm"] = Double(d.bpm.trimmingCharacters(in: .whitespaces)).map { .number($0) } ?? .null
            case "tags": f["tags"] = .array(d.tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { .string($0) })
            case "key": f["key"] = opt(d.key)
            case "time_sig": f["time_sig"] = opt(d.time_sig)
            case "tuning": f["tuning"] = opt(d.tuning)
            case "project_id": f["project_id"] = opt(d.project_id)
            case "audio_ref": f["audio_ref"] = opt(d.audio_ref)
            default: break
            }
        }
        if !f.isEmpty { _ = await engine.update(ideaId, fields: f) }
        savedAt = Date()
    }
}

/// A hum the hub did not get, kept in Application Support/hum-unsent as `<client id>.wav` (a take is recorded to a
/// temporary file, which the system may clear). The client id stays with the file, so a take sent again after a lost
/// answer brings back the idea already made from it instead of a second one.
struct UnsentHum: Identifiable, Equatable {
    var id: String
    var url: URL
    var at: Date

    var label: String { "Unsent take, \(at.formatted(date: .omitted, time: .shortened))" }

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("hum-unsent", isDirectory: true)
    }

    /// Every kept take, oldest first.
    static func load() -> [UnsentHum] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { $0.pathExtension == "wav" }.map { url in
            let at = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
            return UnsentHum(id: url.deletingPathExtension().lastPathComponent, url: url, at: at)
        }
        .sorted { $0.at < $1.at }
    }

    /// Moves a take into the folder (a take already there stays where it is). Nil when the file is gone.
    static func keep(_ url: URL, clientId: String) -> UnsentHum? {
        let fm = FileManager.default
        let dest = folder.appendingPathComponent("\(clientId).wav")
        if url.standardizedFileURL != dest.standardizedFileURL {
            guard fm.fileExists(atPath: url.path) else { return nil }
            // Complete protection: an unsent take is offered again by the open Music screen only.
            DataProtection.folder(folder, .complete)
            try? fm.removeItem(at: dest)
            // When it cannot be moved it is still offered from where it is, until Music is left.
            do { try fm.moveItem(at: url, to: dest) } catch { return UnsentHum(id: clientId, url: url, at: Date()) }
            // A moved file keeps the class it had; this one is closed now.
            DataProtection.protect(dest, .complete)
        }
        guard fm.fileExists(atPath: dest.path) else { return nil }
        return UnsentHum(id: clientId, url: dest, at: Date())
    }
}
