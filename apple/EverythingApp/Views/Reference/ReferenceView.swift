import SwiftUI
import EACore

/// Search as you type: titles from `/reference/suggest` about 120 ms after a key, full text from `/reference/search`
/// about 250 ms after. A newer query or filter cancels the older work, and an answer that comes back for an older
/// query is dropped, so the list never shows older results over newer ones. More results come by offset.
@MainActor
final class ReferenceSearch: ObservableObject {
    @Published var query = "" { didSet { if query != oldValue { queryChanged() } } }
    /// Source ids to search in; empty means all.
    @Published var sources: Set<String> = [] { didSet { if sources != oldValue { filtersChanged() } } }
    /// Language codes to search in; empty means all.
    @Published var langs: Set<String> = [] { didSet { if langs != oldValue { filtersChanged() } } }

    @Published private(set) var suggestions: [ReferenceSuggestion] = []
    @Published private(set) var results: [ReferenceSearchResult] = []
    @Published private(set) var total = 0
    @Published private(set) var partial = false
    /// The words the results on screen are for; differs from the query while a newer search runs.
    @Published private(set) var resultsFor = ""
    @Published private(set) var searching = false
    @Published private(set) var loadingMore = false
    @Published private(set) var problem: String?

    var client: @MainActor () -> HubClient? = { nil }
    var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    var typing: Bool { !trimmed.isEmpty }
    /// The results on screen are for the words typed now.
    var current: Bool { resultsFor == trimmed && !searching }

    private var suggestRun = 0
    private var searchRun = 0
    private var suggestTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    private var moreTask: Task<Void, Never>?
    static let pageSize = 20

    private func queryChanged() {
        suggestRun += 1
        suggestTask?.cancel()
        let q = trimmed
        guard !q.isEmpty, let c = client() else {
            suggestions = []
            clearResults()
            return
        }
        let run = suggestRun
        suggestTask = Task {
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            let r = try? await c.referenceSuggest(q)
            guard !Task.isCancelled, run == self.suggestRun, let r else { return }
            self.suggestions = r.results
        }
        startSearch(q, client: c, delay: 250)
    }

    private func filtersChanged() {
        let q = trimmed
        guard !q.isEmpty, let c = client() else { return }
        startSearch(q, client: c, delay: 0)
    }

    private func clearResults() {
        searchRun += 1
        searchTask?.cancel()
        moreTask?.cancel()
        results = []
        total = 0
        partial = false
        resultsFor = ""
        searching = false
        loadingMore = false
        problem = nil
    }

    private func startSearch(_ q: String, client c: HubClient, delay: Int) {
        searchRun += 1
        searchTask?.cancel()
        moreTask?.cancel()
        loadingMore = false
        searching = true
        let run = searchRun, src = sources.sorted(), lg = langs.sorted()
        searchTask = Task {
            if delay > 0 { try? await Task.sleep(for: .milliseconds(delay)) }
            guard !Task.isCancelled else { return }
            do {
                let page = try await c.referenceSearch(q, sources: src, langs: lg, limit: Self.pageSize, offset: 0)
                guard !Task.isCancelled, run == self.searchRun else { return }
                self.results = Self.unique(page.results)
                self.total = page.total
                self.partial = page.partial
                self.problem = nil
            } catch {
                guard !Task.isCancelled, run == self.searchRun else { return }
                self.results = []
                self.total = 0
                self.partial = false
                self.problem = ReferenceLibrary.message(error)
            }
            self.resultsFor = q
            self.searching = false
        }
    }

    /// The next page, when the last result on screen comes into view.
    func loadMore() {
        guard !loadingMore, !searching, results.count < total, !resultsFor.isEmpty, resultsFor == trimmed, let c = client() else { return }
        let run = searchRun, q = resultsFor, offset = results.count, src = sources.sorted(), lg = langs.sorted()
        loadingMore = true
        moreTask = Task {
            let page = try? await c.referenceSearch(q, sources: src, langs: lg, limit: Self.pageSize, offset: offset)
            guard !Task.isCancelled, run == self.searchRun else { return }
            self.loadingMore = false
            guard let page else { self.total = self.results.count; return }
            var seen = Set(self.results.map(\.id))
            let fresh = page.results.filter { seen.insert($0.id).inserted }
            self.results += fresh
            // A page with nothing new is the end, whatever the total said.
            self.total = fresh.isEmpty ? self.results.count : max(page.total, self.results.count)
            self.partial = self.partial || page.partial
        }
    }

