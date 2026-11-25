import SwiftUI
import EACore

/// Checklists: open lists with progress, templates to start from, archived lists tucked away.
struct ListsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var openId: String?
    @State private var naming = false
    @State private var newTitle = ""
    @State private var usingTemplate: String?
    @State private var showArchived = false

    private var all: [Entity] { engine.list(.checklist) }
    private func sorted(_ xs: [Entity]) -> [Entity] { xs.sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending } }
    private var open: [Entity] { sorted(all.filter { !AdminChecklist.isTemplate($0) && !AdminChecklist.isArchived($0) }) }
    private var templates: [Entity] { sorted(all.filter(AdminChecklist.isTemplate)) }
    private var archived: [Entity] { sorted(all.filter { !AdminChecklist.isTemplate($0) && AdminChecklist.isArchived($0) }) }

    var body: some View {
        // The rows are swiped to archive a list, so the cards are for the Mac only (WideReader).
        WideReader(macOnly: true) { wide in
            if wide { cards } else { list }
        }
        .navigationTitle("Lists")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newTitle = ""; naming = true } label: { Label("New list", systemImage: "plus") }
            }
        }
        .alert("New list", isPresented: $naming) {
            TextField("Title", text: $newTitle)
            Button("Create") { create() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A blank list to tick off. To pack for a trip, use a template instead.")
        }
        .pageDestination(item: $openId) { id in AdminListDetail(id: id) }
        .refreshable { await engine.sync() }
    }

    private var list: some View {
        List {
            SwiftUI.Section("Open lists") {
                if open.isEmpty {
                    Text(templates.isEmpty ? "No open lists. Tap + to start one." : "No open lists. Tap Use on a template below, or tap + for a blank list.")
                        .foregroundStyle(.secondary)
                }
                ForEach(open) { e in
                    PageLink { AdminListDetail(id: e.id) } label: { AdminListRow(list: e) }
                        .swipeActions(edge: .trailing) {
                            Button { Task { _ = await engine.update(e.id, fields: ["archived": true]) } } label: { Label("Archive", systemImage: "archivebox") }.tint(.indigo)
                        }
                        .contextMenu {
                            Button { Task { _ = await engine.update(e.id, fields: ["archived": true]) } } label: { Label("Archive", systemImage: "archivebox") }
                        }
                }
            }
            if !templates.isEmpty {
                SwiftUI.Section {
                    ForEach(templates) { t in
                        HStack(spacing: 12) {
                            PageLink { AdminListDetail(id: t.id) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(StyleGuard.dashes(t.str("title"))).font(.body)
                                    Text(itemsLabel(AdminChecklist.items(t).count)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Button {
                                use(t)
                            } label: {
                                if usingTemplate == t.id { ProgressView().controlSize(.small) } else { Text("Use") }
                            }
                            .buttonStyle(.themedProminent)
                            .disabled(usingTemplate != nil)
                            .accessibilityLabel("Use \(t.str("title"))")
                        }
                    }
                } header: {
                    Text("Start from a template")
                } footer: {
                    Text("Use makes a fresh copy with nothing ticked. The template stays as it is.")
                }
            }
            if !archived.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup("Archived, \(archived.count)", isExpanded: $showArchived) {
                        ForEach(archived) { e in
                            PageLink { AdminListDetail(id: e.id) } label: { AdminListRow(list: e) }
                                .swipeActions(edge: .trailing) {
                                    Button { Task { _ = await engine.update(e.id, fields: ["archived": false]) } } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }.tint(.indigo)
                                }
                        }
                    }
                }
            }
        }
    }

    private func archive(_ e: Entity, _ archived: Bool) {
        Task { _ = await engine.update(e.id, fields: ["archived": .bool(archived)]) }
    }

    /// A wide Mac window: the same sections one under the other, each a grid of cards, as many across as fit, in the
    /// list's order. A click opens the list; Archive and Unarchive are in the right-click menu (on a narrow window
    /// Unarchive is a swipe only).
    private var cards: some View {
        WidePage {
            WideSection("Open lists") {
                if open.isEmpty {
                    Text(templates.isEmpty ? "No open lists. Tap + to start one." : "No open lists. Tap Use on a template below, or tap + for a blank list.")
                        .foregroundStyle(.secondary)
                }
                CardGrid {
                    ForEach(open) { e in
                        PageLink { AdminListDetail(id: e.id) } label: { AdminListRow(list: e).gridCard() }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button { archive(e, true) } label: { Label("Archive", systemImage: "archivebox") }
                            }
                    }
                }
            }
            if !templates.isEmpty {
                WideSection("Start from a template") {
                    CardGrid {
                        ForEach(templates) { t in
                            HStack(spacing: 12) {
                                PageLink { AdminListDetail(id: t.id) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(StyleGuard.dashes(t.str("title"))).font(.body)
                                        Text(itemsLabel(AdminChecklist.items(t).count)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Button {
                                    use(t)
                                } label: {
                                    if usingTemplate == t.id { ProgressView().controlSize(.small) } else { Text("Use") }
                                }
                                .buttonStyle(.themedProminent)
                                .disabled(usingTemplate != nil)
                                .accessibilityLabel("Use \(t.str("title"))")
                            }
                            .gridCard()
                        }
                    }
                    Text("Use makes a fresh copy with nothing ticked. The template stays as it is.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !archived.isEmpty {
                DisclosureGroup("Archived, \(archived.count)", isExpanded: $showArchived) {
                    CardGrid {
                        ForEach(archived) { e in
                            PageLink { AdminListDetail(id: e.id) } label: { AdminListRow(list: e).gridCard() }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button { archive(e, false) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }
                                }
                        }
                    }
                    .padding(.top, 8)
                }
            }
        }
    }

    private func itemsLabel(_ n: Int) -> String { "\(n) item\(n == 1 ? "" : "s")" }

    private func create() {
        let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Task {
            let e = await engine.create(kind: .checklist, fields: ["title": .string(t), "kind": "generic", "items": .array([]), "template": false, "tags": .array([])])
            openId = e?.id
        }
    }

    private func use(_ t: Entity) {
        usingTemplate = t.id
        Task {
            let id = await engine.adminInstantiateChecklist(t)
            usingTemplate = nil
            openId = id
        }
    }
}

/// Title with progress: a bar plus "3 of 12", or Done when every item is ticked.
struct AdminListRow: View {
    var list: Entity

    var body: some View {
        let p = AdminChecklist.progress(list)
        let states = AdminChecklist.isStates(list)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(StyleGuard.dashes(list.str("title"))).font(.body)
                Spacer()
                if p.total > 0 && p.done == p.total && !states {
                    AdminPill(text: "Done", symbol: "checkmark", tone: .ok)
                } else {
                    Text(states ? "\(p.done) of \(p.total) states" : "\(p.done) of \(p.total)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if p.total > 0 {
                ProgressView(value: Double(p.done), total: Double(p.total)).tint(p.done == p.total ? AnyShapeStyle(.ok) : nil)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One checklist: tick items, add items, and for a template, Use it.
struct AdminListDetail: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var id: String
    @State private var newItem = ""
    @FocusState private var adding: Bool
    @State private var busy: Int?
    @State private var error: String?
    @State private var shown = ""
    @State private var confirmDelete = false
    @State private var deletingItem: AdminChecklistItem?
    @State private var openCopy: String?
    @State private var using = false

    var body: some View {
        Group {
            if let e = engine.get(id), !e.isDeleted {
                content(e)
            } else {
                ContentUnavailableView("List not found", systemImage: "checklist", description: Text("It may have been deleted on another device."))
            }
        }
        .pageDestination(item: $openCopy) { cid in AdminListDetail(id: cid) }
    }

    @ViewBuilder
    private func content(_ e: Entity) -> some View {
        let items = AdminChecklist.items(e)
        let template = AdminChecklist.isTemplate(e)
        let states = AdminChecklist.isStates(e) && !template
        let p = AdminChecklist.progress(e)
        List {
            SwiftUI.Section {
                if template {
                    Text("Template, \(items.count) item\(items.count == 1 ? "" : "s"). Templates are copied, never ticked.").foregroundStyle(.secondary)
                    Button {
                        using = true
                        Task {
                            openCopy = await engine.adminInstantiateChecklist(e)
                            using = false
                        }
                    } label: {
                        Label(using ? "Starting" : "Use this template", systemImage: "doc.on.doc").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.themedProminent)
                    .controlSize(.large)
                    .disabled(using)
                } else if !states {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("\(p.done) of \(p.total) done").font(.title3.weight(.semibold).monospacedDigit())
                            Spacer()
                            if AdminChecklist.isArchived(e) { AdminPill(text: "Archived", symbol: "archivebox", color: .indigo) }
                            else if p.total > 0 && p.done == p.total { AdminPill(text: "All done", symbol: "checkmark", tone: .ok) }
                        }
                        if p.total > 0 { ProgressView(value: Double(p.done), total: Double(p.total)).tint(p.done == p.total ? AnyShapeStyle(.ok) : nil) }
                    }
                }
                if let err = error { AdminMessage(tone: .error, text: err) }
            }

            if states {
                statesSection(e, items: items)
            } else {
                SwiftUI.Section {
                    if items.isEmpty { Text("No items yet. Type one below and press Return.").foregroundStyle(.secondary) }
                    ForEach(items) { it in
                        Group {
                            if template { templateRow(it) } else { itemRow(e, it) }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deletingItem = it } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
                SwiftUI.Section {
                    HStack {
                        TextField("Add item", text: $newItem)
                            .focused($adding)
                            .onSubmit { addItem(e) }
                            .submitLabel(.done)
                        Button { addItem(e) } label: { Image(systemName: "plus.circle.fill").font(.title2) }
                            .buttonStyle(.borderless)
                            .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityLabel("Add item")
                    }
                }
            }
        }
        .navigationTitle(StyleGuard.dashes(e.str("title")))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if !template {
                        if AdminChecklist.isArchived(e) {
                            Button { Task { _ = await engine.update(e.id, fields: ["archived": false]) } } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }
                        } else {
                            Button {
                                Task { _ = await engine.update(e.id, fields: ["archived": true]); dismiss() }
                            } label: { Label("Archive", systemImage: "archivebox") }
                        }
                    }
                    Button(role: .destructive) { confirmDelete = true } label: { Label(template ? "Delete template" : "Delete list", systemImage: "trash") }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .confirmationDialog("Delete \(e.str("title"))?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await engine.softDelete(e.id); dismiss() } }
        } message: {
            Text(template ? "Lists already started from it stay." : "All \(items.count) items go with it.")
        }
        .confirmationDialog("Delete \(deletingItem?.text ?? "item")?", isPresented: Binding(get: { deletingItem != nil }, set: { if !$0 { deletingItem = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let it = deletingItem { removeItem(e, it) }
                deletingItem = nil
            }
        }
    }

    private func itemRow(_ e: Entity, _ it: AdminChecklistItem) -> some View {
        Button {
            toggle(e, it.index)
        } label: {
            HStack(spacing: 12) {
                if busy == it.index {
                    ProgressView().frame(width: 28)
                } else {
                    Image(systemName: it.done ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(it.done ? AnyShapeStyle(.okText) : AnyShapeStyle(.secondary))
                        .frame(width: 28)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(StyleGuard.dashes(it.text)).strikethrough(it.done).foregroundStyle(it.done ? .secondary : .primary)
                    if let n = it.note { Text(n).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
        .accessibilityLabel("\(it.text), \(it.done ? "done" : "not done")")
        .accessibilityHint("Toggles the tick")
    }

    private func templateRow(_ it: AdminChecklistItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(StyleGuard.dashes(it.text))
            if let n = it.note { Text(n).font(.caption).foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder
    private func statesSection(_ e: Entity, items: [AdminChecklistItem]) -> some View {
        let chips = AdminChecklist.statesGrid(items)
        let done = chips.filter(\.done).count
        SwiftUI.Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 60), spacing: 8)], spacing: 8) {
                ForEach(chips) { c in
                    Button {
                        shown = "\(c.name), \(c.done ? "not visited" : "visited")"
                        toggle(e, c.index)
                    } label: {
                        HStack(spacing: 3) {
                            if c.done { Image(systemName: "checkmark").font(.caption2.weight(.bold)) }
                            Text(c.code).font(.callout.weight(.semibold).monospaced())
                        }
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(c.done ? AnyShapeStyle(.ok.opacity(0.22)) : AnyShapeStyle(Color.secondary.opacity(0.10)), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.done ? AnyShapeStyle(.ok.opacity(0.7)) : AnyShapeStyle(Color.secondary.opacity(0.25))))
                        .foregroundStyle(c.done ? AnyShapeStyle(.okText) : AnyShapeStyle(.primary))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)
                    .help(c.name)
                    .contextMenu {
                        SwiftUI.Section(c.name) {
                            Button(c.done ? "Mark not visited" : "Mark visited") {
                                shown = "\(c.name), \(c.done ? "not visited" : "visited")"
                                toggle(e, c.index)
                            }
                        }
                    }
                    .accessibilityLabel("\(c.name), \(c.done ? "visited" : "not visited")")
                }
            }
            .padding(.vertical, 4)
            Text(shown.isEmpty ? "Tap a state to mark it visited. Press and hold to see its name." : shown)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("\(done) of \(chips.count) states visited").font(.headline.monospacedDigit()).textCase(nil)
        }
    }

    /// Ticks the item shown at `index`, found again by its text in case the list moved under it.
    private func toggle(_ e: Entity, _ index: Int) {
        guard busy == nil else { return }
        guard let text = AdminChecklist.items(e).first(where: { $0.index == index })?.text else { return }
        busy = index
        error = nil
        Task {
            error = await engine.adminToggleChecklist(e.id, index: index, text: text)
            busy = nil
        }
    }

    /// Adds to the list as it is now: the shown copy could miss a change that arrived since.
    private func addItem(_ e: Entity) {
        let t = newItem.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        newItem = ""
        adding = true
        Task { await engine.adminAddChecklistItem(e.id, text: t) }
    }

    private func removeItem(_ e: Entity, _ it: AdminChecklistItem) {
        Task { await engine.adminRemoveChecklistItem(e.id, index: it.index, text: it.text) }
    }
}
