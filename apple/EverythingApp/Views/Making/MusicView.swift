import SwiftUI
import Combine
import EACore

/// What Music says with no ideas yet. The line to type in is above it on a narrow screen; in a wide window it is
/// in the list beside this one, so the words name where it is instead.
private struct NoIdeasYet: View {
    @Environment(\.listsSideBySide) private var beside
    var body: some View {
        Group {
            if beside {
                Text("No ideas yet. Type a line in the list beside this one, for example Am F C G 6/8 112bpm, and press Save, or press Hum Song.")
            } else {
                Text("No ideas yet. Type a line above, for example Am F C G 6/8 112bpm, and press Save, or press Hum Song.")
            }
        }
        .foregroundStyle(.secondary)
    }
}

/// Music (gnomecannon/aeneas#13): one block of actions (a line to type and Hum Song), the Projects row that opens
/// Music's Projects page, then the ideas grouped by type with a status filter. Cheat sheets and checklists are notes
/// in Music/Reference, pointed to under the ideas.
struct MusicView: View {
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var hum = MusicHum()
    @State private var opened: String?
    @State private var filter = ""

    private var all: [Entity] { engine.list(.music_idea) }
    private var projectCount: Int { engine.list(.project).filter { $0.str("area") == "music" }.count }
    private var groups: [(type: String, items: [Entity])] {
        Making.musicTypes.compactMap { t in
            let items = all.filter { $0.str("type") == t && (filter.isEmpty || $0.str("status", "idea") == filter) }.sorted { $0.updated_at > $1.updated_at }
            return items.isEmpty ? nil : (t, items)
        }
    }

    var body: some View {
        // A wide window: the actions and Projects on the left, the ideas by type on the right, each a list of its own
        // (SplitList).
        SplitList {
            SwiftUI.Section {
                MusicAddRows(hum: hum, projectId: nil)
            } footer: {
                Text("Chords, time signature, bpm and tuning are picked out; the rest is the title.")
            }
            SwiftUI.Section {
                PageLink { MusicProjectsView() } label: {
                    LabeledContent {
                        Text(Making.plural(projectCount, "project"))
                    } label: {
                        Label("Projects", systemImage: "square.stack")
                    }
                }
            }
        } second: {
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
                    SwiftUI.Section {
                        Text("Nothing with that status.").foregroundStyle(.secondary)
                    } footer: { ReferenceNotesLine() }
                }
                ForEach(groups, id: \.type) { g in
                    SwiftUI.Section {
                        ForEach(g.items) { e in MusicLink(idea: e).deleteSwipe(e.id) }
                    } header: {
                        // "Riffs (4)": the type and how many ideas it holds. It read "Riff 4", like an idea's name.
                        Text("\(Making.musicTypeHeading(g.type)) (\(g.items.count))")
                    } footer: {
                        if g.type == groups.last?.type { ReferenceNotesLine() }
                    }
                }
            } else {
                SwiftUI.Section { NoIdeasYet() } footer: { ReferenceNotesLine() }
            }
        }
        .navigationTitle("Music")
        .refreshable { await engine.sync() }
        .pageDestination(item: $opened) { MusicIdeaView(ideaId: $0) }
        .musicHum(hum, opened: $opened)
    }
}

/// Where the reference sheets went: rarely looked for, so one line at the foot of Music rather than a row of its own.
private struct ReferenceNotesLine: View {
    var body: some View { Text("Cheat sheets and checklists are notes, in Notes under Music, Reference.") }
}

/// Music's Projects page (gnomecannon/aeneas#13): each project a release in the making (an album, an EP or a single),
/// a card that opens to its ideas and hummed takes, with the line and Hum Song that add to it. Cards start closed; the
/// ones opened stay open on this device. New project is at the top, and a project started here opens at once.
struct MusicProjectsView: View {
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var hum = MusicHum()
    @AppStorage("music.projects.open") private var openRaw = ""
    @State private var opened: String?
    @State private var naming = false
    @State private var newProject = ""

    private var cards: [MusicProjects.Card] { MusicProjects.cards(projects: engine.list(.project), ideas: engine.list(.music_idea)) }
    private var openSet: Set<String> { Set(openRaw.split(separator: "\n").map(String.init)) }