    private static func unique(_ list: [ReferenceSearchResult]) -> [ReferenceSearchResult] {
        var seen = Set<String>()
        return list.filter { seen.insert($0.id).inserted }
    }
}

/// The Reference screen: search first. Before typing, Continue reading (this device only), Random page and what is
/// on the hub; while typing, titles, then full text with highlighted snippets, narrowed by source and language.
struct ReferenceView: View {
    /// Debug screenshots (Mac, `-EAReferenceQuery` and `-EAReferenceOpen`): words to search for and a page to open
    /// when the screen first shows.
    var startQuery: String? = nil
    var startPage: ReferencePageLink? = nil
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @ObservedObject private var library = ReferenceLibrary.shared
    @ObservedObject private var history = ReferenceHistory.shared
    @StateObject private var search = ReferenceSearch()
    @Environment(\.eaTheme) private var theme
    @State private var began = false
    @State private var opened: ReferencePageLink?
    @State private var settingsOpen = false
    @State private var allRecents = false
    @State private var randomBusy = false
    @State private var randomProblem: String?
    @State private var selection: String?
    @FocusState private var searchFocused: Bool

    var body: some View {
        Group {
            if model.config.sampleMode && !Self.debugRows {
                List {
                    SwiftUI.Section {
                        Label("Reference", systemImage: Section.reference.symbol).font(.headline)
                        Text(ReferenceSample.text).font(.callout).foregroundStyle(.secondary)
                    }
                    .themedRow()
                }
            } else {
                searchList
            }
        }
        .navigationTitle("Reference")
        .pageDestination(item: $opened) { ReferenceReaderView(link: $0) }
        .pageDestination(isPresented: $settingsOpen) { ReferenceSettingsView() }
    }

    // MARK: the list

    #if DEBUG
    /// Debug screenshots (`-EAReferenceRows YES`, with the sample): the list with two books and three pages under
    /// Continue reading, the first chosen, so the chosen row can be seen under each theme with no hub.
    static let debugRows = UserDefaults.standard.bool(forKey: "EAReferenceRows")
    private func showDebugRows() {
        guard Self.debugRows else { return }
        library.take(ReferenceStatus(reader: .init(state: "ready"), books: [
            ReferenceBook(name: "wikipedia_en_all", lang: "eng", source: "wikipedia", title: "Wikipedia", articles: 6_400_000, state: "ready"),
            ReferenceBook(name: "wiktionary_en_all", lang: "eng", source: "wiktionary", title: "Wiktionary", articles: 1_200_000, state: "ready"),
        ]))
        let pages = [("Lighthouse", "A/Lighthouse"), ("Tide", "A/Tide"), ("Fresnel lens", "A/Fresnel_lens")]
        history.debugShow(pages.map { ReferenceRecent(book: "wikipedia_en_all", path: $0.1, title: $0.0, source: "wikipedia", lang: "eng") })
        selection = "c:" + ReferenceLink.key(book: "wikipedia_en_all", path: "A/Lighthouse")
    }
    #else
    static let debugRows = false
    private func showDebugRows() {}
    #endif

