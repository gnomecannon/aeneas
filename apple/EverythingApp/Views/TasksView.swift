import SwiftUI
import EACore
import UniformTypeIdentifiers

/// The Apple Reminders list a task is in, by name (list ids differ from device to device).
extension Entity {
    var reminderList: String? {
        let t = fields["apple"]?.objectValue?["list_title"]?.stringValue ?? ""
        return t.isEmpty ? nil : t
    }
}

extension TaskStatus {
    /// The status in words. `parked` is stored as it always was; on screen it is Set aside, which says what it does.
    var label: String {
        switch self {
        case .parked: return "Set aside"
        case .scheduled: return "Scheduled"
        default: return rawValue.capitalized
        }
    }
}

extension Entity {
    /// Tied to an Apple Reminders item (not only named for a list it is yet to be added to).
    var tiedToApple: Bool { !(fields["apple"]?.objectValue?["id"]?.stringValue ?? "").isEmpty }
}

/// The last Done, Not done, Delete or move on Tasks, for its Undo bar (gone after a few seconds, or with the next one).
@MainActor final class TaskUndo: ObservableObject {
    struct Offer: Identifiable { let id = UUID(); var text: String; var run: () async -> Void }
    @Published var offer: Offer?
    private var timer: Task<Void, Never>?

    func offer(_ text: String, _ run: @escaping () async -> Void) {
        offer = Offer(text: text, run: run)
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            if !Task.isCancelled { self?.offer = nil }
        }
    }

    /// Done with its Undo: what Done wrote goes back as it was (a repeating task's dates too).
    func done(_ t: Entity, engine: SyncEngine) async {
        guard let back = await engine.markDoneUndoable(t.id) else { return }
        offer("Done: \(Self.short(t))") { _ = await engine.update(t.id, fields: back) }
    }

    /// Not done: back at the end of Next.
    func reopen(_ t: Entity, engine: SyncEngine) async {
        guard let back = await engine.reopen(t.id) else { return }
        offer("Back in Next: \(Self.short(t))") { _ = await engine.update(t.id, fields: back) }
    }

    func delete(_ t: Entity, engine: SyncEngine) async {
        await engine.softDelete(t.id)
        offer("Deleted: \(Self.short(t))") { await engine.restore(t.id) }
    }

    /// To the other space, keeping the task. A list it was only named for goes (lists belong to one account); a
    /// personal task in an Apple Reminders list leaves it, as work tasks stay out of personal lists.
    func moveSpace(_ t: Entity, engine: SyncEngine) async {
        let back = await Self.move(t, engine: engine)
        offer("Moved to \(t.space == .work ? "Personal" : "Work"): \(Self.short(t))", back)
    }

    /// The move itself; returns what moves it back.
    static func move(_ t: Entity, engine: SyncEngine) async -> () async -> Void {
        let to: Space = t.space == .work ? .personal : .work
        let named = t.fields["apple"] != nil && !t.tiedToApple
        await engine.moveToSpace(t.id, to, fields: named ? ["apple": .null] : [:])
        return { await engine.moveToSpace(t.id, t.space, fields: named ? ["apple": t.fields["apple"] ?? .null] : [:]) }
    }

    private static func short(_ t: Entity) -> String { String(StyleGuard.dashes(t.str("title")).prefix(40)) }
}

/// The Undo bar at the bottom of Tasks.
struct TaskUndoBar: View {
    @ObservedObject var undo: TaskUndo
    var body: some View {
        if let u = undo.offer {
            HStack(spacing: 14) {
                Text(verbatim: u.text).foregroundStyle(.white).lineLimit(1)
                Button("Undo") { let run = u.run; undo.offer = nil; Task { await run() } }
                    .fontWeight(.semibold)
                    .foregroundStyle(.white)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            .background(Capsule().fill(Color.black.opacity(0.85)))
            .padding(.bottom, 16)
            .padding(.horizontal)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
        }
    }
}

extension SyncEngine {
    /// Every list for one space: Reminders lists on this device (empty ones too) and any a task names.
    @MainActor func taskListTitles(space: Space) -> [String] {
        var names = Set(RemindersSync.shared.lists.filter { $0.isWork == (space == .work) }.map(\.title))
        for t in tasks where t.space == space { if let l = t.reminderList { names.insert(l) } }
        return names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}

/// The test for a group's tasks, made once per drawing of Tasks rather than once per task (`GroupMatchBox.refresh`).
private final class GroupMatchBox {
    private var key: (lists: [String], sources: [SourcesSetting.ReminderList])?
    private(set) var match: TaskListMatch?

