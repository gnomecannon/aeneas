import SwiftUI
import EACore

/// Any item by id, on its own screen: the kind's detail screen where it has one, otherwise its fields, an Edit button
/// for kinds with an editor, and what it is related to. Links, search results and Related rows all open items here.
struct ItemView: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    @State private var fetched = false

    var body: some View {
        if let e = engine.get(id), !e.isDeleted {
            switch e.kind {
            case .person: PersonDetailView(personId: id)
            case .note: NoteEditorView(noteId: id)
            case .project: ProjectDetailView(projectId: id)
            case .film: FilmDetail(id: id)
            case .snippet: SnippetDetailView(id: id)
            case .runbook: RunbookDetailView(id: id)
            case .application: AdminApplicationDetail(id: id)
            case .checklist: AdminListDetail(id: id)
            case .music_idea: MusicIdeaView(ideaId: id)
            default: GenericItemView(item: e)
            }
        } else {
            EmptyState(text: fetched ? "This item was deleted" : "Loading")
                .task {
                    // Not on this device yet: fetch it from the hub.
                    if let c = engine.client, let e = try? await c.entity(id) { await engine.absorb(e) }
                    fetched = true
                }
        }
    }
}

/// An item without a screen of its own: what it says, in plain words, and what it connects to.
struct GenericItemView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    var item: Entity
    @State private var editing = false
    @State private var confirmDelete = false

    /// Fields that are bookkeeping, links (shown under Related) or device state.
    private static let hidden: Set<String> = ["apple", "field_ts", "converted_to", "links", "suggested_tags", "suggested_kind", "sorted_by", "filing",
                                              "filing_attempts", "external_id", "fired", "snooze_log", "checkins", "attachments", "source", "processed", "thread"]

    private var rows: [(String, String)] {
        // An all-day event is stored at midnight UTC: its day is the date part, not a local time.
        let allDay = item.kind == .event && item.bool("all_day") == true
        return item.fields.keys.sorted().compactMap { k in
            guard !Self.hidden.contains(k), !k.hasSuffix("_id"), !(allDay && (k == "end" || k == "all_day")) else { return nil }
            if allDay && k == "start" { return ("Day", Self.day(item.str("start"))) }
            guard let v = Self.text(item.fields[k]), !v.isEmpty else { return nil }
            return (k.replacingOccurrences(of: "_", with: " ").capitalized, v)
        }.filter { $0.1 != item.displayTitle }
    }

    static func day(_ iso: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: String(iso.prefix(10))) else { return iso }
        return d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    static func text(_ v: JSONValue?) -> String? {
        switch v {
        case .string(let s): return ISO.date(s).map { s.count > 10 ? $0.shortDateTime : $0.formatted(date: .abbreviated, time: .omitted) } ?? s
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "Yes" : "No"
        case .array(let a):
            let parts = a.compactMap { x -> String? in
                if case .object(let o) = x { return (o["value"] ?? o["text"] ?? o["name"]).flatMap { text($0) } }
                return text(x)
            }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        default: return nil
        }
    }

    private var editable: Bool { [.task, .fact, .food_option].contains(item.kind) }

    /// What one item of a kind is called (the section title names the screen, e.g. Week for an event).
    static func kindName(_ k: Kind) -> String {
        switch k {
        case .event: return "Event"
        case .capture: return "Capture"
        case .fact: return "Memory"
        case .rule: return "Rule"
        case .log: return "Log"
        case .task: return "Task"
        case .reminder: return "Reminder"
        case .food_option: return "Food place"
        case .pet_event: return PetView.pet
        case .image: return "Image"
        case .inventory: return "Inventory item"
        default: return SearchView.section(for: k).title
        }
    }

    var body: some View {
        List {
            SwiftUI.Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(StyleGuard.dashes(item.displayTitle)).font(.title3.bold())
                    Text("\(Self.kindName(item.kind)), added \(dateLabel(item.created_at))").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !rows.isEmpty {
                SwiftUI.Section {
                    ForEach(rows, id: \.0) { k, v in
                        LabeledContent(k) { Text(StyleGuard.dashes(v)).multilineTextAlignment(.trailing).textSelection(.enabled) }
                    }
                }
            }
            RelatedSection(id: item.id)
        }
        .navigationTitle(Self.kindName(item.kind))
        .toolbar {
            if editable { ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } } }
            // A capture the assistant filed: its chat is where a wrong filing is corrected.
            if item.kind == .capture, let thread = item.string("thread") {
                ToolbarItem(placement: .primaryAction) { Button("Fix the filing") { model.openChat(thread) } }
            }
            ToolbarItem(placement: .secondaryAction) { Button("Delete", role: .destructive) { confirmDelete = true } }
        }
        .confirmationDialog("Delete this item?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await engine.softDelete(item.id) } }
        }
        .sheet(isPresented: $editing) {
            switch item.kind {
            case .task: TaskEditView(task: item)
            case .fact: FactEditView(fact: item)
            case .food_option: FoodOptionEditor(option: item)
            default: EmptyView()
            }
        }
    }
}

/// "Related": what this item points at, what points at it, and people by name. Empty, it shows nothing.
struct RelatedSection: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    /// Hide rows already shown on the screen (a person's facts).
    var excludingWhy: Set<String> = []
    @State private var items: [RelatedItem] = []

    var body: some View {
        let shown = items.filter { !excludingWhy.contains($0.why) && engine.get($0.id)?.isDeleted != true }
        if shown.isEmpty {
            // An empty Section draws nothing in a List, and a view that is not drawn never runs its task, so the
            // loader sits on an invisible row until there is something to show.
            Color.clear.frame(height: 0)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
                .task(id: id) { await load() }
        } else {
            SwiftUI.Section("Related") {
                ForEach(shown) { r in
                    NavigationLink(destination: ItemView(id: r.id)) {
                        HStack(spacing: 10) {
                            Image(systemName: Kind(rawValue: r.kind).map { SearchView.section(for: $0).symbol } ?? "doc")
                                .foregroundStyle(.secondary).frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(StyleGuard.dashes(r.title)).lineLimit(2)
                                ForEach(r.lines ?? [], id: \.self) { Text(StyleGuard.dashes($0)).font(.subheadline).lineLimit(3) }
                                Text("\(r.why), \(dateLabel(r.at))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        guard let c = engine.client, let list = try? await c.related(itemId: id) else { return }
        items = list
    }
}