    private var searchList: some View {
        Group {
            #if os(macOS)
            List(selection: $selection) { rows }
                .onKeyPress(.return) { openSelected() ? .handled : .ignored }
                .onAppear { showDebugRows() }
            #else
            List { rows }
            #endif
        }
        #if os(iOS)
        .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        #else
        .searchable(text: $search.query, placement: .toolbar, prompt: prompt)
        #endif
        .searchFocused($searchFocused)
        .onSubmit(of: .search) { openTop() }
        .onKeyPress(characters: CharacterSet(charactersIn: "/")) { _ in
            searchFocused = true
            return .handled
        }
        .safeAreaInset(edge: .top, spacing: 0) { chips }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { settingsOpen = true } label: { Label("Reference settings", systemImage: "gearshape") }
                    .help("Settings, Reference")
            }
        }
        .task { await start() }
        .task(id: library.status?.downloading ?? false) { await followDownloads() }
        .refreshable { await library.refresh(engine.client, catalog: true) }
        .onChange(of: library.openRequest) { _, _ in takeRequests() }
        .onChange(of: library.queryRequest) { _, _ in takeRequests() }
    }

    @ViewBuilder private var rows: some View {
        if let p = library.problem, library.status == nil {
            SwiftUI.Section {
                Text(p).foregroundStyle(.secondary)
                Button(library.loading ? "Trying" : "Try again") { Task { await library.refresh(engine.client, catalog: true) } }
                    .disabled(library.loading)
            }
            .themedRow()
        } else if library.status == nil {
            SwiftUI.Section { ProgressView().frame(maxWidth: .infinity) }.themedRow()
        } else if library.readableBooks.isEmpty {
            nothingYet
        } else if search.typing {
            titles
            results
        } else {
            startSections
        }
    }

    /// The module is on and nothing is ready: what is coming, or where to choose.
    @ViewBuilder private var nothingYet: some View {
        let downloads = library.status?.downloads ?? []
        if downloads.isEmpty {
            SwiftUI.Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Nothing downloaded yet").font(.headline)
                    Text("Choose what your hub keeps, such as Wikipedia, a dictionary or medical guides. It downloads by itself, and then you can search and read it here with no internet.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Button { settingsOpen = true } label: { Label("Choose sources", systemImage: "books.vertical") }
            }
            .themedRow()
        } else {
            SwiftUI.Section {
                ForEach(downloads) { d in ReferenceDownloadRow(download: d, language: library.languageName(d.lang)) }
                Button { settingsOpen = true } label: { Label("Settings, Reference", systemImage: "gearshape") }
            } header: {
                Text("Downloading")
            } footer: {
                Text("Search starts when the first book is ready.")
            }
            .themedRow()
        }
    }

    /// Before typing: Continue reading, Random page, what is on the hub.
    @ViewBuilder private var startSections: some View {
        if let reader = library.status?.reader, reader.state != "ready" {
            SwiftUI.Section { Text(Self.readerNote(reader)).font(.callout).foregroundStyle(.secondary) }.themedRow()
        }
        let recents = history.recents
        if !recents.isEmpty {
            SwiftUI.Section {
                ForEach(allRecents ? recents : Array(recents.prefix(5))) { r in
                    Button { open(ReferencePageLink(book: r.book, path: r.path, title: r.title)) } label: {
                        ReferenceResultRow(title: r.title, snippet: nil, sourceId: r.source, sourceTitle: library.sourceTitle(r.source),
                                           detail: detail(lang: r.lang, book: r.book), progress: history.progress(r))
                    }
                    .buttonStyle(.plain)
                    .tag("c:" + r.id)
                    .chosenRow(selection == "c:" + r.id)
                    .contextMenu { Button(role: .destructive) { history.remove(r) } label: { Label("Remove from this list", systemImage: "minus.circle") } }
                    #if os(iOS)
                    .swipeActions { Button(role: .destructive) { history.remove(r) } label: { Label("Remove", systemImage: "minus.circle") } }
                    #endif
                }
                if recents.count > 5 {
                    Button(allRecents ? "Show fewer" : "Show all \(recents.count)") { withAnimation { allRecents.toggle() } }
                }
            } header: {
                Text("Continue reading")
            } footer: {
                Text("Kept on this device only.")
            }
            .themedRow()
        }
        SwiftUI.Section {
            Button { random() } label: {
                HStack {
                    Label(randomBusy ? "Finding a page" : "Random page", systemImage: "dice")
                    Spacer()
                    if randomBusy { ProgressView().controlSize(.small) }
                }
                .contentShape(Rectangle())
            }
            .disabled(randomBusy)
            .tag("random")
            .chosenRow(selection == "random")
            if let randomProblem { Text(randomProblem).font(.caption).foregroundStyle(.warnText) }
        } footer: {
            if !search.sources.isEmpty || !search.langs.isEmpty { Text("From the sources and languages chosen above.") }
        }
        .themedRow()
        SwiftUI.Section {
            ForEach(library.readySources) { s in
                Button { narrow(to: s.id) } label: { readySourceRow(s) }
                    .buttonStyle(.plain)
                    .tag("src:" + s.id)
                    .chosenRow(selection == "src:" + s.id)
                    .accessibilityHint("Searches only \(s.title)")
            }
            if let downloads = library.status?.downloads, !downloads.isEmpty {
                Button { settingsOpen = true } label: {
                    Label(Self.downloadsLine(downloads, library: library), systemImage: "arrow.down.circle")
                }
            }
        } header: {
            Text("On your hub")
        } footer: {
            Text("Searched and read on your hub, with no internet.")
        }
        .themedRow()
    }

    /// While typing: titles that the full-text results do not already show.
    @ViewBuilder private var titles: some View {
        let shown = Set(search.results.map(\.id))
        let list = search.suggestions.filter { inScope(source: $0.source, lang: $0.lang) && !shown.contains($0.id) }
        if !list.isEmpty {
            SwiftUI.Section("Titles") {
                ForEach(list) { s in
                    Button { open(ReferencePageLink(book: s.book, path: s.path, title: s.title)) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "doc.text").foregroundStyle(.secondary).font(.caption)
                            Text(s.title).lineLimit(1)
                            Spacer(minLength: 4)
                            ReferenceSourceBadge(title: library.sourceTitle(s.source), id: s.source)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .tag("s:" + s.id)
                    .chosenRow(selection == "s:" + s.id)
                }
            }
            .themedRow()
        }
    }

    /// While typing: full-text results, more as the last one comes into view.
    @ViewBuilder private var results: some View {
        SwiftUI.Section {
            if let p = search.problem, search.resultsFor == search.trimmed {
                Text(p).font(.callout).foregroundStyle(.warnText)
            } else if search.results.isEmpty, search.current {
                Text("Nothing found for \u{201C}\(search.trimmed)\u{201D}.").foregroundStyle(.secondary)
            }
            ForEach(search.results) { r in
                Button { open(ReferencePageLink(book: r.book, path: r.path, title: r.title)) } label: {
                    ReferenceResultRow(title: r.title, snippet: r.snippet.isEmpty ? nil : snippet(r.snippet), sourceId: r.source,
                                       sourceTitle: library.sourceTitle(r.source), detail: detail(lang: r.lang, book: r.book), progress: nil)
                }
                .buttonStyle(.plain)
                .tag("r:" + r.id)
                .chosenRow(selection == "r:" + r.id)
                .onAppear { if r.id == search.results.last?.id { search.loadMore() } }
            }
            if search.loadingMore { ProgressView().frame(maxWidth: .infinity) }
        } header: {
            HStack(spacing: 6) {
                Text(resultsHeader)
                if search.searching { ProgressView().controlSize(.mini) }
            }
        } footer: {
            if search.partial, search.current { Text("A book took too long to answer and was left out of these results.") }
        }
        .opacity(search.resultsFor == search.trimmed || search.results.isEmpty ? 1 : 0.55)
        .themedRow()
    }

    /// Source and language chips, shown while there is more than one of either.
    @ViewBuilder private var chips: some View {
        let sources = library.readySources
        let langs = library.readyLanguages
        if !model.config.sampleMode, sources.count > 1 || langs.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if sources.count > 1 {
                        ReferenceChip(text: "All sources", on: search.sources.isEmpty) { search.sources = [] }
                        ForEach(sources) { s in
                            ReferenceChip(text: s.title, on: search.sources.contains(s.id)) { toggle(&search.sources, s.id) }
                        }
                    }
                    if sources.count > 1, langs.count > 1 { Divider().frame(height: 18).padding(.horizontal, 2) }
                    if langs.count > 1 {
                        ReferenceChip(text: "All languages", on: search.langs.isEmpty) { search.langs = [] }
                        ForEach(langs, id: \.self) { l in
                            ReferenceChip(text: library.languageName(l), on: search.langs.contains(l)) { toggle(&search.langs, l) }
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
            // Only behind the chips: by default a style background reaches up through the top safe area and covered
            // the screen's large title (as on Tasks).
            .background(.bar, ignoresSafeAreaEdges: [])
        }
    }

    // MARK: words

    private var prompt: String {
        let s = library.readySources
        switch s.count {
        case 0: return "Search"
        case 1: return "Search \(s[0].title)"
        default: return "Search \(s[0].title) and more"
        }
    }

    private var resultsHeader: String {
        if search.searching && search.resultsFor != search.trimmed { return "Searching" }
        let n = search.total
        return n == 1 ? "1 result" : "\(n.formatted()) results"
    }

    /// The language and the archive date, for a row.
    private func detail(lang: String, book: String) -> String {
        [lang.isEmpty ? nil : library.languageName(lang), library.archiveDate(book: book)].compactMap { $0 }.joined(separator: ", ")
    }

    /// The snippet with its bold words in the text color, the rest in the quieter one.
    private func snippet(_ html: String) -> AttributedString {
        var s = ReferenceText.snippet(html)
        let bold = s.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.map(\.range)
        for r in bold { s[r].foregroundColor = theme?.text ?? .primary }
        return s
    }

    private func readySourceRow(_ s: ReferenceLibrary.ReadySource) -> some View {
        var langs: [String] = []
        for b in s.books {
            let name = library.languageName(b.lang)
            if !name.isEmpty, !langs.contains(name) { langs.append(name) }
        }
        let newest = s.books.map(\.date).max().map { ReferenceText.shortArchiveDate($0) }
        let titlesOnly = s.books.contains { !$0.fulltext }
        var parts = [ListFormatter.localizedString(byJoining: langs), "\(s.articles.formatted()) articles"]
        if let newest, !newest.isEmpty { parts.append(newest) }
        if titlesOnly { parts.append("titles only") }
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle().fill(ReferenceSourceBadge.color(s.id)).frame(width: 8, height: 8)
                Text(s.title).font(.body.weight(.medium))
                Spacer()
                if search.sources == [s.id] { Image(systemName: "checkmark").foregroundStyle(.tint).font(.caption.weight(.semibold)) }
            }
            Text(parts.filter { !$0.isEmpty }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    static func readerNote(_ r: ReferenceStatus.Reader) -> String {
        switch r.state {
        case "installing": return "Your hub is installing its reader. Searching starts in a minute or two."
        case "starting": return "Your hub's reader is starting. Searching starts in a moment."
        case "failed": return "Your hub's reader stopped" + ((r.error ?? "").isEmpty ? ". It starts again by itself." : ": \(r.error!)")
        default: return "Your hub's reader starts once a book is ready."
        }
    }

    static func downloadsLine(_ list: [ReferenceDownload], library: ReferenceLibrary) -> String {
        let moving = list.filter { $0.state == "downloading" }
        if let d = moving.first {
            return "Downloading \(library.sourceTitle(d.source)), \(Int((d.fraction * 100).rounded()))%"
        }
        return list.count == 1 ? "1 download waiting" : "\(list.count) downloads waiting"
    }

    // MARK: actions

    private func start() async {
        history.checkHub()
        search.client = { [weak engine] in engine?.client }
        if !began {
            began = true
            if let q = startQuery, !q.isEmpty { search.query = q }
            if let p = startPage { opened = p }
        }
        takeRequests()
        #if os(macOS)
        if search.query.isEmpty, opened == nil { searchFocused = true }
        #endif
        await library.refresh(engine.client)
    }

    /// While a download runs, the screen follows it now and then.
    private func followDownloads() async {
        guard library.status?.downloading == true else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await library.refreshStatus(engine.client)
        }
    }

    /// Debug builds: a page or a search asked for by a launch argument.
    private func takeRequests() {
        if let q = library.queryRequest {
            library.queryRequest = nil
            search.query = q
        }
        if let l = library.openRequest {
            library.openRequest = nil
            opened = l
        }
    }

    private func open(_ link: ReferencePageLink) { opened = link }

    /// Return in the search field: the first result, else the first title.
    private func openTop() {
        if let r = search.results.first, search.resultsFor == search.trimmed { open(ReferencePageLink(book: r.book, path: r.path, title: r.title)); return }
        if let s = search.suggestions.first(where: { inScope(source: $0.source, lang: $0.lang) }) { open(ReferencePageLink(book: s.book, path: s.path, title: s.title)) }
    }

    /// Return on a selected row (Mac).
    private func openSelected() -> Bool {
        guard let sel = selection else { return false }
        if sel == "random" { random(); return true }
        if sel.hasPrefix("src:") { narrow(to: String(sel.dropFirst(4))); return true }
        let id = String(sel.dropFirst(2))
        if sel.hasPrefix("r:"), let r = search.results.first(where: { $0.id == id }) { open(ReferencePageLink(book: r.book, path: r.path, title: r.title)); return true }
        if sel.hasPrefix("s:"), let s = search.suggestions.first(where: { $0.id == id }) { open(ReferencePageLink(book: s.book, path: s.path, title: s.title)); return true }
        if sel.hasPrefix("c:"), let r = history.recents.first(where: { $0.id == id }) { open(ReferencePageLink(book: r.book, path: r.path, title: r.title)); return true }
        return false
    }

    private func narrow(to source: String) {
        search.sources = search.sources == [source] ? [] : [source]
        searchFocused = true
    }

    private func toggle(_ set: inout Set<String>, _ id: String) {
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
    }

    private func inScope(source: String, lang: String) -> Bool {
        (search.sources.isEmpty || search.sources.contains(source)) && (search.langs.isEmpty || search.langs.contains(lang))
    }

    private func random() {
        guard let c = engine.client, !randomBusy else { return }
        randomBusy = true
        randomProblem = nil
        let src = search.sources.sorted(), lg = search.langs.sorted()
        Task {
            defer { randomBusy = false }
            do {
                let r = try await c.referenceRandom(sources: src, langs: lg)
                open(ReferencePageLink(book: r.book, path: r.path, title: r.title))
            } catch {
                randomProblem = ReferenceLibrary.message(error)
            }
        }
    }
}