    func refresh(_ group: TaskGroup?, lists: [SourcesSetting.ReminderList]) {
        guard let group else { key = nil; match = nil; return }
        if let k = key, k.lists == group.lists, k.sources == lists { return }
        key = (group.lists, lists)
        match = TaskListMatch(group.lists, lists: lists)
    }
}

/// Tasks by status, inside one space (Personal or Work) or one of the owner's groups (gnomecannon/aeneas#26: the tasks
/// of the lists in it, from both spaces), and one list (all of them, one Reminders list, or none). New group and Edit
/// group beside the selector make and change groups for every device. Drag a task into another section to move it, or
/// within Next to reorder. Done is a drawer. Edit, set aside, block.
struct TasksView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var reminders = RemindersSync.shared
    @State private var editing: Entity?
    @State private var creating = false
    @State private var parking: Entity?
    @State private var showDone = false
    @StateObject private var undo = TaskUndo()
    /// `personal`, `work` or `group:<id>`.
    @AppStorage("tasks.space") private var spaceRaw = Space.personal.rawValue
    /// "" is every list; `noList` is tasks in no Reminders list; anything else is a list name.
    @AppStorage("tasks.list") private var listFilter = ""
    private static let noList = "\u{1}none"
    /// Whether the hub's work space is on; nil until it answers (then: whether any work task or list is here).
    @State private var workOn: Bool?
    /// The group being made (nil group) or changed.
    @State private var groupEdit: GroupEdit?
    @State private var groupMatch = GroupMatchBox()

    #if DEBUG
    @MainActor private static var debugEditShown = false
    #endif

    struct GroupEdit: Identifiable {
        var group: TaskGroup?
        var id: String { group?.id ?? "\u{1}new" }
    }

    private let order: [TaskStatus] = [.doing, .next, .scheduled, .inbox, .parked, .done]

    private var groups: [TaskGroup] { engine.sources?.groups ?? [] }
    /// The group shown; nil for Personal or Work (a group deleted on another device leaves Personal showing).
    private var group: TaskGroup? {
        guard spaceRaw.hasPrefix("group:") else { return nil }
        return groups.first { "group:" + $0.id == spaceRaw }
    }
    /// Until the hub answers, whether any work task or list is here. Read for every task a section filters (through
    /// `space`): with 5,000 tasks and none in Work, opening Tasks looked through all of them for each one (0.4 s).
    private var hasWork: Bool {
        workOn ?? (engine.kept("tasks.anyWork", kinds: [.task]) { engine.tasks.contains { $0.space == .work } } || reminders.lists.contains(where: \.isWork))
    }
    private var space: Space { group == nil && hasWork ? (Space(rawValue: spaceRaw) ?? .personal) : .personal }
    /// The tag the selector shows: the one chosen, or Personal when that is not there.
    private var scopeTag: String { group.map { "group:" + $0.id } ?? space.rawValue }
    /// In the space or group shown, before the list chips.
    private func inView(_ t: Entity) -> Bool {
        if group != nil { return groupMatch.match?.contains(t) ?? false }
        return t.space == space
    }
    private func inScope(_ t: Entity) -> Bool {
        guard inView(t) else { return false }
        switch listFilter {
        case "": return true
        case Self.noList: return t.reminderList == nil
        default: return t.reminderList == listFilter
        }
    }
    private func openCount(_ match: (Entity) -> Bool) -> Int { engine.tasks.filter { inView($0) && $0.str("status") != "done" && match($0) }.count }

