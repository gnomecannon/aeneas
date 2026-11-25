import SwiftUI
import EACore

/// Everything that is not a tab, grouped by area, and on the iPhone the main screens the bottom bar leaves out. Each row
/// says what is waiting there, so the list doubles as a status board.
/// Areas start closed, each naming the screens inside, so all of them fit on one screen; the ones you open stay open.
struct LibraryView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.phoneBar) private var bar
    @AppStorage(LibraryOpen.key) private var openRaw = ""

    /// The phone layout: a main screen left out of the bottom bar is reached from here, like every other screen.
    private var loose: [Section] {
        guard let bar else { return [] }
        return BarScreen.main.compactMap(Section.init(rawValue:)).filter { !bar.has($0.rawValue) }
    }

    var body: some View {
        List {
            if !loose.isEmpty {
                SwiftUI.Section {
                    ForEach(loose) { s in
                        NavigationLink(value: s) { LibraryRow(section: s, summary: nil) }
                    }
                }
            }
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
                            NavigationLink(value: s) { LibraryRow(section: s, summary: engine.keptSummary(for: s)) }
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
                    .foregroundStyle(.onAccent)
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

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the largest text sizes the symbol goes over the words: in its column of 28 points it ran over the
        // title, and a column that grew with it left the title a few letters a line.
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Image(systemName: section.symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.tint)
                .frame(width: stacked ? nil : 28)
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
    /// `summary(for:)`, kept until the items it counts change or the day turns. Library is a tab, and a tab out of sight
    /// still draws again on every change the app takes in: a sensor's reading counted every task again.
    func keptSummary(for s: Section) -> String? {
        guard let kinds = s.summaryKinds else { return summary(for: s) }
        return kept("library.\(s.rawValue)", kinds: kinds, stamp: ISO.localDay()) { summary(for: s) }
    }

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
            // The checks in their own words (a monitor that is off or not known yet is not up), then readings that alert,
            // as on the web.
            let states = list(.monitor).map(MonitorStatus.init)
            let alerts = list(.sensor).filter { $0.bool("alert") != false && ["high", "low", "stale"].contains($0.str("state")) }.count
            let down = states.filter { $0 == .down }.count, unknown = states.filter { $0 == .unknown }.count
            let up = states.filter { $0 == .up }.count, off = states.filter { $0 == .off }.count
            let checks: String
            if states.isEmpty { checks = "No checks" }
            else if down > 0 { checks = "\(down) down" }
            else if unknown > 0 { checks = "\(unknown) unknown" }
            else if up == 0 { checks = "All \(off) off" }
            else { checks = "All \(up) up" + (off > 0 ? ", \(off) off" : "") }
            return alerts > 0 ? "\(checks), \(n(alerts, "alert", "alerts"))" : checks
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
        case .games: return n(count(.game), "game", "games")
        case .films: return n(list(.film).filter { $0.fields["watched"] != .bool(false) }.count, "film", "films")
        case .listening: return MusicTaste.libraryLine(MusicTaste.Profile(entity: get(MusicTaste.profileId)))
        case .reference: return "Wikipedia and more, kept on the hub"
        // Never anything of a mail: the Library line is the same whatever is in the Inbox.
        case .mail: return "Your Inbox, in bundles"
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
    /// Assistant chats: kept on the hub only, so a search on this device alone has none.
    @State private var chats: [ChatHit] = []
    @State private var searching = false

    /// What the screen says before a search, or when one found nothing.
    @ViewBuilder private var hint: some View {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            Text("Search tasks, notes, assistant chats, fix notes, projects and everything else.")
                .font(.callout).foregroundStyle(.secondary)
        } else if hits.isEmpty && chats.isEmpty && !searching {
            Text("Nothing found for \u{201C}\(query)\u{201D}.").foregroundStyle(.secondary)
        }
    }

    /// One thing found: its name, the screen it lives on, and the words around the match.
    private func hitWords(_ h: SearchHit) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: Self.section(for: h.kind).symbol).foregroundStyle(.tint).font(.caption)
                Text(h.title?.isEmpty == false ? h.title! : "Untitled").foregroundStyle(.primary).multilineTextAlignment(.leading)
            }
            Text(Self.section(for: h.kind).title).font(.caption2).foregroundStyle(.tint)
            if let s = h.snippet, !s.isEmpty { Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading) }
        }
    }

    /// One chat found: its title, who said the words that matched, and when.
    private func chatWords(_ c: ChatHit) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(.tint).font(.caption)
                Text(StyleGuard.dashes(c.title)).foregroundStyle(.primary).multilineTextAlignment(.leading)
            }
            if !c.snippet.isEmpty {
                Text((c.role == "assistant" ? "Assistant: " : c.role == "user" ? "You: " : "") + StyleGuard.dashes(c.snippet))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(3).multilineTextAlignment(.leading)
            }
            if let d = ISO.date(c.at ?? c.last_at) { Text(d.shortDateTime).font(.caption2).foregroundStyle(.secondary) }
        }
    }

    private var list: some View {
        List {
            hint
            ForEach(hits) { h in
                Button { open(h) } label: { hitWords(h) }
            }
            if !chats.isEmpty {
                SwiftUI.Section("Assistant chats") {
                    ForEach(chats) { c in
                        Button { model.openChat(c.session_id) } label: { chatWords(c) }
                    }
                }
            }
        }
    }

    /// A wide window: what was found as cards, as many across as fit at 360 points each (2 across a screen of 1040
    /// points, 4 across a 1920 window), best match first, left to right and then down; the chats found under them
    /// the same way, at 440 points each. A card opens what a row opens.
    private var cards: some View {
        WidePage {
            hint
            CardGrid(minWidth: 360) {
                ForEach(hits) { h in
                    Button { open(h) } label: { hitWords(h).gridCard() }
                        .buttonStyle(.plain)
                }
            }
            if !chats.isEmpty {
                WideSection("Assistant chats") {
                    CardGrid(minWidth: 440) {
                        ForEach(chats) { c in
                            Button { model.openChat(c.session_id) } label: { chatWords(c).gridCard() }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    var body: some View {
        WideReader { wide in
            if wide { cards } else { list }
        }
        .navigationTitle("Search")
        .searchable(text: $query, prompt: "Search everything")
        .overlay { if searching && hits.isEmpty { ProgressView() } }
        #if DEBUG
        // `-EASearchFor <words>` (DebugHooksMac): the search runs for those words, for a screenshot of what it finds.
        .onAppear { if query.isEmpty, let words = UserDefaults.standard.string(forKey: "EASearchFor") { query = words } }
        #endif
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { hits = []; chats = []; return }
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            searching = true
            defer { searching = false }
            // A hit from a module that is off would open a screen that is not there, as would one of a kind no screen shows
            // any more (an older hub still sends job applications).
            if let c = engine.client, let r = try? await c.searchWithChats(q) {
                hits = r.hits.filter { !Kind.gone.contains($0.kind) && model.shows(Self.section(for: $0.kind)) }
                chats = r.chats
                return
            }
            chats = []
            let needle = q.lowercased()
            // A task in an Apple Reminders list that is switched off is hidden here as everywhere (`engine.shows`).
            hits = engine.entities.values
                .filter { !$0.isDeleted && !Kind.gone.contains($0.kind) && engine.shows($0) && model.shows(Self.section(for: $0.kind)) && ($0.str("title") + " " + $0.str("text") + " " + $0.str("body")).lowercased().contains(needle) }
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
        // Nothing shows it since Job search was taken out on 2026-11-25 (`Kind.gone`); Lists is where it was.
        case .application: return .lists
        case .game: return .games
        case .film: return .films
        case .music_profile: return .listening
        case .invitation: return .week
        case .person: return .people
        case .image: return .images
        case .device: return .settings
        }
    }
}

extension Section {
    /// The kinds a Library line counts (`SyncEngine.summary(for:)`); nil for a line that reads something else, or nothing.
    var summaryKinds: [Kind]? {
        switch self {
        case .inbox: [.capture]
        case .tasks: [.task]
        case .renewals: [.watch]
        case .dashboard, .health: [.task, .log]
        case .notes: [.note]
        case .memory: [.fact]
        case .people: [.person]
        case .ops: [.monitor, .sensor]
        case .hosts: [.runbook, .journal, .snippet, .monitor]
        case .journal: [.journal]
        case .snippets: [.snippet]
        case .projects: [.project]
        case .procedures: [.procedure]
        case .music: [.music_idea]
        case .quiz: [.quiz]
        case .images: [.image]
        case .pet: [.pet_event]
        case .food: [.food_option]
        case .sensors: [.sensor]
        case .lists: [.checklist]
        case .games: [.game]
        case .films: [.film]
        case .listening: [.music_profile]
        default: nil
        }
    }
}
