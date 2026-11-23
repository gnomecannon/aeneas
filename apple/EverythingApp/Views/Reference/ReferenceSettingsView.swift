import SwiftUI
import EACore

/// Settings, Reference: what the hub keeps (sources by group, languages, pictures, Wikipedia intros or full text),
/// the space it takes against what is free, the downloads with their progress, the books on the hub, and when and
/// how fast it downloads. The hub keeps the choices for every device; this screen writes them and shows its answer.
struct ReferenceSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @ObservedObject private var library = ReferenceLibrary.shared
    @State private var settings: ReferenceSettings?
    @State private var plan: ReferencePlan?
    @State private var problem: String?
    @State private var busy: String?
    @State private var removing: ReferenceBook?
    @State private var openGroups: Set<String> = []
    /// Only the newest save's answer is taken, so a slow answer never undoes a later change.
    @State private var saveRun = 0

    private static let speeds: [Double] = [5, 10, 25, 50, 100, 250]

    var body: some View {
        Group {
            if model.config.sampleMode {
                Form { SwiftUI.Section { Text(ReferenceSample.text).foregroundStyle(.secondary) }.themedRow() }
            } else {
                form
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Reference")
    }

    private var form: some View {
        Form {
            if let problem {
                SwiftUI.Section { Text(problem).font(.callout).foregroundStyle(.warnText) }.themedRow()
            }
            if let s = settings {
                space
                downloads
                ForEach(library.catalog?.grouped ?? []) { g in group(g, s) }
                if library.catalog == nil {
                    SwiftUI.Section { HStack { ProgressView().controlSize(.small); Text("Reading the list of sources").foregroundStyle(.secondary) } }.themedRow()
                }
                languages(s)
                pictures(s)
                books
                schedule(s)
            } else if problem == nil {
                SwiftUI.Section { ProgressView().frame(maxWidth: .infinity) }.themedRow()
            }
        }
        .task {
            await load()
            await poll()
        }
        .refreshable { await load() }
        .onChange(of: library.status?.plan) { _, p in if let p { plan = p } }
        .confirmationDialog(removing.map { "Remove \($0.title)?" } ?? "Remove?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { b in
            Button("Remove", role: .destructive) { remove(b) }
            Button("Cancel", role: .cancel) {}
        } message: { b in
            Text("Its file is deleted from your hub, freeing \(ReferenceText.size(b.bytes)). It is not downloaded again until you choose it again.")
        }
    }

    // MARK: space and downloads

    @ViewBuilder private var space: some View {
        if let p = plan {
            SwiftUI.Section {
                LabeledContent("Your choices", value: ReferenceText.size(p.wanted_bytes))
                if p.to_download_bytes > 0 { LabeledContent("Still to download", value: ReferenceText.size(p.to_download_bytes)) }
                LabeledContent("Free on the hub", value: ReferenceText.size(p.free_bytes))
                if p.free_bytes > 0, p.to_download_bytes > 0 {
                    ProgressView(value: min(1, Double(p.to_download_bytes) / Double(p.free_bytes)))
                        .tint(p.fits ? nil : AnyShapeStyle(.warn))
                        .accessibilityLabel("Still to download, against the free space")
                }
                if let r = library.status?.reader { LabeledContent("Reader on the hub", value: Self.readerState(r)) }
            } header: {
                Text("Space")
            } footer: {
                Text(p.fits
                     ? "Each download also leaves 7 GB free on the hub, so its disk never fills up."
                     : "This does not fit on the hub. Choose fewer sources or languages, or text only, or free some space on the hub.")
            }
            .themedRow()
        }
    }

    @ViewBuilder private var downloads: some View {
        let status = library.status
        let list = status?.downloads ?? []
        SwiftUI.Section {
            if list.isEmpty {
                Text(status?.readableBooks.isEmpty == false ? "Everything chosen is on the hub." : "Nothing is downloading.").foregroundStyle(.secondary)
            }
            ForEach(list) { d in ReferenceDownloadRow(download: d, language: library.languageName(d.lang)) }
            if list.contains(where: { !["paused", "failed"].contains($0.state) }) {
                Button(busy == "pause" ? "Pausing" : "Pause downloads") { act("pause") { try await $0.pauseReferenceDownloads() } }
                    .disabled(busy != nil)
            }
            if status?.paused == true {
                Button(busy == "resume" ? "Resuming" : "Resume downloads") { act("resume") { try await $0.resumeReferenceDownloads() } }
                    .disabled(busy != nil)
            }
            Button(busy == "check" ? "Checking" : "Check now") { act("check") { try await $0.checkReferenceNow() } }
                .disabled(busy != nil)
        } header: {
            Text("Downloads")
        } footer: {
            Text(nextCheck)
        }
        .themedRow()
    }

    private var nextCheck: String {
        let when = dateLabel(library.status?.next_check)
        let base = "Check now reads the catalog and gets what is missing or newer."
        return when.isEmpty ? base : "\(base) The next weekly check is \(when)."
    }

    // MARK: sources

    private func group(_ g: ReferenceSourceGroup, _ s: ReferenceSettings) -> some View {
        let kept = g.sources.filter { s.sources.contains($0.id) }
        return SwiftUI.Section {
            DisclosureGroup(isExpanded: Binding(get: { openGroups.contains(g.title) }, set: { if $0 { openGroups.insert(g.title) } else { openGroups.remove(g.title) } })) {
                ForEach(g.sources) { src in sourceRow(src, s) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(g.title).font(.headline)
                        Spacer()
                        Text("\(kept.count) of \(g.sources.count) kept").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(g.sources.map(\.title).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .themedRow()
    }

    @ViewBuilder private func sourceRow(_ src: ReferenceSource, _ s: ReferenceSettings) -> some View {
        let chosen = s.sources.contains(src.id)
        Toggle(isOn: Binding(get: { chosen }, set: { on in
            var list = s.sources.filter { $0 != src.id }
            if on { list.append(src.id) }
            save(ReferenceSettingsChange(sources: list))
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(src.title)
                if !src.summary.isEmpty { Text(src.summary).font(.caption).foregroundStyle(.secondary) }
                Text(sizeLine(src, s)).font(.caption).foregroundStyle(chosen ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            }
        }
        .toggleStyle(.switch)
        if chosen, src.offersPictures, !(src.id == ReferencePlanner.wikipedia && s.wikipedia == "intros") {
            Picker("Pictures in \(src.title)", selection: Binding(get: { PictureChoice(s.overrides[src.id]?.images) }, set: { setPictures($0, for: src, s) })) {
                Text("Same as all sources").tag(PictureChoice.same)
                Text("With pictures").tag(PictureChoice.with)
                Text("Text only").tag(PictureChoice.without)
            }
            .font(.callout)
            .padding(.leading, 12)
        }
    }

    /// What a source comes to with the choices as they are: its size, its languages and its license.
    private func sizeLine(_ src: ReferenceSource, _ s: ReferenceSettings) -> String {
        let wanted = ReferencePlanner.wanted(src, settings: s)
        if wanted.isEmpty {
            let n = src.languages.count
            if n == 0 { return "Not in the catalog right now" }
            return "Not in your languages. It comes in \(n == 1 ? "1 other language" : "\(n) other languages")."
        }
        let names = wanted.map(\.language.name)
        var parts = [ReferenceText.size(ReferencePlanner.bytes(src, settings: s)),
                     names.count <= 3 ? ListFormatter.localizedString(byJoining: names) : "\(names.count) languages"]
        if wanted.count == 1, let f = ReferenceText.flavour(wanted[0].book.flavour) { parts.append(f) }
        if !src.license.isEmpty { parts.append(src.license) }
        return parts.joined(separator: ", ")
    }

    private enum PictureChoice: Hashable {
        case same, with, without
        init(_ images: Bool?) { self = images.map { $0 ? .with : .without } ?? .same }
        var images: Bool? { self == .same ? nil : self == .with }
    }

    private func setPictures(_ c: PictureChoice, for src: ReferenceSource, _ s: ReferenceSettings) {
        var all = s.overrides
        var o = all[src.id] ?? ReferenceOverride()
        o.images = c.images
        if o.isEmpty { all.removeValue(forKey: src.id) } else { all[src.id] = o }
        save(ReferenceSettingsChange(overrides: all))
    }

    // MARK: languages and pictures

    private func languages(_ s: ReferenceSettings) -> some View {
        let names = s.languages.map { library.languageName($0) }
        return SwiftUI.Section {
            PageLink {
                ReferenceLanguagesView(chosen: Binding(get: { settings?.languages ?? s.languages }, set: { save(ReferenceSettingsChange(languages: $0)) }),
                                       all: library.catalog?.languages ?? [], catalog: library.catalog)
            } label: {
                LabeledContent("Languages", value: names.count <= 3 ? ListFormatter.localizedString(byJoining: names) : "\(names.count) languages")
            }
        } footer: {
            Text("Each source downloads in these languages where it has them.")
        }
        .themedRow()
    }

    private func pictures(_ s: ReferenceSettings) -> some View {
        let wiki = library.catalog?.source(ReferencePlanner.wikipedia)
        return SwiftUI.Section {
            Toggle("Pictures", isOn: Binding(get: { s.images }, set: { save(ReferenceSettingsChange(images: $0)) }))
                .toggleStyle(.switch)
            if wiki != nil {
                Picker("Wikipedia", selection: Binding(get: { s.wikipedia }, set: { save(ReferenceSettingsChange(wikipedia: $0)) })) {
                    Text("Full text").tag("text")
                    Text("Intros only").tag("intros")
                }
            }
        } header: {
            Text("Pictures and Wikipedia")
        } footer: {
            Text(picturesFooter(wiki, s))
        }
        .themedRow()
    }

    /// Says what pictures and intros cost, with Wikipedia's own sizes for the chosen languages when they are known.
    private func picturesFooter(_ wiki: ReferenceSource?, _ s: ReferenceSettings) -> String {
        var text = "Books with pictures are several times larger. A source can have its own choice once it is kept."
        if let wiki {
            var full = s, intros = s
            full.wikipedia = "text"
            intros.wikipedia = "intros"
            let a = ReferencePlanner.bytes(wiki, settings: intros), b = ReferencePlanner.bytes(wiki, settings: full)
            text += " Intros only keeps the start of each Wikipedia article"
            text += a > 0 && b > 0 ? ": \(ReferenceText.size(a)) instead of \(ReferenceText.size(b)) in your languages." : "."
        }
        return text
    }

    // MARK: books

    @ViewBuilder private var books: some View {
        let list = library.status?.books ?? []
        if !list.isEmpty {
            SwiftUI.Section {
                ForEach(list) { b in
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b.title)
                            Text(bookLine(b)).font(.caption).foregroundStyle(.secondary)
                            if b.state == "update" { Text("A newer copy is downloading.").font(.caption).foregroundStyle(.secondary) }
                            if b.state == "removing" { Text("Being removed.").font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 8)
                        Button("Remove", role: .destructive) { removing = b }
                            .buttonStyle(.borderless)
                            .disabled(b.state == "removing" || busy != nil)
                    }
                }
            } header: {
                Text("On your hub")
            }
            .themedRow()
        }
    }

    private func bookLine(_ b: ReferenceBook) -> String {
        var parts = [library.languageName(b.lang)]
        if let f = ReferenceText.flavour(b.flavour) { parts.append(f) }
        if !b.date.isEmpty { parts.append(ReferenceText.archiveDate(b.date)) }
        parts.append(ReferenceText.size(b.bytes))
        if b.articles > 0 { parts.append("\(b.articles.formatted()) articles") }
        if !b.fulltext { parts.append("titles only") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    // MARK: schedule

    private func schedule(_ s: ReferenceSettings) -> some View {
        SwiftUI.Section {
            Picker("Download", selection: Binding(get: { s.schedule }, set: { save(ReferenceSettingsChange(schedule: $0)) })) {
                Text("At night").tag("nights")
                Text("Any time").tag("any")
            }
            Picker("Speed limit", selection: Binding(get: { s.max_mbps ?? 0 }, set: { save(ReferenceSettingsChange(max_mbps: .some($0 > 0 ? $0 : nil))) })) {
                Text("No limit").tag(0.0)
                ForEach(Self.speeds, id: \.self) { v in Text("\(Int(v)) Mbps").tag(v) }
                if let m = s.max_mbps, m > 0, !Self.speeds.contains(m) { Text("\(m.formatted()) Mbps").tag(m) }
            }
        } header: {
            Text("When and how fast")
        } footer: {
            Text("At night means 01:00 to 07:00 on the hub, for updates; a first download starts at once. Downloads also wait while a game runs on the hub, and while its disk is low.")
        }
        .themedRow()
    }

    // MARK: talking to the hub

    private func load() async {
        guard let c = engine.client else { problem = "Connect your hub in Settings first."; return }
        do {
            let a = try await c.referenceSettings()
            settings = a.settings
            if let p = a.plan { plan = p }
            problem = nil
        } catch {
            guard !Task.isCancelled else { return }
            problem = ReferenceLibrary.message(error)
        }
        await library.refresh(c, catalog: true)
        if let p = library.status?.plan { plan = p }
    }

    /// Every 2 seconds while a download moves, every 20 otherwise, while this screen shows.
    private func poll() async {
        while !Task.isCancelled {
            let fast = library.status?.downloading ?? false
            try? await Task.sleep(for: .seconds(fast ? 2 : 20))
            guard !Task.isCancelled else { return }
            await library.refreshStatus(engine.client)
        }
    }

    /// The change shows at once; the hub's answer then replaces it, or it goes back with the reason.
    private func save(_ change: ReferenceSettingsChange) {
        guard let c = engine.client, let before = settings else { return }
        settings = change.applied(to: before)
        problem = nil
        saveRun += 1
        let run = saveRun
        Task {
            do {
                let a = try await c.setReferenceSettings(change)
                guard run == saveRun else { return }
                settings = a.settings
                if let p = a.plan { plan = p }
                await library.refreshStatus(c)
            } catch {
                guard run == saveRun else { return }
                settings = before
                problem = "Could not save: \(ReferenceLibrary.message(error))"
            }
        }
    }

    private func act(_ name: String, _ work: @escaping (HubClient) async throws -> Void) {
        guard let c = engine.client, busy == nil else { return }
        busy = name
        problem = nil
        Task {
            defer { busy = nil }
            do {
                try await work(c)
                await library.refreshStatus(c)
            } catch {
                problem = "Could not do that: \(ReferenceLibrary.message(error))"
            }
        }
    }

    private func remove(_ b: ReferenceBook) {
        removing = nil
        act("remove") { c in
            try await c.removeReferenceBook(b.name)
            await load()
        }
    }

    static func readerState(_ r: ReferenceStatus.Reader) -> String {
        switch r.state {
        case "ready": return "Ready"
        case "installing": return "Installing"
        case "starting": return "Starting"
        case "failed": return (r.error ?? "").isEmpty ? "Stopped" : "Stopped: \(r.error!)"
        default: return "Starts once a book is ready"
        }
    }
}

/// Every language a source comes in, searchable by its English or its own name; the chosen ones first.
struct ReferenceLanguagesView: View {
    @Binding var chosen: [String]
    var all: [ReferenceLanguage]
    var catalog: ReferenceSources?
    @State private var query = ""

    private var matches: [ReferenceLanguage] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return all }
        return all.filter { l in [l.name, l.native, l.code, l.tag].contains { $0.localizedStandardContains(q) } }
    }

    var body: some View {
        List {
            if query.isEmpty {
                let picked = all.filter { chosen.contains($0.code) }
                if !picked.isEmpty {
                    SwiftUI.Section {
                        ForEach(picked) { row($0) }
                    } header: {
                        Text("Chosen")
                    } footer: {
                        if chosen.count == 1 { Text("Keep at least one language.") }
                    }
                    .themedRow()
                }
            }
            SwiftUI.Section(query.isEmpty ? "All languages" : "Matches") {
                ForEach(matches) { row($0) }
                if matches.isEmpty { Text("No language matches \u{201C}\(query)\u{201D}.").foregroundStyle(.secondary) }
            }
            .themedRow()
        }
        .searchable(text: $query, prompt: "Search languages")
        .themedScreen()
        .navigationTitle("Languages")
    }

    private func row(_ l: ReferenceLanguage) -> some View {
        let on = chosen.contains(l.code)
        let n = catalog?.sourceCount(language: l.code) ?? 0
        return Button {
            if on { if chosen.count > 1 { chosen = chosen.filter { $0 != l.code } } } else { chosen = chosen + [l.code] }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(l.name)
                    if !l.native.isEmpty, l.native != l.name { Text(l.native).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if n > 0 { Text(n == 1 ? "1 source" : "\(n) sources").font(.caption).foregroundStyle(.secondary) }
                Image(systemName: "checkmark").foregroundStyle(.tint).opacity(on ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