    private func setOpen(_ id: String, _ open: Bool) {
        var s = openSet
        if open { s.insert(id) } else { s.remove(id) }
        openRaw = s.sorted().joined(separator: "\n")
    }

    var body: some View {
        List {
            SwiftUI.Section {
                Button { naming = true } label: { Label("New project", systemImage: "plus") }
            } footer: {
                Text("A project is a release in the making: an album, an EP or a single, with its ideas and hummed takes.")
            }
            if cards.isEmpty {
                SwiftUI.Section { Text("No projects yet. Tap New project and give it a name.").foregroundStyle(.secondary) }
            }
            ForEach(cards) { c in
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: Binding(get: { openSet.contains(c.id) }, set: { setOpen(c.id, $0) })) {
                        MusicProjectCardRows(card: c, hum: hum)
                    } label: {
                        MusicProjectLabel(card: c)
                    }
                }
            }
        }
        .navigationTitle("Projects")
        .refreshable { await engine.sync() }
        .alert("New project", isPresented: $naming) {
            TextField("An album, an EP or a single", text: $newProject)
            Button("Start") {
                let name = newProject.trimmingCharacters(in: .whitespaces)
                newProject = ""
                guard !name.isEmpty else { return }
                Task {
                    if let p = await engine.create(kind: .project, fields: ["name": .string(name), "status": "active", "definition_of_done": "", "area": "music"]) {
                        setOpen(p.id, true)
                    }
                }
            }
            Button("Cancel", role: .cancel) { newProject = "" }
        }
        .pageDestination(item: $opened) { MusicIdeaView(ideaId: $0) }
        .musicHum(hum, opened: $opened)
    }
}

/// A project's card, closed: its name, its status and what it holds.
private struct MusicProjectLabel: View {
    var card: MusicProjects.Card

    private var holds: String {
        let parts = [card.ideas.isEmpty ? nil : Making.plural(card.ideas.count, "idea"),
                     card.takes.isEmpty ? nil : Making.plural(card.takes.count, "hummed take")].compactMap { $0 }
        return parts.isEmpty ? "Empty" : parts.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(StyleGuard.dashes(card.project.str("name", "Untitled"))).font(.headline)
                Spacer(minLength: 6)
                MakingBadge.project(card.project.str("status", "active"))
            }
            Text(holds).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A project's card, open: when it is done, the line and Hum Song that add to it, its ideas, its hummed takes, and
/// its page in Projects (status, tasks and plan).
private struct MusicProjectCardRows: View {
    var card: MusicProjects.Card
    var hum: MusicHum

    var body: some View {
        let done = card.project.str("definition_of_done")
        if !done.isEmpty { Text("Done when: \(StyleGuard.dashes(done))").font(.subheadline) }
        MusicAddRows(hum: hum, projectId: card.id)
        if !card.ideas.isEmpty {
            Text("Ideas (\(card.ideas.count))").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(card.ideas) { MusicLink(idea: $0) }
        }
        if !card.takes.isEmpty {
            Text("Hummed takes (\(card.takes.count))").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(card.takes) { MusicLink(idea: $0) }
        }
        PageLink { ProjectDetailView(projectId: card.id) } label: {
            Label("Status, tasks and plan", systemImage: "hammer")
        }
    }
}

/// Music's actions, on the Music screen and in each card on its Projects page: one line (chords, time signature, bpm
/// and tuning are picked out, the rest is the title) and Hum Song. In a card (`projectId`), what is added goes into
/// that project. These are rows of the list section they are in.
struct MusicAddRows: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var hum: MusicHum
    var projectId: String?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var saved: String?
    @FocusState private var focused: Bool

    private var preview: Making.MusicQuick? {
        text.trimmingCharacters(in: .whitespaces).isEmpty ? nil : Making.parseMusicQuick(text)
    }