/// A page in a list: title, the snippet with its matches in bold, the source, the language and the archive's date,
/// and how far it was read when it was.
struct ReferenceResultRow: View {
    var title: String
    var snippet: AttributedString?
    var sourceId: String
    var sourceTitle: String
    var detail: String
    var progress: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.body.weight(.semibold)).lineLimit(2)
            if let snippet, !snippet.characters.isEmpty {
                Text(snippet).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack(spacing: 6) {
                ReferenceSourceBadge(title: sourceTitle, id: sourceId)
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            if let progress {
                ProgressView(value: progress)
                    .frame(maxWidth: 160)
                    .accessibilityLabel("Read \(Int((progress * 100).rounded())) percent")
            }
        }
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// A filter chip: on or off.
struct ReferenceChip: View {
    var text: String
    var on: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.subheadline.weight(on ? .semibold : .regular))
                .lineLimit(1)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(on ? AnyShapeStyle(.tint.opacity(0.22)) : AnyShapeStyle(Color.secondary.opacity(0.12)), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A download: what it is, how far, and how fast or why it waits.
struct ReferenceDownloadRow: View {
    var download: ReferenceDownload
    var language: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(download.title).lineLimit(1)
                Spacer()
                Text([language, ReferenceText.flavour(download.flavour)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if download.bytes > 0, download.state != "failed" {
                ProgressView(value: download.fraction)
            }
            Text(ReferenceText.progress(download))
                .font(.caption)
                .foregroundStyle(download.state == "failed" ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.secondary))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The Reference row in Settings: what the hub keeps, or what it is downloading.
struct ReferenceSettingsRow: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var library = ReferenceLibrary.shared

    var body: some View {
        SettingsRow(title: "Reference", symbol: Section.reference.symbol, summary: summary)
            .task { if library.status == nil, !engine.config.sampleMode { await library.refreshStatus(engine.client) } }
    }

    private var summary: String {
        guard let s = library.status else { return "Wikipedia and other references, offline" }
        if let d = s.downloads.first(where: { $0.state == "downloading" }) { return "Downloading, \(Int((d.fraction * 100).rounded()))%" }
        let n = s.readableBooks.count
        if n == 0 { return s.downloads.isEmpty ? "Nothing downloaded yet" : "Downloads waiting" }
        return n == 1 ? "1 book on your hub" : "\(n) books on your hub"
    }
}
