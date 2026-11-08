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

extension SyncEngine {
    /// Every list for one space: Reminders lists on this device (empty ones too) and any a task names.
    @MainActor func taskListTitles(space: Space) -> [String] {
        var names = Set(RemindersSync.shared.lists.filter { $0.isWork == (space == .work) }.map(\.title))
        for t in tasks where t.space == space { if let l = t.reminderList { names.insert(l) } }
        return names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}

/// Tasks by status, inside one space (Personal or Work) and one list (all of them, one Reminders list, or none).
/// Drag a task into another section to move it, or within Next to reorder. Done is a drawer. Edit, park, block.
struct TasksView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var reminders = RemindersSync.shared
    @State private var editing: Entity?
    @State private var creating = false
    @State private var parking: Entity?
    @State private var showDone = false
    @AppStorage("tasks.space") private var spaceRaw = Space.personal.rawValue
    /// "" is every list; `noList` is tasks in no Reminders list; anything else is a list name.
    @AppStorage("tasks.list") private var listFilter = ""
    private static let noList = "\u{1}none"

    private let order: [TaskStatus] = [.doing, .next, .scheduled, .inbox, .parked, .done]

    private var hasWork: Bool { engine.tasks.contains { $0.space == .work } || reminders.lists.contains(where: \.isWork) }
    private var space: Space { hasWork ? (Space(rawValue: spaceRaw) ?? .personal) : .personal }
    private func inScope(_ t: Entity) -> Bool {
        guard t.space == space else { return false }
        switch listFilter {
        case "": return true
        case Self.noList: return t.reminderList == nil
        default: return t.reminderList == listFilter
        }
    }
    private func openCount(_ match: (Entity) -> Bool) -> Int { engine.tasks.filter { $0.space == space && $0.str("status") != "done" && match($0) }.count }

    var body: some View {
        List {
            ForEach(order, id: \.self) { status in section(status) }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .top, spacing: 0) { scopeBar }
        .onChange(of: spaceRaw) { _, _ in listFilter = "" }
        .navigationTitle("Tasks")
        // Personal tasks only: no work item leaves the device in an export (contract, work space rule 6).
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .task, filter: ["space": "personal"]) } }
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .navigationBarLeading) { EditButton() }
            #endif
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New", systemImage: "plus") } }
        }
        .sheet(item: $editing) { t in TaskEditView(task: t) }
        .sheet(isPresented: $creating) { TaskEditView(task: nil, newSpace: space, newList: listFilter == Self.noList || listFilter.isEmpty ? nil : listFilter) }
        .sheet(item: $parking) { t in ParkSheet(task: t) }
        .refreshable { await engine.sync() }
        .overlay { if !engine.tasks.contains(where: inScope) { EmptyState(text: listFilter.isEmpty ? "No tasks yet" : "Nothing in this list") } }
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
                        TaskRow(task: t, onEdit: { editing = t }, onPark: { parking = t }, showsList: listFilter.isEmpty)
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
            Text(status == .scheduled ? "Scheduled and reminders" : status.rawValue.capitalized).font(.headline)
            if status == .done && showDone {
                Spacer()
                Button("Hide") { withAnimation { showDone = false } }.font(.subheadline).buttonStyle(.borderless)
            }
        }
    }

    /// Parked asks for its reason; Scheduled without a time opens the editor to set one.
    private func drop(_ id: String, on status: TaskStatus, order: [String]?) {
        guard let t = engine.get(id), t.kind == .task else { return }
        if status == .parked { if t.str("status") != "parked" { parking = t }; return }
        Task {
            if !(await engine.moveTask(id, to: status, nextOrder: status == .next ? order : nil)), status == .scheduled { editing = t }
        }
    }

    /// Personal or Work, then the lists in it with how many open tasks each holds. Stays on top while scrolling.
    private var scopeBar: some View {
        VStack(spacing: 8) {
            if hasWork {
                Picker("Space", selection: $spaceRaw) {
                    Text("Personal").tag(Space.personal.rawValue)
                    Text("Work").tag(Space.work.rawValue)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
            }
            let titles = engine.taskListTitles(space: space)
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
        .background(.bar)
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
            .background(selected ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Color.accentColor.opacity(0.6) : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count) open")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct TaskRow: View {
    @EnvironmentObject var engine: SyncEngine
    var task: Entity
    var onEdit: () -> Void
    var onPark: () -> Void
    /// Off while the screen shows one list, which would only repeat its name on every row.
    var showsList = true

    var body: some View {
        let f = task.decoded(TaskFields.self)
        HStack(spacing: 12) {
            Button {
                Task { await engine.markDone(task.id) }
            } label: {
                Image(systemName: f?.status == .done ? "checkmark.circle.fill" : "circle").font(.title2)
            }
            .buttonStyle(.borderless)
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(task.str("title"))).font(.title3)
                // When: the reminder, repeat, deadline and block. Then what it belongs to.
                HStack(spacing: 8) {
                    if let at = task.alertDate {
                        Label(at.formatted(.dateTime.month(.abbreviated).day().hour().minute()), systemImage: "bell")
                            .foregroundStyle(at <= Date() ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    }
                    if let r = f?.repeat, !r.isEmpty { Image(systemName: "repeat").accessibilityLabel(r) }
                    if let d = f?.due, !d.isEmpty, let dd = ISO.date(d) {
                        Text("Due \(dd.formatted(.dateTime.month(.abbreviated).day()))")
                            // A date alone is overdue once its day is over, not from its own midnight.
                            .foregroundStyle(TaskDue.isOverdue(d) && f?.status != .done ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
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
            if f?.status != .parked { Button("Park") { onPark() }.tint(.orange) }
            if f?.status != .doing { Button("Block") { Task { await engine.startBlock(task.id) } }.tint(.blue) }
            if f?.status != .next && f?.status != .doing { Button("Next") { Task { await engine.moveToNext(task.id) } }.tint(.green) }
        }
        .contextMenu {
            Button("Edit") { onEdit() }
            Button("Start 3 h block") { Task { await engine.startBlock(task.id) } }
            Button("Make Now") { Task { await engine.makeNow(task.id) } }
            Button("Move to Next") { Task { await engine.moveToNext(task.id) } }
            Button("Park") { onPark() }
            Button("Done") { Task { await engine.markDone(task.id) } }
            if task.alertDate != nil { Button("Snooze 1 hour") { snooze() } }
            Divider()
            Button("Delete", role: .destructive) { Task { await engine.softDelete(task.id) } }
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
                BigButton(title: "Park", symbol: "pause", prominent: true) {
                    Task { await engine.park(task.id, reason: reason) }
                    dismiss()
                }
                .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
            .padding()
            .navigationTitle("Park")
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
                Picker("Status", selection: $status) { ForEach(TaskStatus.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                Picker("Space", selection: $space) { ForEach(Space.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                    .disabled(task != nil)
                    .onChange(of: space) { _, _ in if task == nil, !engine.taskListTitles(space: space).contains(listTitle ?? "") { listTitle = nil } }
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
                        Button("Delete", role: .destructive) { Task { await engine.softDelete(t.id) }; dismiss() }
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