    var body: some View {
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
                .accessibilityLabel(projectId == nil ? "Quick capture" : "New idea in this project")
            Button("Save") { Task { await save() } }
                .buttonStyle(.themedProminent)
                .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        if let p = preview {
            let meta = Making.musicMeta(key: p.key, bpm: p.bpm, time: p.time_sig, tuning: p.tuning)
            Text("\(p.type.capitalized): \(p.title)\(meta.isEmpty ? "" : ", " + meta.joined(separator: ", "))")
                .font(.caption).foregroundStyle(.secondary)
        }
        if let s = saved { Label("Saved \(s)", systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.okText) }
        if let e = error { MakingErrorLine(text: e) }
        if model.isOn(.music) { HumSongRows(hum: hum, recorder: hum.recorder, projectId: projectId) }
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
                let e = try await c.musicQuick(t, projectId: projectId)
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
            if let p = projectId { f["project_id"] = .string(p) }
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

/// Hum Song in a block of Music's actions: the button with an optional tempo beside it (the hub finds one when it is
/// empty), the recording while it runs, and takes the hub did not get. One recorder serves the whole screen
/// (`MusicHum`); the block that started it shows the recording.
private struct HumSongRows: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var hum: MusicHum
    @ObservedObject var recorder: HumRecorder
    var projectId: String?

    /// This block started the recording or sending under way. On Music itself there is only the one block.
    private var mine: Bool { projectId == nil || hum.project == projectId }

    var body: some View {
        if recorder.recording, mine {
            HumRecordingPanel(recorder: recorder)
        } else if hum.sending, mine {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Sending the recording").foregroundStyle(.secondary)
            }
        } else {
            HStack(spacing: 8) {
                Button { Task { await hum.start(project: projectId) } } label: {
                    Label { Text(Hum.buttonTitle) } icon: { HumSongGlyph().frame(width: 22, height: 22) }
                }
                .buttonStyle(.themedProminent)
                .tint(.red)
                .disabled(recorder.recording || hum.sending)
                Spacer(minLength: 8)
                TextField("BPM", text: $hum.tempo)
                    .multilineTextAlignment(.trailing)
                    .font(.body.monospaced())
                    .numericKeyboard()
                    .frame(maxWidth: 80)
                    .accessibilityLabel("Tempo for Hum Song, found by the hub when empty")
            }
        }
        if mine, let e = hum.error ?? recorder.error { MakingErrorLine(text: e) }
        if !recorder.recording, !hum.sending {
            ForEach(hum.unsent.filter { projectId == nil || $0.projectId == projectId }) { take in
                HStack {
                    Text(take.label).font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Button("Send again") { Task { await hum.sendAgain(take, engine: engine) } }.buttonStyle(.bordered)
                    Button("Discard", role: .destructive) { hum.discard(take) }
                        .buttonStyle(.borderless)
                }
            }
        }
    }
}

/// Hum Song for one Music screen: one recorder for the screen, so leaving the screen stops a recording, and the takes
/// the hub did not get. `project` is the project the take under way goes into ("" for none), so the card on Music's
/// Projects page that started it is the one that shows it.
@MainActor
final class MusicHum: ObservableObject {
    let recorder = HumRecorder()
    @Published var tempo = ""
    @Published private(set) var project: String?
    @Published private(set) var sending = false
    @Published var error: String?
    /// Takes the hub did not get, kept on disk until sent or discarded. One take was held in memory, so it was lost on
    /// leaving Music, and a second failed take replaced the first.
    @Published private(set) var unsent: [UnsentHum] = []
    /// The idea the last take made, for the screen to open.
    @Published var made: String?
    private var relay: AnyCancellable?