    /// The list chips: in a space, its lists; in a group, its lists that are on and any its tasks name.
    private var chipTitles: [String] {
        guard let g = group else { return engine.taskListTitles(space: space) }
        var names = Set((engine.sources?.lists(in: g) ?? []).map(\.title))
        for t in engine.tasks where inView(t) { if let l = t.reminderList { names.insert(l) } }
        return names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// Where a new task goes: the list chosen. In a group with every list showing, nowhere when the group holds the
    /// tasks in no list, else its first list, so the task shows in the group; its space is that list's.
    private var newTarget: (space: Space, list: String?) {
        let chosen = listFilter == Self.noList || listFilter.isEmpty ? nil : listFilter
        guard let g = group else { return (space, chosen) }
        let lists = engine.sources?.lists(in: g) ?? []
        let title = chosen ?? (listFilter.isEmpty && !g.lists.contains(ListChoices.noList) ? lists.first?.title : nil)
        return (lists.first { $0.title == title }?.space ?? .personal, title)
    }

    var body: some View {
        let _ = groupMatch.refresh(group, lists: engine.sources?.lists ?? [])
        // Each column of the board is a list of its own, so swipes, drags and drops work in it as in the one list.
        WideReader { wide in
            if wide { board } else { list }
        }
        .safeAreaInset(edge: .top, spacing: 0) { scopeBar }
        .onChange(of: spaceRaw) { _, _ in listFilter = "" }
        .task(id: engine.client == nil) {
            guard let c = engine.client, let w = try? await withDeadline(15, { try await c.workSpace() }) else { return }
            workOn = w.enabled
        }
        #if DEBUG
        // `-EAGroupEdit <id, or new>` (DebugHooks): the group editor over Tasks, once, for screenshots.
        .onAppear {
            guard !Self.debugEditShown, let id = UserDefaults.standard.string(forKey: "EAGroupEdit") else { return }
            Self.debugEditShown = true
            groupEdit = GroupEdit(group: id == "new" ? nil : groups.first { $0.id == id })
        }
        #endif
        .sheet(item: $groupEdit) { e in
            TaskGroupEditor(group: e.group) { saved in
                if let saved { spaceRaw = "group:" + saved.id } else if e.group != nil { spaceRaw = Space.personal.rawValue }
            }
        }
        .navigationTitle("Tasks")
        // Personal tasks only: no work item leaves the device in an export (contract, work space rule 6).
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .task, filter: ["space": "personal"]) } }
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .navigationBarLeading) { EditButton() }
            #endif
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New", systemImage: "plus") } }
        }
        .sheet(item: $editing) { t in TaskEditView(task: t, undo: undo) }
        .sheet(isPresented: $creating) { TaskEditView(task: nil, newSpace: newTarget.space, newList: newTarget.list) }
        .sheet(item: $parking) { t in ParkSheet(task: t) }
        .refreshable { await engine.sync() }
        .overlay {
            if !engine.tasks.contains(where: inScope) {
                EmptyState(text: group?.lists.isEmpty == true ? TaskGroupText.empty : listFilter.isEmpty ? "No tasks yet" : "Nothing in this list")
            }
        }
        .overlay(alignment: .bottom) { TaskUndoBar(undo: undo) }
    }

    private var list: some View {
        List {
            ForEach(order, id: \.self) { status in section(status) }
        }
        .listStyle(.plain)
    }

    /// The narrowest a column of the board gets: 3 columns across a screen of 1040 points, 5 across a 1920 window.
    private static let columnWidth: CGFloat = 320

    /// Which statuses share a column of the board when `count` columns fit, in the list's order from left to right
    /// and from top to bottom. Doing sits over Next (it holds a task or two), and with fewer columns the statuses
    /// that wait (Unsorted, Parked, Done) are stacked first.
    private static func boardColumns(_ count: Int) -> [[TaskStatus]] {
        switch count {
        case 5...: return [[.doing, .next], [.scheduled], [.inbox], [.parked], [.done]]
        case 4: return [[.doing, .next], [.scheduled], [.inbox], [.parked, .done]]
        case 3: return [[.doing, .next], [.scheduled, .inbox], [.parked, .done]]
        default: return [[.doing, .next, .scheduled], [.inbox, .parked, .done]]
        }
    }

    /// A wide window: the statuses side by side as a board, in as many columns as fit at 320 points each (3 across a
    /// screen of 1040 points, 5 across a 1920 window). Which statuses share a column depends only on how many
    /// columns fit (`boardColumns`), so a status never changes its neighbors when tasks come and go. A column whose
    /// statuses hold nothing is left out and the others share its width. Each column scrolls by itself.
    private var board: some View {
        GeometryReader { geo in
            let columns = Self.boardColumns(Int(geo.size.width / Self.columnWidth))
                .filter { column in column.contains { status in engine.tasks(status: status).contains(where: inScope) } }
            HStack(alignment: .top, spacing: 0) {
                ForEach(columns, id: \.self) { column in
                    if column != columns.first { Divider() }
                    List {
                        ForEach(column, id: \.self) { status in section(status) }
                    }
                    .listStyle(.plain)
                    #if os(iOS)
                    // The same top margin for every column. Left to itself, the iPad starts a column that has one
                    // on each side 22 points lower than the two outer ones (measured on a board of 3 columns:
                    // the first heading at 22 points in the middle list, at 0 in the others).
                    .contentMargins(.top, 0, for: .scrollContent)
                    #endif
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    /// One status. Done is a drawer: one row while closed (it takes drops too), newest first when open.
    @ViewBuilder private func section(_ status: TaskStatus) -> some View {
        let all = engine.tasks(status: status).filter(inScope)
        if !all.isEmpty {
            SwiftUI.Section(header: header(status)) {
                if status == .done && !showDone {
                    ForEach(["drawer"], id: \.self) { _ in
                        Button { withAnimation { showDone = true } } label: {
                            Label("\(all.count) finished", systemImage: "chevron.down").foregroundStyle(.secondary)
                        }
                    }
                    .onInsert(of: [.plainText]) { _, providers in dropInto([], status: .done, providers: providers, index: 0) }
                } else {
                    let items = status == .done ? Array(all.sorted { $0.str("done_at") > $1.str("done_at") }.prefix(50)) : all
                    ForEach(items) { t in
                        TaskRow(task: t, undo: undo, onEdit: { editing = t }, onPark: { parking = t }, showsList: listFilter.isEmpty)
                            .draggable(t.id)
                    }
                    .onMove { from, to in reorder(items, status: status, from: from, to: to) }
                    .onInsert(of: [.plainText]) { index, providers in dropInto(items, status: status, providers: providers, index: index) }
                    .moveDisabled(status != .next)
                }
            }
        }
    }

    private func reorder(_ items: [Entity], status: TaskStatus, from: IndexSet, to: Int) {
        guard status == .next else { return }
        var ids = items.map(\.id)
        ids.move(fromOffsets: from, toOffset: to)
        Task { await engine.reorderNext(ids: ids) }
    }

    /// A row dragged in from another section (or from Next to a new place in it).
    private func dropInto(_ items: [Entity], status: TaskStatus, providers: [NSItemProvider], index: Int) {
        guard let p = providers.first else { return }
        _ = p.loadTransferable(type: String.self) { result in
            guard case .success(let id) = result else { return }
            Task { @MainActor in
                var order = items.map(\.id).filter { $0 != id }
                order.insert(id, at: min(index, order.count))
                drop(id, on: status, order: order)
            }
        }
    }

    private func header(_ status: TaskStatus) -> some View {
        HStack {
            Text(status == .scheduled ? "Scheduled and reminders" : status.label).font(.headline)
            if status == .done && showDone {
                Spacer()
                Button("Hide") { withAnimation { showDone = false } }.font(.subheadline).buttonStyle(.borderless)
            }
        }
        .pinnedHeader()
    }

    /// Set aside asks for its reason; Scheduled without a time opens the editor to set one.
    private func drop(_ id: String, on status: TaskStatus, order: [String]?) {
        guard let t = engine.get(id), t.kind == .task else { return }
        if status == .parked { if t.str("status") != "parked" { parking = t }; return }
        Task {
            if !(await engine.moveTask(id, to: status, nextOrder: status == .next ? order : nil)), status == .scheduled { editing = t }
        }
    }

    /// Personal, Work while it is on, and the owner's groups (segmented while they fit, else a menu), with a menu beside
    /// them for New group and Edit group; then the lists in it with how many open tasks each holds. Stays on top while
    /// scrolling.
    private var scopeBar: some View {
        VStack(spacing: 8) {
            let choices = 1 + (hasWork ? 1 : 0) + groups.count
            let canGroup = !groups.isEmpty || engine.sources?.lists.contains(where: \.on) == true
            if choices > 1 || canGroup {
                HStack(spacing: 10) {
                    if choices > 1 {
                        ViewThatFits(in: .horizontal) {
                            scopePicker.pickerStyle(.segmented).fixedSize()
                            scopePicker.pickerStyle(.menu)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Spacer(minLength: 0)
                    }
                    if canGroup { groupMenu }
                }
                .padding(.horizontal)
                if group != nil {
                    Text(TaskGroupText.note)
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                } else if hasWork {
                    Text(verbatim: "Work holds tasks you add under Work, tasks from work Reminders accounts and captures that start with \"work:\". The rest are Personal. To move one, open it.")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                }
            }
            let titles = chipTitles
            let loose = openCount { $0.reminderList == nil }
            if !titles.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ListChip(title: "All", count: openCount { _ in true }, selected: listFilter.isEmpty) { listFilter = "" }
                        ForEach(titles, id: \.self) { title in
                            ListChip(title: title, count: openCount { $0.reminderList == title }, selected: listFilter == title) { listFilter = title }
                        }
                        if loose > 0 {
                            ListChip(title: "No list", count: loose, selected: listFilter == Self.noList) { listFilter = Self.noList }
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
        .padding(.vertical, 8)
        // Only behind the bar itself: by default a style background reaches up through the top safe area, and there it
        // covered the large title, so the iPhone showed a blank band where "Tasks" belongs.
        .background(.bar, ignoresSafeAreaEdges: [])
    }

    private var scopePicker: some View {
        Picker(TaskGroupText.show, selection: Binding(get: { scopeTag }, set: { spaceRaw = $0 })) {
            Text(TaskGroupText.personal).tag(Space.personal.rawValue)
            if hasWork { Text(TaskGroupText.work).tag(Space.work.rawValue) }
            ForEach(groups) { g in Text(StyleGuard.dashes(g.name)).tag("group:" + g.id) }
        }
    }

    /// New group, and Edit group while one is shown.
    private var groupMenu: some View {
        Menu {
            Button { groupEdit = GroupEdit(group: nil) } label: { Label(TaskGroupText.newGroup, systemImage: "plus") }
            if let g = group {
                Button { groupEdit = GroupEdit(group: g) } label: { Label(TaskGroupText.editGroup, systemImage: "pencil") }
            }
        } label: {
            Label(group == nil ? TaskGroupText.newGroup : TaskGroupText.editGroup, systemImage: "folder.badge.gearshape")
                .labelStyle(.iconOnly)
                .font(.title3)
                .frame(minWidth: 36, minHeight: 32)
                .contentShape(Rectangle())
        }
        .fixedSize()
        .accessibilityLabel("Groups")
    }
}

/// Making or changing a group on Tasks (gnomecannon/aeneas#26): its name and its lists (each list that is on, and the
/// tasks in no list), or Delete group. The whole set of groups goes to the hub (`groups` in the sources setting),
/// checked first by the same rules the hub keeps (`TaskGroups.problem`). The same words as the web's editor.
struct TaskGroupEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    /// Nil for a new group.
    let group: TaskGroup?
    /// The group saved, or nil once it is deleted.
    var onDone: (TaskGroup?) -> Void
    @State private var name = ""
    @State private var chosen: [String] = []
    @State private var error: String?
    @State private var busy = false
    @State private var asksDelete = false

    private var groups: [TaskGroup] { engine.sources?.groups ?? [] }
    private var lists: [SourcesSetting.ReminderList] { TodayText.choosable(engine.sources?.lists ?? []) }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section(TaskGroupText.name) {
                    TextField(TaskGroupText.name, text: $name, prompt: Text(TaskGroupText.namePlaceholder))
                        .onChange(of: name) { _, n in if n.unicodeScalars.count > TaskGroups.nameMax { name = String(String.UnicodeScalarView(n.unicodeScalars.prefix(TaskGroups.nameMax))) } }
                }
                .themedRow()
                SwiftUI.Section {
                    ForEach(lists) { l in
                        Toggle(isOn: Binding(get: { ListChoices.contains(chosen, l) }, set: { chosen = ListChoices.with(chosen, l, $0) })) {
                            label(l.title, TodayText.accountName(l.account, kind: l.kind) + (l.space == .work ? ", \(TodayText.work)" : ""))
                        }
                    }
                    Toggle(isOn: Binding(get: { chosen.contains(ListChoices.noList) }, set: { chosen = ListChoices.withNoList(chosen, $0) })) {
                        label(TodayText.noList, TodayText.noListNote)
                    }
                } header: {
                    Text(TaskGroupText.lists)
                } footer: {
                    Text(lists.isEmpty ? "\(TodayText.noListsYet) \(TaskGroupText.note)" : TaskGroupText.note)
                }
                .themedRow()
                if let error {
                    SwiftUI.Section { Text(error).foregroundStyle(.dangerText) }.themedRow()
                }
                if group != nil {
                    SwiftUI.Section {
                        Button(TaskGroupText.delete, role: .destructive) { asksDelete = true }
                    }
                    .themedRow()
                }
            }
            #if os(macOS)
            .toggleStyle(.switch)
            .frame(minWidth: 420, minHeight: 460)
            #endif
            .formStyle(.grouped)
            .themedScreen()
            .navigationTitle(group == nil ? TaskGroupText.newGroup : TaskGroupText.editGroup)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(TaskGroupText.cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TaskGroupText.save) { save() }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .alert(TaskGroupText.deleteAsk, isPresented: $asksDelete) {
                Button(TaskGroupText.delete, role: .destructive) { if let g = group { send(TaskGroups.without(groups, id: g.id), result: nil) } }
                Button(TaskGroupText.cancel, role: .cancel) {}
            }
            .disabled(busy)
        }
        .onAppear {
            name = group?.name ?? ""
            chosen = group?.lists ?? []
        }
    }

    private func label(_ title: String, _ note: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(StyleGuard.dashes(title))
            Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func save() {
        let g = TaskGroup(id: group?.id ?? TaskGroups.newId(name, groups: groups), name: name.trimmingCharacters(in: .whitespacesAndNewlines), lists: chosen)
        send(TaskGroups.with(groups, g), result: g)
    }

    /// The whole set to the hub; its answer is the whole sources setting, which every screen then follows.
    private func send(_ next: [TaskGroup], result: TaskGroup?) {
        if let p = TaskGroups.problem(next) { error = p; return }
        guard engine.client != nil else { error = TaskGroupText.offline; return }
        guard let value = try? JSONCoding.value(next) else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await engine.changeSources(["groups": value])
                onDone(result)
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// One list in the Tasks bar: its name and open count.
struct ListChip: View {
    var title: String
    var count: Int
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(StyleGuard.dashes(title)).font(.subheadline.weight(selected ? .semibold : .regular)).lineLimit(1)
                if count > 0 { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(selected ? AnyShapeStyle(.tint.opacity(0.22)) : AnyShapeStyle(Color.secondary.opacity(0.12)), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? AnyShapeStyle(.tint.opacity(0.6)) : AnyShapeStyle(Color.clear), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count) open")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct TaskRow: View {
    @EnvironmentObject var engine: SyncEngine
    var task: Entity
    @ObservedObject var undo: TaskUndo
    var onEdit: () -> Void
    var onPark: () -> Void
    /// Off while the screen shows one list, which would only repeat its name on every row.
    var showsList = true

    var body: some View {
        let f = task.decoded(TaskFields.self)
        HStack(spacing: 12) {
            // The circle finishes a task; on a finished one it is Not done. Both offer Undo.
            Button {
                Task { if f?.status == .done { await undo.reopen(task, engine: engine) } else { await undo.done(task, engine: engine) } }
            } label: {
                Image(systemName: f?.status == .done ? "checkmark.circle.fill" : "circle").font(.title2)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(f?.status == .done ? "Not done" : "Done")
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(task.str("title"))).font(.title3)
                // When: the reminder, repeat, deadline and block. Then what it belongs to.
                HStack(spacing: 8) {
                    if let at = task.alertDate {
                        Label(at.formatted(.dateTime.month(.abbreviated).day().hour().minute()), systemImage: "bell")
                            .foregroundStyle(at <= Date() ? AnyShapeStyle(.warnText) : AnyShapeStyle(.secondary))
                    }
                    if let r = f?.repeat, !r.isEmpty { Image(systemName: "repeat").accessibilityLabel(r) }
                    if let d = f?.due, !d.isEmpty, let dd = ISO.date(d) {
                        Text("Due \(dd.formatted(.dateTime.month(.abbreviated).day()))")
                            // A date alone is overdue once its day is over, not from its own midnight.
                            .foregroundStyle(TaskDue.isOverdue(d) && f?.status != .done ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.secondary))
                    }
                    if let b = f?.block { Text("Block \(dateLabel(b.start))") }
                    if let r = f?.parked_reason, !r.isEmpty { Text(r) }
                }
                .lineLimit(1)
                HStack(spacing: 8) {
                    if let l = f?.linked_id { LinkedItem(id: l) }
                    if let p = f?.project_id { LinkedItem(id: p, showsScreen: false) }
                    // The list only when it is not the default one, which every synced task would show.
                    if showsList, let a = f?.apple?.list_title, a != "Reminders" { Label(a, systemImage: "checklist").accessibilityLabel("Apple Reminders list \(a)") }
                }
                .lineLimit(1)
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let at = task.alertDate, at <= Date() { Button("Snooze") { snooze() }.tint(.purple) }
            Button("Delete", role: .destructive) { Task { await undo.delete(task, engine: engine) } }
            if f?.status != .parked && f?.status != .done { Button("Set aside") { onPark() }.tint(.orange) }
            if f?.status != .doing { Button("Block") { Task { await engine.startBlock(task.id) } }.tint(.blue) }
            if f?.status != .next && f?.status != .doing { Button("Next") { Task { await engine.moveToNext(task.id) } }.tint(.green) }
        }
        .contextMenu {
            Button("Edit") { onEdit() }
            Button("Start 3 h block") { Task { await engine.startBlock(task.id) } }
            Button("Start") { Task { await engine.startTask(task.id) } }
            Button("Move to Next") { Task { await engine.moveToNext(task.id) } }
            if f?.status != .done { Button("Set aside") { onPark() } }
            if f?.status == .done { Button("Not done") { Task { await undo.reopen(task, engine: engine) } } }
            else { Button("Done") { Task { await undo.done(task, engine: engine) } } }
            if task.alertDate != nil { Button("Snooze 1 hour") { snooze() } }
            Divider()
            Button("Delete", role: .destructive) { Task { await undo.delete(task, engine: engine) } }
        }
    }
}

extension TaskRow {
    /// A reason-free reminder snoozes an hour at once; one that asks why opens the reason sheet.
    fileprivate func snooze() {
        if task.str("friction") == "reason" { AppModel.shared.pendingSnoozeReminderId = task.id }
        else { Task { _ = await engine.snooze(task.id, minutes: 60, reason: nil) } }
    }
}

struct ParkSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var task: Entity
    @State private var reason = ""
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(task.str("title")).font(.title3)
                TextField("Reason", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).font(.title3).lineLimit(2...6)
                BigButton(title: "Set aside", symbol: "pause", prominent: true) {
                    Task { await engine.park(task.id, reason: reason) }
                    dismiss()
                }
                .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty)
                Text("Out of Next and Now until you bring it back.").font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle("Set aside")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

struct TaskEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var task: Entity?
    /// For a new task: the space and list the Tasks screen was showing.
    var newSpace: Space = .personal
    var newList: String? = nil
    /// Tasks' Undo bar, for Delete and moves from here; elsewhere they act without one.
    var undo: TaskUndo? = nil
    @State private var title = ""
    @State private var notes = ""
    @State private var listTitle: String?
    @State private var status: TaskStatus = .inbox
    @State private var hasDue = false
    @State private var due = Date()
    @State private var space: Space = .personal
    @State private var projectId: String?
    @State private var hasReminder = false
    @State private var remindAt = Date().addingTimeInterval(3600)
    @State private var repeatRule: String?
    @State private var askWhy = false
    @State private var loaded: Snapshot?

    private var projects: [Entity] {
        engine.list(.project).filter { $0.str("status") != "done" || $0.id == projectId }.sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title).font(.title3)
                Picker("Status", selection: $status) { ForEach(TaskStatus.allCases, id: \.self) { Text($0.label).tag($0) } }
                if task == nil {
                    Picker("Space", selection: $space) { ForEach(Space.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                        .onChange(of: space) { _, _ in if !engine.taskListTitles(space: space).contains(listTitle ?? "") { listTitle = nil } }
                }
                Picker("List", selection: $listTitle) {
                    Text(space == .work ? "None" : "Default list").tag(String?.none)
                    ForEach(engine.taskListTitles(space: space), id: \.self) { Text(StyleGuard.dashes($0)).tag(Optional($0)) }
                }
                Picker("Project", selection: $projectId) {
                    Text("None").tag(String?.none)
                    ForEach(projects) { p in Text(StyleGuard.dashes(p.str("name"))).tag(Optional(p.id)) }
                }
                Toggle("Due date", isOn: $hasDue)
                if hasDue { DatePicker("Due", selection: $due) }
                SwiftUI.Section("Reminder") {
                    Toggle("Remind me", isOn: $hasReminder)
                    if hasReminder {
                        DatePicker("At", selection: $remindAt)
                        RepeatEditor(rule: $repeatRule)
                        Toggle("Ask why when I snooze it", isOn: $askWhy)
                    }
                }
                if let t = task, let log = t.reminderFields?.snooze_log, !log.isEmpty {
                    SwiftUI.Section("Snoozed") {
                        ForEach(log.suffix(10).reversed(), id: \.at) { s in
                            VStack(alignment: .leading) { Text(s.reason.isEmpty ? "(no reason)" : s.reason); Text(dateLabel(s.at)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                SwiftUI.Section("Notes") {
                    TextEditor(text: $notes).frame(minHeight: 120)
                }
                if let t = task {
                    SwiftUI.Section {
                        Button("Start 3 h block") { Task { await engine.startBlock(t.id) }; dismiss() }
                        // Personal or Work: a task from a work Reminders account stays in Work (work items stay in Apple).
                        if !(t.space == .work && t.tiedToApple) {
                            Button(t.space == .work ? "Move to Personal" : "Move to Work") {
                                Task { if let u = undo { await u.moveSpace(t, engine: engine) } else { _ = await TaskUndo.move(t, engine: engine) } }
                                dismiss()
                            }
                        }
                        Button("Delete", role: .destructive) {
                            Task { if let u = undo { await u.delete(t, engine: engine) } else { await engine.softDelete(t.id) } }
                            dismiss()
                        }
                    } footer: {
                        Text(t.space == .work && t.tiedToApple ? "Work. It is in a work Reminders list, so it stays in Work." : t.space == .work ? "Work." : "Personal.")
                    }
                }
            }
            .navigationTitle(task == nil ? "New task" : "Edit task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }

    private func load() {
        if task == nil { space = newSpace; listTitle = newList }
        guard let t = task, let f = t.decoded(TaskFields.self) else { return }
        listTitle = t.reminderList
        title = f.title
        notes = f.notes ?? ""
        status = f.status
        space = t.space
        projectId = f.project_id
        if let d = ISO.date(f.due) { hasDue = true; due = d }
        if let r = ISO.date(f.remind_at) { hasReminder = true; remindAt = r }
        repeatRule = f.repeat
        askWhy = f.friction == .reason
        loaded = Snapshot(title: title, notes: notes, status: status, hasDue: hasDue, due: due, projectId: projectId, hasReminder: hasReminder,
                          remindAt: remindAt, repeatRule: repeatRule, askWhy: askWhy, listTitle: listTitle)
    }

    /// What the editor showed when it opened, so Save writes only what was changed here.
    private struct Snapshot {
        var title: String, notes: String, status: TaskStatus, hasDue: Bool, due: Date, projectId: String?
        var hasReminder: Bool, remindAt: Date, repeatRule: String?, askWhy: Bool, listTitle: String?
    }

    /// Save on an existing task. It used to write every field from the copy taken when the sheet opened, which undid
    /// a Done (or any edit) made meanwhile on another device; it writes only the fields changed here. Done goes
    /// through markDone, as the row's checkmark does: it used to save done with no done_at and never moved a
    /// repeating task on. Default list (or None on Work) used to leave the list as it was.
    private func saveChanges(_ t: Entity, _ o: Snapshot) {
        var fields: [String: JSONValue] = [:]
        if title != o.title { fields["title"] = .string(title) }
        if notes != o.notes { fields["notes"] = .string(notes) }
        let finishing = status != o.status && status == .done
        if status != o.status, !finishing { fields["status"] = .string(status.rawValue) }
        if hasDue != o.hasDue || (hasDue && due != o.due) { fields["due"] = hasDue ? .string(ISO.string(due)) : .null }
        if projectId != o.projectId { fields["project_id"] = projectId.map { .string($0) } ?? .null }
        if hasReminder {
            if !o.hasReminder || remindAt != o.remindAt { fields["remind_at"] = .string(ISO.string(remindAt)); fields["snoozed_until"] = .null }
            if !o.hasReminder || repeatRule != o.repeatRule { fields["repeat"] = repeatRule.map { .string($0) } ?? .null }
            if !o.hasReminder || askWhy != o.askWhy { fields["friction"] = .string(askWhy ? "reason" : "none") }
        } else if o.hasReminder {
            fields["remind_at"] = .null
            fields["repeat"] = .null
            fields["snoozed_until"] = .null
        }
        // The list: kept by name; the iPhone adds or moves the Apple item to match.
        if listTitle != o.listTitle {
            var link = t.fields["apple"]?.objectValue ?? ["id": "", "list": ""]
            let linked = !(link["id"]?.stringValue ?? "").isEmpty
            if let l = listTitle {
                link["list_title"] = .string(l)
            } else if linked, t.space == .personal, let d = RemindersSync.shared.defaultListTitle {
                // An empty name on a linked task moves nothing, so Default list names the default list.
                link["list_title"] = .string(d)
            } else {
                // Not in Apple yet: a personal task with no list goes to the default list, a work task stays out.
                link["list_title"] = ""
            }
            fields["apple"] = .object(link)
        }
        Task {
            if !fields.isEmpty { _ = await engine.update(t.id, fields: fields) }
            if finishing { await engine.markDone(t.id) }
        }
    }

    private func save() {
        if let t = task, let o = loaded {
            saveChanges(t, o)
            dismiss()
            return
        }
        var fields: [String: JSONValue] = ["title": .string(title), "status": .string(status.rawValue), "notes": .string(notes)]
        fields["due"] = hasDue ? .string(ISO.string(due)) : .null
        fields["project_id"] = projectId.map { .string($0) } ?? .null
        if hasReminder {
            let at = ISO.string(remindAt)
            if task?.str("remind_at") != at { fields["remind_at"] = .string(at); fields["snoozed_until"] = .null }
            fields["repeat"] = repeatRule.map { .string($0) } ?? .null
            fields["friction"] = .string(askWhy ? "reason" : "none")
        } else {
            fields["remind_at"] = .null
            fields["repeat"] = .null
            fields["snoozed_until"] = .null
        }
        // The list: kept by name; the iPhone adds or moves the Apple item to match.
        if listTitle != task?.reminderList, let l = listTitle {
            var link = task?.fields["apple"]?.objectValue ?? ["id": "", "list": ""]
            link["list_title"] = .string(l)
            fields["apple"] = .object(link)
        }
        let extra = fields.filter { ["project_id", "remind_at", "repeat", "friction", "snoozed_until", "apple"].contains($0.key) && $0.value != .null }
        // A new task with a reminder waits in Scheduled instead of Inbox.
        let newStatus: TaskStatus = task == nil && hasReminder && status == .inbox ? .scheduled : status
        Task {
            if let t = task {
                _ = await engine.update(t.id, fields: fields)
            } else if let made = await engine.createTask(title: title, notes: notes, status: newStatus == .done ? .inbox : newStatus, due: hasDue ? ISO.string(due) : nil, space: space) {
                if !extra.isEmpty { _ = await engine.update(made.id, fields: extra) }
                // Made as done: finished the same way as the checkmark, with its done_at.
                if newStatus == .done { await engine.markDone(made.id) }
            }
        }
        dismiss()
    }
}
