import SwiftUI
import EACore

/// Everything that is not a tab, grouped by area. Each row says what is waiting there, so the list doubles as a status board.
/// Areas start closed, each naming the screens inside, so all of them fit on one screen; the ones you open stay open.
struct LibraryView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @AppStorage(LibraryOpen.key) private var openRaw = ""

    var body: some View {
        List {
            ForEach(model.libraryAreas) { area in
                let open = LibraryOpen.isOpen(openRaw, area.title)
                SwiftUI.Section {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { openRaw = LibraryOpen.toggled(openRaw, area.title) }
                    } label: {
                        LibraryAreaRow(area: area, open: open, waiting: area.sections.contains(.inbox) ? engine.unprocessedCaptures.count : 0)
                    }
                    .accessibilityHint(open ? "Hides its screens" : "Shows its screens")
                    if open {
                        ForEach(area.sections) { s in
                            NavigationLink(value: s) { LibraryRow(section: s, summary: engine.summary(for: s)) }
                        }
                    }
                }
            }
        }
        #if os(iOS)
        .listSectionSpacing(.compact)
        #endif
        .navigationTitle("Library")
    }
}

/// An area's own row: its name, and while closed the screens inside and anything waiting to be sorted.
struct LibraryAreaRow: View {
    var area: LibraryArea
    var open: Bool
    var waiting: Int

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                // Plain colors: inside a button the hierarchical .primary and .secondary would take the tint.
                Text(area.title).font(.headline).foregroundStyle(Color.primary)
                if !open {
                    Text(area.sections.map(\.title).joined(separator: ", "))
                        .font(.caption).foregroundStyle(Color.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if !open && waiting > 0 {
                Text("\(waiting)")
                    .font(.caption.weight(.semibold)).monospacedDigit()
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(.tint))
                    .foregroundStyle(.white)
                    .accessibilityLabel("\(waiting) to sort")
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .rotationEffect(.degrees(open ? 90 : 0))
                .accessibilityHidden(true)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct LibraryRow: View {
    var section: Section
    var summary: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: section.symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(section.title)
                if let s = summary, !s.isEmpty { Text(s).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

extension SyncEngine {
    /// One short line per Library screen: what is waiting there right now.
    func summary(for s: Section) -> String? {
        func n(_ c: Int, _ one: String, _ many: String) -> String { c == 1 ? "1 \(one)" : "\(c) \(many)" }
        func count(_ k: Kind) -> Int { list(k).count }
        switch s {
        case .inbox:
            let c = unprocessedCaptures.count
            return c == 0 ? "Nothing to sort" : "\(c) to sort"
        case .tasks:
            let c = list(.task).filter { ["next", "doing"].contains($0.str("status")) }.count
            let r = remindersToday.count
            return (c == 0 ? "Nothing next" : "\(c) next") + (r == 0 ? "" : ", \(r) reminder\(r == 1 ? "" : "s") today")
        case .renewals:
            let soon = Date().addingTimeInterval(30 * 86400)
            let c = list(.watch).filter { (ISO.date($0.str("due")) ?? .distantFuture) < soon }.count
            return c == 0 ? "Nothing due in 30 days" : "\(c) due in 30 days"
        case .dashboard:
            let cal = Calendar.current
            let done = list(.task).filter { $0.date("done_at").map(cal.isDateInToday) ?? false }.count
            let logged = logs.filter { $0.date("at").map(cal.isDateInToday) ?? false }.count
            if done == 0 && logged == 0 { return "Charts of logs, tasks and sensors" }
            return [done > 0 ? "\(done) done today" : nil, logged > 0 ? n(logged, "log today", "logs today") : nil].compactMap { $0 }.joined(separator: ", ")
        case .notes: return n(count(.note), "note", "notes")
        case .memory: return n(count(.fact), "fact", "facts")
        case .people: return n(count(.person), "person", "people")
        case .ops:
            let monitors = list(.monitor)
            let down = monitors.filter { $0.str("state") == "down" }.count
            if monitors.isEmpty { return "No monitors" }
            return down > 0 ? "\(down) down" : "All \(monitors.count) up"
        case .hosts:
            let names = Set([Kind.runbook, .journal, .snippet, .monitor].flatMap { list($0) }.map { $0.str("host").trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty })
            return n(names.count, "machine", "machines")
        case .journal: return n(count(.journal), "entry", "entries")
        case .snippets: return n(count(.snippet), "snippet", "snippets")
        case .projects:
            let c = list(.project).filter { $0.str("status") == "active" }.count
            return n(c, "active", "active")
        case .wiki:
            let c = WikiCache.pageCount
            return c == 0 ? "Design docs and the Confluence handbook" : n(c, "page", "pages")
        case .procedures:
            let c = list(.procedure).filter { $0.str("done_at").isEmpty }.count
            return c == 0 ? "None in progress" : "\(c) in progress"
        case .music: return n(count(.music_idea), "idea", "ideas")
        case .quiz: return n(count(.quiz), "quiz", "quizzes")
        case .images:
            let g = list(.image).filter { $0.str("source") == "generated" }.count, all = list(.image).count
            return all == 0 ? "Created and saved pictures" : "\(g) created, \(all - g) saved"
        case .health:
            if let w = list(.log).filter({ $0.str("type") == "weight" }).max(by: { $0.str("at") < $1.str("at") }), let v = w.number("value") {
                return "Weight \(JSONValue.number(v).displayString) lb"
            }
            return "Weight, sleep, steps and more"
        case .logs: return "Log weight, meds, mood and more"
        case .pet: return n(count(.pet_event), "event", "events")
        case .food: return n(count(.food_option), "option", "options")
        case .sensors: return n(count(.sensor), "sensor", "sensors")
        case .lists: return n(count(.checklist), "list", "lists")
        case .career:
            let c = list(.application).filter { !["rejected", "withdrawn", "accepted"].contains($0.str("stage")) }.count
            return n(c, "open application", "open applications")
        case .games: return n(count(.game), "game", "games")
        case .films: return n(list(.film).filter { $0.fields["watched"] != .bool(false) }.count, "film", "films")
        default: return nil
        }
    }
}

/// Search everything on the hub; with no hub, titles on this device.
struct SearchView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searching = false

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("Search tasks, notes, fix notes, snippets, projects and everything else.")
                    .font(.callout).foregroundStyle(.secondary)
            } else if hits.isEmpty && !searching {
                Text("Nothing found for \u{201C}\(query)\u{201D}.").foregroundStyle(.secondary)
            }
            ForEach(hits) { h in
                Button { open(h) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Image(systemName: Self.section(for: h.kind).symbol).foregroundStyle(.tint).font(.caption)
                            Text(h.title?.isEmpty == false ? h.title! : "Untitled").foregroundStyle(.primary)
                        }
                        Text(Self.section(for: h.kind).title).font(.caption2).foregroundStyle(.tint)
                        if let s = h.snippet, !s.isEmpty { Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                }
            }
        }
        .navigationTitle("Search")
        .searchable(text: $query, prompt: "Search everything")
        .overlay { if searching && hits.isEmpty { ProgressView() } }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { hits = []; return }
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            searching = true
            defer { searching = false }
            // A hit from a module that is off would open a screen that is not there.
            if let c = engine.client, let r = try? await c.search(q) { hits = r.filter { model.shows(Self.section(for: $0.kind)) }; return }
            let needle = q.lowercased()
            hits = engine.entities.values
                .filter { !$0.isDeleted && model.shows(Self.section(for: $0.kind)) && ($0.str("title") + " " + $0.str("text") + " " + $0.str("body")).lowercased().contains(needle) }
                .prefix(50)
                .map { SearchHit(id: $0.id, kind: $0.kind, title: $0.str("title", $0.str("text")), snippet: nil, score: nil) }
        }
    }

    /// A hit opens the item itself. It used to open only the section the item lives in.
    private func open(_ h: SearchHit) { model.open(itemId: h.id) }

    static func section(for k: Kind) -> Section {
        switch k {
        case .capture: return .inbox
        case .note: return .notes
        case .task: return .tasks
        case .reminder: return .tasks
        case .event, .plan_rule: return .week
        case .log: return .logs
        case .fact, .rule, .ledger: return .memory
        case .runbook: return .hosts
        case .project, .inventory: return .projects
        case .watch: return .renewals
        case .journal: return .journal
        case .snippet: return .snippets
        case .pet_event: return .pet
        case .sensor, .reading: return .sensors
        case .food_option: return .food
        case .procedure: return .procedures
        case .music_idea: return .music
        case .quiz: return .quiz
        case .monitor, .incident: return .ops
        case .checklist: return .lists
        case .application: return .career
        case .game: return .games
        case .film: return .films
        case .person: return .people
        case .image: return .images
        case .device: return .settings
        }
    }
}