    init() {
        // The recorder's changes are this one's, so a screen that watches this sees a recording start and end.
        relay = recorder.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    func start(project: String?) async {
        self.project = project ?? ""
        error = nil
        await recorder.start()
    }

    /// Takes kept from before, less any whose file is gone (sent or discarded on the other Music screen).
    func load() {
        unsent.removeAll { !FileManager.default.fileExists(atPath: $0.url.path) }
        for t in UnsentHum.load() where !unsent.contains(where: { $0.id == t.id }) { unsent.append(t) }
    }

    /// A new take: its client id is the one Hum.send gives a take, kept with the file so a resend is the same take.
    func send(_ take: HumTake, engine: SyncEngine) async {
        await send(url: take.url, clientId: "app-\(take.id.uuidString.lowercased())", engine: engine)
    }

    func sendAgain(_ take: UnsentHum, engine: SyncEngine) async {
        project = take.projectId ?? ""
        await send(url: take.url, clientId: take.id, engine: engine)
    }

    func discard(_ take: UnsentHum) {
        UnsentHum.forget(take.id, url: take.url)
        unsent.removeAll { $0.id == take.id }
        if unsent.isEmpty { error = nil }
    }

    private func send(url: URL, clientId: String, engine: SyncEngine) async {
        let projectId = project.flatMap { $0.isEmpty ? nil : $0 }
        sending = true
        error = nil
        defer { sending = false }
        do {
            guard let c = engine.client else { throw HubError.notConfigured }
            let e = try await c.uploadHum(fileURL: url, bpm: Hum.tempo(tempo), projectId: projectId, fromCapture: false, clientId: clientId)
            await engine.absorb(e)
            engine.moment(.create, kind: .music_idea)
            UnsentHum.forget(clientId, url: url)
            unsent.removeAll { $0.id == clientId }
            made = e.id
        } catch {
            if let kept = UnsentHum.keep(url, clientId: clientId, projectId: projectId), !unsent.contains(where: { $0.id == clientId }) { unsent.append(kept) }
            self.error = "The hum was not sent. \(Making.message(error))"
        }
    }
}

extension View {
    /// A Music screen's side of Hum Song: a finished take goes to the hub at once and its idea opens; takes kept from
    /// before are offered again; leaving the screen stops a recording.
    func musicHum(_ hum: MusicHum, opened: Binding<String?>) -> some View { modifier(MusicHumScreen(hum: hum, opened: opened)) }
}

private struct MusicHumScreen: ViewModifier {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var hum: MusicHum
    @Binding var opened: String?

    func body(content: Content) -> some View {
        content
            .onChange(of: hum.recorder.finished) { _, take in
                guard let take else { return }
                hum.recorder.finished = nil
                Task { await hum.send(take, engine: engine) }
            }
            .onChange(of: hum.made) { _, id in
                guard let id else { return }
                hum.made = nil
                opened = id
            }
            .onAppear { hum.load() }
            .onDisappear { hum.recorder.cancel() }
    }
}

struct MusicLink: View {
    var idea: Entity
    var body: some View {
        PageLink { MusicIdeaView(ideaId: idea.id) } label: { MusicRow(idea: idea) }
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
            // When it was made comes first: two hums with the same key and tempo are told apart by it.
            HStack(spacing: 8) {
                Text(dateLabel(idea.created_at)).font(.caption)
                if !meta.isEmpty { Text(meta.joined(separator: "  ")).font(.caption.monospaced()) }
                if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")).font(.caption) }
            }
            .foregroundStyle(.secondary)
            .lineLimit(1)
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
                if let made = ISO.date(e.created_at) {
                    Text("\(e.str("audio_ref").hasPrefix("hum:") ? "Recorded" : "Added") \(made.shortDateTime)")
                        .font(.caption).foregroundStyle(.secondary)
                }
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
    /// The project the take goes into (a card on Music's Projects page), nil for none.
    var projectId: String? = nil

    var label: String { "Unsent take, \(at.formatted(date: .omitted, time: .shortened))" }

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("hum-unsent", isDirectory: true)
    }

    /// Which project each kept take goes into, by client id (ids only, no names).
    private static let projectsKey = "hum.unsent.projects"
    private static var projects: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: projectsKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: projectsKey) }
    }

    /// Every kept take, oldest first.
    static func load() -> [UnsentHum] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let map = Self.projects
        return files.filter { $0.pathExtension == "wav" }.map { url in
            let at = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
            let id = url.deletingPathExtension().lastPathComponent
            return UnsentHum(id: id, url: url, at: at, projectId: map[id])
        }
        .sorted { $0.at < $1.at }
    }

    /// Moves a take into the folder (a take already there stays where it is), remembering its project. Nil when the
    /// file is gone.
    static func keep(_ url: URL, clientId: String, projectId: String? = nil) -> UnsentHum? {
        guard let kept = move(url, clientId: clientId) else { return nil }
        if let projectId { projects[clientId] = projectId }
        return UnsentHum(id: kept.id, url: kept.url, at: kept.at, projectId: projectId)
    }

    /// A take sent or discarded: its file and the note of its project go.
    static func forget(_ id: String, url: URL) {
        try? FileManager.default.removeItem(at: url)
        if projects[id] != nil { projects[id] = nil }
    }

    private static func move(_ url: URL, clientId: String) -> UnsentHum? {
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
