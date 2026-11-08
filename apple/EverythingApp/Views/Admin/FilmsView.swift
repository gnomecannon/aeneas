import SwiftUI
import EACore

/// Films from Letterboxd (export and diary feed) or added here: what was watched and when, ratings, likes, the watchlist.
struct FilmsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var linked: String?
    @State private var list: Shelf = .watched
    @State private var sort: FilmSort = .recent
    @State private var query = ""
    @State private var adding = false
    @State private var deleting: Entity?

    enum Shelf: String, CaseIterable, Identifiable { case watched = "Watched", watchlist = "Watchlist"; var id: String { rawValue } }
    enum FilmSort: String, CaseIterable, Identifiable {
        case recent = "Recent", rating = "Rating", rewatched = "Most watched", title = "A to Z"
        var id: String { rawValue }
    }

    static func watchedOn(_ e: Entity) -> [String] { e.stringArray("watched_on") }

    /// A film asked for by a link or Spotlight opens straight away.
    private func takeFocus() {
        guard let id = model.focusItemId, engine.get(id)?.kind == .film else { return }
        model.focusItemId = nil
        linked = id
    }
    static func stars(_ r: Double?) -> String {
        guard let r, r > 0 else { return "" }
        return String(repeating: "★", count: Int(r)) + (r.truncatingRemainder(dividingBy: 1) > 0 ? "½" : "")
    }
    /// Today as YYYY-MM-DD in local time.
    static func today() -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
    static func day(_ s: String) -> String {
        guard let d = ISO.date("\(s)T12:00:00Z") else { return s }
        return d.formatted(date: .abbreviated, time: .omitted)
    }

    private var shown: [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let all = engine.list(.film).filter { e in
            list == .watchlist ? (e.fields["watchlist"] == .bool(true) && e.fields["watched"] != .bool(true)) : e.fields["watched"] != .bool(false)
        }
        let filtered = q.isEmpty ? all : all.filter { $0.str("title").localizedCaseInsensitiveContains(q) }
        switch sort {
        case .recent: return filtered.sorted { $0.str("last_watched") > $1.str("last_watched") }
        case .rating: return filtered.sorted { ($0.number("rating") ?? 0, $0.str("last_watched")) > ($1.number("rating") ?? 0, $1.str("last_watched")) }
        case .rewatched: return filtered.sorted { Self.watchedOn($0).count > Self.watchedOn($1).count }
        case .title: return filtered.sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending }
        }
    }

    var body: some View {
        let films = shown
        let all = engine.list(.film)
        let year = String(Calendar.current.component(.year, from: Date()))
        List {
            SwiftUI.Section {
                Picker("List", selection: $list) { ForEach(Shelf.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                Picker("Order", selection: $sort) { ForEach(FilmSort.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
            } footer: {
                if all.isEmpty { Text("No films yet. Link Letterboxd in Settings, Connections, or tap + to add one.") }
                else { Text("\(all.filter { $0.fields["watched"] != .bool(false) }.count) watched, \(all.filter { Self.watchedOn($0).contains { $0.hasPrefix(year) } }.count) this year.") }
            }
            SwiftUI.Section {
                ForEach(films) { f in
                    NavigationLink { FilmDetail(id: f.id) } label: { FilmRow(film: f) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleting = f } label: { Label("Delete", systemImage: "trash") }
                        }
                }
            }
        }
        .searchable(text: $query, prompt: "Filter films")
        .navigationTitle("Films")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .film) } }
        .navigationDestination(item: $linked) { FilmDetail(id: $0) }
        .onAppear { takeFocus() }
        .onChange(of: model.focusItemId) { _, _ in takeFocus() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add film", systemImage: "plus") } }
        }
        .sheet(isPresented: $adding) { NewFilm(watchlist: list == .watchlist) }
        .confirmationDialog("Delete \(deleting?.str("title") ?? "film")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let d = deleting { Task { await engine.softDelete(d.id) } }
                deleting = nil
            }
        }
        .refreshable { await engine.sync() }
    }
}

struct FilmRow: View {
    var film: Entity

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(StyleGuard.dashes(film.str("title"))) + Text(film.number("year").map { " (\(Int($0)))" } ?? "").foregroundStyle(.secondary)
                Spacer()
                if film.fields["liked"] == .bool(true) { Image(systemName: "heart.fill").foregroundStyle(.pink).accessibilityLabel("Liked") }
                Text(FilmsView.stars(film.number("rating"))).foregroundStyle(.tint)
            }
            HStack(spacing: 8) {
                if !film.str("last_watched").isEmpty { Text("Watched \(FilmsView.day(film.str("last_watched")))") }
                else if film.fields["watchlist"] == .bool(true) { Text("On the watchlist") }
                let n = FilmsView.watchedOn(film).count
                if n > 1 { Text("\(n) times") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct FilmDetail: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String

    var body: some View {
        // A film deleted on another device stayed open here as if it were live, and "Watched today" wrote into it.
        if let f = engine.get(id), !f.isDeleted {
            let days = FilmsView.watchedOn(f)
            List {
                SwiftUI.Section {
                    if let r = f.number("rating") { LabeledContent("Rating", value: FilmsView.stars(r)) }
                    if f.fields["liked"] == .bool(true) { Label("Liked", systemImage: "heart.fill") }
                    if !f.stringArray("tags").isEmpty { LabeledContent("Tags", value: f.stringArray("tags").joined(separator: ", ")) }
                    if let u = URL(string: f.str("url")), !f.str("url").isEmpty { Link("Open on Letterboxd", destination: u) }
                }
                if !f.str("review").isEmpty {
                    SwiftUI.Section("Review") { Text(f.str("review")) }
                }
                SwiftUI.Section("Watched") {
                    ForEach(days.reversed(), id: \.self) { Text(FilmsView.day($0)) }
                    Button("Watched today") {
                        let today = FilmsView.today()
                        let next = Array(Set(days + [today])).sorted()
                        Task { _ = await engine.update(id, fields: ["watched_on": .array(next.map { .string($0) }), "last_watched": .string(today), "watched": .bool(true), "watchlist": .bool(false)]) }
                    }
                }
            }
            .navigationTitle(StyleGuard.dashes(f.str("title")))
        } else {
            Text("Film not found.").foregroundStyle(.secondary)
        }
    }
}

struct NewFilm: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var watchlist: Bool
    @State private var title = ""
    @State private var year = ""
    /// Set while the film is being written: two quick taps on Add made two films.
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Year", text: $year)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                Text(watchlist ? "Goes on the watchlist." : "Logged as watched today.").foregroundStyle(.secondary)
            }
            .navigationTitle(watchlist ? "Add to watchlist" : "Add a film")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard !saving else { return }
                        saving = true
                        let today = FilmsView.today()
                        var f: [String: JSONValue] = ["title": .string(title.trimmingCharacters(in: .whitespaces)), "tags": .array([]), "source": .string("manual")]
                        if let y = Int(year), y > 1870 { f["year"] = .number(Double(y)) }
                        if watchlist { f["watched"] = .bool(false); f["watchlist"] = .bool(true); f["watched_on"] = .array([]) }
                        else { f["watched"] = .bool(true); f["watched_on"] = .array([.string(today)]); f["last_watched"] = .string(today) }
                        Task { _ = await engine.create(kind: .film, fields: f); dismiss() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
    }
}
